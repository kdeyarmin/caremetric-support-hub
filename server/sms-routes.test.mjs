import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer } from './http.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
const auth = { start: vi.fn(async () => ({ id: 'challenge', browserToken: 'b'.repeat(43) })) };
const registration = { start: vi.fn(async () => ({ id: 'challenge', browserToken: 'b'.repeat(43) })) };
let server, base;
beforeAll(async () => {
  server = appServer({ auth, delegations: { registration }, gateway: {}, origins: [origin] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
const post = (path, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify({ phone: '+12025550101' }) });

describe('SMS sign-in rate-limit bucket', () => {
  // Railway's edge proxy connects for every visitor, so its socket address would put everyone in one bucket and let a
  // handful of requests lock the owner out. The bucket is the visitor address the edge appends last.
  it('rate-limits code requests by the visitor address, not the proxy connection', async () => {
    expect((await post('/api/auth/sms/start', { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9' })).status).toBe(200);
    expect(auth.start).toHaveBeenLastCalledWith('+12025550101', '203.0.113.9');
    expect((await post('/api/auth/invitation/start', { 'X-Forwarded-For': '203.0.113.10' })).status).toBe(200);
    expect(registration.start).toHaveBeenLastCalledWith({ phone: '+12025550101' }, '203.0.113.10');
  });
});
