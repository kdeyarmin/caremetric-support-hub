import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_CATALOG_CONTRACT, deterministicKey, factSheetDrift, parseAppCatalog, planCatalogSync } from './app-catalog-sync.mjs';
import { platformBilling } from './billing.mjs';
import { followFoundersReplacements, foundersAmounts, foundersPrice } from './founders-sale.mjs';
import { products as facts } from './agents/content/facts.mjs';
import { STRIPE_ACCOUNT_ID } from './stripe.mjs';
import { billingCommandSchema } from '../src/billing/billingProtocol.ts';

// Intel's three plans as Stripe holds them today (server/founders-catalog.mjs).
const STRIPE_PLANS = {
  starter: { product: 'prod_VSriGb3ARXxJlP', month: ['price_1URvzhB06O2UFlNznOktoU9H', 34900], year: ['price_1URvzhB06O2UFlNz2uH6oVny', 348000] },
  growth: { product: 'prod_VSrjq4fOEjD0Rf', month: ['price_1URvziB06O2UFlNzzVpLGAIv', 89900], year: ['price_1URvziB06O2UFlNzfHPKmesB', 898800] },
  pro: { product: 'prod_VSrjbU8azeV2EF', month: ['price_1URvzjB06O2UFlNzCb3lgr86', 199900], year: ['price_1URvzkB06O2UFlNzMj7j750M', 1998000] },
};

/** Intel's published catalog (GET /api/billing/catalog), with plan amounts overridable. */
function intelCatalog(amounts = {}) {
  const price = (key, interval) => amounts[`${key}.${interval}`] ?? STRIPE_PLANS[key][interval][1];
  return {
    contract: APP_CATALOG_CONTRACT, app: 'caremetric-intel', version: 'c1d077452fe4327d', currency: 'usd', trial_days: 14,
    products: [
      ...Object.keys(STRIPE_PLANS).map(key => ({ entitlement_key: key, kind: 'plan', name: key, description: '', self_serve: true, founders_eligible: true,
        prices: [{ interval: 'month', unit_amount: price(key, 'month') }, { interval: 'year', unit_amount: price(key, 'year') }] })),
      { entitlement_key: 'enterprise', kind: 'plan', name: 'Enterprise', description: '', self_serve: false, founders_eligible: false, prices: [] },
      { entitlement_key: 'extra_seat', kind: 'addon', name: 'Extra seat', description: '', self_serve: true, founders_eligible: false,
        prices: [{ interval: 'month', unit_amount: 5900, plan: 'starter' }, { interval: 'month', unit_amount: 4900, plan: 'growth' }] },
      { entitlement_key: 'onboarding', kind: 'fee', name: 'Onboarding', description: '', self_serve: true, founders_eligible: false,
        prices: [{ interval: 'once', unit_amount: 50000, plan: 'growth', waived_with_annual: true }] },
    ],
  };
}

function stripeObjects() {
  const products = Object.entries(STRIPE_PLANS).map(([key, plan]) => ({ id: plan.product, object: 'product', active: true, livemode: false, name: key,
    metadata: { app: 'caremetric-intel', kind: 'plan', entitlement: key } }));
  const prices = Object.values(STRIPE_PLANS).flatMap(plan => ['month', 'year'].map(interval => ({
    id: plan[interval][0], object: 'price', active: true, product: plan.product, currency: 'usd', unit_amount: plan[interval][1], type: 'recurring',
    recurring: { interval, interval_count: 1 }, metadata: { app: 'caremetric-intel', pricing_model: 'flat' }, livemode: false,
  })));
  return { products, prices };
}

afterEach(() => { followFoundersReplacements([]); });

describe('reading an application catalog', () => {
  it('accepts what Intel publishes and refuses anything else', () => {
    const catalog = parseAppCatalog(intelCatalog(), 'caremetric-intel');
    expect(catalog).toMatchObject({ app: 'caremetric-intel', version: 'c1d077452fe4327d', trial_days: 14 });
    expect(catalog.products.map(product => product.entitlement_key)).toEqual(['starter', 'growth', 'pro', 'enterprise', 'extra_seat', 'onboarding']);
    expect(() => parseAppCatalog({ ...intelCatalog(), contract: 'other.v9' }, 'caremetric-intel')).toThrow(/contract/);
    expect(() => parseAppCatalog(intelCatalog(), 'carebase')).toThrow(/not carebase/);
    expect(() => parseAppCatalog(intelCatalog({ 'starter.month': -1 }), 'caremetric-intel')).toThrow(/positive amount/);
    expect(() => parseAppCatalog(intelCatalog({ 'starter.month': 34900.5 }), 'caremetric-intel')).toThrow(/positive amount/);
    expect(() => parseAppCatalog({ ...intelCatalog(), version: '' }, 'caremetric-intel')).toThrow(/version/);
  });

  it('derives the same request key for the same change, valid for the billing commands', () => {
    const key = deterministicKey('caremetric-intel', 'price.change', 'price_1', 'month', '39900');
    expect(deterministicKey('caremetric-intel', 'price.change', 'price_1', 'month', '39900')).toBe(key);
    expect(deterministicKey('caremetric-intel', 'price.change', 'price_1', 'month', '39901')).not.toBe(key);
    expect(billingCommandSchema.parse({ action: 'price.change', price: 'price_1', unit_amount: 39900, migrate: 'grandfather', expected_version: 1, request_key: key }).request_key).toBe(key);
  });
});

describe('planning the Stripe changes', () => {
  const plan = (amounts, mutate = objects => objects) => {
    const { products, prices } = mutate(stripeObjects());
    return planCatalogSync(parseAppCatalog(intelCatalog(amounts), 'caremetric-intel'), products, prices);
  };

  it('changes nothing when Stripe already matches, and leaves add-ons and fees to the application', () => {
    const result = plan();
    expect(result).toMatchObject({ creates: [], changes: [], held: [], missing: [], unchanged: 6 });
    expect(result.skipped.map(item => item.entitlement_key)).toEqual(['extra_seat', 'onboarding']);
  });

  it('replaces a changed price, grandfathering, and creates a price an interval lacks', () => {
    const result = plan({ 'growth.year': 958800 }, objects => ({ ...objects, prices: objects.prices.filter(price => price.id !== STRIPE_PLANS.pro.year[0]) }));
    expect(result.changes).toEqual([{ entitlement_key: 'growth', product: STRIPE_PLANS.growth.product, interval: 'year', unit_amount: 958800,
      price: STRIPE_PLANS.growth.year[0], from: 898800 }]);
    expect(result.creates).toEqual([{ entitlement_key: 'pro', product: STRIPE_PLANS.pro.product, interval: 'year', unit_amount: 1998000 }]);
  });

  it('holds a change outside the automatic range and an ambiguous product for an administrator', () => {
    expect(plan({ 'starter.month': 3490 }).held).toMatchObject([{ entitlement_key: 'starter', interval: 'month', from: 34900, unit_amount: 3490 }]);
    expect(plan({ 'starter.month': 349000 }).held).toHaveLength(1);
    const twice = plan({}, objects => ({ ...objects, products: [...objects.products, { ...objects.products[0], id: 'prod_copy' }] }));
    expect(twice.held).toMatchObject([{ entitlement_key: 'starter', reason: '2 active Stripe products carry this entitlement key' }]);
    expect(twice.changes).toEqual([]);
  });

  it('ignores customers\' contract prices and archived prices, and reports a plan Stripe does not sell', () => {
    const result = plan({ 'starter.month': 39900 }, objects => ({
      products: objects.products.filter(product => product.id !== STRIPE_PLANS.pro.product),
      prices: [...objects.prices, { ...objects.prices[0], id: 'price_contract', unit_amount: 25000, metadata: { app: 'caremetric-intel', hub_tenant_id: '11111111-1111-4111-8111-111111111111' } },
        { ...objects.prices[0], id: 'price_old', active: false, unit_amount: 29900 }],
    }));
    expect(result.changes).toMatchObject([{ entitlement_key: 'starter', interval: 'month', price: STRIPE_PLANS.starter.month[0], unit_amount: 39900 }]);
    expect(result.missing).toEqual([{ entitlement_key: 'pro', reason: 'no active Stripe product carries this entitlement key' }]);
  });
});

describe('the Founders Sale after a price change', () => {
  const replacement = (id, replaces, amount, extra = {}) => ({ id, object: 'price', active: true, product: STRIPE_PLANS.starter.product, currency: 'usd',
    unit_amount: amount, type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, metadata: { app: 'caremetric-intel', hub_replaces: replaces }, ...extra });

  it('keeps the offer on a price that replaces a verified Intel price, at its own amount', () => {
    const old = { ...replacement(STRIPE_PLANS.starter.month[0], undefined, 34900), active: false, metadata: { app: 'caremetric-intel' } };
    expect(foundersPrice('price_new')).toBeUndefined();
    expect(followFoundersReplacements([old, replacement('price_new', STRIPE_PLANS.starter.month[0], 39900)])).toBe(1);
    expect(foundersPrice('price_new')).toEqual({ app: 'caremetric-intel', product: STRIPE_PLANS.starter.product, kind: 'plan', amount: 39900 });
    expect(foundersAmounts([{ price: 'price_new', quantity: 1 }])).toMatchObject({ standard_recurring_subtotal: 39900, recurring_subtotal: 19950 });
    // Grandfathered subscribers keep the verified price and its offer.
    expect(foundersPrice(STRIPE_PLANS.starter.month[0])).toMatchObject({ amount: 34900 });
  });

  it('follows a chain of changes, and nothing outside it', () => {
    followFoundersReplacements([
      replacement('price_second', STRIPE_PLANS.starter.month[0], 37900, { active: false }),
      replacement('price_third', 'price_second', 39900),
      replacement('price_contract', STRIPE_PLANS.starter.month[0], 20000, { metadata: { app: 'caremetric-intel', hub_replaces: STRIPE_PLANS.starter.month[0], hub_tenant_id: '11111111-1111-4111-8111-111111111111' } }),
      replacement('price_moved', STRIPE_PLANS.starter.month[0], 39900, { product: 'prod_other' }),
      replacement('price_unrelated', 'price_nowhere', 39900),
    ]);
    expect(foundersPrice('price_third')).toMatchObject({ app: 'caremetric-intel', amount: 39900 });
    expect(foundersPrice('price_second')).toMatchObject({ amount: 37900 });
    for (const id of ['price_contract', 'price_moved', 'price_unrelated']) expect(foundersPrice(id), id).toBeUndefined();
    // Each refresh replaces what was followed before.
    followFoundersReplacements([]);
    expect(foundersPrice('price_third')).toBeUndefined();
  });

  it('leaves other applications\' price changes to their verified list', () => {
    followFoundersReplacements([{ id: 'price_carebase_new', object: 'price', active: true, product: 'prod_penntrain_train_single_facility_flat_20261029', unit_amount: 12900,
      currency: 'usd', type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, metadata: { app: 'carebase', hub_replaces: 'price_1UVz4gB06O2UFlNzKeveaEqY' } }]);
    expect(foundersPrice('price_carebase_new')).toBeUndefined();
  });
});

describe('the AI fact sheet', () => {
  it('states every Intel plan price today, and names a price it does not', () => {
    expect(factSheetDrift(parseAppCatalog(intelCatalog(), 'caremetric-intel'), facts.intel.pricing)).toEqual([]);
    expect(factSheetDrift(parseAppCatalog(intelCatalog({ 'starter.month': 39900 }), 'caremetric-intel'), facts.intel.pricing))
      .toEqual([{ entitlement_key: 'starter', interval: 'month', amount: '$399' }]);
  });
});

describe('syncing Stripe from Intel\'s catalog', () => {
  function harness(stripe = stripeObjects()) {
    const posts = [];
    const audits = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const { pathname, searchParams } = new URL(url);
      const json = body => ({ ok: true, status: 200, json: async () => structuredClone(body) });
      if (pathname === '/v1/account') return json({ id: STRIPE_ACCOUNT_ID });
      if (init.method === 'GET' && pathname === '/v1/products') return json({ object: 'list', data: stripe.products, has_more: false });
      if (init.method === 'GET' && pathname === '/v1/prices') return json({ object: 'list', data: stripe.prices.filter(price => price.product === searchParams.get('product')), has_more: false });
      if (init.method === 'GET' && pathname.startsWith('/v1/prices/')) return json(stripe.prices.find(price => price.id === pathname.split('/').pop()));
      if (init.method === 'GET' && pathname.startsWith('/v1/products/')) return json(stripe.products.find(product => product.id === pathname.split('/').pop()));
      if (init.method === 'POST' && pathname === '/v1/prices') {
        const form = new URLSearchParams(init.body);
        posts.push({ path: pathname, key: init.headers['Idempotency-Key'], form });
        const created = { id: `price_new_${posts.length}`, object: 'price', active: true, product: form.get('product'), currency: form.get('currency'),
          unit_amount: Number(form.get('unit_amount')), type: 'recurring', recurring: { interval: form.get('recurring[interval]'), interval_count: 1 },
          metadata: { app: 'caremetric-intel', ...(form.get('metadata[hub_replaces]') ? { hub_replaces: form.get('metadata[hub_replaces]') } : {}) }, livemode: false };
        stripe.prices.push(created);
        return json(created);
      }
      if (init.method === 'POST' && pathname.startsWith('/v1/prices/')) {
        const form = new URLSearchParams(init.body);
        posts.push({ path: pathname, key: init.headers['Idempotency-Key'], form });
        const price = stripe.prices.find(item => item.id === pathname.split('/').pop());
        price.active = form.get('active') === 'true';
        return json(price);
      }
      throw new Error(`Unexpected Stripe request ${init.method} ${pathname}`);
    });
    const query = vi.fn(async (sql, params = []) => {
      if (['begin', 'commit', 'rollback', "set local statement_timeout='12s'"].includes(sql)) return { rows: [] };
      if (sql.includes('billing_set_account') || sql.includes('billing_lock')) return { rows: [] };
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ ok: true }] };
      if (sql.includes('billing_sync')) return { rows: [{ outcome: 'applied' }] };
      if (sql.includes('billing_audit')) { audits.push({ action: params[1], metadata: JSON.parse(params[4]) }); return { rows: [] }; }
      if (sql.includes('billing_lookup')) {
        const [kind, id] = params;
        if (kind === 'app') return { rows: [{ v: { id: '00000000-0000-4000-8000-000000000006', slug: id } }] };
        if (kind === 'product') return { rows: [{ v: { id, active: true, app: 'caremetric-intel' } }] };
        if (kind === 'price') {
          const price = stripe.prices.find(item => item.id === id);
          return { rows: [{ v: price && { id, product: price.product, active: price.active, product_active: true, unit_amount: price.unit_amount, app: 'caremetric-intel', tenant_id: null, version: 4 } }] };
        }
      }
      throw new Error(`Unexpected query ${sql}`);
    });
    const pool = { connect: async () => ({ query, release: () => {} }) };
    const log = { warn: vi.fn(), info: vi.fn() };
    const billing = platformBilling({ pool, secretKey: 'sk_test_synthetic', publicOrigin: 'https://hub.test', fetchImpl, log });
    const sync = amounts => billing.syncAppCatalog('caremetric-intel', { fetchCatalog: async () => ({ ok: true, json: async () => intelCatalog(amounts) }) });
    return { billing, sync, posts, audits, log, stripe };
  }

  it('replaces a changed plan price in Stripe, keeps subscribers on the old one, and keeps the Founders Sale', async () => {
    const t = harness();
    const result = await t.sync({ 'starter.month': 39900 });
    expect(result).toMatchObject({ ok: true, applied: 1, failed: 0, unchanged: 5, held: [], missing: [] });
    const [created, archived] = t.posts;
    expect(created.path).toBe('/v1/prices');
    expect(Object.fromEntries(['product', 'unit_amount', 'recurring[interval]', 'metadata[hub_replaces]'].map(key => [key, created.form.get(key)]))).toEqual({
      product: STRIPE_PLANS.starter.product, unit_amount: '39900', 'recurring[interval]': 'month', 'metadata[hub_replaces]': STRIPE_PLANS.starter.month[0] });
    expect(archived).toMatchObject({ path: `/v1/prices/${STRIPE_PLANS.starter.month[0]}` });
    expect(archived.form.get('active')).toBe('false');
    // Grandfathered: no subscription was touched.
    expect(t.posts.some(post => post.path.startsWith('/v1/subscriptions'))).toBe(false);
    expect(t.audits.map(entry => entry.action)).toEqual(['billing.price.change', 'billing.catalog.sync', 'billing.catalog.facts_stale']);
    expect(t.audits[1].metadata).toMatchObject({ source: 'app_catalog', entitlement: 'starter', interval: 'month', price_from: STRIPE_PLANS.starter.month[0], unit_amount_to: 39900 });
    expect(foundersPrice('price_new_1')).toMatchObject({ app: 'caremetric-intel', kind: 'plan', amount: 39900 });
    expect(result.facts_stale).toEqual([{ entitlement_key: 'starter', interval: 'month', amount: '$399' }]);
  });

  it('does nothing more on the next run, and reuses its Stripe request keys if a run is retried', async () => {
    const t = harness();
    await t.sync({ 'starter.month': 39900 });
    const firstKey = t.posts[0].key;
    expect(await t.sync({ 'starter.month': 39900 })).toMatchObject({ applied: 0, unchanged: 6 });
    expect(t.posts).toHaveLength(2);
    const retry = harness();
    await retry.sync({ 'starter.month': 39900 });
    expect(retry.posts[0].key).toBe(firstKey);
  });

  it('holds a change outside the automatic range and changes nothing in Stripe', async () => {
    const t = harness();
    const result = await t.sync({ 'starter.month': 3490 });
    expect(result).toMatchObject({ applied: 0, held: [{ entitlement_key: 'starter', interval: 'month' }] });
    expect(t.posts).toEqual([]);
    expect(t.audits.map(entry => entry.action)).toContain('billing.catalog.held');
    expect(t.log.warn).toHaveBeenCalledWith(expect.stringMatching(/held for an administrator/));
  });

  it('leaves Stripe alone when the catalog cannot be read', async () => {
    const t = harness();
    const result = await t.billing.syncAppCatalog('caremetric-intel', { fetchCatalog: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    expect(result).toEqual({ ok: false, app: 'caremetric-intel', reason: 'catalog_unreadable' });
    expect(t.posts).toEqual([]);
  });
});
