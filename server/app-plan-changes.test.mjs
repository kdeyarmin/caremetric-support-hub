import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer } from './http.mjs';

// Applications change their own customers' plans server to server; a browser never reaches this route.
const billing = { appPlanChanges: vi.fn(async () => ({ state: 'applied' })) };
let server, base;
beforeAll(async () => {
  server = appServer({ auth: {}, gateway: {}, delegations: {}, billing, origins: ['https://help.caremetric.ai'] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => vi.clearAllMocks());
const body = { account: 'acct-1', return_url: 'https://app.test/app/billing', actor: { id: 'admin-1' }, scope: { facilities: [], plan_size: null },
  request: { action: 'confirm', quote_id: '95000000-0000-4000-8000-000000000001', confirmed: true } };
const post = (headers = {}, { path = '/api/apps/billing', method = 'POST', payload = body } = {}) => fetch(`${base}${path}`, { method,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cmb_key', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}) });

describe('application plan change route', () => {
  it('passes the application key and the whole request to billing and returns its answer', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'applied' });
    expect(billing.appPlanChanges).toHaveBeenCalledWith('Bearer cmb_key', body);
  });

  it('accepts a full facility scope', async () => {
    const payload = { ...body, scope: { facilities: Array.from({ length: 1000 }, (_, index) => ({ id: 'f'.repeat(120) + index, name: 'Synthetic facility ' + index })), plan_size: null } };
    expect((await post({}, { payload })).status).toBe(200);
  });

  it('refuses browser requests, other methods and query strings before billing sees them', async () => {
    for (const headers of [{ Origin: 'https://help.caremetric.ai' }, { Cookie: '__Host-caremetric_session=x' }]) expect((await post(headers)).status).toBe(403);
    expect((await post({}, { method: 'GET' })).status).toBe(403);
    expect((await post({}, { path: '/api/apps/billing?account=other' })).status).toBe(403);
    expect(billing.appPlanChanges).not.toHaveBeenCalled();
  });
});
