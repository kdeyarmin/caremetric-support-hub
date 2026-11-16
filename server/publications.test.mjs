import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { publications } from './publications.mjs';
import { HttpError } from './sms-auth.mjs';
import { fixtureManifest, articleBytes } from '../src/imports/publicationFixtures.ts';

// The Hub's direct transfer of a checked publication file to Storage (knowledge.publications.direct-storage.v1,
// docs/PUBLICATION_IMPORTS.md). The database is a stand-in that records which guarded functions ran; the real SQL is exercised by
// server/publication-integration.mjs.
const storageUrl = 'https://xgauehtwksmnoqhgqegm.supabase.co';
const session = 'session-token';
const sha256 = createHash('sha256').update(articleBytes).digest('hex');
const uploadToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1cGxvYWQifQ.c2lnbmVk';
const readToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJyZWFkIn0.c2lnbmVk';

let id, manifest, uploaded, calls;
function fakePool() {
  return { connect: async () => ({
    async query(text, params) {
      if (/^(begin|commit|rollback|set local|reset role|select set_config)/.test(text)) return { rows: [] };
      if (text.includes('from private.sms_sessions')) return { rows: [{ id: 'sms-session', user_id: 'owner', auth_method: 'sms' }] };
      const name = /select private\.(\w+)\(/.exec(text)?.[1];
      if (!name) throw new Error(`Unexpected statement: ${text}`);
      calls.push(name);
      if (name === 'get_publication_import') return { rows: [{ result: { id, expiresAt: new Date(Date.now() + 1800000).toISOString(), manifest, plan: null, uploadedParts: uploaded ? ['primary'] : [] } }] };
      if (name === 'verify_publication_asset') {
        expect(params).toEqual([id, 'primary', sha256, articleBytes.length, new TextDecoder().decode(articleBytes)]);
        uploaded = true; return { rows: [{ result: null }] };
      }
      if (name === 'keep_publication_import_open') { expect(params).toEqual([id]); return { rows: [{ result: new Date().toISOString() }] }; }
      throw new Error(`Unexpected function: ${name}`);
    },
    release() {},
  }) };
}
const signed = { sign: () => Response.json({ token: uploadToken }), check: () => Response.json({ token: readToken }) };
function service({ sign = signed.sign, check = signed.check, storage, directStorage = true, streamed } = {}) {
  const operations = [];
  const delegations = { async publication(sessionToken, importId, part, operation, body, contentType) {
    expect([sessionToken, importId, part]).toEqual([session, id, 'primary']);
    operations.push(operation);
    if (operation === 'sign') { expect(body).toBeUndefined(); return sign(); }
    if (operation === 'check') { expect(body).toBeUndefined(); return check(); }
    return streamed(body, contentType);
  } };
  const requests = [];
  const fetchImpl = async (url, options = {}) => { requests.push({ url, ...options }); return storage(url, options); };
  return { operations, requests, publications: publications({ pool: fakePool(), delegations, storageUrl, fetchImpl, directStorage }) };
}
const object = () => `${storageUrl}/storage/v1/object/upload/sign/hub-publications/publications/${id}/primary?token=${uploadToken}`;
const readBack = () => `${storageUrl}/storage/v1/object/sign/hub-publications/publications/${id}/primary?token=${readToken}`;
// Storage that keeps what was uploaded and serves it back on the signed read address.
function memoryStorage({ answer } = {}) {
  let held = null;
  return async (url, options) => {
    if (options.method === 'PUT') {
      expect(url).toBe(object());
      const headers = new Headers(options.headers);
      expect(headers.get('authorization')).toBeNull(); expect(headers.get('apikey')).toBeNull();
      expect(headers.get('content-type')).toBe('text/markdown'); expect(headers.get('x-upsert')).toBe('false');
      expect(options.redirect).toBe('error'); expect(options.signal).toBeInstanceOf(AbortSignal);
      held = new Uint8Array(await new Response(options.body).arrayBuffer());
      return answer ? answer() : Response.json({ Key: `hub-publications/publications/${id}/primary` });
    }
    expect(url).toBe(readBack()); expect(options.redirect).toBe('error');
    return held ? new Response(held, { headers: { 'Content-Type': 'text/markdown' } }) : new Response('{}', { status: 404 });
  };
}
const send = s => s.publications.upload(session, id, 'primary', [Buffer.from(articleBytes)], 'text/markdown');

beforeEach(async () => { id = randomUUID(); manifest = await fixtureManifest(); uploaded = false; calls = []; });

describe('publication direct transfer to Storage', () => {
  it('keeps the import open, uploads the checked file to a signed address, and hashes it back before recording it', async () => {
    const s = service({ storage: memoryStorage() });
    const stage = await send(s);
    expect(stage.uploadedParts).toEqual(['primary']);
    expect(s.operations).toEqual(['sign', 'check']);
    expect(s.requests.map(r => r.method ?? 'GET')).toEqual(['PUT', 'GET']);
    expect(calls).toEqual(['get_publication_import', 'keep_publication_import_open', 'verify_publication_asset', 'get_publication_import']);
  });
  it('after a lost answer finds the object stored and only checks it', async () => {
    const held = memoryStorage(); await held(object(), { method: 'PUT', headers: { 'Content-Type': 'text/markdown', 'x-upsert': 'false' }, redirect: 'error', signal: AbortSignal.timeout(1000), body: articleBytes });
    const s = service({ sign: () => Response.json({ stored: true }), storage: held });
    expect((await send(s)).uploadedParts).toEqual(['primary']);
    expect(s.requests.map(r => r.method ?? 'GET')).toEqual(['GET']);
    expect(calls).toContain('verify_publication_asset');
  });
  it.each([
    ['409', () => new Response('{}', { status: 409 })],
    ['legacy duplicate', () => Response.json({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }, { status: 400 })],
  ])('reads an existing object back after a %s answer to the upload', async (_name, answer) => {
    const s = service({ storage: memoryStorage({ answer }) });
    expect((await send(s)).uploadedParts).toEqual(['primary']);
    expect(s.operations).toEqual(['sign', 'check']);
  });
  it.each([
    ['different bytes', () => new Response(new Uint8Array(articleBytes.length), { headers: { 'Content-Type': 'text/markdown' } })],
    ['a truncated object', () => new Response(articleBytes.slice(1), { headers: { 'Content-Type': 'text/markdown' } })],
    ['a longer object', () => new Response(new Uint8Array([...articleBytes, 10]), { headers: { 'Content-Type': 'text/markdown' } })],
    ['another media type', () => new Response(articleBytes, { headers: { 'Content-Type': 'text/html' } })],
    ['a missing object', () => new Response('{}', { status: 404 })],
    ['a failed read', () => { throw new TypeError('network'); }],
  ])('never records a file when the read-back finds %s', async (_name, read) => {
    const s = service({ storage: async (_url, options) => options.method === 'PUT' ? Response.json({ Key: 'x' }) : read() });
    await expect(send(s)).rejects.toMatchObject({ status: 503 });
    expect(calls).not.toContain('verify_publication_asset');
  });
  it.each([400, 401, 403, 500])('does not treat a %s upload refusal as stored', async status => {
    const s = service({ storage: memoryStorage({ answer: () => Response.json({ code: 'AccessDenied' }, { status }) }) });
    await expect(send(s)).rejects.toMatchObject({ status: 503 });
    expect(s.operations).toEqual(['sign']);
    expect(calls).not.toContain('verify_publication_asset');
  });
  it("reports Storage's own size limit", async () => {
    const s = service({ storage: memoryStorage({ answer: () => Response.json({ error: 'Payload too large' }, { status: 413 }) }) });
    const error = await send(s).catch(cause => cause);
    expect(error).toBeInstanceOf(HttpError); expect(error.status).toBe(413);
    expect(error.message).toMatch(/upload limit is lower/);
  });
  it.each([
    ['an unsafe token', () => Response.json({ token: 'not a token!' })],
    ['extra fields', () => Response.json({ token: uploadToken, url: 'https://attacker.invalid/' })],
    ['stored: false', () => Response.json({ stored: false })],
    ['a refusal', () => Response.json({ error: 'Storage unavailable' }, { status: 503 })],
  ])('refuses a signing answer with %s and sends nothing', async (_name, sign) => {
    const s = service({ sign, storage: memoryStorage() });
    await expect(send(s)).rejects.toMatchObject({ status: 503 });
    expect(s.requests).toEqual([]);
  });
  it('says so when the import has been open too long to finish', async () => {
    const s = service({ storage: memoryStorage() });
    const pool = fakePool(), connect = pool.connect;
    s.publications = publications({ pool: { connect: async () => {
      const db = await connect();
      return { ...db, query: async (text, params) => {
        if (text.includes('keep_publication_import_open')) throw Object.assign(new Error('Import window closed.'), { code: 'P4090' });
        return db.query(text, params);
      } };
    } }, delegations: { publication: () => { throw new Error('nothing is signed'); } }, storageUrl, fetchImpl: () => { throw new Error('nothing is sent'); }, directStorage: true });
    const error = await send(s).catch(cause => cause);
    expect(error.status).toBe(409); expect(error.message).toMatch(/open too long/);
    expect(calls).not.toContain('verify_publication_asset');
  });
  it('a read address is never skipped: stored is only an answer to sign', async () => {
    const s = service({ check: () => Response.json({ stored: true }), storage: memoryStorage() });
    await expect(send(s)).rejects.toMatchObject({ status: 503 });
    expect(calls).not.toContain('verify_publication_asset');
  });
  it('each part keeps the import open while a file arrives in parts', async () => {
    const s = service({ storage: memoryStorage() });
    const half = Math.ceil(articleBytes.length / 2), total = articleBytes.length;
    const first = await s.publications.uploadPart(session, id, 'primary', { offset: 0, total, length: half }, Readable.from([Buffer.from(articleBytes.subarray(0, half))]), 'text/markdown');
    expect(first).toEqual({ received: half });
    expect(calls.filter(name => name === 'keep_publication_import_open')).toHaveLength(1);
    const last = await s.publications.uploadPart(session, id, 'primary', { offset: half, total, length: total - half }, Readable.from([Buffer.from(articleBytes.subarray(half))]), 'text/markdown');
    expect(last.result.uploadedParts).toEqual(['primary']);
    // The last part, then the transfer itself.
    expect(calls.filter(name => name === 'keep_publication_import_open')).toHaveLength(3);
  });
  it('without the feature, streams the file through the publication-media function as before', async () => {
    let streamedBytes;
    const s = service({ directStorage: false, storage: () => { throw new Error('Storage is not called directly'); }, streamed: async (body, contentType) => {
      expect(contentType).toBe('text/markdown');
      streamedBytes = new Uint8Array(await new Response(body).arrayBuffer());
      return Response.json({ uploaded: true, sha256, byteLength: articleBytes.length });
    } });
    expect((await send(s)).uploadedParts).toEqual(['primary']);
    expect(streamedBytes).toEqual(articleBytes);
    expect(s.operations).toEqual(['upload']);
    expect(calls).not.toContain('keep_publication_import_open');
  });
});
