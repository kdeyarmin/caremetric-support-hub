import { z } from 'zod';
import { appRequest } from '../lib/appSession';

const text = (max: number) => z.string().max(max).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'Use plain text without control characters.');
export const tenantStatuses = ['active','suspended','closed'] as const;
export type TenantStatus = typeof tenantStatuses[number];
export const statusLabels: Record<TenantStatus,string> = {active:'Active',suspended:'Suspended',closed:'Closed'};
export const intervalLabels = {month:'month',year:'year'} as const;
export const maxPriceCents = 100_000_000;

/** One application's subscription exactly as hub.save_tenant_subscription accepts it: paid, or complimentary with a reason. */
export const subscriptionRecordSchema = z.object({
  access_status: z.enum(tenantStatuses),
  plan_name: text(80).trim().min(1,'Enter a plan name.'),
  price_cents: z.number().int().min(0).max(maxPriceCents,'Enter a price up to $1,000,000.'),
  billing_interval: z.enum(['month','year']),
  complimentary: z.boolean(),
  complimentary_reason: text(300).trim(),
  complimentary_until: z.union([z.literal(''),z.iso.date()]),
  notes: text(1000).trim(),
}).strict().refine(value => value.complimentary || value.price_cents > 0, {
  message:'Enter a price, or make the subscription complimentary.', path:['price_cents'],
}).refine(value => !value.complimentary || !!value.complimentary_reason, {
  message:'Record why the subscription is complimentary.', path:['complimentary_reason'],
}).refine(value => value.complimentary || (!value.complimentary_reason && !value.complimentary_until), {
  message:'Only a complimentary subscription has a complimentary reason or end date.', path:['complimentary_reason'],
}).refine(value => !value.complimentary_until || value.price_cents > 0, {
  message:'Enter the price that applies after the complimentary period ends.', path:['price_cents'],
});
export type SubscriptionRecord = z.infer<typeof subscriptionRecordSchema>;

/** Slugs that app onboarding generates stay reserved for it. */
export const newTenantSchema = z.object({
  name: text(180).trim().min(2,'Enter the tenant name.'),
  slug: z.string().min(2,'Enter a slug.').max(63,'Use a slug of 63 characters or fewer.').regex(/^[a-z0-9]+(-[a-z0-9]+)*$/,'Use a slug of lowercase letters, numbers and single hyphens.')
    .refine(value => !/^(carebase|support)-/.test(value),'Slugs beginning with carebase- or support- are reserved for app onboarding.'),
  industry: text(120).trim(),
  subscriptions: z.array(subscriptionRecordSchema.safeExtend({product_id:z.guid()})).max(20),
}).strict();
export type NewTenant = z.infer<typeof newTenantSchema>;

export const tenantEditSchema = z.object({
  name: text(180).trim().min(2,'Enter the tenant name.'),
  industry: text(120).trim(),
  status: z.enum(tenantStatuses),
}).strict();
export type TenantEdit = z.infer<typeof tenantEditSchema>;

const pricingSchema = z.object({
  plan_name:z.string(), price_cents:z.number().int().min(0), billing_interval:z.enum(['month','year']),
  complimentary:z.boolean(), complimentary_reason:z.string(), complimentary_until:z.string(), notes:z.string(),
  version:z.number().int().positive(), updated_at:z.string(),
});
export type SubscriptionPricing = z.infer<typeof pricingSchema>;
const subscriptionSchema = z.object({
  product_id:z.guid(), product_slug:z.string(), product_name:z.string(), access_status:z.enum(tenantStatuses), pricing:pricingSchema.nullable(),
});
export type TenantSubscription = z.infer<typeof subscriptionSchema>;
export const tenantAccountSchema = z.object({
  id:z.guid(), slug:z.string(), name:z.string(), industry:z.string(), status:z.enum(tenantStatuses),
  created_at:z.string(), updated_at:z.string(), linked:z.boolean(), member_count:z.number().int().min(0),
  subscriptions:z.array(subscriptionSchema),
});
export type TenantAccount = z.infer<typeof tenantAccountSchema>;
const productSchema = z.object({id:z.guid(), slug:z.string(), name:z.string(), status:z.string()});
export type TenantProduct = z.infer<typeof productSchema>;
const listSchema = z.object({tenants:z.array(tenantAccountSchema), products:z.array(productSchema), loaded_at:z.string()});
export type TenantAccountList = z.infer<typeof listSchema>;

export const tenantAccountsClient = {
  async list(signal?: AbortSignal) {return listSchema.parse(await appRequest('rpc/list_tenant_accounts',{},signal));},
  async create(record: NewTenant) {return tenantAccountSchema.parse(await appRequest('rpc/create_tenant',{p_record:newTenantSchema.parse(record)}));},
  async saveTenant(tenant: TenantAccount, record: TenantEdit) {
    return tenantAccountSchema.parse(await appRequest('rpc/save_tenant',{p_tenant_id:tenant.id,p_record:tenantEditSchema.parse(record),p_expected_updated_at:tenant.updated_at}));
  },
  async saveSubscription(tenant: TenantAccount, productId: string, record: SubscriptionRecord, previous: SubscriptionPricing|null) {
    return tenantAccountSchema.parse(await appRequest('rpc/save_tenant_subscription',{p_tenant_id:tenant.id,p_product_id:productId,p_record:subscriptionRecordSchema.parse(record),p_expected_version:previous?.version??0}));
  },
};
export type TenantAccountsClient = typeof tenantAccountsClient;

/** "$1,299.50", "1299.5" or "499" as whole cents; null when it is not a dollar amount up to $1,000,000. */
export function parseDollars(value: string): number|null {
  const cleaned = value.trim().replace(/^\$/,'').replace(/,/g,'');
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const cents = Number(match[1])*100 + Number((match[2] ?? '').padEnd(2,'0'));
  return cents <= maxPriceCents ? cents : null;
}
export function centsToDollars(cents: number) {
  return (cents/100).toFixed(2);
}
const usd = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
export function formatCents(cents: number) {
  return usd.format(cents/100);
}
export function formatDay(day: string) {
  return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(day+'T00:00:00Z'));
}
/** Today's date where the administrator is, as YYYY-MM-DD. */
export function localToday(now = new Date()) {
  return [now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
}
export function slugify(name: string) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,63).replace(/-+$/,'');
}

/** Complimentary through its end date (inclusive), or indefinitely when no end date is recorded. */
export function isComplimentaryNow(pricing: SubscriptionPricing, today: string) {
  return pricing.complimentary && (!pricing.complimentary_until || pricing.complimentary_until >= today);
}
export function priceLabel(pricing: SubscriptionPricing|null, today: string) {
  if (!pricing) return 'No pricing recorded';
  const price = formatCents(pricing.price_cents)+' per '+intervalLabels[pricing.billing_interval];
  if (!pricing.complimentary) return price;
  if (!isComplimentaryNow(pricing,today)) return price+' · complimentary period ended '+formatDay(pricing.complimentary_until);
  if (pricing.complimentary_until) return 'Complimentary (free) until '+formatDay(pricing.complimentary_until)+', then '+price;
  return pricing.price_cents ? 'Complimentary (free) · regular price '+price : 'Complimentary (free)';
}

/** Paid subscriptions an active tenant is using now, by recorded price; yearly prices count as one twelfth per month. */
export function recordedMonthlyCents(tenants: TenantAccount[], today: string) {
  let total = 0;
  for (const tenant of tenants) {
    if (tenant.status !== 'active') continue;
    for (const item of tenant.subscriptions) {
      if (item.access_status !== 'active' || !item.pricing || isComplimentaryNow(item.pricing,today)) continue;
      total += item.pricing.billing_interval === 'year' ? item.pricing.price_cents/12 : item.pricing.price_cents;
    }
  }
  return Math.round(total);
}
