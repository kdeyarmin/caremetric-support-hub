import type { BillingWorkspace, Coupon, CustomerDetail, Subscription, SubscriptionItem } from './billingModel';

/** Synthetic billing records for tests. Never real customers or Stripe objects. */
export const fixtureTenantId = '00000000-0000-4000-8000-0000000000a1';
export const fixtureTenantTwoId = '00000000-0000-4000-8000-0000000000a2';

export const fixtureItem = (overrides: Partial<SubscriptionItem> = {}): SubscriptionItem => ({
  id: 'si_core', price: 'price_core_monthly', product: 'prod_core', quantity: 3, unit_amount: 19900, currency: 'usd', interval: 'month', interval_count: 1,
  product_name: 'Core', kind: 'plan', unit_label: 'facility', pricing_model: 'per_unit', custom: false, ...overrides,
});

export const fixtureSubscription = (overrides: Partial<Subscription> = {}): Subscription => ({
  id: 'sub_core', tenant_id: fixtureTenantId, customer: 'cus_one', app: 'carebase', status: 'active', collection_method: 'send_invoice',
  cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null, current_period_start: '2026-10-01T00:00:00Z',
  current_period_end: '2026-11-01T00:00:00Z', trial_start: null, trial_end: null, pause_behavior: null, pause_resumes_at: null, discounts: [],
  created: '2026-10-01T00:00:00Z', version: 2, items: [fixtureItem()], ...overrides,
});

export const fixtureCoupon = (overrides: Partial<Coupon> = {}): Coupon => ({
  id: 'co_founding', name: 'Legacy founding agency', percent_off: 25, amount_off: null, currency: null, duration: 'forever', duration_in_months: null,
  max_redemptions: null, times_redeemed: 0, redeem_by: null, valid: true, applies_to: [], app: 'caremetric-intel', created: '2026-10-01T00:00:00Z', version: 1, deleted: false,
  ...overrides,
});

export const fixtureWorkspace = (overrides: Partial<BillingWorkspace> = {}): BillingWorkspace => ({
  mode: 'test', account: 'acct_1SinLKB06O2UFlNz',
  apps: [{ id: '00000000-0000-4000-8000-000000000001', slug: 'carebase', name: 'CareMetric CareBase', status: 'active' }],
  tenants: [
    { id: fixtureTenantId, slug: 'synthetic-one', name: 'Synthetic Senior Living', industry: 'Assisted living', status: 'active', updated_at: '2026-10-01T00:00:00Z',
      customer: { id: 'cus_one', email: 'billing@test.invalid', name: 'Synthetic Senior Living', delinquent: false, balance: 0, version: 1 } },
    { id: fixtureTenantTwoId, slug: 'synthetic-two', name: 'Synthetic Home Medical', industry: 'DME', status: 'active', updated_at: '2026-10-01T00:00:00Z', customer: null },
  ],
  subscriptions: [
    fixtureSubscription(),
    fixtureSubscription({ id: 'sub_breathe', app: 'breathe', status: 'trialing', trial_end: '2026-11-10T00:00:00Z', tenant_id: fixtureTenantTwoId,
      items: [fixtureItem({ id: 'si_launch', price: 'price_launch', product: 'prod_launch', quantity: 1, unit_amount: 79900, product_name: 'Launch', unit_label: '', pricing_model: 'flat' })] }),
    fixtureSubscription({ id: 'sub_old', status: 'canceled', ended_at: '2026-09-01T00:00:00Z' }),
  ],
  products: [
    { id: 'prod_core', app: 'carebase', name: 'Core', description: 'Base plan', active: true, kind: 'plan', entitlement_key: 'core', unit_label: 'facility', created: '2026-10-01T00:00:00Z', version: 1 },
    { id: 'prod_launch', app: 'breathe', name: 'Launch', description: '', active: true, kind: 'plan', entitlement_key: 'launch', unit_label: '', created: '2026-10-01T00:00:00Z', version: 1 },
  ],
  prices: [
    { id: 'price_core_monthly', product: 'prod_core', active: true, currency: 'usd', unit_amount: 19900, pricing_model: 'per_unit', type: 'recurring', interval: 'month',
      interval_count: 1, lookup_key: null, nickname: 'Core monthly', tenant_id: null, replaces: null, created: '2026-10-01T00:00:00Z', version: 1, subscribers: 2 },
    { id: 'price_launch', product: 'prod_launch', active: true, currency: 'usd', unit_amount: 79900, pricing_model: 'flat', type: 'recurring', interval: 'month',
      interval_count: 1, lookup_key: null, nickname: '', tenant_id: null, replaces: null, created: '2026-10-01T00:00:00Z', version: 1, subscribers: 1 },
  ],
  coupons: [fixtureCoupon()],
  promotion_codes: [{ id: 'promo_1', code: 'FOUNDING', coupon: 'co_founding', active: true, customer: null, max_redemptions: null, times_redeemed: 0,
    expires_at: null, first_time_transaction: false, minimum_amount: null, created: '2026-10-01T00:00:00Z', version: 1 }],
  app_keys: [],
  webhook: { last_received_at: '2026-10-27T00:00:00Z', events_24h: 4 },
  loaded_at: '2026-10-27T00:00:00Z',
  ...overrides,
});

export const fixtureCustomer = (overrides: Partial<CustomerDetail> = {}): CustomerDetail => {
  const workspace = fixtureWorkspace();
  return {
    ...workspace.tenants[0],
    subscriptions: [fixtureSubscription()],
    custom_prices: [],
    invoices: [{ id: 'in_1', tenant_id: fixtureTenantId, subscription: 'sub_core', app: 'carebase', status: 'open', number: 'SYN-0001', currency: 'usd',
      total: 59700, amount_due: 59700, amount_paid: 0, amount_remaining: 59700, hosted_invoice_url: 'https://invoice.stripe.com/i/synthetic', invoice_pdf: null,
      collection_method: 'send_invoice', period_start: null, period_end: null, due_date: '2026-11-01T00:00:00Z', created: '2026-10-01T00:00:00Z', version: 1 }],
    links: [], usage: [], loaded_at: '2026-10-27T00:00:00Z',
    ...overrides,
  };
};
