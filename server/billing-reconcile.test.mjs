import { describe, expect, it, vi } from 'vitest';
import { platformBilling } from './billing.mjs';
import { STRIPE_ACCOUNT_ID } from './stripe.mjs';

describe('the full refresh from Stripe', () => {
  it('runs once, as soon as Stripe can be reached: at the start, or on a later sweep when Stripe was down at the start', async () => {
    let up = false;
    const listed = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const { pathname } = new URL(url);
      const json = body => ({ ok: true, status: 200, json: async () => structuredClone(body) });
      if (pathname === '/v1/account') return up ? json({ id: STRIPE_ACCOUNT_ID }) : { ok: false, status: 503, json: async () => ({ error: { type: 'api_error', message: 'Down.' } }) };
      if (init.method === 'GET') { listed.push(pathname); return json({ object: 'list', data: [], has_more: false }); }
      throw new Error(`Unexpected Stripe request ${init.method} ${pathname}`);
    });
    const query = vi.fn(async sql => (/reconcile|claim|usage|checkout/i.test(sql) ? { rows: [{ result: [], items: [] }] } : { rows: [] }));
    const billing = platformBilling({ pool: { connect: async () => ({ query, release() {} }) }, secretKey: 'sk_test_synthetic', publicOrigin: 'https://hub.test', fetchImpl,
      log: { warn: vi.fn(), info: vi.fn() } });

    // Stripe is down at the start: nothing is refreshed, and the next sweep tries again.
    expect(await billing.reconcileOnce()).toBeNull();
    expect(listed).toEqual([]);
    up = true;
    expect(await billing.reconcileOnce()).toMatchObject({ synced: 0 });
    expect(listed).toContain('/v1/products');
    // Once done, later sweeps leave it to the webhooks.
    const after = listed.length;
    await billing.reconcileOnce();
    expect(listed).toHaveLength(after);
  });
});
