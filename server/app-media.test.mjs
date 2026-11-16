import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createAppMediaHandler } from '../supabase/functions/app-media/handler.ts';

// The app-media Edge Function (lesson media in the private hub-learning bucket), with the Hub's capability gate and Storage stubbed.
const storageOrigin = 'https://xgauehtwksmnoqhgqegm.supabase.co';
const capabilityToken = 'Bearer cmh_' + 'a'.repeat(43);
const path = `learning/${randomUUID()}/video.mp4`;
const request = (headers = {}, body = '{}') => new Request('https://native.test/functions/v1/app-media', { method: 'POST', headers: { Authorization: capabilityToken, 'Content-Type': 'application/json', ...headers }, body });
function handler(operation, storage) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      expect(url).toBe('https://support-hub-web-production.up.railway.app/api/internal/media/authorize');
      expect(options.headers.Authorization).toBe(capabilityToken); expect(options.redirect).toBe('manual');
      return Response.json({ path, operation });
    }
    return storage(url, options);
  });
  return { calls, fetchImpl, handle: createAppMediaHandler({ storageOrigin, serviceKey: 'synthetic-only', fetchImpl }) };
}
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ4In0.c2lnbmVk';

describe('app-media upload-sign', () => {
  it('returns only a one-time upload token for the exact authorized object, never overwriting it', async () => {
    const h = handler('upload-sign', async (url, options) => {
      expect(url).toBe(`${storageOrigin}/storage/v1/object/upload/sign/hub-learning/${path}`);
      expect(options.method).toBe('POST'); expect(options.headers.Authorization).toBe('Bearer synthetic-only');
      expect(options.headers['x-upsert']).toBeUndefined(); expect(options.redirect).toBe('manual');
      // Storage answers {url, token}: only the address's token, for this object, is passed on.
      return Response.json({ url: `/object/upload/sign/hub-learning/${path}?token=${token}`, token });
    });
    const response = await h.handle(request());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ token }); expect(h.calls).toHaveLength(2);
  });
  it.each([409, 'legacy', 'code'])('answers stored when Storage already holds the object (%s)', async duplicate => {
    const h = handler('upload-sign', async () => duplicate === 409 ? new Response('{}', { status: 409 })
      : Response.json(duplicate === 'legacy' ? { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' } : { code: 'KeyAlreadyExists' }, { status: 400 }));
    const response = await h.handle(request());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ stored: true });
  });
  it.each([
    ['another object', { url: `/object/upload/sign/hub-learning/learning/${randomUUID()}/video.mp4?token=${token}` }],
    ['another bucket', { url: `/object/upload/sign/hub-publications/${path}?token=${token}` }],
    ['an absolute address', { url: `https://attacker.invalid/object/upload/sign/hub-learning/${path}?token=${token}` }],
    ['an unsafe token', { url: `/object/upload/sign/hub-learning/${path}?token=<script>alert(1)</script>` }],
    ['no address', { token }],
  ])('refuses a signing answer for %s', async (_name, answer) => {
    const h = handler('upload-sign', async () => Response.json(answer));
    expect((await h.handle(request())).status).toBe(503);
  });
  it.each([400, 401, 403, 413, 500])('never reads a %s refusal as a stored object', async status => {
    const h = handler('upload-sign', async () => Response.json({ code: 'AccessDenied' }, { status }));
    const response = await h.handle(request());
    expect(response.status).toBe(503); expect(await response.json()).not.toHaveProperty('stored');
  });
});

describe('app-media existing operations', () => {
  it('rejects browser or forged requests before the Hub is asked', async () => {
    for (const headers of [{ Origin: 'https://hub.test' }, { Authorization: 'Bearer forged' }]) {
      const fetchImpl = vi.fn();
      expect((await createAppMediaHandler({ storageOrigin, serviceKey: 'x', fetchImpl })(request(headers))).status).toBeGreaterThanOrEqual(400);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
  it.each([{ path: 'learning/../other', operation: 'upload' }, { path, operation: 'delete' }, { path, operation: 'upload-signed' }, null])(
    'refuses a capability it does not know (%o)', async capability => {
      const fetchImpl = vi.fn(async () => Response.json(capability));
      expect((await createAppMediaHandler({ storageOrigin, serviceKey: 'x', fetchImpl })(request())).status).toBe(403);
      expect(fetchImpl).toHaveBeenCalledOnce();
    });
  it('signs a ten-minute read address for the exact object', async () => {
    const h = handler('sign', async (url, options) => {
      expect(url).toBe(`${storageOrigin}/storage/v1/object/sign/hub-learning/${path}`); expect(JSON.parse(options.body)).toEqual({ expiresIn: 600 });
      return Response.json({ signedURL: `/object/sign/hub-learning/${path}?token=${token}` });
    });
    expect(await (await h.handle(request())).json()).toEqual({ signedUrl: `${storageOrigin}/storage/v1/object/sign/hub-learning/${path}?token=${token}` });
  });
  it('streams an upload to the fixed object without overwriting, within the type and size limit', async () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const h = handler('upload', async (url, options) => {
      expect(url).toBe(`${storageOrigin}/storage/v1/object/hub-learning/${path}`);
      expect(options.headers['x-upsert']).toBe('false'); expect(options.headers['Content-Type']).toBe('video/mp4');
      expect(new Uint8Array(await new Response(options.body).arrayBuffer())).toEqual(bytes);
      return Response.json({ Key: path });
    });
    const response = await h.handle(request({ 'Content-Type': 'video/mp4' }, bytes));
    expect(await response.json()).toEqual({ uploaded: true });
    const wrongType = handler('upload', async () => { throw new Error('Storage is not called'); });
    expect((await wrongType.handle(request({ 'Content-Type': 'text/html' }, bytes))).status).toBe(415);
  });
  it('downloads the object with its fixed media type', async () => {
    const h = handler('download', async (url, options) => {
      expect(url).toBe(`${storageOrigin}/storage/v1/object/authenticated/hub-learning/${path}`); expect(options.redirect).toBe('manual');
      return new Response('video bytes', { headers: { 'Content-Type': 'application/octet-stream' } });
    });
    const response = await h.handle(request());
    expect(response.headers.get('Content-Type')).toBe('video/mp4'); expect(await response.text()).toBe('video bytes');
  });
});
