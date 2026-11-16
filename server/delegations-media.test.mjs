import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { delegations } from './delegations.mjs';

// Lesson media sent straight to Storage (learning.lesson-media.direct-storage.v1, docs/CENTRAL_LEARNING.md). The database stand-in
// records each capability's payload and the operation hub.authorize_learning_object was asked about; app-media and Storage are stubs.
const storageUrl = 'https://xgauehtwksmnoqhgqegm.supabase.co';
const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)]);
const sha256 = createHash('sha256').update(video).digest('hex');
const uploadToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1cGxvYWQifQ.c2lnbmVk', readToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJyZWFkIn0.c2lnbmVk';

function setup({ directMedia = true, sign, read, put } = {}) {
  const path = `learning/${randomUUID()}/video.mp4`;
  const payloads = [], authorized = [], requests = [];
  let held = null;
  const pool = { connect: async () => ({
    release() {},
    query: async (text, params) => {
      if (/^select s\.id/.test(text)) return { rows: [{ id: 'session', user_id: 'editor', auth_method: 'sms' }] };
      if (text.includes('hub.authorize_learning_object')) { authorized.push(params[1]); return { rows: [{ allowed: true }] }; }
      if (text.includes('insert into private.app_delegations')) { payloads.push(JSON.parse(params[3])); return { rows: [] }; }
      return { rows: [] };
    },
  }) };
  const fetchImpl = vi.fn(async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url === `${storageUrl}/functions/v1/app-media`) {
      const { operation } = payloads.at(-1);
      if (operation === 'upload-sign') return sign ? sign() : Response.json({ token: uploadToken });
      if (operation === 'sign') return Response.json({ signedUrl: `${storageUrl}/storage/v1/object/sign/hub-learning/${path}?token=${readToken}` });
      if (operation === 'upload') { held = new Uint8Array(await new Response(options.body).arrayBuffer()); return Response.json({ uploaded: true }); }
      throw new Error(`Unexpected operation ${operation}`);
    }
    const headers = new Headers(options.headers);
    expect(headers.get('authorization')).toBeNull(); expect(headers.get('apikey')).toBeNull(); expect(options.redirect).toBe('error');
    if (options.method === 'PUT') {
      expect(url).toBe(`${storageUrl}/storage/v1/object/upload/sign/hub-learning/${path}?token=${uploadToken}`);
      expect(headers.get('content-type')).toBe('video/mp4'); expect(headers.get('x-upsert')).toBe('false');
      const bytes = new Uint8Array(await new Response(options.body).arrayBuffer());
      if (put) return put(bytes);
      held = bytes; return Response.json({ Key: `hub-learning/${path}` });
    }
    expect(url).toBe(`${storageUrl}/storage/v1/object/sign/hub-learning/${path}?token=${readToken}`);
    if (read) return read();
    return held ? new Response(held, { headers: { 'Content-Type': 'video/mp4' } }) : new Response('{}', { status: 404 });
  });
  const hub = delegations({ pool, storageUrl, fetchImpl, directMedia });
  const send = () => hub.mediaPart('session-token', path, { offset: 0, total: video.length, length: video.length }, Readable.from([video]), 'video/mp4', 268435456);
  return { path, payloads, authorized, requests, hub, send, hold: bytes => { held = bytes; } };
}
const kinds = requests => requests.map(r => r.url.endsWith('/functions/v1/app-media') ? 'app-media' : r.method === 'PUT' ? 'PUT' : 'GET');

describe('a lesson file sent straight to Storage', () => {
  it('uploads it to a signed address, reads it back and answers with the stored copy\'s checksum', async () => {
    const s = setup();
    expect(await s.send()).toEqual({ result: { uploaded: true, sha256 } });
    expect(s.payloads.map(p => p.operation)).toEqual(['upload-sign', 'sign']);
    // An upload address is authorized exactly as an upload; the read address as a read.
    expect(s.authorized).toEqual(['upload', 'upload', 'sign']);
    expect(kinds(s.requests)).toEqual(['app-media', 'PUT', 'app-media', 'GET']);
  });
  it('reads back what Storage already holds, after a lost answer', async () => {
    const s = setup({ sign: () => Response.json({ stored: true }) });
    s.hold(new Uint8Array(video));
    expect(await s.send()).toEqual({ result: { uploaded: true, sha256 } });
    expect(kinds(s.requests)).toEqual(['app-media', 'app-media', 'GET']);
  });
  it.each([
    ['409', () => new Response('{}', { status: 409 })],
    ['legacy duplicate', () => Response.json({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }, { status: 400 })],
  ])('reads an existing object back after a %s answer to the upload', async (_name, answer) => {
    const s = setup({ put: answer });
    s.hold(new Uint8Array(video));
    expect((await s.send()).result.sha256).toBe(sha256);
  });
  it('refuses another file already at the name, and asks for a retry when the stored copy differs', async () => {
    const taken = setup({ sign: () => Response.json({ stored: true }) });
    taken.hold(new Uint8Array(video.length));
    await expect(taken.send()).rejects.toMatchObject({ status: 409 });
    const changed = setup({ read: () => new Response(new Uint8Array(video.length), { headers: { 'Content-Type': 'video/mp4' } }) });
    await expect(changed.send()).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    ['a truncated copy', () => new Response(video.subarray(1), { headers: { 'Content-Type': 'video/mp4' } })],
    ['another media type', () => new Response(video, { headers: { 'Content-Type': 'text/html' } })],
    ['a missing copy', () => new Response('{}', { status: 404 })],
    ['a failed read', () => { throw new TypeError('network'); }],
  ])('never answers uploaded when the read-back finds %s', async (_name, read) => {
    await expect(setup({ read }).send()).rejects.toMatchObject({ status: 503 });
  });
  it("reports Storage's own size limit, and never treats another refusal as stored", async () => {
    const big = setup({ put: () => Response.json({ error: 'Payload too large' }, { status: 413 }) });
    const error = await big.send().catch(cause => cause);
    expect(error.status).toBe(413); expect(error.message).toMatch(/upload limit is lower/);
    for (const status of [400, 401, 403, 500]) {
      const refused = setup({ put: () => Response.json({ code: 'AccessDenied' }, { status }) });
      await expect(refused.send()).rejects.toMatchObject({ status: 503 });
      expect(kinds(refused.requests)).toEqual(['app-media', 'PUT']);
    }
  });
  it.each([
    ['an unsafe token', () => Response.json({ token: 'not a token!' })],
    ['extra fields', () => Response.json({ token: uploadToken, url: 'https://attacker.invalid/' })],
    ['a refusal', () => Response.json({ error: 'Media unavailable' }, { status: 503 })],
  ])('sends nothing on a signing answer with %s', async (_name, sign) => {
    const s = setup({ sign });
    await expect(s.send()).rejects.toMatchObject({ status: 503 });
    expect(kinds(s.requests)).toEqual(['app-media']);
  });
  it('without the feature, streams the file through app-media as before', async () => {
    const s = setup({ directMedia: false });
    expect(await s.send()).toEqual({ result: { uploaded: true } });
    expect(s.payloads.map(p => p.operation)).toEqual(['upload']);
    expect(kinds(s.requests)).toEqual(['app-media']);
  });
});

describe('lesson media for the bulk import', () => {
  it('answers as app-media does: 200 when stored, 409 when Storage already holds it, 503 otherwise', async () => {
    const blob = new Blob([video], { type: 'video/mp4' });
    const s = setup();
    expect((await s.hub.mediaUpload('session-token', s.path, blob, 'video/mp4')).status).toBe(200);
    const read = await s.hub.mediaDownload('session-token', s.path);
    expect(read.status).toBe(200); expect(Buffer.from(await read.arrayBuffer())).toEqual(video);
    expect((await setup({ sign: () => Response.json({ stored: true }) }).hub.mediaUpload('session-token', s.path, blob, 'video/mp4')).status).toBe(409);
    expect((await setup({ put: () => Response.json({}, { status: 500 }) }).hub.mediaUpload('session-token', s.path, blob, 'video/mp4')).status).toBe(503);
    const streamed = setup({ directMedia: false });
    expect((await streamed.hub.mediaUpload('session-token', streamed.path, blob, 'video/mp4')).status).toBe(200);
    expect(streamed.payloads.map(p => p.operation)).toEqual(['upload']);
  });
  it('refuses a read address for another object or origin', async () => {
    const s = setup();
    const hub = delegations({ pool: { connect: async () => ({ release() {}, query: async (text, params) => {
      if (/^select s\.id/.test(text)) return { rows: [{ id: 'session', user_id: 'editor', auth_method: 'sms' }] };
      if (text.includes('hub.authorize_learning_object')) return { rows: [{ allowed: true }] };
      if (text.includes('insert into private.app_delegations')) return { rows: [] };
      return { rows: [], params };
    } }) }, storageUrl, directMedia: true, fetchImpl: async () => Response.json({ signedUrl: `https://attacker.invalid/storage/v1/object/sign/hub-learning/${s.path}?token=${readToken}` }) });
    expect((await hub.mediaDownload('session-token', s.path)).status).toBe(503);
  });
});
