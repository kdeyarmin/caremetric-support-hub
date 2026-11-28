import { z } from 'zod';
import { centralHubApps, isCentralHubApp } from '../hubScope.ts';
import { sourceId } from '../self-service/protocol.ts';
import { appCustomerBillingRequest } from './customerBillingProtocol.ts';
import { planSizeFacts } from './planSize.ts';

/**
 * The closed set of billing commands the Hub server runs against Stripe for a
 * platform administrator. The browser and the server parse the same schemas,
 * so a field the server does not expect is rejected before Stripe is called.
 */
const plain = (max: number) => z.string().max(max).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'Use plain text without control characters.');
const stripeId = (prefix?: string) => z.string().regex(prefix ? new RegExp(`^${prefix}_[A-Za-z0-9]{1,250}$`) : /^[A-Za-z0-9_-]{1,255}$/);
export const historicalBillingApps = ['carebase', 'breathe', 'caremetric-emr', 'caremetric-go', 'caremetric-intel'] as const;
export const billingApps = centralHubApps;
export type BillingApp = typeof historicalBillingApps[number];
export const appLabels: Record<BillingApp, string> = {
  carebase: 'CareBase', breathe: 'Breathe', 'caremetric-emr': 'CareMetric EMR', 'caremetric-go': 'CareMetric Go', 'caremetric-intel': 'CareMetric Intel',
};
export const maxAmountCents = 100_000_000;
const amount = z.number().int().min(0).max(maxAmountCents);
const version = z.number().int().min(0);
const requestKey = z.guid();
export const prorations = ['create_prorations', 'none', 'always_invoice'] as const;
export const proration = z.enum(prorations);
const day = z.iso.date();
const quantity = z.number().int().min(1).max(100_000);

const customerSave = z.object({ action: z.literal('customer.save'), tenant_id: z.guid(), email: z.email().max(320), name: plain(256).trim().min(1), expected_version: version, request_key: requestKey }).strict();
const subscriptionCreate = z.object({
  action: z.literal('subscription.create'), tenant_id: z.guid(), app: z.enum(historicalBillingApps),
  items: z.array(z.object({ price: stripeId(), quantity }).strict()).min(1).max(20),
  trial_days: z.number().int().min(0).max(730), collection_method: z.enum(['charge_automatically', 'send_invoice']),
  days_until_due: z.number().int().min(1).max(365),
  coupon: stripeId().nullable(), promotion_code: stripeId('promo').nullable(), request_key: requestKey,
}).strict();
const subscriptionTarget = { subscription: stripeId('sub'), expected_version: version, request_key: requestKey };
const itemAdd = z.object({ action: z.literal('subscription.item.add'), ...subscriptionTarget, price: stripeId(), quantity, proration }).strict();
const itemUpdate = z.object({ action: z.literal('subscription.item.update'), ...subscriptionTarget, item: stripeId('si'), price: stripeId().nullable(), quantity: quantity.nullable(), proration }).strict()
  .refine(value => value.price !== null || value.quantity !== null, 'Change the price or the quantity.');
const itemRemove = z.object({ action: z.literal('subscription.item.remove'), ...subscriptionTarget, item: stripeId('si'), proration }).strict();
const trial = z.object({ action: z.literal('subscription.trial'), ...subscriptionTarget, trial_end: z.union([day, z.literal('now')]) }).strict();
const cancel = z.object({ action: z.literal('subscription.cancel'), ...subscriptionTarget, when: z.enum(['period_end', 'immediately', 'undo']), prorate: z.boolean() }).strict();
const pause = z.object({ action: z.literal('subscription.pause'), ...subscriptionTarget, behavior: z.enum(['void', 'keep_as_draft', 'mark_uncollectible']), resumes_at: day.nullable() }).strict();
const resume = z.object({ action: z.literal('subscription.resume'), ...subscriptionTarget }).strict();
const discount = z.object({ action: z.literal('subscription.discount'), ...subscriptionTarget, op: z.enum(['apply', 'remove']), coupon: stripeId().nullable(), promotion_code: stripeId('promo').nullable() }).strict()
  .refine(value => (value.coupon === null) !== (value.promotion_code === null), 'Choose a coupon or a promotion code.');
const productFields = { name: plain(250).trim().min(1), description: plain(2000).trim(), kind: z.enum(['plan', 'addon', 'fee']), unit_label: plain(12).trim(), entitlement_key: z.string().regex(/^[a-z0-9_.-]{0,64}$/) };
const productCreate = z.object({ action: z.literal('product.create'), app: z.enum(historicalBillingApps), ...productFields, request_key: requestKey }).strict();
const productUpdate = z.object({ action: z.literal('product.update'), product: stripeId(), app: z.enum(historicalBillingApps).nullable(), ...productFields, active: z.boolean(), expected_version: version, request_key: requestKey }).strict();
const priceCreate = z.object({
  action: z.literal('price.create'), product: stripeId(), pricing_model: z.enum(['flat', 'per_unit']), type: z.enum(['recurring', 'one_time']),
  interval: z.enum(['month', 'year']).nullable(), unit_amount: amount, nickname: plain(250).trim(), tenant_id: z.guid().nullable(), request_key: requestKey,
}).strict().refine(value => (value.type === 'recurring') === (value.interval !== null), 'Recurring prices bill monthly or yearly; one-time fees have no interval.');
export const migrations = ['grandfather', 'prorate', 'no_proration'] as const;
const priceChange = z.object({ action: z.literal('price.change'), price: stripeId(), unit_amount: amount, migrate: z.enum(migrations), expected_version: version, request_key: requestKey }).strict();
const priceArchive = z.object({ action: z.literal('price.archive'), price: stripeId(), active: z.boolean(), expected_version: version, request_key: requestKey }).strict();
const couponCreate = z.object({
  action: z.literal('coupon.create'), name: plain(40).trim().min(1), percent_off: z.number().gt(0).max(100).nullable(), amount_off: amount.nullable(),
  duration: z.enum(['once', 'repeating', 'forever']), duration_in_months: z.number().int().min(1).max(120).nullable(),
  max_redemptions: z.number().int().min(1).max(1_000_000).nullable(), redeem_by: day.nullable(),
  app: z.enum(historicalBillingApps).nullable(), products: z.array(stripeId()).max(50), request_key: requestKey,
}).strict()
  .refine(value => (value.percent_off === null) !== (value.amount_off === null || value.amount_off === 0), 'Enter a percent or an amount off.')
  .refine(value => (value.duration === 'repeating') === (value.duration_in_months !== null), 'A repeating discount lasts a number of months.');
const couponUpdate = z.object({ action: z.literal('coupon.update'), coupon: stripeId(), name: plain(40).trim().min(1), expected_version: version, request_key: requestKey }).strict();
const couponDelete = z.object({ action: z.literal('coupon.delete'), coupon: stripeId(), expected_version: version, request_key: requestKey }).strict();
const promotionCreate = z.object({
  action: z.literal('promotion_code.create'), coupon: stripeId(), code: z.string().regex(/^[A-Za-z0-9-]{3,50}$/, 'Use 3 to 50 letters, digits and dashes.'),
  max_redemptions: z.number().int().min(1).max(1_000_000).nullable(), expires_at: day.nullable(), first_time_transaction: z.boolean(),
  minimum_amount: amount.nullable(), tenant_id: z.guid().nullable(), request_key: requestKey,
}).strict();
const promotionUpdate = z.object({ action: z.literal('promotion_code.update'), promotion_code: stripeId('promo'), active: z.boolean(), expected_version: version, request_key: requestKey }).strict();
const invoiceSend = z.object({ action: z.literal('invoice.send'), invoice: stripeId('in'), expected_version: version, request_key: requestKey }).strict();
const portal = z.object({ action: z.literal('customer.portal'), tenant_id: z.guid() }).strict();
const customerSync = z.object({ action: z.literal('customer.sync'), tenant_id: z.guid() }).strict();
const catalogSync = z.object({ action: z.literal('catalog.sync') }).strict();
const accountLink = z.object({ action: z.literal('account.link'), tenant_id: z.guid(), app: z.enum(historicalBillingApps), account: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Use the account id exactly as the application shows it.'), expected_version: version }).strict();
const accountUnlink = z.object({ action: z.literal('account.unlink'), tenant_id: z.guid(), app: z.enum(historicalBillingApps), expected_version: version }).strict();
const appKeyIssue = z.object({ action: z.literal('app_key.issue'), app: z.enum(historicalBillingApps) }).strict();
const appKeyRevoke = z.object({ action: z.literal('app_key.revoke'), key_id: z.guid() }).strict();

export const billingCommandSchema = z.union([
  customerSave, subscriptionCreate, itemAdd, itemUpdate, itemRemove, trial, cancel, pause, resume, discount,
  productCreate, productUpdate, priceCreate, priceChange, priceArchive, couponCreate, couponUpdate, couponDelete,
  promotionCreate, promotionUpdate, invoiceSend, portal, customerSync, catalogSync, accountLink, accountUnlink, appKeyIssue, appKeyRevoke,
]).superRefine((command, context) => {
  if ('app' in command && command.app !== null && !isCentralHubApp(command.app)) {
    context.addIssue({ code: 'custom', message: 'This application is independent of the centralized Hub.' });
  }
});
export type BillingCommand = z.infer<typeof billingCommandSchema>;
export type BillingAction = BillingCommand['action'];
/** Commands that only touch the Hub database and work before Stripe is configured. */
export const localBillingActions: ReadonlySet<string> = new Set(['account.link', 'account.unlink', 'app_key.issue', 'app_key.revoke']);

export const billingResultSchema = z.object({
  ok: z.literal(true), url: z.string().optional(), key: z.string().optional(),
  migrated: z.number().int().optional(), failed: z.number().int().optional(), incomplete: z.literal(true).optional(), synced: z.number().int().optional(),
  id: z.string().optional(),
}).strict();
export type BillingResult = z.infer<typeof billingResultSchema>;

/** Application requests, authenticated by an application key. */
export const entitlementRequestSchema = z.object({ account: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
export const usageReportSchema = z.object({
  account: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), metric: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  quantity: z.number().int().min(0).max(1_000_000), request_key: z.guid(),
}).strict();
// An application opens one of its own customers' Stripe billing; the customer returns to the application's https page.
const httpsReturn = z.string().max(2048).refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } });
export const appPortalRequestSchema = z.object({ account: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), return_url: httpsReturn, payment_method_only: z.boolean().optional() }).strict();
// An application changes one of its own customers' plans and add-ons for that organization's administrator. The
// application vouches for the administrator and reports the facilities it bills and their plan-size facts, as it does
// for the Hub customer center's purchasing authority; the customer returns from Stripe Checkout to its https page.
export const appBillingRequestSchema = z.object({
  account: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), return_url: httpsReturn,
  actor: z.object({ id: sourceId }).strict(),
  scope: z.object({
    facilities: z.array(z.object({ id: sourceId, name: plain(180).trim().min(1) }).strict()).max(1000),
    plan_size: planSizeFacts.nullable(),
  }).strict(),
  request: appCustomerBillingRequest,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.scope.facilities.map(site => site.id)).size !== value.scope.facilities.length) ctx.addIssue({ code: 'custom', message: 'Duplicate facility.' });
});
export type AppBillingRequest = z.infer<typeof appBillingRequestSchema>;
// An application sets the quantity of one of its own customers' per-unit add-ons (CareMetric Intel: its additional
// marketers and AI packs), for that organization's administrator. The application decides the quantity, by its entitlement
// key; the Hub prices it for the subscription's plan and billing cycle (server/billing.mjs appAddons).
export const appAddonRequestSchema = z.object({
  account: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  actor: z.object({ id: sourceId }).strict(),
  addon: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  quantity: z.number().int().min(0).max(1000),
  request_key: z.guid(),
}).strict();
export type AppAddonRequest = z.infer<typeof appAddonRequestSchema>;
export const trialRequestSchema = z.object({
  account: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), name: plain(180).trim().min(2), email: z.email().max(320).nullable(),
  plan: z.string().regex(/^[a-z0-9_.-]{1,64}$/).nullable(),
  interval: z.enum(['month', 'year']).optional(),
  require_payment_method: z.boolean().optional(),
  // The code of an owner's invitation (the `hub_invite` its sign-up link carries): the account joins the invitation's plan instead of a
  // trial. A code that cannot be used is refused (409) and starts nothing.
  invite: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
}).strict();
