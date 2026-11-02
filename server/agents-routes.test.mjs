import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer } from './http.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
const agents = Object.fromEntries(['overview', 'status', 'autonomy', 'budget', 'decide', 'run', 'cancel'].map(name => [name, vi.fn(async () => ({ ok: name }))]));
const health = vi.fn(async () => undefined);
const sessionToken = 'a'.repeat(43);
let server, base;
beforeAll(async () => {
  server = appServer({ agents, health, origins: [origin], gateway: {}, delegations: {}, auth: {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
const post = (path, body = {}, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('AI team routes', () => {
  it('serves a public liveness check that reveals nothing and follows the database', async () => {
    const live = await fetch(base + '/api/health');
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ ok: true });
    expect(live.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(base + '/api/health', { method: 'HEAD' })).status).toBe(200);
    expect((await post('/api/health')).status).toBe(405);
    health.mockRejectedValueOnce(new Error('connection refused to db.internal:5432'));
    const down = await fetch(base + '/api/health');
    expect(down.status).toBe(503);
    expect(await down.text()).not.toMatch(/db\.internal|5432/);
  });

  it('runs an owner action with the session cookie and nothing else from the browser', async () => {
    const response = await post('/api/admin/team/status', { key: 'platform_engineer', status: 'active', expectedUpdatedAt: '2026-11-02T12:00:00.123456+00:00' }, { Cookie: `__Host-caremetric_session=${sessionToken}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: 'status' });
    expect(agents.status).toHaveBeenCalledWith(sessionToken, { key: 'platform_engineer', status: 'active', expectedUpdatedAt: '2026-11-02T12:00:00.123456+00:00' });
  });

  it('serves each allowlisted action and no other', async () => {
    for (const name of Object.keys(agents)) expect((await post(`/api/admin/team/${name}`)).status, name).toBe(200);
    for (const path of ['/api/admin/team/delete', '/api/admin/team/', '/api/admin/team/overview/extra', '/api/admin/team/__proto__']) expect((await post(path)).status, path).toBe(404);
    expect((await fetch(base + '/api/admin/team/overview')).status).toBe(404);
  });

  it('refuses a cross-site request, a query string, a non-JSON body and an oversized body', async () => {
    expect((await post('/api/admin/team/decide', {}, { Origin: 'https://attacker.test' })).status).toBe(403);
    expect((await fetch(base + '/api/admin/team/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await post('/api/admin/team/decide?all=1')).status).toBe(400);
    expect((await fetch(base + '/api/admin/team/decide', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: origin }, body: '{}' })).status).toBe(415);
    expect((await post('/api/admin/team/decide', 'not json')).status).toBe(400);
    expect((await post('/api/admin/team/decide', { note: 'x'.repeat(9000) })).status).toBe(413);
  });

  it('says so when the AI team is not configured', async () => {
    const bare = appServer({ origins: [origin], gateway: {}, delegations: {}, auth: {} });
    bare.listen(0, '127.0.0.1'); await once(bare, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${bare.address().port}/api/admin/team/overview`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
      expect(response.status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${bare.address().port}/api/health`)).status).toBe(200);
    } finally { await new Promise(resolve => bare.close(resolve)); }
  });
});
