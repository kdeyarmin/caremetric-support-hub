import { z } from 'zod';

/**
 * Customer invitations (docs/CUSTOMER_INVITATIONS.md): the owner invites one customer to one application at a plan price they authorize,
 * with a discount from 0 to 100%. The browser and the server parse the same schemas, and the emails, the welcome page and the Billing
 * page describe the price and the discount with the same words.
 */
export const invitationApps = ['carebase', 'breathe', 'caremetric-intel'] as const;
export type InvitationApp = typeof invitationApps[number];
export const invitationAppNames: Record<InvitationApp, string> = {
  carebase: 'CareMetric CareBase', breathe: 'CareMetric Breathe', 'caremetric-intel': 'CareMetric Intel',
};
export const discountDurations = ['forever', 'once', 'repeating'] as const;
export type DiscountDuration = typeof discountDurations[number];

const controlFree = (value: string, newlines = false) => [...value].every(char => {
  const code = char.charCodeAt(0);
  return (code >= 32 && code !== 127) || (newlines && char === '\n');
});
const line = (max: number, message: string) => z.string().trim().max(max).refine(value => controlFree(value), 'Use plain text without control characters.')
  .refine(value => value.length > 0, message);

export const invitationRecordSchema = z.object({
  app: z.enum(invitationApps, 'Choose CareBase, Breathe or CareMetric Intel.'),
  contact_name: line(120, 'Enter the contact\'s name.'),
  contact_email: z.string().trim().toLowerCase().pipe(z.email('Enter the contact\'s email address.').max(320)),
  organization_name: line(180, 'Enter the organization\'s name.').refine(value => value.length >= 2, 'Enter the organization\'s name.'),
  price: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/, 'Choose a plan price.'),
  quantity: z.number().int().min(1, 'Enter a quantity from 1 to 10,000.').max(10_000, 'Enter a quantity from 1 to 10,000.'),
  discount_percent: z.number().min(0, 'Enter a discount from 0 to 100%.').max(100, 'Enter a discount from 0 to 100%.')
    .refine(value => Math.round(value * 100) === value * 100, 'Use at most two decimal places for the discount.'),
  discount_duration: z.enum(discountDurations),
  discount_months: z.number().int().min(1, 'A discount for some months lasts 1 to 36 months.').max(36, 'A discount for some months lasts 1 to 36 months.').nullable(),
  note: z.string().transform(value => value.replace(/\r\n?/g, '\n').trim())
    .pipe(z.string().max(1000, 'Keep the personal note under 1,000 characters.').refine(value => controlFree(value, true), 'Use plain text without control characters.')),
}).strict().superRefine((value, ctx) => {
  if ((value.discount_duration === 'repeating') !== (value.discount_months !== null) && value.discount_percent > 0) {
    ctx.addIssue({ code: 'custom', message: 'Choose how many months the discount lasts.', path: ['discount_months'] });
  }
});
export type InvitationRecord = z.infer<typeof invitationRecordSchema>;

/** The record as the server stores it: a 0% discount has no duration. */
export function normalizedRecord(record: InvitationRecord): InvitationRecord {
  if (record.discount_percent === 0) return { ...record, discount_duration: 'forever', discount_months: null };
  return record.discount_duration === 'repeating' ? record : { ...record, discount_months: null };
}

const version = z.number().int().min(0);
export const invitationCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('preview'), invitation: invitationRecordSchema }).strict(),
  z.object({ action: z.literal('create'), invitation: invitationRecordSchema, request_key: z.guid() }).strict(),
  z.object({ action: z.literal('resend'), id: z.guid(), expected_version: version }).strict(),
  z.object({ action: z.literal('revoke'), id: z.guid(), expected_version: version }).strict(),
  z.object({ action: z.literal('link'), id: z.guid(), expected_version: version }).strict(),
]);
export type InvitationCommand = z.infer<typeof invitationCommandSchema>;

export const invitationStatuses = ['pending', 'checkout', 'active', 'claimed', 'revoked', 'expired'] as const;
export type InvitationStatus = typeof invitationStatuses[number];
export const invitationStatusLabels: Record<InvitationStatus, string> = {
  pending: 'Invited', checkout: 'Paying in Stripe', active: 'Active · waiting for sign-up', claimed: 'Signed up', revoked: 'Revoked', expired: 'Expired',
};

const ts = z.string().nullable();
export const invitationSchema = z.object({
  id: z.guid(), app: z.enum(invitationApps), contact_name: z.string(), contact_email: z.string(), organization_name: z.string(),
  price: z.string(), plan_name: z.string(), unit_label: z.string(), pricing_model: z.enum(['flat', 'per_unit']), quantity: z.number().int(),
  unit_amount: z.number().int(), currency: z.string(), interval: z.enum(['day', 'week', 'month', 'year']), interval_count: z.number().int(),
  discount_percent: z.coerce.number(), discount_duration: z.enum(discountDurations), discount_months: z.number().int().nullable(), note: z.string(),
  status: z.enum(invitationStatuses), expires_at: z.string(), tenant_id: z.guid().nullable(), subscription: z.string().nullable(),
  pending_account_hint: z.string().nullable(), pending_account_at: ts, account_hint: z.string().nullable(), claim_method: z.string().nullable(), claimed_at: ts,
  email_status: z.enum(['sent', 'failed', 'unknown']).nullable(), email_sent_at: ts, send_count: z.number().int(),
  accepted_at: ts, activated_at: ts, revoked_at: ts, created_at: z.string(), version: z.number().int(),
});
export type Invitation = z.infer<typeof invitationSchema>;
export const invitationListSchema = z.object({ invitations: z.array(invitationSchema) }).strict();
export const invitationPreviewSchema = z.object({ subject: z.string(), html: z.string(), text: z.string() }).strict();
export const invitationResultSchema = z.object({ invitation: invitationSchema, delivery: z.enum(['sent', 'failed', 'unknown']).nullable() }).strict();

// ---- How a price and its discount read, in the emails, on the welcome page and on the Billing page ---------------------------------------

export type PricedOffer = Pick<InvitationRecord, 'quantity' | 'discount_percent' | 'discount_duration' | 'discount_months'> & {
  unit_amount: number; currency: string; interval: 'day' | 'week' | 'month' | 'year'; interval_count: number;
  pricing_model: 'flat' | 'per_unit'; unit_label: string; plan_name: string;
};

export function money(cents: number, currency = 'usd') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}
/** "per month", "every 3 months", "per year". */
export function every(interval: PricedOffer['interval'], count = 1) {
  return count > 1 ? `every ${count} ${interval}s` : `per ${interval}`;
}
/** "facility" → "facilities", "seat" → "seats", "branch" → "branches"; one of them stays as it is. */
export function plural(noun: string, count: number) {
  const word = noun.trim() || 'unit';
  if (count === 1) return word;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}
/** "3 facilities", "1 seat". */
export const quantityLabel = (offer: Pick<PricedOffer, 'quantity' | 'unit_label'>) => `${offer.quantity} ${plural(offer.unit_label, offer.quantity)}`;
/** The regular price and the discounted price of one billing period, in cents (Stripe rounds the same way, to the nearest cent). */
export function offerAmounts(offer: Pick<PricedOffer, 'unit_amount' | 'quantity' | 'discount_percent'>) {
  const regular = offer.unit_amount * offer.quantity;
  const discount = Math.round(regular * offer.discount_percent / 100);
  return { regular, discount, discounted: regular - discount };
}
/** The plan's regular price: "$199.00 per month", "$199.00 per facility per month", or "$597.00 per month ($199.00 per facility × 3)". */
export function regularPriceLabel(offer: PricedOffer) {
  const period = every(offer.interval, offer.interval_count);
  const unit = money(offer.unit_amount, offer.currency);
  if (offer.pricing_model !== 'per_unit') return `${unit} ${period}`;
  const noun = offer.unit_label.trim() || 'unit';
  if (offer.quantity === 1) return `${unit} per ${noun} ${period}`;
  return `${money(offer.unit_amount * offer.quantity, offer.currency)} ${period} (${unit} per ${noun} × ${offer.quantity})`;
}
export const isComplimentary = (offer: Pick<PricedOffer, 'discount_percent'>) => offer.discount_percent >= 100;
const percent = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0$/, '')}%`;
/** How long the discount lasts, after "50% off": "for as long as you subscribe", "for your first 12 months", "on your first invoice". */
export function durationWords(offer: Pick<PricedOffer, 'discount_duration' | 'discount_months' | 'interval'>) {
  if (offer.discount_duration === 'forever') return 'for as long as you subscribe';
  if (offer.discount_duration === 'once') return offer.interval === 'year' ? 'on your first year' : `on your first ${offer.interval}'s invoice`;
  const months = offer.discount_months ?? 1;
  return months === 1 ? 'for your first month' : `for your first ${months} months`;
}
/** "50% off for your first 12 months", "Complimentary (100% off) for as long as you subscribe", or "No discount". */
export function discountLabel(offer: Pick<PricedOffer, 'discount_percent' | 'discount_duration' | 'discount_months' | 'interval'>) {
  if (offer.discount_percent <= 0) return 'No discount';
  if (isComplimentary(offer)) return `Complimentary (100% off) ${durationWords(offer)}`;
  return `${percent(offer.discount_percent)} off ${durationWords(offer)}`;
}
/** What they pay: "$298.50 per month for your first 12 months, then $597.00 per month", or "$0.00 — complimentary". */
export function yourPriceLabel(offer: PricedOffer) {
  const { regular, discounted } = offerAmounts(offer);
  const period = every(offer.interval, offer.interval_count);
  if (offer.discount_percent <= 0) return `${money(regular, offer.currency)} ${period}`;
  const now = discounted === 0 ? `${money(0, offer.currency)} (complimentary)` : `${money(discounted, offer.currency)} ${period}`;
  if (offer.discount_duration === 'forever') return now;
  return `${now} ${durationWords(offer)}, then ${money(regular, offer.currency)} ${period}`;
}
