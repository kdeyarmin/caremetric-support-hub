import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { request } from 'node:http';
import { appServer } from './http.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
const creative = { admin: { video: vi.fn(), brandFile: vi.fn() } };
const mediaImport = { handle: vi.fn() };
const delegations = { package: vi.fn() };
let server, port;
beforeAll(async () => {
  server = appServer({ auth: {}, gateway: {}, delegations, creative, mediaImport, origins: [origin] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  port = server.address().port;
});
afterAll(() => new Promise(resolve => server.close(resolve)));

// Sends the headers, then reports how many body bytes the server took before it answered.
function upload(path, total) {
  return new Promise((resolve, reject) => {
    let sent = 0;
    const call = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { Origin: origin, 'Content-Type': 'video/mp4', 'Content-Length': total } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.status ?? response.statusCode, body, sent }));
    });
    call.on('error', error => (error.code === 'EPIPE' || error.code === 'ECONNRESET' ? resolve({ status: 0, sent }) : reject(error)));
    const chunk = Buffer.alloc(64 * 1024);
    const pump = () => { while (sent < total) { sent += chunk.length; if (!call.write(chunk)) { call.once('drain', pump); return; } } call.end(); };
    pump();
  });
}

describe('uploads without a signed-in session', () => {
  it('are refused before the body is read', async () => {
    for (const path of ['/api/admin/creative/video', '/api/admin/creative/brandFile', '/api/admin/learning-media-import', '/api/admin/packages']) {
      const result = await upload(path, 8 * 1024 * 1024);
      expect(result.status, path).toBe(401);
      expect(JSON.parse(result.body), path).toEqual({ error: 'Sign in to continue.' });
    }
    expect(creative.admin.video).not.toHaveBeenCalled();
    expect(creative.admin.brandFile).not.toHaveBeenCalled();
    expect(delegations.package).not.toHaveBeenCalled();
  });
});
