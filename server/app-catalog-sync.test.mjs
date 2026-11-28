import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_CATALOG_CONTRACT, FOR_PLAN_KEY, REVIEWED_PRICE_MOVES, deterministicKey, migrationFor, parseAppCatalog, planCatalogSync, reviewedMove } from './app-catalog-sync.mjs';
import { platformBilling } from './billing.mjs';
import { FOUNDERS_FOLLOW_APPS, followFoundersReplacements, foundersAmounts, foundersFollowProducts, foundersPrice } from './founders-sale.mjs';
import { intelFactsFromCatalog, intelReviewedFacts, products as facts, resetAppCatalogFacts } from './agents/content/facts.mjs';
import { STRIPE_ACCOUNT_ID } from './stripe.mjs';
import { billingCommandSchema } from '../src/billing/billingProtocol.ts';

/**
 * What Intel served at GET /api/billing/catalog on 2026-11-24 (its src/lib/planCatalog.ts), the prices Stripe holds in STRIPE_PLANS: the
 * sync's mechanics are tested on it. Intel's current catalog (fixtures/intel-catalog.json) is the reviewed copy facts.test.mjs checks.
 */
const CURRENT = JSON.parse(readFileSync(new URL('./fixtures/intel-catalog.json', import.meta.url), 'utf8'));
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/intel-catalog-2026-11-24.json', import.meta.url), 'utf8'));

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
const DESCRIPTIONS = Object.fromEntries(FIXTURE.products.map(product => [product.entitlement_key, product.description]));

/**
 * Stripe with Intel's plans, or with the add-on products and prices the sync creates too. Products carry the catalog's
 * descriptions unless `described` is false, as Intel's plans were before the sync kept descriptions in step.
 */
function stripeObjects({ addons = false, described = true } = {}) {
  const description = key => (described ? { description: DESCRIPTIONS[key] } : { description: null });
  const products = Object.entries(STRIPE_PLANS).map(([key, plan]) => ({ id: plan.product, object: 'product', active: true, livemode: false,
    name: `CareMetric Intel ${PLAN_NAMES[key]}`, ...description(key), metadata: { app: 'caremetric-intel', kind: 'plan', entitlement: key } }));
  const prices = Object.values(STRIPE_PLANS).flatMap(plan => ['month', 'year'].map(interval => ({
    id: plan[interval][0], object: 'price', active: true, product: plan.product, currency: 'usd', unit_amount: plan[interval][1], type: 'recurring',
    recurring: { interval, interval_count: 1 }, metadata: { app: 'caremetric-intel', pricing_model: 'flat' }, livemode: false,
  })));
  if (addons) {
    for (const addon of ADDONS) {
      products.push({ id: `prod_${addon.key}`, object: 'product', active: true, livemode: false, name: addon.key, unit_label: addon.unit_label,
        ...description(addon.entitlement), metadata: { app: 'caremetric-intel', kind: 'addon', entitlement: addon.entitlement, ...(addon.plan ? { [FOR_PLAN_KEY]: addon.plan } : {}) } });
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
  const plan = (amounts, mutate = objects => objects, { addons = true, described = true, edit } = {}) => {
    const { products, prices } = mutate(stripeObjects({ addons, described }));
    return planCatalogSync(parseAppCatalog(intelCatalog(amounts, edit), 'caremetric-intel'), products, prices);
  };

  it('changes nothing when Stripe already matches, plans and add-ons alike', () => {
    expect(plan()).toEqual({ productCreates: [], creates: [], changes: [], descriptions: [], held: [], missing: [], skipped: [], unchanged: 6 + ADDON_PRICES });
  });

  it('gives each plan and add-on product the catalog\'s description, and never touches a name, a unit label or a price', () => {
    const result = plan({}, objects => objects, { addons: true, described: false });
    expect(result.descriptions).toEqual([
      ...Object.entries(STRIPE_PLANS).map(([key, { product }]) => ({ entitlement_key: key, kind: 'plan', product, from: '', description: DESCRIPTIONS[key] })),
      ...ADDONS.map(addon => ({ entitlement_key: addon.entitlement, kind: 'addon', ...(addon.plan ? { plan: addon.plan } : {}), product: `prod_${addon.key}`,
        from: '', description: DESCRIPTIONS[addon.entitlement] })),
    ]);
    expect(result).toMatchObject({ productCreates: [], creates: [], changes: [], held: [], unchanged: 6 + ADDON_PRICES });
    expect(result.descriptions.every(step => !('name' in step) && !('unit_label' in step))).toBe(true);
  });

  it('replaces an outdated description, reads spacing as the same words, and clears nothing the catalog leaves empty', () => {
    const result = plan({}, objects => ({ ...objects, products: objects.products.map(product =>
      product.id === 'prod_extra_branch' ? { ...product, name: 'Extra branch', unit_label: 'branch', description: 'One more branch on any plan.' }
        : product.id === 'prod_extra_state' ? { ...product, description: 'A state set by hand.' }
          : product.id === STRIPE_PLANS.growth.product ? { ...product, description: `  ${DESCRIPTIONS.growth.replace(/ /g, '  ')}\n` } : product) }),
    { edit: body => ({ ...body, products: body.products.map(product => (product.entitlement_key === 'extra_state' ? { ...product, description: '' } : product)) }) });
    expect(result.descriptions).toEqual([{ entitlement_key: 'extra_branch', kind: 'addon', product: 'prod_extra_branch',
      from: 'One more branch on any plan.', description: 'One more location on any plan.' }]);
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
        price: 'price_extra_seat_growth_month', from: 4900, migrate: 'grandfather' },
      { entitlement_key: 'extra_state', kind: 'addon', product: 'prod_extra_state', interval: 'year', unit_amount: 209000, price: 'price_extra_state_year', from: 199000, migrate: 'grandfather' },
    ]);
  });

  it('replaces a changed plan price, grandfathering, and creates a price an interval lacks', () => {
    const result = plan({ 'growth.year': 958800 }, objects => ({ ...objects, prices: objects.prices.filter(price => price.id !== STRIPE_PLANS.pro.year[0]) }));
    expect(result.changes).toEqual([{ entitlement_key: 'growth', kind: 'plan', product: STRIPE_PLANS.growth.product, interval: 'year', unit_amount: 958800,
      price: STRIPE_PLANS.growth.year[0], from: 898800, migrate: 'grandfather' }]);
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

  it('moves the people on a price to a lower one, and keeps a higher one off them (the price lock)', () => {
    expect(migrationFor(34900, 29900)).toBe('no_proration');
    expect(migrationFor(34900, 39900)).toBe('grandfather');
    expect(plan({ 'starter.month': 29900 }).changes).toMatchObject([{ entitlement_key: 'starter', interval: 'month', from: 34900, unit_amount: 29900, migrate: 'no_proration' }]);
  });

  it('applies a move outside the automatic range only when the owner reviewed that exact amount', () => {
    const reviewed = plan({ 'starter.month': 9900, 'extra_seat.month.starter': 2900, 'extra_state.month': 9900 });
    expect(reviewed.held).toEqual([]);
    expect(reviewed.changes).toMatchObject([
      { entitlement_key: 'starter', interval: 'month', from: 34900, unit_amount: 9900, migrate: 'no_proration', reviewed: true },
      { entitlement_key: 'extra_seat', plan: 'starter', interval: 'month', from: 5900, unit_amount: 2900, migrate: 'no_proration', reviewed: true },
      { entitlement_key: 'extra_state', interval: 'month', from: 19900, unit_amount: 9900, migrate: 'no_proration', reviewed: true },
    ]);
    // An amount next to the reviewed one, or the reviewed amount on another interval or plan, is still held.
    expect(plan({ 'starter.month': 9800 }).held).toMatchObject([{ entitlement_key: 'starter', interval: 'month', unit_amount: 9800 }]);
    expect(plan({ 'extra_seat.month.growth': 2400 }).held).toHaveLength(1);
    expect(reviewedMove('carebase', { entitlement_key: 'starter', interval: 'month', unit_amount: 9900 })).toBe(false);
    // Every reviewed move is the amount Intel's current catalog publishes.
    const current = parseAppCatalog(CURRENT, 'caremetric-intel');
    for (const move of REVIEWED_PRICE_MOVES['caremetric-intel']) {
      const product = current.products.find(item => item.entitlement_key === move.entitlement_key);
      expect(product?.prices.find(price => price.interval === move.interval && (price.plan ?? '') === (move.plan ?? ''))?.unit_amount, JSON.stringify(move)).toBe(move.unit_amount);
    }
  });

  it('reads the founding offer and the AI packs Intel publishes now', () => {
    const current = parseAppCatalog(CURRENT, 'caremetric-intel');
    expect(current.founding_offer).toMatchObject({ kind: 'price_lock', plans: ['starter', 'growth', 'pro'] });
    expect(current.founding_offer.terms).toMatch(/never|does not apply/);
    expect(current.products.filter(item => /^ai_/.test(item.entitlement_key)).map(item => [item.entitlement_key, item.kind, item.unit_label]))
      .toEqual([['ai_plus', 'addon', 'aiplus'], ['ai_max', 'addon', 'aimax']]);
    expect(parseAppCatalog(FIXTURE, 'caremetric-intel').founding_offer).toBeNull();
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
    expect(foundersAmounts([{ price: 'price_new', quantity: 1 }])).toMatchObject({ standard_recurring_subtotal: 39900, recurring_subtotal: 9975 });
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
    const subscriptionLists = [];
    const audits = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const { pathname, searchParams } = new URL(url);
      const json = body => ({ ok: true, status: 200, json: async () => structuredClone(body) });
      if (pathname === '/v1/account') return json({ id: STRIPE_ACCOUNT_ID });
      if (init.method === 'GET' && pathname === '/v1/products') return json({ object: 'list', data: stripe.products, has_more: false });
      if (init.method === 'GET' && pathname === '/v1/prices') return json({ object: 'list', data: stripe.prices.filter(price => price.product === searchParams.get('product')), has_more: false });
      if (init.method === 'GET' && pathname.startsWith('/v1/prices/')) return json(stripe.prices.find(price => price.id === pathname.split('/').pop()));
      if (init.method === 'GET' && pathname.startsWith('/v1/products/')) return json(stripe.products.find(product => product.id === pathname.split('/').pop()));
      // Who is on a price, when a lower one moves them (migrateSubscribers): nobody in these tests.
      if (init.method === 'GET' && pathname === '/v1/subscriptions') {
        subscriptionLists.push(searchParams.get('price'));
        return json({ object: 'list', data: [], has_more: false });
      }
      if (init.method === 'POST' && pathname === '/v1/products') {
        const form = new URLSearchParams(init.body);
        posts.push({ path: pathname, key: init.headers['Idempotency-Key'], form });
        const created = { id: `prod_new_${posts.length}`, object: 'product', active: true, livemode: false, name: form.get('name'), description: form.get('description'),
          unit_label: form.get('unit_label'), metadata: metadataOf(form) };
        stripe.products.push(created);
        return json(created);
      }
      if (init.method === 'POST' && pathname.startsWith('/v1/products/')) {
        const form = new URLSearchParams(init.body);
        posts.push({ path: pathname, key: init.headers['Idempotency-Key'], form });
        const product = stripe.products.find(item => item.id === pathname.split('/').pop());
        if (form.has('description')) product.description = form.get('description');
        return json(product);
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
    return { billing, sync, posts, audits, log, stripe, subscriptionLists };
  }

  it('sets up the add-ons Stripe lacks, a product per plan for the seat, with monthly and annual prices, once', async () => {
    const t = harness();
    const result = await t.sync();
    expect(result).toMatchObject({ ok: true, failed: 0, applied: ADDONS.length + ADDON_PRICES, unchanged: 6, held: [], missing: [] });
    const products = t.posts.filter(post => post.path === '/v1/products');
    expect(products.map(post => post.form.get('name'))).toEqual(['Extra seat (Starter)', 'Extra seat (Growth)', 'Extra seat (Pro)', 'Extra location', 'Extra state']);
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
    // The AI team quotes the catalog it read (facts.test.mjs holds Intel's current catalog to the reviewed copy).
    expect(facts.intel.pricing).toEqual(intelFactsFromCatalog(parseAppCatalog(FIXTURE, 'caremetric-intel')).pricing);
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
    // The AI team quotes $399 at once; docs/GTM_FACTS.md, whose reviewed copy states other prices, is flagged for review.
    expect(facts.intel.pricing[0]).toMatch(/^Starter: \$399 per month/);
    expect(result.facts_stale).toEqual(expect.arrayContaining(['$399']));
    expect(t.log.warn).toHaveBeenCalledWith(expect.stringMatching(/GTM_FACTS\.md .* do not state .*\$399/));
  });

  it('moves the people on a price onto a lower one after the change, and never onto a higher one', async () => {
    const t = harness(stripeObjects({ addons: true }));
    expect(await t.sync({ 'starter.month': 9900 })).toMatchObject({ ok: true, applied: 1, held: [] });
    expect(t.subscriptionLists).toEqual([STRIPE_PLANS.starter.month[0]]);
    expect(t.audits.find(entry => entry.action === 'billing.catalog.sync').metadata).toMatchObject({ migrate: 'no_proration', reviewed: 'true', unit_amount_to: 9900 });
    const higher = harness(stripeObjects({ addons: true }));
    await higher.sync({ 'starter.month': 39900 });
    expect(higher.subscriptionLists).toEqual([]);
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

  it('brings descriptions in step once, leaving names alone, and reuses its request keys if a run is retried', async () => {
    const outdated = () => {
      const objects = stripeObjects({ addons: true, described: false });
      Object.assign(objects.products.find(product => product.id === 'prod_extra_branch'), { name: 'Extra branch', description: 'One more branch on any plan.' });
      return objects;
    };
    const t = harness(outdated());
    const result = await t.sync();
    expect(result).toMatchObject({ ok: true, failed: 0, applied: 3 + ADDONS.length, unchanged: 6 + ADDON_PRICES, held: [] });
    expect(t.posts.every(post => post.path.startsWith('/v1/products/') && [...post.form.keys()].join() === 'description')).toBe(true);
    const branch = t.posts.find(post => post.path === '/v1/products/prod_extra_branch');
    expect(branch.form.get('description')).toBe('One more location on any plan.');
    expect(branch.key).toBe(`hub-catalog-description-${deterministicKey('caremetric-intel', 'prod_extra_branch', 'One more branch on any plan.', 'One more location on any plan.')}`);
    expect(t.posts.find(post => post.path === `/v1/products/${STRIPE_PLANS.growth.product}`).form.get('description')).toBe(DESCRIPTIONS.growth);
    expect(t.stripe.products.find(product => product.id === 'prod_extra_branch').name).toBe('Extra branch');
    expect(t.stripe.products.find(product => product.id === STRIPE_PLANS.growth.product).name).toBe('CareMetric Intel Growth');
    const described = t.audits.filter(entry => entry.action === 'billing.catalog.description');
    expect(described).toHaveLength(3 + ADDONS.length);
    expect(described.find(entry => entry.metadata.product === 'prod_extra_branch').metadata).toEqual({
      source: 'app_catalog', version: FIXTURE.version, entitlement: 'extra_branch', product: 'prod_extra_branch' });
    // The next run finds them in step.
    expect(await t.sync()).toMatchObject({ applied: 0 });
    expect(t.posts).toHaveLength(3 + ADDONS.length);
    const retry = harness(outdated());
    await retry.sync();
    expect(retry.posts.map(post => post.key)).toEqual(t.posts.map(post => post.key));
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
