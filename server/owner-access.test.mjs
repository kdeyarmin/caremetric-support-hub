import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer, privateHubMessage } from './http.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
// Session tokens have the real 43-character shape the cookie parser accepts.
const ownerToken = 'o'.repeat(43), customerToken = 'c'.repeat(43);
const sessionCookie = token => ({ Cookie: `__Host-caremetric_session=${token}` });
const auth = {
  verify: vi.fn(async () => ownerToken),
  logout: vi.fn(async () => undefined),
};
const gateway = { session: vi.fn(async session => ({ authenticated: Boolean(session), session: session ?? null })) };
const selfService = { issue: vi.fn(), start: vi.fn(), verify: vi.fn() };
const delegations = { registration: { start: vi.fn(), verify: vi.fn() } };
const owner = { allows: vi.fn(async token => token === ownerToken) };
let server, base;
beforeAll(async () => {
  server = appServer({ auth, gateway, delegations, selfService, owner, origins: [origin] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => vi.clearAllMocks());
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });

describe('a Hub private to its owner', () => {
  it('passes the owner session through and treats any other session as signed out', async () => {
    expect(await (await fetch(`${base}/api/auth/session`, { headers: sessionCookie(ownerToken) })).json()).toEqual({ authenticated: true, session: ownerToken });
    expect(await (await fetch(`${base}/api/auth/session`, { headers: sessionCookie(customerToken) })).json()).toEqual({ authenticated: false, session: null });
    expect(owner.allows).toHaveBeenCalledWith(customerToken);
  });

  it('signs the owner in and revokes anyone else the moment their code is accepted', async () => {
    const signedIn = await post('/api/auth/sms/verify', { challengeId: 'c', code: '123456' });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get('set-cookie')).toContain(`__Host-caremetric_session=${ownerToken}`);
    expect(auth.logout).not.toHaveBeenCalled();

    auth.verify.mockResolvedValueOnce(customerToken);
    const refused = await post('/api/auth/sms/verify', { challengeId: 'c', code: '123456' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: privateHubMessage });
    expect(refused.headers.get('set-cookie') ?? '').not.toContain(customerToken);
    expect(auth.logout).toHaveBeenCalledWith(customerToken);
  });

  it('closes every route that creates a sign-in for someone else', async () => {
    for (const path of ['/api/auth/invitation/start', '/api/auth/invitation/verify', '/api/self-service/connect/start', '/api/self-service/connect/verify']) {
      const response = await post(path, {});
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({ error: privateHubMessage });
    }
    const handoff = await fetch(`${base}/api/apps/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer app-key' }, body: '{}' });
    expect(handoff.status).toBe(403);
    expect(delegations.registration.start).not.toHaveBeenCalled();
    expect(delegations.registration.verify).not.toHaveBeenCalled();
    expect(selfService.issue).not.toHaveBeenCalled();
    expect(selfService.start).not.toHaveBeenCalled();
    expect(selfService.verify).not.toHaveBeenCalled();
  });
});
