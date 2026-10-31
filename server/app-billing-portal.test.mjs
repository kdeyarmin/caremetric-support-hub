import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer } from './http.mjs';

// Applications open their own customers' billing server to server; a browser never reaches this route.
const billing = { appPortal: vi.fn(async () => ({ url: 'https://billing.stripe.com/p/session/test_1' })) };
let server, base;
beforeAll(async () => {
  server = appServer({ auth: {}, gateway: {}, delegations: {}, billing, origins: ['https://help.caremetric.ai'] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => vi.clearAllMocks());
const body = { account: 'acct-1', return_url: 'https://app.test/billing' };
const post = headers => fetch(`${base}/api/apps/portal`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cmb_key', ...headers }, body: JSON.stringify(body) });

describe('application billing portal route', () => {
  it('passes the application key and request to billing and returns only the portal address', async () => {
    const response = await post({});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://billing.stripe.com/p/session/test_1' });
    expect(billing.appPortal).toHaveBeenCalledWith('Bearer cmb_key', body);
  });

  it('refuses browser requests before billing sees them', async () => {
    for (const headers of [{ Origin: 'https://help.caremetric.ai' }, { Cookie: '__Host-caremetric_session=x' }]) {
      expect((await post(headers)).status).toBe(403);
    }
    expect(billing.appPortal).not.toHaveBeenCalled();
  });
});
