import { describe, expect, it } from 'vitest';
import { billingTotals, itemMonthlyCents as screenItem, revenueStatuses as screenStatuses, subscriptionMonthlyCents as screenSubscription } from '../../../src/billing/billingModel.ts';
import { itemMonthlyCents, monthlyTotals, revenueStatuses, subscriptionMonthlyCents } from './money.mjs';

const item = (over = {}) => ({ product: 'p1', quantity: 1, unit_amount: 4900, currency: 'usd', interval: 'month', interval_count: 1, ...over });
const coupon = (over = {}) => ({ id: 'c1', percent_off: null, amount_off: null, applies_to: [], ...over });
const sub = (over = {}) => ({ status: 'active', items: [item()], discounts: [], ...over });

describe('revenue figures', () => {
  it('turns an item into a month of revenue, by hand', () => {
    expect(itemMonthlyCents(item({ quantity: 2 }))).toBe(9800);
    expect(itemMonthlyCents(item({ unit_amount: 120000, interval: 'year' }))).toBe(10000);
    expect(itemMonthlyCents(item({ unit_amount: 1000, interval: 'week' }))).toBeCloseTo(4333.33, 2);
    expect(itemMonthlyCents(item({ unit_amount: 100, interval: 'day' }))).toBeCloseTo(3041.67, 2);
    expect(itemMonthlyCents(item({ interval_count: 3 }))).toBeCloseTo(1633.33, 2);
    expect(itemMonthlyCents(item({ unit_amount: null }))).toBe(0);
    expect(itemMonthlyCents(item({ interval: null }))).toBe(0);
  });

  it('applies percent and amount coupons the way the Billing screen does', () => {
    const items = [item({ product: 'plan', unit_amount: 10000 }), item({ product: 'addon', unit_amount: 2000 })];
    expect(subscriptionMonthlyCents(sub({ items }), [])).toBe(12000);
    expect(subscriptionMonthlyCents(sub({ items, discounts: [{ coupon: 'c1' }] }), [coupon({ percent_off: 25 })])).toBe(9000);
    expect(subscriptionMonthlyCents(sub({ items, discounts: [{ coupon: 'c1' }] }), [coupon({ percent_off: 50, applies_to: ['addon'] })])).toBe(11000);
    expect(subscriptionMonthlyCents(sub({ items, discounts: [{ coupon: 'c1' }] }), [coupon({ amount_off: 500 })])).toBe(11500);
    expect(subscriptionMonthlyCents(sub({ items: [item({ unit_amount: 120000, interval: 'year' })], discounts: [{ coupon: 'c1' }] }), [coupon({ amount_off: 6000 })])).toBe(9500);
    expect(subscriptionMonthlyCents(sub({ items, discounts: [{ coupon: 'unknown' }] }), [coupon({ percent_off: 50 })])).toBe(12000);
    expect(subscriptionMonthlyCents(sub({ items, discounts: [{ coupon: 'c1' }] }), [coupon({ amount_off: 999999 })])).toBe(0);
    expect(subscriptionMonthlyCents(sub({ items: [] }), [])).toBe(0);
  });

  it('takes an amount coupon once per invoice and only from the items it applies to', () => {
    const items = [item({ product: 'plan', unit_amount: 50000 }), item({ product: 'addon', unit_amount: 2000 })];
    // $100 off restricted to a $20 add-on takes $20, not $100.
    expect(subscriptionMonthlyCents(sub({ items, discounts: [{ coupon: 'c1' }] }), [coupon({ amount_off: 10000, applies_to: ['addon'] })])).toBe(50000);
    // A restriction to a product the subscription does not carry takes nothing.
    expect(subscriptionMonthlyCents(sub({ items, discounts: [{ coupon: 'c1' }] }), [coupon({ amount_off: 10000, applies_to: ['other'] })])).toBe(52000);
    // $300 off a $900 quarterly invoice is $100 a month off $300 a month.
    const quarterly = [item({ unit_amount: 90000, interval: 'month', interval_count: 3 })];
    expect(subscriptionMonthlyCents(sub({ items: quarterly, discounts: [{ coupon: 'c1' }] }), [coupon({ amount_off: 30000 })])).toBe(20000);
  });

  it('leaves a subscription whose payment collection is paused out of MRR', () => {
    const totals = monthlyTotals([sub(), sub({ pause_behavior: 'void' }), sub({ status: 'past_due', pause_behavior: 'keep_as_draft' })], []);
    expect(totals).toEqual({ subscriptions: 3, mrrCents: 4900, arrCents: 58800, trialMrrCents: 0, byStatus: { active: 2, past_due: 1 } });
    expect(monthlyTotals([sub({ pause_behavior: null })], []).mrrCents).toBe(4900);
  });

  it('counts paying and past-due subscriptions as MRR and a trial apart', () => {
    const totals = monthlyTotals([sub(), sub({ status: 'past_due' }), sub({ status: 'trialing' }), sub({ status: 'paused' }), sub({ status: 'unpaid' }), sub({ status: 'canceled' })], []);
    expect(totals).toEqual({ subscriptions: 6, mrrCents: 9800, arrCents: 117600, trialMrrCents: 4900, byStatus: { active: 1, past_due: 1, trialing: 1, paused: 1, unpaid: 1, canceled: 1 } });
    expect(monthlyTotals([], [])).toEqual({ subscriptions: 0, mrrCents: 0, arrCents: 0, trialMrrCents: 0, byStatus: {} });
    expect(revenueStatuses).toEqual(['active', 'past_due']);
  });

  it('is the very same maths as the Billing screen, on every fixture', () => {
    const coupons = [coupon({ id: 'pct', percent_off: 15 }), coupon({ id: 'amt', amount_off: 700 }), coupon({ id: 'scoped', percent_off: 40, applies_to: ['p2'] })];
    const fixtures = [
      sub(), sub({ status: 'trialing' }), sub({ status: 'past_due', items: [item({ quantity: 3 }), item({ product: 'p2', unit_amount: 1999, interval: 'year' })] }),
      sub({ discounts: [{ coupon: 'pct' }, { coupon: 'amt' }] }), sub({ discounts: [{ coupon: 'scoped' }], items: [item(), item({ product: 'p2', unit_amount: 25000 })] }),
      sub({ items: [item({ interval: 'week', unit_amount: 1234 }), item({ interval: 'day', unit_amount: 77, quantity: 9 })], discounts: [{ coupon: 'amt' }] }),
      sub({ status: 'canceled' }), sub({ items: [item({ unit_amount: null })] }),
    ];
    for (const fixture of fixtures) expect(screenSubscription(fixture, coupons)).toBe(subscriptionMonthlyCents(fixture, coupons));
    for (const entry of fixtures.flatMap(fixture => fixture.items)) expect(screenItem(entry)).toBe(itemMonthlyCents(entry));
    expect(billingTotals(fixtures, coupons)).toEqual(monthlyTotals(fixtures, coupons));
    expect([...screenStatuses]).toEqual([...revenueStatuses]);
  });
});
