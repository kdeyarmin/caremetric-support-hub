// Monthly recurring revenue, in one place. The Billing screen (src/billing/billingModel.ts) and the AI team's account report
// (server/agents/accounts) both use these functions, so the two can never disagree about a figure.
//
// This file has no imports and uses only syntax that Node can strip, because the Hub server loads it directly (the Dockerfile
// copies it). Keep it that way: a runtime import here would need a `.ts` specifier and a COPY line of its own.

export interface MoneyItem { unit_amount: number | null; quantity: number; interval: string | null; interval_count: number | null; product: string }
export interface MoneyCoupon { id: string; percent_off: number | null; amount_off: number | null; applies_to: readonly string[] }
export interface MoneySubscription { status: string; items: readonly MoneyItem[]; discounts: readonly { coupon: string }[] }
export interface MoneyTotals { subscriptions: number; mrrCents: number; arrCents: number; trialMrrCents: number; byStatus: Partial<Record<string, number>> }

const perMonth: Record<string, number> = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 };

/** One recurring item's list amount per month, before discounts. */
export function itemMonthlyCents(item: Pick<MoneyItem, 'unit_amount' | 'quantity' | 'interval' | 'interval_count'>): number {
  if (item.unit_amount === null || !item.interval) return 0;
  return (item.unit_amount * item.quantity * perMonth[item.interval]) / (item.interval_count || 1);
}

/**
 * Monthly recurring revenue of one subscription after its discounts. A percent
 * coupon reduces the items it applies to; an amount coupon is spread over the
 * subscription's interval. Never below zero.
 */
export function subscriptionMonthlyCents(subscription: Pick<MoneySubscription, 'items' | 'discounts'>, coupons: readonly MoneyCoupon[]): number {
  let total = subscription.items.reduce((sum, item) => sum + itemMonthlyCents(item), 0);
  for (const discount of subscription.discounts) {
    const coupon = coupons.find(entry => entry.id === discount.coupon);
    if (!coupon) continue;
    const applies = (item: MoneyItem) => !coupon.applies_to.length || coupon.applies_to.includes(item.product);
    if (coupon.percent_off !== null) {
      const base = subscription.items.filter(applies).reduce((sum, item) => sum + itemMonthlyCents(item), 0);
      total -= base * coupon.percent_off / 100;
    } else if (coupon.amount_off !== null) {
      const interval = subscription.items.find(item => item.interval)?.interval ?? 'month';
      total -= coupon.amount_off * perMonth[interval];
    }
  }
  return Math.max(0, Math.round(total));
}

/** Paying statuses count toward MRR; a trial is reported separately and paused or unpaid collection is not revenue. */
export const revenueStatuses: readonly string[] = ['active', 'past_due'];

export function monthlyTotals(subscriptions: readonly MoneySubscription[], coupons: readonly MoneyCoupon[]): MoneyTotals {
  const byStatus: Partial<Record<string, number>> = {};
  let mrr = 0, trial = 0;
  for (const subscription of subscriptions) {
    byStatus[subscription.status] = (byStatus[subscription.status] ?? 0) + 1;
    const monthly = subscriptionMonthlyCents(subscription, coupons);
    if (revenueStatuses.includes(subscription.status)) mrr += monthly;
    else if (subscription.status === 'trialing') trial += monthly;
  }
  return { subscriptions: subscriptions.length, mrrCents: mrr, arrCents: mrr * 12, trialMrrCents: trial, byStatus };
}
