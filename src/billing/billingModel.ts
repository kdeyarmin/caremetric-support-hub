import { z } from 'zod';
import { appLabels, billingApps, historicalBillingApps, type BillingApp } from './billingProtocol';
import type { ActorContext, Product } from '../domain';
import { itemMonthlyCents, monthlyTotals, revenueStatuses as revenueStatusList, subscriptionMonthlyCents } from './billingMath.ts';

/** Organization payment navigation follows the same paid-app memberships as the server. */
export function canManageOrganizationBilling(actor: Pick<ActorContext, 'role' | 'memberships'>, products: readonly Pick<Product, 'id' | 'slug'>[]): boolean {
  return actor.role !== 'platform_admin' && actor.memberships.some(membership => membership.role === 'tenant_admin'
    && products.some(product => product.id === membership.productId && billingApps.some(app => app === product.slug)));
}

/** The Billing workspace as hub.billing_workspace() returns it; Stripe stays the source of truth. */
const ts = z.string().nullable();
export const subscriptionStatuses = ['trialing', 'active', 'past_due', 'paused', 'unpaid', 'incomplete', 'incomplete_expired', 'canceled'] as const;
export type SubscriptionStatus = typeof subscriptionStatuses[number];
export const statusLabels: Record<SubscriptionStatus, string> = {
  trialing: 'Trial', active: 'Active', past_due: 'Past due', paused: 'Paused', unpaid: 'Unpaid', incomplete: 'Awaiting first payment',
  incomplete_expired: 'Expired before payment', canceled: 'Canceled',
};
const appSlug = z.enum(historicalBillingApps).nullable().catch(null);
export const itemSchema = z.object({
  id: z.string(), price: z.string(), product: z.string(), quantity: z.number().int(), unit_amount: z.number().int().nullable(), currency: z.string(),
  interval: z.enum(['day', 'week', 'month', 'year']).nullable(), interval_count: z.number().int().nullable(), product_name: z.string(),
  kind: z.enum(['plan', 'addon', 'fee']), unit_label: z.string(), pricing_model: z.string(), custom: z.boolean(),
});
export type SubscriptionItem = z.infer<typeof itemSchema>;
export const discountSchema = z.object({ id: z.string(), coupon: z.string(), promotion_code: z.string().nullable() });
export const subscriptionSchema = z.object({
  id: z.string(), tenant_id: z.guid(), customer: z.string(), app: appSlug, status: z.enum(subscriptionStatuses),
  collection_method: z.enum(['charge_automatically', 'send_invoice']), cancel_at_period_end: z.boolean(), cancel_at: ts, canceled_at: ts, ended_at: ts,
  current_period_start: ts, current_period_end: ts, trial_start: ts, trial_end: ts, pause_behavior: z.string().nullable(), pause_resumes_at: ts,
  discounts: z.array(discountSchema), created: z.string(), version: z.number().int(), items: z.array(itemSchema),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
export const customerSchema = z.object({ id: z.string(), email: z.string(), name: z.string(), delinquent: z.boolean(), balance: z.number(), version: z.number().int() });
export const tenantSchema = z.object({
  id: z.guid(), slug: z.string(), name: z.string(), industry: z.string(), status: z.enum(['active', 'suspended', 'closed']), updated_at: z.string(),
  customer: customerSchema.nullable(),
});
export type BillingTenant = z.infer<typeof tenantSchema>;
export const productSchema = z.object({
  id: z.string(), app: appSlug, name: z.string(), description: z.string(), active: z.boolean(), kind: z.enum(['plan', 'addon', 'fee']),
  entitlement_key: z.string(), unit_label: z.string(), created: z.string(), version: z.number().int(),
});
export type CatalogProduct = z.infer<typeof productSchema>;
export const priceSchema = z.object({
  id: z.string(), product: z.string(), active: z.boolean(), currency: z.string(), unit_amount: z.number().int().nullable(),
  pricing_model: z.enum(['flat', 'per_unit', 'tiered', 'custom']), type: z.enum(['recurring', 'one_time']),
  interval: z.enum(['day', 'week', 'month', 'year']).nullable(), interval_count: z.number().int().nullable(), lookup_key: z.string().nullable(),
  nickname: z.string(), tenant_id: z.guid().nullable(), replaces: z.string().nullable(), created: z.string(), version: z.number().int(), subscribers: z.number().int(),
});
export type CatalogPrice = z.infer<typeof priceSchema>;
export const couponSchema = z.object({
  id: z.string(), name: z.string(), percent_off: z.number().nullable(), amount_off: z.number().int().nullable(), currency: z.string().nullable(),
  duration: z.enum(['once', 'repeating', 'forever']), duration_in_months: z.number().int().nullable(), max_redemptions: z.number().int().nullable(),
  times_redeemed: z.number().int(), redeem_by: ts, valid: z.boolean(), applies_to: z.array(z.string()), app: appSlug, created: z.string(), version: z.number().int(),
  // A coupon deleted in Stripe still discounts the subscriptions that already have it, so the money maths keeps it; it is not listed or offered.
  deleted: z.boolean().default(false),
});
export type Coupon = z.infer<typeof couponSchema>;
export const promotionCodeSchema = z.object({
  id: z.string(), code: z.string(), coupon: z.string(), active: z.boolean(), customer: z.string().nullable(), max_redemptions: z.number().int().nullable(),
  times_redeemed: z.number().int(), expires_at: ts, first_time_transaction: z.boolean(), minimum_amount: z.number().int().nullable(), created: z.string(), version: z.number().int(),
});
export type PromotionCode = z.infer<typeof promotionCodeSchema>;
export const appKeySchema = z.object({ id: z.guid(), app: z.string(), hint: z.string(), created_at: z.string(), last_used_at: ts, revoked_at: ts });
export type AppKey = z.infer<typeof appKeySchema>;
export const workspaceSchema = z.object({
  mode: z.enum(['live', 'test', 'unverified']), account: z.string().nullable(),
  apps: z.array(z.object({ id: z.guid(), slug: z.string(), name: z.string(), status: z.string() })),
  tenants: z.array(tenantSchema), subscriptions: z.array(subscriptionSchema), products: z.array(productSchema), prices: z.array(priceSchema),
  coupons: z.array(couponSchema), promotion_codes: z.array(promotionCodeSchema), app_keys: z.array(appKeySchema),
  webhook: z.object({ last_received_at: ts, events_24h: z.number().int() }), loaded_at: z.string(),
});
export type BillingWorkspace = z.infer<typeof workspaceSchema>;
export const invoiceSchema = z.object({
  id: z.string(), tenant_id: z.guid(), subscription: z.string().nullable(), app: appSlug, status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']),
  number: z.string().nullable(), currency: z.string(), total: z.number().int(), amount_due: z.number().int(), amount_paid: z.number().int(),
  amount_remaining: z.number().int(), hosted_invoice_url: z.string().nullable(), invoice_pdf: z.string().nullable(),
  collection_method: z.string().nullable(), period_start: ts, period_end: ts, due_date: ts, created: z.string(), version: z.number().int(),
});
export type Invoice = z.infer<typeof invoiceSchema>;
export const customerDetailSchema = tenantSchema.extend({
  subscriptions: z.array(subscriptionSchema), custom_prices: z.array(priceSchema), invoices: z.array(invoiceSchema),
  links: z.array(z.object({ app: z.string(), hint: z.string(), version: z.number().int(), linked_at: z.string() })),
  usage: z.array(z.object({ app: z.string(), metric: z.string(), quantity: z.number().int(), outcome: z.string(), reported_at: z.string() })),
  loaded_at: z.string(),
});
export type CustomerDetail = z.infer<typeof customerDetailSchema>;

// ---------------------------------------------------------------------------
// Money. Amounts are integer cents; MRR normalizes every recurring item to a month.

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export function formatCents(cents: number, currency = 'usd') {
  if (currency === 'usd') return usd.format(cents / 100);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}
/** "$1,299.50", "1299.5" or "499" as whole cents; null when it is not a dollar amount up to $1,000,000. */
export function parseDollars(value: string): number | null {
  const cleaned = value.trim().replace(/^\$/, '').replace(/,/g, '');
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents <= 100_000_000 ? cents : null;
}
export const centsToDollars = (cents: number) => (cents / 100).toFixed(2);

// The revenue maths lives in billingMath.ts so the server's account report uses the very same functions.
export { itemMonthlyCents, subscriptionMonthlyCents };
/** Paying statuses count toward MRR; a trial is reported separately and paused or unpaid collection is not revenue. */
export const revenueStatuses: readonly SubscriptionStatus[] = revenueStatusList as readonly SubscriptionStatus[];
export const liveStatuses: readonly SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'paused', 'unpaid', 'incomplete'];
export interface BillingTotals { subscriptions: number; mrrCents: number; arrCents: number; trialMrrCents: number; byStatus: Partial<Record<SubscriptionStatus, number>> }
export function billingTotals(subscriptions: readonly Subscription[], coupons: readonly Coupon[]): BillingTotals {
  return monthlyTotals(subscriptions, coupons) as BillingTotals;
}

/**
 * Current subscription counts per application, for the control center and the portfolio rollup. They count what the Billing
 * screen shows by default ("Current (not canceled)"), so a figure and the page it links to agree and churn does not inflate it.
 */
export interface AppBillingSummary { app: BillingApp; subscriptionCount: number; statusCounts: Array<{ status: string; count: number }>; mrrCents: number }
export function summarizeByApp(workspace: Pick<BillingWorkspace, 'subscriptions' | 'coupons'>): Record<BillingApp, AppBillingSummary> {
  return Object.fromEntries(historicalBillingApps.map(app => {
    const rows = workspace.subscriptions.filter(subscription => subscription.app === app && liveStatuses.includes(subscription.status));
    const totals = billingTotals(rows, workspace.coupons);
    return [app, { app, subscriptionCount: rows.length, mrrCents: totals.mrrCents,
      statusCounts: subscriptionStatuses.filter(status => totals.byStatus[status]).map(status => ({ status, count: totals.byStatus[status] ?? 0 })) }];
  })) as Record<BillingApp, AppBillingSummary>;
}

export function priceLabel(price: Pick<CatalogPrice, 'unit_amount' | 'currency' | 'type' | 'interval' | 'interval_count' | 'pricing_model'>, unitLabel = '') {
  if (price.unit_amount === null) return price.pricing_model === 'tiered' ? 'Tiered (set in Stripe)' : 'Customer-entered amount';
  const amount = formatCents(price.unit_amount, price.currency);
  const unit = price.pricing_model === 'per_unit' ? ` per ${unitLabel || 'unit'}` : '';
  if (price.type === 'one_time') return `${amount}${unit} one-time`;
  const every = price.interval_count && price.interval_count > 1 ? `every ${price.interval_count} ${price.interval}s` : `per ${price.interval}`;
  return `${amount}${unit} ${every}`;
}
export function couponLabel(coupon: Pick<Coupon, 'percent_off' | 'amount_off' | 'currency' | 'duration' | 'duration_in_months'>) {
  const off = coupon.percent_off !== null ? `${coupon.percent_off}% off` : `${formatCents(coupon.amount_off ?? 0, coupon.currency ?? 'usd')} off`;
  const how = coupon.duration === 'forever' ? 'forever' : coupon.duration === 'once' ? 'once' : `for ${coupon.duration_in_months} months`;
  return `${off} ${how}`;
}
export const appLabel = (app: string | null) => app && app in appLabels ? appLabels[app as BillingApp] : 'Unassigned';
export function dateLabel(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}
