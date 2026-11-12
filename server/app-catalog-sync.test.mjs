import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_CATALOG_CONTRACT, FOR_PLAN_KEY, deterministicKey, parseAppCatalog, planCatalogSync } from './app-catalog-sync.mjs';
import { platformBilling } from './billing.mjs';
import { FOUNDERS_FOLLOW_APPS, followFoundersReplacements, foundersAmounts, foundersFollowProducts, foundersPrice } from './founders-sale.mjs';
import { intelReviewedFacts, products as facts, resetAppCatalogFacts } from './agents/content/facts.mjs';
import { STRIPE_ACCOUNT_ID } from './stripe.mjs';
import { billingCommandSchema } from '../src/billing/billingProtocol.ts';

/** What Intel serves at GET /api/billing/catalog (its src/lib/planCatalog.ts), as reviewed for docs/GTM_FACTS.md. */
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/intel-catalog.json', import.meta.url), 'utf8'));

// Intel's three plans as Stripe holds them today (server/founders-catalog.mjs).
const STRIPE_PLANS = {
  starter: { product: 'prod_VSriGb3ARXxJlP', month: ['price_1URvzhB06O2UFlNznOktoU9H', 34900], year: ['price_1URvzhB06O2UFlNz2uH6oVny', 348000] },
  growth: { product: 'prod_VSrjq4fOEjD0Rf', month: ['price_1URvziB06O2UFlNzzVpLGAIv', 89900], year: ['price_1URvziB06O2UFlNzfHPKmesB', 898800] },
  pro: { product: 'prod_VSrjbU8azeV2EF', month: ['price_1URvzjB06O2UFlNzCb3lgr86', 199900], year: ['price_1URvzkB06O2UFlNzMj7j750M', 1998000] },
};

/** Intel's catalog, with amounts overridable as `entitlement.interval` or, for a per-plan add-on price, `entitlement.interval.plan`. */
function intelCatalog(amounts = {}, edit = body => body) {
  const body = structuredClone(FIXTURE);
  for (const product of body.products) {
    for (const price of product.prices) {
      const key = [product.entitlement_key, price.interval, price.plan].filter(Boolean).join('.');
      if (key in amounts) price.unit_amount = amounts[key];
    }
  }
  return edit(body);
}

// Each add-on product the catalog needs in Stripe: one per plan when its price depends on the plan.
const ADDONS = FIXTURE.products.filter(product => product.kind === 'addon').flatMap(product => [...new Set(product.prices.map(price => price.plan ?? ''))]
  .map(plan => ({ key: [product.entitlement_key, plan].filter(Boolean).join('_'), entitlement: product.entitlement_key, plan, unit_label: product.unit_label,
    prices: product.prices.filter(price => (price.plan ?? '') === plan) })));
const PLAN_NAMES = Object.fromEntries(FIXTURE.products.filter(product => product.kind === 'plan').map(product => [product.entitlement_key, product.name]));
const ADDON_NAMES = Object.fromEntries(FIXTURE.products.filter(product => product.kind === 'addon').map(product => [product.entitlement_key, product.name]));
const ADDON_PRICES = ADDONS.reduce((count, addon) => count + addon.prices.length, 0);

/** Stripe as it is today (Intel's plans only), or with the add-on products and prices the sync creates. */
function stripeObjects({ addons = false } = {}) {
  const products = Object.entries(STRIPE_PLANS).map(([key, plan]) => ({ id: plan.product, object: 'product', active: true, livemode: false, name: key,
    metadata: { app: 'caremetric-intel', kind: 'plan', entitlement: key } }));
  const prices = Object.values(STRIPE_PLANS).flatMap(plan => ['month', 'year'].map(interval => ({
    id: plan[interval][0], object: 'price', active: true, product: plan.product, currency: 'usd', unit_amount: plan[interval][1], type: 'recurring',
    recurring: { interval, interval_count: 1 }, metadata: { app: 'caremetric-intel', pricing_model: 'flat' }, livemode: false,
  })));
  if (addons) {
    for (const addon of ADDONS) {
      products.push({ id: `prod_${addon.key}`, object: 'product', active: true, livemode: false, name: addon.key, unit_label: addon.unit_label,
        metadata: { app: 'caremetric-intel', kind: 'addon', entitlement: addon.entitlement, ...(addon.plan ? { [FOR_PLAN_KEY]: addon.plan } : {}) } });
      for (const price of addon.prices) {
        prices.push({ id: `price_${addon.key}_${price.interval}`, object: 'price', active: true, product: `prod_${addon.key}`, currency: 'usd', unit_amount: price.unit_amount,
          type: 'recurring', recurring: { interval: price.interval, interval_count: 1 }, metadata: { app: 'caremetric-intel', pricing_model: 'per_unit', billing_metric: addon.unit_label },
          livemode: false });
      }
    }
  }
  return { products, prices };
}

afterEach(() => { followFoundersReplacements([]); resetAppCatalogFacts(); });

describe('reading an application catalog', () => {
  it('accepts what Intel publishes and refuses anything else', () => {
    const catalog = parseAppCatalog(intelCatalog(), 'caremetric-intel');
    expect(catalog).toMatchObject({ app: 'caremetric-intel', version: FIXTURE.version, trial_days: 30, annual_saving_percent: 17, free_onboarding: true,
      trial_includes: FIXTURE.trial.includes });
    expect(catalog.products.map(product => product.entitlement_key)).toEqual(['starter', 'growth', 'pro', 'enterprise', 'extra_seat', 'extra_branch', 'extra_state']);
    expect(catalog.products.find(product => product.entitlement_key === 'enterprise')).toMatchObject({ self_serve: false, prices: [], from_unit_amount: 350000 });
    expect(catalog.products.find(product => product.entitlement_key === 'extra_seat')).toMatchObject({ kind: 'addon', unit_label: 'seat' });
    expect(() => parseAppCatalog({ ...intelCatalog(), contract: 'other.v9' }, 'caremetric-intel')).toThrow(/contract/);
    expect(() => parseAppCatalog(intelCatalog(), 'carebase')).toThrow(/not carebase/);
    expect(() => parseAppCatalog(intelCatalog({ 'starter.month': -1 }), 'caremetric-intel')).toThrow(/positive amount/);
    expect(() => parseAppCatalog(intelCatalog({ 'starter.month': 34900.5 }), 'caremetric-intel')).toThrow(/positive amount/);
    expect(() => parseAppCatalog(intelCatalog({ 'extra_seat.month.growth': 0 }), 'caremetric-intel')).toThrow(/positive amount/);
    expect(() => parseAppCatalog({ ...intelCatalog(), version: '' }, 'caremetric-intel')).toThrow(/version/);
    expect(APP_CATALOG_CONTRACT).toBe(FIXTURE.contract);
  });

  it('keeps markup and unbounded text out of what reaches Stripe and the fact sheet', () => {
    const catalog = parseAppCatalog(intelCatalog({}, body => {
      body.products[0].name = '<b>Starter</b> `x`\u0000 {{monthly:starter}}';
      body.products[0].description = 'a'.repeat(2000);
      body.products[4].unit_label = 'Seats!';
      body.trial.includes = '<script>alert(1)</script>';
      return body;
    }), 'caremetric-intel');
    expect(catalog.products[0].name).not.toMatch(/[<>`{}\u0000]/);
    expect(catalog.products[0].description).toHaveLength(400);
    expect(catalog.products[4].unit_label).toBe('');
    expect(catalog.trial_includes).not.toMatch(/[<>]/);
  });

  it('derives the same request key for the same change, valid for the billing commands', () => {
    const key = deterministicKey('caremetric-intel', 'price.change', 'price_1', 'month', '39900');
    expect(deterministicKey('caremetric-intel', 'price.change', 'price_1', 'month', '39900')).toBe(key);
    expect(deterministicKey('caremetric-intel', 'price.change', 'price_1', 'month', '39901')).not.toBe(key);
    expect(billingCommandSchema.parse({ action: 'price.change', price: 'price_1', unit_amount: 39900, migrate: 'grandfather', expected_version: 1, request_key: key }).request_key).toBe(key);
  });
});

describe('planning the Stripe changes', () => {
  const plan = (amounts, mutate = objects => objects, { addons = true, edit } = {}) => {
    const { products, prices } = mutate(stripeObjects({ addons }));
    return planCatalogSync(parseAppCatalog(intelCatalog(amounts, edit), 'caremetric-intel'), products, prices);
  };

  it('changes nothing when Stripe already matches, plans and add-ons alike', () => {
    expect(plan()).toEqual({ productCreates: [], creates: [], changes: [], held: [], missing: [], skipped: [], unchanged: 6 + ADDON_PRICES });
  });

  it('creates each add-on product Stripe lacks, one per plan when the price depends on the plan', () => {
    const result = plan({}, objects => objects, { addons: false });
    expect(result.productCreates.map(create => [create.entitlement_key, create.plan ?? null, create.name])).toEqual(ADDONS.map(addon =>
      [addon.entitlement, addon.plan || null, addon.plan ? `${ADDON_NAMES[addon.entitlement]} (${PLAN_NAMES[addon.plan]})` : ADDON_NAMES[addon.entitlement]]));
    expect(result.productCreates.find(create => create.entitlement_key === 'extra_seat' && create.plan === 'growth')).toMatchObject({
      kind: 'addon', unit_label: 'seat', prices: [{ interval: 'month', unit_amount: 4900, plan: 'growth' }, { interval: 'year', unit_amount: 49000, plan: 'growth' }] });
    expect(result).toMatchObject({ creates: [], changes: [], held: [], missing: [], unchanged: 6 });
  });

  it('replaces a changed add-on price on the product for its plan', () => {
    expect(plan({ 'extra_seat.month.growth': 5900, 'extra_state.year': 209000 }).changes).toEqual([
      { entitlement_key: 'extra_seat', kind: 'addon', plan: 'growth', product: 'prod_extra_seat_growth', interval: 'month', unit_amount: 5900,
        price: 'price_extra_seat_growth_month', from: 4900 },
      { entitlement_key: 'extra_state', kind: 'addon', product: 'prod_extra_state', interval: 'year', unit_amount: 209000, price: 'price_extra_state_year', from: 199000 },
    ]);
  });

  it('replaces a changed plan price, grandfathering, and creates a price an interval lacks', () => {
    const result = plan({ 'growth.year': 958800 }, objects => ({ ...objects, prices: objects.prices.filter(price => price.id !== STRIPE_PLANS.pro.year[0]) }));
    expect(result.changes).toEqual([{ entitlement_key: 'growth', kind: 'plan', product: STRIPE_PLANS.growth.product, interval: 'year', unit_amount: 958800,
      price: STRIPE_PLANS.growth.year[0], from: 898800 }]);
    expect(result.creates).toEqual([{ entitlement_key: 'pro', kind: 'plan', product: STRIPE_PLANS.pro.product, interval: 'year', unit_amount: 1998000 }]);
  });

  it('holds a change outside the automatic range and an ambiguous product for an administrator', () => {
    expect(plan({ 'starter.month': 3490 }).held).toMatchObject([{ entitlement_key: 'starter', interval: 'month', from: 34900, unit_amount: 3490 }]);
    expect(plan({ 'starter.month': 349000 }).held).toHaveLength(1);
    expect(plan({ 'extra_seat.month.pro': 39000 }).held).toMatchObject([{ entitlement_key: 'extra_seat', plan: 'pro', interval: 'month', from: 3900 }]);
    const twice = plan({}, objects => ({ ...objects, products: [...objects.products, { ...objects.products[0], id: 'prod_copy' },
      { ...objects.products.find(product => product.id === 'prod_extra_seat_starter'), id: 'prod_seat_copy' }] }));
    expect(twice.held).toMatchObject([
      { entitlement_key: 'starter', reason: '2 active Stripe products carry this entitlement key' },
      { entitlement_key: 'extra_seat', plan: 'starter', reason: '2 active Stripe products carry this entitlement key' },
    ]);
    expect(twice).toMatchObject({ changes: [], productCreates: [] });
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

  it('leaves one-time fees to an administrator', () => {
    const result = plan({}, objects => objects, { edit: body => ({ ...body, products: [...body.products,
      { entitlement_key: 'onboarding', kind: 'fee', name: 'Onboarding', description: '', self_serve: true, prices: [{ interval: 'once', unit_amount: 50000, plan: 'growth' }] }] }) });
    expect(result.skipped).toEqual([{ entitlement_key: 'onboarding', reason: 'one-time fees are added to a first invoice by an administrator' }]);
    expect(result).toMatchObject({ productCreates: [], creates: [], changes: [] });
  });
});

describe('the Founders Sale after a price change', () => {
  const replacement = (id, replaces, amount, extra = {}) => ({ id, object: 'price', active: true, product: STRIPE_PLANS.starter.product, currency: 'usd',
    unit_amount: amount, type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, metadata: { app: 'caremetric-intel', hub_replaces: replaces }, ...extra });
  const TRAIN = { product: 'prod_penntrain_train_single_facility_flat_20261029', month: 'price_1UVz4gB06O2UFlNzKeveaEqY' };
  const carebasePrice = (id, replaces, amount, extra = {}) => ({ id, object: 'price', active: true, product: TRAIN.product, unit_amount: amount, currency: 'usd',
    type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, metadata: { app: 'carebase', hub_replaces: replaces }, ...extra });

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

  it('keeps the offer on a changed CareBase price too, Train included', () => {
    expect(FOUNDERS_FOLLOW_APPS).toEqual(['caremetric-intel', 'carebase']);
    expect(foundersFollowProducts()).toEqual(expect.arrayContaining([TRAIN.product, ...Object.values(STRIPE_PLANS).map(plan => plan.product)]));
    expect(foundersFollowProducts(['caremetric-intel'])).not.toContain(TRAIN.product);
    expect(followFoundersReplacements([carebasePrice('price_train_new', TRAIN.month, 12900),
      carebasePrice('price_train_contract', TRAIN.month, 9900, { metadata: { app: 'carebase', hub_replaces: TRAIN.month, hub_tenant_id: '11111111-1111-4111-8111-111111111111' } })])).toBe(1);
    expect(foundersPrice('price_train_new')).toEqual({ app: 'carebase', product: TRAIN.product, kind: 'plan', amount: 12900 });
    expect(foundersPrice('price_train_contract')).toBeUndefined();
    // An application left off the list keeps only its verified prices.
    followFoundersReplacements([carebasePrice('price_train_new', TRAIN.month, 12900)], ['caremetric-intel']);
    expect(foundersPrice('price_train_new')).toBeUndefined();
  });
});

describe('syncing Stripe from Intel\'s catalog', () => {
  const metadataOf = form => Object.fromEntries([...form.entries()].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value]));

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
      if (init.method === 'POST' && pathname === '/v1/products') {
        const form = new URLSearchParams(init.body);
        posts.push({ path: pathname, key: init.headers['Idempotency-Key'], form });
        const created = { id: `prod_new_${posts.length}`, object: 'product', active: true, livemode: false, name: form.get('name'), description: form.get('description'),
          unit_label: form.get('unit_label'), metadata: metadataOf(form) };
        stripe.products.push(created);
        return json(created);
      }
      if (init.method === 'POST' && pathname === '/v1/prices') {
        const form = new URLSearchParams(init.body);
        posts.push({ path: pathname, key: init.headers['Idempotency-Key'], form });
        const created = { id: `price_new_${posts.length}`, object: 'price', active: true, product: form.get('product'), currency: form.get('currency'),
          unit_amount: Number(form.get('unit_amount')), type: 'recurring', recurring: { interval: form.get('recurring[interval]'), interval_count: 1 },
          metadata: metadataOf(form), livemode: false };
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
        if (kind === 'product') {
          const product = stripe.products.find(item => item.id === id);
          return { rows: [{ v: product && { id, active: product.active, app: product.metadata.app, unit_label: product.unit_label ?? '' } }] };
        }
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

  it('sets up the add-ons Stripe lacks, a product per plan for the seat, with monthly and annual prices, once', async () => {
    const t = harness();
    const result = await t.sync();
    expect(result).toMatchObject({ ok: true, failed: 0, applied: ADDONS.length + ADDON_PRICES, unchanged: 6, held: [], missing: [], facts_stale: [] });
    const products = t.posts.filter(post => post.path === '/v1/products');
    expect(products.map(post => post.form.get('name'))).toEqual(['Extra seat (Starter)', 'Extra seat (Growth)', 'Extra seat (Pro)', 'Extra branch', 'Extra state']);
    expect(Object.fromEntries(products[1].form)).toMatchObject({ unit_label: 'seat', 'metadata[app]': 'caremetric-intel', 'metadata[kind]': 'addon',
      'metadata[entitlement]': 'extra_seat', [`metadata[${FOR_PLAN_KEY}]`]: 'growth', 'metadata[hub_managed]': 'true' });
    expect(products[3].form.get(`metadata[${FOR_PLAN_KEY}]`)).toBeNull();
    expect(products[0].key).toBe(`hub-catalog-product-${deterministicKey('caremetric-intel', 'extra_seat', 'starter')}`);
    const growthSeat = t.stripe.products.find(product => product.name === 'Extra seat (Growth)').id;
    expect(t.stripe.prices.filter(price => price.product === growthSeat).map(price => [price.recurring.interval, price.unit_amount, price.metadata.pricing_model, price.metadata.billing_metric]))
      .toEqual([['month', 4900, 'per_unit', 'seat'], ['year', 49000, 'per_unit', 'seat']]);
    const actions = t.audits.map(entry => entry.action);
    expect(actions.filter(action => action === 'billing.catalog.product')).toHaveLength(ADDONS.length);
    expect(actions.filter(action => action === 'billing.price.create')).toHaveLength(ADDON_PRICES);
    expect(actions.filter(action => action === 'billing.catalog.sync')).toHaveLength(ADDON_PRICES);
    // The next run finds everything in place.
    expect(await t.sync()).toMatchObject({ applied: 0, unchanged: 6 + ADDON_PRICES });
    expect(t.posts).toHaveLength(ADDONS.length + ADDON_PRICES);
    // The AI team quotes the catalog, which matches the reviewed copy.
    expect(facts.intel.pricing).toEqual(intelReviewedFacts.pricing);
  });

  it('replaces a changed plan price in Stripe, keeps subscribers on the old one, keeps the Founders Sale and quotes the new price', async () => {
    const t = harness(stripeObjects({ addons: true }));
    const result = await t.sync({ 'starter.month': 39900 });
    expect(result).toMatchObject({ ok: true, applied: 1, failed: 0, unchanged: 5 + ADDON_PRICES, held: [], missing: [] });
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
    // The AI team quotes $399 at once (and half of it under the Founders Sale); docs/GTM_FACTS.md is flagged for review.
    expect(facts.intel.pricing[0]).toMatch(/^Starter: \$399 per month/);
    expect(result.facts_stale).toEqual(['$199.50', '$399']);
    expect(t.log.warn).toHaveBeenCalledWith(expect.stringMatching(/GTM_FACTS\.md .* do not state \$199\.50, \$399/));
  });

  it('replaces a changed add-on price, priced per unit like the one it replaces', async () => {
    const t = harness(stripeObjects({ addons: true }));
    expect(await t.sync({ 'extra_branch.month': 10900 })).toMatchObject({ ok: true, applied: 1 });
    const [created] = t.posts;
    expect(Object.fromEntries(['product', 'unit_amount', 'metadata[pricing_model]', 'metadata[hub_replaces]'].map(key => [key, created.form.get(key)]))).toEqual({
      product: 'prod_extra_branch', unit_amount: '10900', 'metadata[pricing_model]': 'per_unit', 'metadata[hub_replaces]': 'price_extra_branch_month' });
  });

  it('does nothing more on the next run, and reuses its Stripe request keys if a run is retried', async () => {
    const t = harness(stripeObjects({ addons: true }));
    await t.sync({ 'starter.month': 39900 });
    const firstKey = t.posts[0].key;
    expect(await t.sync({ 'starter.month': 39900 })).toMatchObject({ applied: 0, unchanged: 6 + ADDON_PRICES });
    expect(t.posts).toHaveLength(2);
    const retry = harness(stripeObjects({ addons: true }));
    await retry.sync({ 'starter.month': 39900 });
    expect(retry.posts[0].key).toBe(firstKey);
  });

  it('holds a change outside the automatic range and changes nothing in Stripe', async () => {
    const t = harness(stripeObjects({ addons: true }));
    const result = await t.sync({ 'starter.month': 3490 });
    expect(result).toMatchObject({ applied: 0, held: [{ entitlement_key: 'starter', interval: 'month' }] });
    expect(t.posts).toEqual([]);
    expect(t.audits.map(entry => entry.action)).toContain('billing.catalog.held');
    expect(t.log.warn).toHaveBeenCalledWith(expect.stringMatching(/held for an administrator/));
  });

  it('leaves Stripe and the fact sheet alone when the catalog cannot be read', async () => {
    const t = harness();
    const result = await t.billing.syncAppCatalog('caremetric-intel', { fetchCatalog: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    expect(result).toEqual({ ok: false, app: 'caremetric-intel', reason: 'catalog_unreadable' });
    expect(t.posts).toEqual([]);
    expect(facts.intel.pricing).toEqual(intelReviewedFacts.pricing);
  });

  it('refreshes the followed Founders prices on its own', async () => {
    const t = harness(stripeObjects({ addons: true }));
    t.stripe.prices.push({ id: 'price_starter_later', object: 'price', active: true, product: STRIPE_PLANS.starter.product, currency: 'usd', unit_amount: 37900,
      type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, metadata: { app: 'caremetric-intel', hub_replaces: STRIPE_PLANS.starter.month[0] }, livemode: false });
    expect(await t.billing.refreshFounders()).toBe(1);
    expect(foundersPrice('price_starter_later')).toMatchObject({ app: 'caremetric-intel', amount: 37900 });
  });
});
