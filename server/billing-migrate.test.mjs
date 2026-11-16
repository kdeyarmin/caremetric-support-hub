import { describe, expect, it, vi } from 'vitest';
import { platformBilling } from './billing.mjs';
import { STRIPE_ACCOUNT_ID } from './stripe.mjs';

/**
 * "Move everyone" on a price change: every live subscription item on the old price goes to the new one. Stripe lists a subscription
 * with only its first ten items, and a list of subscriptions in pages; the Hub reads the rest of both before it reports the move done.
 */
const item = (id, price) => ({ id, object: 'subscription_item', price: { id: price }, quantity: 1 });
const addons = count => Array.from({ length: count }, (_, index) => item(`si_addon_${index}`, `price_addon_${index}`));

function harness({ subscriptions, pages = 1 }) {
  const moved = [];
  const audits = [];
  let listed = 0;
  const fetchImpl = vi.fn(async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const json = body => ({ ok: true, status: 200, json: async () => structuredClone(body) });
    if (pathname === '/v1/account') return json({ id: STRIPE_ACCOUNT_ID });
    if (init.method === 'GET' && pathname === '/v1/prices/price_old') {
      return json({ id: 'price_old', object: 'price', active: true, type: 'recurring', currency: 'usd', unit_amount: 1000, product: 'prod_plan', recurring: { interval: 'month', interval_count: 1 }, metadata: {} });
    }
    if (init.method === 'POST' && pathname === '/v1/prices') {
      return json({ id: 'price_new', object: 'price', active: true, type: 'recurring', currency: 'usd', unit_amount: 1200, product: 'prod_plan', recurring: { interval: 'month', interval_count: 1 }, metadata: {}, livemode: false });
    }
    if (init.method === 'POST' && pathname === '/v1/prices/price_old') {
      return json({ id: 'price_old', object: 'price', active: false, type: 'recurring', currency: 'usd', unit_amount: 1000, product: 'prod_plan', recurring: { interval: 'month', interval_count: 1 }, metadata: {}, livemode: false });
    }
    if (init.method === 'GET' && pathname === '/v1/subscriptions') {
      // Each page is the whole list again; `pages` pages say there is more, then the list ends.
      listed += 1;
      return json({ object: 'list', data: subscriptions.map(subscription => ({ ...subscription, id: `${subscription.id}_${listed}` })), has_more: listed < pages });
    }
    if (init.method === 'GET' && pathname === '/v1/subscription_items') {
      const subscription = subscriptions.find(entry => searchParams.get('subscription').startsWith(entry.id));
      return json({ object: 'list', data: subscription.allItems, has_more: false });
    }
    if (init.method === 'POST' && pathname.startsWith('/v1/subscription_items/')) {
      moved.push(pathname.split('/').pop());
      return json({ id: pathname.split('/').pop(), object: 'subscription_item' });
    }
    if (init.method === 'GET' && pathname.startsWith('/v1/subscriptions/')) {
      return json({ id: pathname.split('/').pop(), object: 'subscription', status: 'active', items: { object: 'list', data: [], has_more: false }, metadata: {} });
    }
    return { ok: false, status: 404, json: async () => ({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'Not in this test.' } }) };
  });
  const query = vi.fn(async (sql, params = []) => {
    if (/sms_sessions/.test(sql)) return { rows: [{ id: 's', user_id: 'u', auth_method: 'sms' }] };
    if (/authorize_app_command/.test(sql)) return { rows: [{ actor: { user_id: '00000000-0000-4000-8000-000000000001' } }] };
    if (/billing_lookup/.test(sql)) {
      const [kind, id] = params;
      if (kind === 'price') return { rows: [{ v: { id, product: 'prod_plan', active: true, product_active: true, unit_amount: 1000, app: 'caremetric-intel', tenant_id: null, version: 4 } }] };
      if (kind === 'app') return { rows: [{ v: { id: '00000000-0000-4000-8000-000000000006', slug: id } }] };
      return { rows: [{ v: null }] };
    }
    if (/billing_audit/.test(sql)) { audits.push({ action: params[1], metadata: JSON.parse(params[4]) }); return { rows: [] }; }
    if (/billing_sync/.test(sql)) return { rows: [{ outcome: 'applied' }] };
    if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ ok: true }] };
    return { rows: [] };
  });
  const billing = platformBilling({ pool: { connect: async () => ({ query, release() {} }) }, secretKey: 'sk_test_synthetic', publicOrigin: 'https://hub.test', fetchImpl,
    log: { warn: vi.fn(), info: vi.fn() } });
  const change = () => billing.command('session', { action: 'price.change', price: 'price_old', unit_amount: 1200, migrate: 'prorate', expected_version: 4,
    request_key: '33333333-3333-4333-8333-333333333333' });
  return { change, moved, audits };
}

describe('moving every subscriber to a new price', () => {
  it('finds the old price past a subscription\'s first ten items', async () => {
    // A plan with eleven add-ons: Stripe embeds the first ten items, and the old price is the twelfth.
    const allItems = [...addons(11), item('si_plan', 'price_old')];
    const t = harness({ subscriptions: [{ id: 'sub_many', object: 'subscription', status: 'active', items: { object: 'list', data: allItems.slice(0, 10), has_more: true }, allItems }] });
    const result = await t.change();
    expect(t.moved).toEqual(['si_plan']);
    expect(result).toMatchObject({ ok: true, id: 'price_new', migrated: 1, failed: 0 });
    expect(result.incomplete).toBeUndefined();
  });

  it('says the move is incomplete when Stripe lists more subscriptions than one pass reads', async () => {
    const one = { id: 'sub', object: 'subscription', status: 'active', items: { object: 'list', data: [item('si_plan', 'price_old')], has_more: false } };
    const t = harness({ subscriptions: Array.from({ length: 100 }, (_, index) => ({ ...one, id: `sub${index}` })), pages: 50 });
    const result = await t.change();
    expect(result).toMatchObject({ ok: true, migrated: 1000, failed: 0, incomplete: true });
    expect(t.audits.find(entry => entry.action === 'billing.price.migrate').metadata).toMatchObject({ migrated: 1000, failed: 0 });
  });
});
