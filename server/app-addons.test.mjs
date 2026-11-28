import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer } from './http.mjs';
import { platformBilling } from './billing.mjs';
import { deterministicKey } from './app-catalog-sync.mjs';
import { STRIPE_ACCOUNT_ID } from './stripe.mjs';

// Applications set their own customers' add-on quantities server to server (Intel: a marketer seat bought on invite, an
// AI pack added on its Billing page). A browser never reaches the route.
describe('application add-on route', () => {
  const billing = { appAddons: vi.fn(async () => ({ outcome: 'updated', addon: 'extra_seat', quantity: 2, previous: 1 })) };
  let server, base;
  beforeAll(async () => {
    server = appServer({ auth: {}, gateway: {}, delegations: {}, billing, origins: ['https://help.caremetric.ai'] });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  beforeEach(() => vi.clearAllMocks());
  const body = { account: 'acct-1', actor: { id: 'admin-1' }, addon: 'extra_seat', quantity: 2, request_key: '95000000-0000-4000-8000-000000000001' };
  const post = (headers = {}, { path = '/api/apps/addons', method = 'POST' } = {}) => fetch(`${base}${path}`, { method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cmb_key', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });

  it('passes the application key and the request to billing and returns its answer', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'updated', addon: 'extra_seat', quantity: 2, previous: 1 });
    expect(billing.appAddons).toHaveBeenCalledWith('Bearer cmb_key', body);
  });

  it('refuses browser requests, other methods and query strings before billing sees them', async () => {
    for (const headers of [{ Origin: 'https://help.caremetric.ai' }, { Cookie: '__Host-caremetric_session=x' }]) expect((await post(headers)).status).toBe(403);
    expect((await post({}, { method: 'GET' })).status).toBe(403);
    expect((await post({}, { path: '/api/apps/addons?account=other' })).status).toBe(403);
    expect(billing.appAddons).not.toHaveBeenCalled();
  });
});

describe('setting an application customer\'s add-on quantity', () => {
  const KEY = `cmb_${'a'.repeat(43)}`;
  const PRODUCT = '00000000-0000-4000-8000-000000000006';
  const TENANT = '00000000-0000-4000-8000-0000000000aa';
  const REQUEST = '95000000-0000-4000-8000-000000000001';
  const base = { app: 'caremetric-intel', active: true, currency: 'usd', interval_count: 1, features: [], allows_addons: true, description: '' };
  // Team's subscription: the plan, monthly; the seat is priced by plan (a product per plan), the AI pack is one product.
  const CATALOG = [
    { ...base, id: 'price_team_month', product: 'prod_team', name: 'CareMetric Intel Team', kind: 'plan', key: 'growth', amount: 19900, interval: 'month', model: 'flat', unit_label: '' },
    { ...base, id: 'price_seat_local_month', product: 'prod_seat_local', name: 'Additional marketer (Local)', kind: 'addon', key: 'extra_seat', amount: 2900, interval: 'month', model: 'per_unit', unit_label: 'seat' },
    { ...base, id: 'price_seat_team_month', product: 'prod_seat_team', name: 'Additional marketer (Team)', kind: 'addon', key: 'extra_seat', amount: 3900, interval: 'month', model: 'per_unit', unit_label: 'seat' },
    { ...base, id: 'price_seat_team_year', product: 'prod_seat_team', name: 'Additional marketer (Team)', kind: 'addon', key: 'extra_seat', amount: 39000, interval: 'year', model: 'per_unit', unit_label: 'seat' },
    { ...base, id: 'price_aiplus_month', product: 'prod_aiplus', name: 'AI Plus', kind: 'addon', key: 'ai_plus', amount: 2900, interval: 'month', model: 'per_unit', unit_label: 'aiplus' },
  ].map(({ app: _app, ...price }) => price);
  const FOR_PLAN = { prod_seat_local: 'starter', prod_seat_team: 'growth', prod_aiplus: '' };

  function harness({ items = [], status = 'active', schedule = null, decline = false } = {}) {
    const posts = [], deletes = [], audits = [];
    const stripe = { subscription: { id: 'sub_1', object: 'subscription', customer: 'cus_1', status, schedule, metadata: { app: 'caremetric-intel' }, livemode: false,
      items: { object: 'list', has_more: false, data: [{ id: 'si_plan', quantity: 1, price: { id: 'price_team_month', product: 'prod_team', unit_amount: 19900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }, ...items] } } };
    const fetchImpl = vi.fn(async (url, init) => {
      const { pathname } = new URL(url);
      const json = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
      if (pathname === '/v1/account') return json({ id: STRIPE_ACCOUNT_ID });
      if (init.method === 'GET' && pathname === '/v1/subscriptions/sub_1') return json(stripe.subscription);
      if (init.method === 'GET' && pathname.startsWith('/v1/products/')) {
        const id = pathname.split('/').pop();
        return json({ id, object: 'product', active: true, metadata: { app: 'caremetric-intel', kind: 'addon', ...(FOR_PLAN[id] ? { hub_for_plan: FOR_PLAN[id] } : {}) } });
      }
      if (init.method === 'POST' && pathname.startsWith('/v1/subscription_items')) {
        const form = new URLSearchParams(init.body);
        posts.push({ path: pathname, key: init.headers['Idempotency-Key'], form: Object.fromEntries(form) });
        if (decline) return { ok: false, status: 402, json: async () => ({ error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } }) };
        const itemId = pathname.split('/')[3];
        const list = stripe.subscription.items.data;
        if (itemId) list.find(item => item.id === itemId).quantity = Number(form.get('quantity'));
        else list.push({ id: 'si_new', quantity: Number(form.get('quantity')), price: { id: form.get('price'), product: CATALOG.find(price => price.id === form.get('price')).product, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } });
        return json({ id: itemId ?? 'si_new' });
      }
      if (init.method === 'DELETE' && pathname.startsWith('/v1/subscription_items/')) {
        const itemId = pathname.split('/').pop();
        deletes.push({ id: itemId, query: Object.fromEntries(new URL(url).searchParams) });
        stripe.subscription.items.data = stripe.subscription.items.data.filter(item => item.id !== itemId);
        return json({ id: itemId, deleted: true });
      }
      throw new Error(`Unexpected Stripe request ${init.method} ${pathname}`);
    });
    const query = vi.fn(async (sql, params = []) => {
      if (['begin', 'commit', 'rollback', "set local statement_timeout='12s'"].includes(sql)) return { rows: [] };
      if (sql.includes('billing_set_account')) return { rows: [] };
      if (sql.includes('billing_authenticate_app')) return { rows: [{ app: { slug: 'caremetric-intel', product_id: PRODUCT } }] };
      if (sql.includes('app_customer_billing_tenant')) return { rows: [{ t: TENANT }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql.includes('app_customer_billing_context')) {
        return { rows: [{ c: { connection_id: null, tenant_id: TENANT, app: 'caremetric-intel', role: 'organization_admin', mode: 'legacy', can_activate: false,
          configuration_version: 0, facilities: [], allocations: [], catalog: CATALOG, customer: 'cus_1', loaded_at: new Date(0).toISOString(),
          subscription: { id: 'sub_1', version: 3, status, current_period_end: null, interval: 'month', currency: 'usd',
            items: stripe.subscription.items.data.map(item => ({ id: item.id, price: item.price.id, quantity: item.quantity })) } } }] };
      }
      if (sql.includes('billing_sync')) return { rows: [{ outcome: 'applied' }] };
      if (sql.includes('billing_audit')) { audits.push({ action: params[1], tenant: params[2], metadata: JSON.parse(params[4]) }); return { rows: [] }; }
      throw new Error(`Unexpected query ${sql}`);
    });
    const pool = { connect: async () => ({ query, release: () => {} }) };
    const log = { warn: vi.fn(), info: vi.fn() };
    const billing = platformBilling({ pool, secretKey: 'sk_test_synthetic', publicOrigin: 'https://hub.test', fetchImpl, log });
    const set = (addon, quantity, request_key = REQUEST) => billing.appAddons(`Bearer ${KEY}`, { account: 'acct-1', actor: { id: 'admin-1' }, addon, quantity, request_key });
    return { set, posts, deletes, audits, stripe };
  }

  it('adds the seat priced for the subscription\'s own plan, charged now, and refused with nothing changed if the card fails', async () => {
    const t = harness();
    expect(await t.set('extra_seat', 1)).toEqual({ outcome: 'updated', addon: 'extra_seat', quantity: 1, previous: 0 });
    expect(t.posts).toEqual([{ path: '/v1/subscription_items',
      key: `hub-app-addon-${deterministicKey('caremetric-intel', 'acct-1', 'extra_seat', REQUEST, '1')}`,
      form: { subscription: 'sub_1', price: 'price_seat_team_month', quantity: '1', proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' } }]);
    expect(t.audits).toEqual([{ action: 'billing.addon.app', tenant: TENANT, metadata: { account: 'acct-1', actor: 'admin-1', addon: 'extra_seat', quantity: 1, app: 'caremetric-intel',
      previous: 0, subscription: 'sub_1', price: 'price_seat_team_month', outcome: 'added' } }]);
    const declined = harness({ decline: true });
    await expect(declined.set('extra_seat', 1)).rejects.toMatchObject({ status: 402, message: expect.stringContaining('declined, so nothing was added') });
    expect(declined.audits.at(-1).metadata).toMatchObject({ outcome: 'refused', status: 402 });
  });

  it('raises a seat already on the subscription at its own price, and lowers or removes it without a credit', async () => {
    // A founding member's older seat price stays: the item is changed, never replaced.
    const seat = { id: 'si_seat', quantity: 2, price: { id: 'price_seat_old', product: 'prod_seat_team', currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } };
    const t = harness({ items: [seat] });
    await t.set('extra_seat', 3);
    expect(t.posts.at(-1)).toMatchObject({ path: '/v1/subscription_items/si_seat', form: { quantity: '3', proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' } });
    expect(t.posts.at(-1).form.price).toBeUndefined();
    await t.set('extra_seat', 1, '95000000-0000-4000-8000-000000000002');
    expect(t.posts.at(-1)).toMatchObject({ path: '/v1/subscription_items/si_seat', form: { quantity: '1', proration_behavior: 'none' } });
    expect(t.posts.at(-1).form.payment_behavior).toBeUndefined();
    expect(await t.set('extra_seat', 0, '95000000-0000-4000-8000-000000000003')).toMatchObject({ outcome: 'updated', quantity: 0, previous: 1 });
    expect(t.deletes).toEqual([{ id: 'si_seat', query: { proration_behavior: 'none' } }]);
    expect(t.audits.map(entry => entry.metadata.outcome)).toEqual(['added', 'lowered', 'lowered']);
  });

  it('adds an AI pack sold to every plan, and says nothing changed when the quantity already holds', async () => {
    const t = harness();
    await t.set('ai_plus', 1);
    expect(t.posts.at(-1).form).toMatchObject({ price: 'price_aiplus_month', quantity: '1' });
    expect(await t.set('ai_plus', 1, '95000000-0000-4000-8000-000000000004')).toEqual({ outcome: 'unchanged', addon: 'ai_plus', quantity: 1, previous: 1 });
    expect(t.posts).toHaveLength(1);
    expect(t.audits.at(-1).metadata).toMatchObject({ addon: 'ai_plus', outcome: 'unchanged' });
  });

  it('leaves a subscription with a scheduled change, or not active, alone, and refuses an add-on the application doesn\'t sell', async () => {
    await expect(harness({ schedule: 'sub_sched_1' }).set('extra_seat', 1)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('scheduled change') });
    await expect(harness({ status: 'past_due' }).set('extra_seat', 1)).rejects.toMatchObject({ status: 409 });
    await expect(harness().set('extra_branch', 1)).rejects.toMatchObject({ status: 404 });
    const t = harness();
    await expect(t.set('Extra-Seat', 1)).rejects.toMatchObject({ status: 400 });
    expect(t.posts).toEqual([]);
  });

  it('adds a seat to a trialing subscription, which costs nothing until the trial ends', async () => {
    const t = harness({ status: 'trialing' });
    expect(await t.set('extra_seat', 2)).toMatchObject({ outcome: 'updated', quantity: 2 });
    expect(t.posts.at(-1).form).toMatchObject({ price: 'price_seat_team_month', quantity: '2', proration_behavior: 'always_invoice' });
  });
});
