import { describe, expect, it } from 'vitest';
import { billingTotals, couponLabel, customerDetailSchema, itemMonthlyCents, parseDollars, priceLabel, subscriptionMonthlyCents, summarizeByApp, workspaceSchema } from './billingModel';
import { billingCommandSchema } from './billingProtocol';
import { fixtureCoupon, fixtureCustomer, fixtureItem, fixtureSubscription, fixtureWorkspace } from './billingFixtures';

describe('billing money', () => {
  it('parses dollar entries to whole cents and refuses anything else', () => {
    expect(['$1,299.50', '1299.5', '499', '0', '0.07'].map(parseDollars)).toEqual([129950, 129950, 49900, 0, 7]);
    expect(['', '12.345', '-5', 'ten', '10000001'].map(parseDollars)).toEqual([null, null, null, null, null]);
  });
  it('normalizes recurring items to a month', () => {
    expect(itemMonthlyCents(fixtureItem({ unit_amount: 120000, quantity: 1, interval: 'year' }))).toBe(10000);
    expect(itemMonthlyCents(fixtureItem({ unit_amount: 19900, quantity: 3, interval: 'month' }))).toBe(59700);
    expect(itemMonthlyCents(fixtureItem({ unit_amount: 50000, interval: null }))).toBe(0);
  });
  it('applies percent coupons to the products they cover and amount coupons per interval', () => {
    const subscription = fixtureSubscription({ items: [fixtureItem(), fixtureItem({ id: 'si_addon', product: 'prod_addon', unit_amount: 10000, quantity: 1 })],
      discounts: [{ id: 'di_1', coupon: 'co_core', promotion_code: null }] });
    expect(subscriptionMonthlyCents(subscription, [fixtureCoupon({ id: 'co_core', percent_off: 50, applies_to: ['prod_core'] })])).toBe(59700 / 2 + 10000);
    expect(subscriptionMonthlyCents(subscription, [fixtureCoupon({ id: 'co_core', percent_off: null, amount_off: 1000000, currency: 'usd' })])).toBe(0);
  });
  it('counts MRR only for paying subscriptions and reports trials separately', () => {
    const workspace = fixtureWorkspace();
    expect(billingTotals(workspace.subscriptions, workspace.coupons)).toMatchObject({ subscriptions: 3, mrrCents: 59700, arrCents: 59700 * 12, trialMrrCents: 79900 });
    const byApp = summarizeByApp(workspace);
    expect(byApp.carebase).toMatchObject({ subscriptionCount: 2, mrrCents: 59700 });
    expect(byApp.breathe.statusCounts).toEqual([{ status: 'trialing', count: 1 }]);
  });
  it('labels prices and coupons in plain words', () => {
    expect(priceLabel({ unit_amount: 19900, currency: 'usd', type: 'recurring', interval: 'month', interval_count: 1, pricing_model: 'per_unit' }, 'facility')).toBe('$199.00 per facility per month');
    expect(priceLabel({ unit_amount: 50000, currency: 'usd', type: 'one_time', interval: null, interval_count: null, pricing_model: 'flat' })).toBe('$500.00 one-time');
    expect(couponLabel({ percent_off: 25, amount_off: null, currency: null, duration: 'forever', duration_in_months: null })).toBe('25% off forever');
    expect(couponLabel({ percent_off: null, amount_off: 5000, currency: 'usd', duration: 'repeating', duration_in_months: 3 })).toBe('$50.00 off for 3 months');
  });
});

describe('billing records', () => {
  it('accepts the workspace and customer shapes the Hub returns', () => {
    expect(workspaceSchema.parse(fixtureWorkspace()).subscriptions).toHaveLength(3);
    expect(customerDetailSchema.parse(fixtureCustomer()).invoices[0].status).toBe('open');
  });
  it('reads an unknown application as unassigned instead of failing the page', () => {
    expect(workspaceSchema.parse(fixtureWorkspace({ products: [{ ...fixtureWorkspace().products[0], app: 'PennTrain' as never }] })).products[0].app).toBeNull();
  });
});

describe('billing commands', () => {
  const requestKey = '00000000-0000-4000-8000-0000000000ff';
  it('accepts a subscription with quantities, a trial and a coupon', () => {
    expect(billingCommandSchema.parse({ action: 'subscription.create', tenant_id: fixtureCustomer().id, app: 'carebase', items: [{ price: 'price_core_monthly', quantity: 3 }],
      trial_days: 30, collection_method: 'send_invoice', days_until_due: 30, coupon: 'co_founding', promotion_code: null, request_key: requestKey }).action).toBe('subscription.create');
  });
  it('refuses unknown fields, actions and applications', () => {
    expect(() => billingCommandSchema.parse({ action: 'catalog.sync', extra: true })).toThrow();
    expect(() => billingCommandSchema.parse({ action: 'customer.delete', tenant_id: fixtureCustomer().id })).toThrow();
    expect(() => billingCommandSchema.parse({ action: 'product.create', app: 'advisors', name: 'X', description: '', kind: 'plan', unit_label: '', entitlement_key: '', request_key: requestKey })).toThrow();
  });
  it('offers only the three price change choices', () => {
    for (const migrate of ['grandfather', 'prorate', 'no_proration'])
      expect(billingCommandSchema.parse({ action: 'price.change', price: 'price_core_monthly', unit_amount: 24900, migrate, expected_version: 1, request_key: requestKey }).action).toBe('price.change');
    expect(() => billingCommandSchema.parse({ action: 'price.change', price: 'price_core_monthly', unit_amount: 24900, migrate: 'later', expected_version: 1, request_key: requestKey })).toThrow();
  });
});
