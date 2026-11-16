import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer, privateHubMessage } from './http.mjs';
import { ownerAccess } from './sms-auth.mjs';

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

describe('the owner check during a database outage', () => {
  const busy = () => ({ connect: async () => { throw new Error('timeout exceeded when trying to connect'); } });
  // A pool answering one query: the session lookup (no rows means signed out), then the owner permission.
  const answering = (rows, permission) => ({ connect: async () => ({
    query: async text => {
      if (/^select s\.id/.test(text)) return { rows };
      if (text === 'select hub.authorize_app_admin()' && permission) throw permission;
      return { rows: [] };
    },
    release() {},
  }) });

  it('reports an outage instead of calling the owner signed out', async () => {
    await expect(ownerAccess(busy()).allows(ownerToken)).rejects.toThrow('timeout exceeded');
    expect(await ownerAccess(answering([])).allows(customerToken)).toBe(false);
    expect(await ownerAccess(answering([{ id: 's', user_id: 'u', auth_method: 'sms' }], Object.assign(new Error('Platform administrator required.'), { code: '42501' }))).allows(customerToken)).toBe(false);
    expect(await ownerAccess(answering([{ id: 's', user_id: 'u', auth_method: 'sms' }])).allows(ownerToken)).toBe(true);
  });

  it('answers an outage as unavailable, never as "this Hub is private", and still ends the session on sign-out', async () => {
    owner.allows.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
    const response = await fetch(`${base}/api/auth/session`, { headers: sessionCookie(ownerToken) });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'The service is temporarily unavailable.' });
    owner.allows.mockClear();
    owner.allows.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    const signedOut = await post('/api/auth/logout', {}, sessionCookie(ownerToken));
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.getSetCookie().some(value => value.startsWith('__Host-caremetric_session=;'))).toBe(true);
    expect(auth.logout).toHaveBeenLastCalledWith(ownerToken);
    expect(owner.allows).not.toHaveBeenCalled();
    owner.allows.mockImplementation(async token => token === ownerToken);
    // A session the owner check refuses is still the cookie's to end.
    expect((await post('/api/auth/logout', {}, sessionCookie(customerToken))).status).toBe(200);
    expect(auth.logout).toHaveBeenLastCalledWith(customerToken);
  });
});
