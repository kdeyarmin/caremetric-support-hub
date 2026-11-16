import { beforeAll, describe, expect, it, vi } from 'vitest';
import { trialCardOnFile } from './trial-card.mjs';
import { trialRequestSchema, appPortalRequestSchema } from '../src/billing/billingProtocol.ts';

function fixture() {
  const entitlement = { entitled: true, status: 'trialing', app: 'caremetric-intel', tenant_id: 'tenant-a', products: [{ kind: 'plan', status: 'trialing', subscription: 'sub_trial' }] };
  const subscription = { status: 'trialing', collection_method: 'charge_automatically', metadata: { app: 'caremetric-intel' }, customer: 'cus_owner', default_payment_method: null };
  const customer = { metadata: { hub_tenant_id: 'tenant-a' }, invoice_settings: { default_payment_method: 'pm_card' } };
  const method = { type: 'card', customer: 'cus_owner' };
  const get = vi.fn(async path => {
    if (path === '/v1/subscriptions/sub_trial') return subscription;
    if (path === '/v1/customers/cus_owner') return customer;
    if (path === '/v1/payment_methods/pm_card') return method;
    throw new Error('Unexpected provider request');
  });
  return { entitlement, subscription, customer, method, live: { get } };
}

describe('trial card confirmation', () => {
  it('accepts the card saved by the Stripe portal as the customer default for automatic collection', async () => {
    const f = fixture();
    expect(await trialCardOnFile(f.live, f.entitlement)).toBe(true);
  });

  it.each([
    f => { f.customer.invoice_settings.default_payment_method = null; },
    f => { f.subscription.collection_method = 'send_invoice'; },
    f => { f.subscription.status = 'canceled'; },
    f => { f.customer.deleted = true; },
    f => { f.customer.metadata.hub_tenant_id = 'other-tenant'; },
    f => { f.subscription.metadata.app = 'carebase'; },
    f => { f.method.type = 'us_bank_account'; },
    f => { f.method.customer = 'cus_someoneelse'; },
    f => { f.entitlement.products = []; },
  ])('refuses an absent, invalid, or differently owned card (%#)', async change => {
    const f = fixture(); change(f);
    expect(await trialCardOnFile(f.live, f.entitlement)).toBe(false);
  });

  it('fails closed when Stripe is unavailable', async () => {
    const f = fixture(); f.live.get.mockRejectedValue(new Error('offline'));
    await expect(trialCardOnFile(f.live, f.entitlement)).rejects.toThrow('offline');
  });

  it('accepts an explicit annual choice and the card-update portal flow', () => {
    expect(trialRequestSchema.parse({ account: '123', name: 'Test Agency', email: 'owner@example.com', plan: 'growth', interval: 'year', require_payment_method: true }).interval).toBe('year');
    expect(appPortalRequestSchema.parse({ account: '123', return_url: 'https://intel.example/Billing', payment_method_only: true }).payment_method_only).toBe(true);
    expect(trialRequestSchema.safeParse({ account: '123', name: 'Test Agency', email: null, plan: 'growth', interval: 'week' }).success).toBe(false);
  });
});

it('creates one annual trial with automatic card collection, and reuses it on retry', async () => {
  const { platformBilling } = await import('./billing.mjs');
  const { STRIPE_ACCOUNT_ID } = await import('./stripe.mjs');
  let current = { linked: true, status: 'none', entitled: false, products: [] };
  const created = [];
  const lookups = [];
  const query = vi.fn(async (sql, values = []) => {
    if (sql.includes('billing_authenticate_app')) return { rows: [{ app: { slug: 'caremetric-intel', product_id: 'intel' } }] };
    if (sql.includes('billing_app_tenant')) return { rows: [{ t: 'tenant-a' }] };
    if (sql.includes('billing_app_entitlements')) return { rows: [{ e: current }] };
    if (sql.includes('billing_context')) return { rows: [{ c: { stripe_customer_id: 'cus_owner' } }] };
    if (sql.includes('billing_lookup')) { lookups.push(values); return { rows: [{ v: { price: 'price_year' } }] }; }
    if (sql.includes('billing_sync')) {
      if (values[0] === 'subscription') current = { linked: true, entitled: true, status: 'trialing', products: [] };
      return { rows: [{ outcome: 'applied' }] };
    }
    if (sql.includes('app_billing_portal_customer')) return { rows: [{ c: { tenant: 'tenant-a', customer: 'cus_owner' } }] };
    return { rows: [] };
  });
  const portalRequests = [];
  const fetchImpl = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    let body;
    if (path === '/v1/account') body = { id: STRIPE_ACCOUNT_ID };
    else if (path === '/v1/subscriptions' && init.method === 'GET') body = { data: [], has_more: false };
    else if (path === '/v1/subscriptions' && init.method === 'POST') {
      created.push({ params: new URLSearchParams(init.body), headers: init.headers });
      body = { id: 'sub_trial', customer: 'cus_owner', status: 'trialing', collection_method: 'charge_automatically',
        metadata: { app: 'caremetric-intel' }, items: { data: [] }, discounts: [] };
    } else if (path === '/v1/billing_portal/sessions') {
      portalRequests.push(new URLSearchParams(init.body)); body = { url: 'https://billing.stripe.com/p/session/test' };
    } else throw new Error(`Unexpected provider request ${path}`);
    return new Response(JSON.stringify(body));
  });
  const billing = platformBilling({ pool: { connect: async () => ({ query, release() {} }) }, secretKey: 'sk_test_fixture', fetchImpl });
  const key = `Bearer cmb_${'a'.repeat(43)}`;
  const input = { account: 'abc', name: 'Test Agency', email: 'owner@example.com', plan: 'pro', interval: 'year', require_payment_method: true };
  await billing.trial(key, input);
  await billing.trial(key, input);
  expect(lookups).toContainEqual(['trial_price_interval', 'caremetric-intel:pro:year']);
  expect(created).toHaveLength(1);
  expect(Object.fromEntries(created[0].params)).toMatchObject({
    'items[0][price]': 'price_year', trial_period_days: '30', collection_method: 'charge_automatically',
    'payment_settings[payment_method_types][0]': 'card',
    'payment_settings[save_default_payment_method]': 'on_subscription',
    'trial_settings[end_behavior][missing_payment_method]': 'cancel',
  });
  expect(created[0].headers['Idempotency-Key']).toMatch(/^hub-trial-subscription-/);
  await billing.appPortal(key, { account: 'abc', return_url: 'https://intel.test/Billing?card_setup=returned', payment_method_only: true });
  expect(Object.fromEntries(portalRequests[0])).toMatchObject({
    customer: 'cus_owner', 'flow_data[type]': 'payment_method_update',
    'flow_data[after_completion][redirect][return_url]': 'https://intel.test/Billing?card_setup=returned',
  });
});

describe('an Intel trial entitlement while Stripe cannot be reached', () => {
  // Intel locks an organization to its Billing page whenever the Hub cannot answer its entitlement (sessionUsers.ts), so a Stripe
  // failure inside the card check must not fail the whole answer.
  function hub({ cardSaved = true } = {}) {
    const stripe = { up: true, account: true, card: cardSaved };
    let clock = Date.parse('2026-11-16T12:00:00Z');
    const trial = { linked: true, entitled: true, status: 'trialing', app: 'caremetric-intel', tenant_id: 'tenant-a', trial_end: '2026-12-16T00:00:00Z',
      products: [{ key: 'growth', kind: 'plan', status: 'trialing', subscription: 'sub_trial' }] };
    const query = vi.fn(async sql => {
      if (sql.includes('billing_authenticate_app')) return { rows: [{ app: { slug: 'caremetric-intel', product_id: 'intel' } }] };
      if (sql.includes('scoped_app_billing_entitlements')) return { rows: [{ e: structuredClone(trial) }] };
      return { rows: [] };
    });
    const fetchImpl = vi.fn(async url => {
      const path = new URL(url).pathname;
      const down = () => new Response(JSON.stringify({ error: { type: 'api_error', message: 'Stripe is down.' } }), { status: 503 });
      if (path === '/v1/account') return stripe.account ? new Response(JSON.stringify({ id: STRIPE_ACCOUNT_ID })) : down();
      if (!stripe.up) return down();
      if (path === '/v1/subscriptions/sub_trial') return new Response(JSON.stringify({ status: 'trialing', collection_method: 'charge_automatically', metadata: { app: 'caremetric-intel' }, customer: 'cus_owner' }));
      if (path === '/v1/customers/cus_owner') return new Response(JSON.stringify({ metadata: { hub_tenant_id: 'tenant-a' }, invoice_settings: { default_payment_method: stripe.card ? 'pm_card' : null } }));
      if (path === '/v1/payment_methods/pm_card') return new Response(JSON.stringify({ type: 'card', customer: 'cus_owner' }));
      throw new Error(`Unexpected provider request ${path}`);
    });
    const log = { warn: vi.fn(), info: vi.fn() };
    const make = () => platformBilling({ pool: { connect: async () => ({ query, release() {} }) }, secretKey: 'sk_test_fixture', fetchImpl, now: () => clock, log });
    return { stripe, log, make, later: ms => { clock += ms; } };
  }
  const key = `Bearer cmb_${'a'.repeat(43)}`;
  let platformBilling, STRIPE_ACCOUNT_ID;
  beforeAll(async () => { ({ platformBilling } = await import('./billing.mjs')); ({ STRIPE_ACCOUNT_ID } = await import('./stripe.mjs')); });

  it('still answers the entitlement, keeping a card Stripe confirmed in the last day', async () => {
    const h = hub();
    const billing = h.make();
    expect(await billing.entitlements(key, { account: 'abc' })).toMatchObject({ entitled: true, status: 'trialing', payment_method_on_file: true });
    h.stripe.up = false;
    expect(await billing.entitlements(key, { account: 'abc' })).toMatchObject({ entitled: true, status: 'trialing', payment_method_on_file: true });
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('confirmed in the last 24 hours'));
    // A day on, the old confirmation no longer stands in: the card reads as not confirmed until Stripe answers again.
    h.later(25 * 60 * 60 * 1000);
    expect(await billing.entitlements(key, { account: 'abc' })).toMatchObject({ entitled: true, status: 'trialing', payment_method_on_file: false });
    h.stripe.up = true;
    expect(await billing.entitlements(key, { account: 'abc' })).toMatchObject({ payment_method_on_file: true });
  });

  it('never unlocks a trial whose card Stripe has not confirmed', async () => {
    // No card yet, then Stripe goes down: still not confirmed.
    const h = hub({ cardSaved: false });
    const billing = h.make();
    expect(await billing.entitlements(key, { account: 'abc' })).toMatchObject({ payment_method_on_file: false });
    h.stripe.up = false;
    expect(await billing.entitlements(key, { account: 'abc' })).toMatchObject({ entitled: true, payment_method_on_file: false });
    // A card that was confirmed and then removed is forgotten at once.
    const removed = hub();
    const again = removed.make();
    expect(await again.entitlements(key, { account: 'abc' })).toMatchObject({ payment_method_on_file: true });
    removed.stripe.card = false;
    expect(await again.entitlements(key, { account: 'abc' })).toMatchObject({ payment_method_on_file: false });
    removed.stripe.up = false;
    expect(await again.entitlements(key, { account: 'abc' })).toMatchObject({ payment_method_on_file: false });
  });

  it('answers when Stripe cannot even be verified, as after a restart during an outage', async () => {
    const h = hub();
    h.stripe.account = false;
    expect(await h.make().entitlements(key, { account: 'abc' })).toMatchObject({ entitled: true, status: 'trialing', payment_method_on_file: false });
  });
});
