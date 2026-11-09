import { HttpError } from './sms-auth.mjs';
import { foundersCatalog } from './founders-catalog.mjs';
import { normalizers, withAllSubscriptionItems } from './stripe.mjs';

export const FOUNDERS_COUPON = 'caremetric_founders_sale_50_12m_20261108';
export const FOUNDERS_OFFER = 'founders_sale_20261108';
const ref = value => typeof value === 'string' ? value : value?.id;
const discounts = object => object.discounts ?? (object.discount ? [object.discount] : []);
const couponOf = discount => ref(discount.source?.coupon ?? discount.coupon);
const isFounders = discount => couponOf(discount) === FOUNDERS_COUPON;
const invoiceSubscription = invoice => normalizers.invoice(invoice).subscription;
// Replacements of verified prices that keep the offer (followFoundersReplacements).
const followed = new Map();
export const foundersPrice = price => foundersCatalog[ref(price)] ?? followed.get(ref(price));

/**
 * Applications whose Founders prices keep the offer when a price change replaces
 * them: Intel, whose prices the Hub changes from Intel's own catalog
 * (server/app-catalog-sync.mjs), and CareBase (Train included), whose prices an
 * administrator changes in the Hub.
 */
export const FOUNDERS_FOLLOW_APPS = Object.freeze(['caremetric-intel', 'carebase']);

/** The Stripe products whose prices followFoundersReplacements needs: the Founders products of FOUNDERS_FOLLOW_APPS. */
export function foundersFollowProducts(apps = FOUNDERS_FOLLOW_APPS) {
  return [...new Set(Object.values(foundersCatalog).filter(entry => apps.includes(entry.app)).map(entry => entry.product))].sort();
}

/**
 * A price change creates a new Stripe price and archives the old one, stamping
 * the new price's `hub_replaces` with the old id. For the applications in
 * FOUNDERS_FOLLOW_APPS, a price that replaces a verified Founders price (directly
 * or through earlier replacements), on the same product and not a customer's
 * contract price, keeps the offer at its own amount: a new Starter price is
 * still Starter. Everything else stays as founders-catalog.mjs lists it, and the
 * coupon's product scope is unchanged because the products are the same.
 * `prices` are Stripe price objects (active and archived) of those products;
 * the result replaces what was followed before. Returns the count followed.
 */
export function followFoundersReplacements(prices, apps = FOUNDERS_FOLLOW_APPS) {
  const byId = new Map(prices.map(price => [price.id, price]));
  const origin = (price, seen = new Set()) => {
    const known = foundersCatalog[price.id];
    if (known) return known;
    const prior = price.metadata?.hub_replaces;
    if (typeof prior !== 'string' || seen.has(price.id)) return null;
    seen.add(price.id);
    const before = foundersCatalog[prior] ? { id: prior, product: foundersCatalog[prior].product } : byId.get(prior);
    if (!before || ref(before.product) !== ref(price.product)) return null;
    return foundersCatalog[prior] ?? origin(before, seen);
  };
  const next = new Map();
  for (const price of prices) {
    if (foundersCatalog[price.id] || price.metadata?.hub_tenant_id || !Number.isInteger(price.unit_amount)) continue;
    const base = origin(price);
    if (!base || !apps.includes(base.app) || base.product !== ref(price.product)) continue;
    next.set(price.id, { app: base.app, product: base.product, kind: base.kind, amount: price.unit_amount });
  }
  followed.clear();
  for (const [id, entry] of next) followed.set(id, entry);
  return next.size;
}
export const foundersMetadata = { hub_founders_sale: FOUNDERS_OFFER, hub_founders_origin: 'paid' };

export function foundersAmounts(lines) {
  const standard = lines.reduce((sum, line) => sum + (foundersPrice(line.price)?.amount ?? line.amount) * line.quantity, 0);
  const saving = lines.reduce((sum, line) => sum + Math.round((foundersPrice(line.price)?.amount ?? 0) * line.quantity / 2), 0);
  return { standard_recurring_subtotal: standard, recurring_subtotal: standard - saving,
    founders_sale: { percent_off: 50, months: 12, savings: saving } };
}

export async function verifyFoundersCoupon(live) {
  const coupon = await live.get(`/v1/coupons/${FOUNDERS_COUPON}`);
  const expected = [...new Set(Object.values(foundersCatalog).map(price => price.product))].sort();
  if (!coupon.valid || coupon.percent_off !== 50 || coupon.duration !== 'repeating' || coupon.duration_in_months !== 12
    || JSON.stringify([...(coupon.applies_to?.products ?? [])].sort()) !== JSON.stringify(expected)) {
    throw new HttpError(503, 'The Founders Sale could not be verified. Please try again before paying.');
  }
}

async function selectionEligible(live, app, lines) {
  if (!['carebase', 'caremetric-intel'].includes(app) || !lines.length
    || !lines.some(line => foundersPrice(line.price)?.app === app && foundersPrice(line.price)?.kind === 'plan')) return false;
  const eligibleProducts = new Set(Object.values(foundersCatalog).map(price => price.product));
  for (const line of lines) {
    const known = foundersPrice(line.price);
    if (known && known.app !== app) return false;
    if (!known) {
      const price = await live.get(`/v1/prices/${ref(line.price)}`);
      // Extra seats/onboarding stay at full price. An unpublished contract price on a campaign product is excluded entirely.
      if (!ref(price.product) || eligibleProducts.has(ref(price.product))) return false;
    }
  }
  return true;
}

/** Server-owned catalog and complete paid history decide eligibility, never a browser flag or promo code. */
export async function foundersEligibility(live, { app, customer, lines, ownSubscription, ownQuote, ownInvoice, ownRequest }) {
  if (!await selectionEligible(live, app, lines)) return false;
  if (customer) {
    const account = await live.get(`/v1/customers/${customer}`);
    if (account.deleted || discounts(account).length) return false;
    const history = await live.list('/v1/subscriptions', { customer, status: 'all', expand: ['data.discounts'] }, 1000);
    const invoices = await live.list('/v1/invoices', { customer, status: 'paid' }, 1000);
    if (history.truncated || invoices.truncated) throw new HttpError(409, 'Billing history needs reconciliation before this offer can be verified.');
    const relevant = history.filter(sub => !sub.metadata?.app || sub.metadata.app === app
      || sub.items?.data?.some(item => foundersPrice(item.price)?.app === app));
    const ownPurchase = sub => ownQuote && sub.metadata?.hub_checkout_quote === ownQuote || ownRequest && sub.metadata?.hub_creation_request === ownRequest;
    for (const sub of relevant) {
      if (sub.id === ownSubscription || ownPurchase(sub)) continue;
      if (sub.metadata?.hub_founders_sale || discounts(sub).length || !['trialing', 'canceled', 'incomplete_expired'].includes(sub.status)) return false;
    }
    const ids = new Set(relevant.filter(sub => !ownPurchase(sub)).map(sub => sub.id));
    if (invoices.some(invoice => invoice.id !== ownInvoice && (invoice.total > 0 || invoice.subtotal > 0)
      && (ids.has(invoiceSubscription(invoice)) || !invoiceSubscription(invoice) && (!invoice.metadata?.app || invoice.metadata.app === app)))) return false;
  }
  await verifyFoundersCoupon(live);
  return true;
}

export function foundersWindow(subscription) {
  if (subscription.metadata?.hub_founders_sale !== FOUNDERS_OFFER) return null;
  const start = Number(subscription.metadata.hub_founders_start)
    || (subscription.metadata.hub_founders_origin === 'paid' ? subscription.start_date : subscription.trial_end || subscription.start_date);
  if (!Number.isSafeInteger(start) || start <= 0) return null;
  const end = new Date(start * 1000), day = end.getUTCDate();
  end.setUTCDate(1); end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setUTCDate(Math.min(day, new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate()));
  return { start, end: Math.floor(end.getTime() / 1000) };
}

/**
 * Stripe waits for invoice.created acknowledgement before automatic finalization. Trial conversions
 * attach the coupon to both the subscription and its first draft paid invoice here. The calendar
 * window is anchored to paid service, so a delayed webhook cannot grant a thirteenth discounted bill.
 * No customer is charged here; duplicate deliveries repeat the same provider idempotency keys.
 */
export async function applyFoundersToInvoice(live, invoiceId) {
  let invoice = await live.get(`/v1/invoices/${invoiceId}`, { expand: ['discounts'] });
  const subscriptionId = invoiceSubscription(invoice);
  if (!subscriptionId || !['subscription_create', 'subscription_cycle', 'subscription_update'].includes(invoice.billing_reason)) return;
  let sub = await withAllSubscriptionItems(live, await live.get(`/v1/subscriptions/${subscriptionId}`, { expand: ['discounts'] }));
  const app = sub.metadata?.app;
  if (!['carebase', 'caremetric-intel'].includes(app) || !sub.metadata?.hub_tenant_id) return;
  const lines = (sub.items?.data ?? []).map(item => ({ price: ref(item.price), quantity: item.quantity ?? 1 }));
  let window = foundersWindow(sub);
  const subDiscounts = discounts(sub), invoiceDiscounts = discounts(invoice);
  const subHas = subDiscounts.some(isFounders), invoiceHas = invoiceDiscounts.some(isFounders);
  const previouslyApplied = sub.metadata?.hub_founders_origin === 'paid' || Boolean(sub.metadata?.hub_founders_start);
  // Expired or deliberately removed offers do not re-enroll, or constrain later ordinary contracts.
  // A trial awaiting its first paid invoice has neither a paid origin nor a saved paid-service start.
  if (window && previouslyApplied && !subHas && !invoiceHas) return;
  // Existing paid contracts are never enrolled retroactively. A trial's zero-dollar invoice is skipped.
  if (!window) {
    if (!sub.trial_end || sub.status === 'trialing' || invoice.billing_reason !== 'subscription_cycle' || invoice.subtotal <= 0
      || discounts(sub).length || discounts(invoice).length) return;
    if (!await foundersEligibility(live, { app, customer: ref(sub.customer), lines, ownSubscription: sub.id, ownInvoice: invoice.id })) return;
    sub = { ...sub, metadata: { ...sub.metadata, ...foundersMetadata, hub_founders_start: String(sub.trial_end) } };
    window = foundersWindow(sub);
  }
  // Existing administrator-selected agreements take precedence over automatic enrollment and its price restrictions.
  // Still reconcile a lingering Founders coupon on service beyond the original introductory year.
  const replacementAgreement = subDiscounts.some(discount => !isFounders(discount)) || invoiceDiscounts.some(discount => !isFounders(discount));
  if (replacementAgreement && !subHas && !invoiceHas) return;
  if (!replacementAgreement && !await selectionEligible(live, app, lines)) {
    if (invoice.status === 'draft') await live.post(`/v1/invoices/${invoice.id}`, { auto_advance: false }, { idempotencyKey: `hub-founders-hold-${invoice.id}` });
    throw new HttpError(409, 'This subscription changed to pricing outside the Founders Sale. Reconcile its agreement before payment.');
  }
  const invoiceLines = await live.list(`/v1/invoices/${invoice.id}/lines`, {}, 1000);
  if (invoiceLines.truncated) throw new HttpError(503, 'The Founders Sale invoice needs reconciliation before payment.');
  const eligibleLines = invoiceLines.filter(line => line.amount > 0 && (replacementAgreement || foundersPrice(line.price ?? line.pricing?.price_details?.price)));
  if (!eligibleLines.length) return;
  const inside = eligibleLines.every(line => line.period?.start >= window.start && line.period?.end <= window.end);
  const outside = eligibleLines.every(line => line.period?.start >= window.end);
  if (replacementAgreement && !outside) return;
  if (!inside && !outside) {
    if (invoice.status === 'draft') await live.post(`/v1/invoices/${invoice.id}`, { auto_advance: false }, { idempotencyKey: `hub-founders-hold-${invoice.id}` });
    throw new HttpError(409, 'This invoice crosses the Founders Sale renewal boundary. Review its service dates before payment.');
  }
  if (invoice.status !== 'draft') {
    if (inside !== invoiceHas) throw new HttpError(409, 'The finalized invoice needs Founders Sale reconciliation.');
    return;
  }
  if (inside && !subHas && !previouslyApplied) {
    await verifyFoundersCoupon(live);
    await live.post(`/v1/subscriptions/${sub.id}`, { discounts: [{ coupon: FOUNDERS_COUPON }], proration_behavior: 'none',
      metadata: { ...foundersMetadata, hub_founders_start: String(window.start) } }, { idempotencyKey: `hub-founders-subscription-${sub.id}` });
  } else if (outside && subHas) {
    await live.post(`/v1/subscriptions/${sub.id}`, { discounts: subDiscounts.filter(discount => !isFounders(discount)).map(discount => ({ discount: ref(discount) })), proration_behavior: 'none' }, { idempotencyKey: `hub-founders-expire-subscription-${sub.id}` });
  }
  if (inside && !invoiceHas) {
    await verifyFoundersCoupon(live);
    invoice = await live.post(`/v1/invoices/${invoice.id}`, { discounts: [{ coupon: FOUNDERS_COUPON }] }, { idempotencyKey: `hub-founders-invoice-${invoice.id}` });
  } else if (outside && invoiceHas) {
    await live.post(`/v1/invoices/${invoice.id}`, { discounts: invoiceDiscounts.filter(discount => !isFounders(discount)).map(discount => ({ discount: ref(discount) })) }, { idempotencyKey: `hub-founders-expire-invoice-${invoice.id}` });
  }

}
