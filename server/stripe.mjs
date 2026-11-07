import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A small Stripe REST client for the Hub's platform billing. The Hub is the
 * only Stripe client for platform billing, so this module owns the API version
 * pin, form encoding, idempotency keys and webhook signature verification.
 * Secrets never appear in thrown messages or logs.
 */
export const STRIPE_API_VERSION = '2026-02-25.clover';
// New Checkout sessions use the current API without changing existing integrations.
export const CHECKOUT_API_VERSION = '2026-08-26.dahlia';
/** The CareMetric account. A key for any other account is refused at startup. */
export const STRIPE_ACCOUNT_ID = 'acct_1SinLKB06O2UFlNz';

export class StripeError extends Error {
  constructor(status, type, code, message) {
    super(message); this.status = status; this.type = type; this.code = code;
  }
}

/** Stripe's bracketed form encoding: a[b][0][c]=d. Undefined values are left out; null clears a field. */
export function formEncode(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === null) out.append(name, '');
    else if (Array.isArray(value)) {
      if (!value.length) out.append(name, '');
      value.forEach((item, index) => {
        if (item !== null && typeof item === 'object') formEncode(item, `${name}[${index}]`, out);
        else out.append(`${name}[${index}]`, String(item));
      });
    } else if (typeof value === 'object') formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

export const keyMode = key => /^(sk|rk)_live_/.test(key ?? '') ? 'live' : /^(sk|rk|rkcs)_test_/.test(key ?? '') ? 'test' : null;

export function stripeClient({ secretKey, fetchImpl = fetch, apiBase = 'https://api.stripe.com', timeoutMs = 20000 }) {
  if (!keyMode(secretKey)) return null;
  async function request(method, path, params, { idempotencyKey, apiVersion = STRIPE_API_VERSION } = {}) {
    if (!/^\/v1\/[A-Za-z0-9_/.-]+$/.test(path)) throw new Error('Invalid Stripe path.');
    // As Stripe's own SDKs do, GET and DELETE carry their parameters in the query string (a DELETE body may be ignored, which would
    // silently drop an immediate cancel's proration and final invoice); only POST has a form body.
    const inQuery = method === 'GET' || method === 'DELETE';
    const encoded = params ? formEncode(params).toString() : '';
    const query = inQuery && encoded ? `?${encoded}` : '';
    const headers = { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': apiVersion };
    if (!inQuery) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey && method === 'POST') headers['Idempotency-Key'] = idempotencyKey;
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(`${apiBase}${path}${query}`, {
          method, headers, body: inQuery ? undefined : formEncode(params).toString(),
          redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Retry once with the same idempotency key; GETs and DELETEs are safe to repeat.
        if (attempt === 0 && (method !== 'POST' || idempotencyKey)) continue;
        throw new StripeError(503, 'api_connection_error', null, 'Stripe could not be reached. Try again.');
      }
      let body = null;
      try { body = await response.json(); } catch { /* handled below */ }
      if (response.ok && body) return body;
      if (attempt === 0 && (response.status === 429 || response.status >= 500) && (method !== 'POST' || idempotencyKey)) continue;
      const error = body?.error ?? {};
      // Stripe's own messages are safe to show an administrator; they never contain the key.
      throw new StripeError(response.status, error.type ?? 'api_error', error.code ?? null,
        typeof error.message === 'string' ? error.message.slice(0, 500) : 'Stripe rejected the request.');
    }
  }
  return {
    mode: keyMode(secretKey),
    get: (path, params, options) => request('GET', path, params, options),
    post: (path, params, options) => request('POST', path, params, options),
    del: (path, params) => request('DELETE', path, params),
    /**
     * Every page of a list endpoint, up to `max` rows. `truncated` is set when Stripe
     * still has more, so a caller never treats a cut-off page as the full list.
     */
    async list(path, params = {}, max = 1000) {
      const rows = []; let starting_after; let truncated = false;
      while (rows.length < max) {
        const limit = Math.min(100, max - rows.length);
        const page = await request('GET', path, { ...params, limit, ...(starting_after ? { starting_after } : {}) });
        const data = Array.isArray(page?.data) ? page.data : [];
        rows.push(...data.slice(0, limit));
        const more = page?.has_more === true || data.length > limit;
        if (!more || !data.length) break;
        if (rows.length >= max) { truncated = true; break; }
        const next = data[Math.min(data.length, limit) - 1]?.id;
        if (!next || next === starting_after) break;
        starting_after = next;
      }
      if (truncated) rows.truncated = true;
      return rows;
    },
  };
}

/**
 * Verifies a Stripe-Signature header (t=…,v1=…) over the exact raw body with
 * any of the configured endpoint secrets, within a five-minute tolerance.
 */
export function verifyStripeSignature(rawBody, header, secrets, { now = Date.now(), toleranceSeconds = 300 } = {}) {
  if (typeof header !== 'string' || header.length > 2000 || !secrets?.length) return false;
  const parts = header.split(',').map(part => part.split('=')).filter(pair => pair.length === 2);
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value).filter(value => /^[0-9a-f]{64}$/.test(value));
  if (!timestamp || !/^[0-9]{1,12}$/.test(timestamp) || !signatures.length) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)]);
  return secrets.some(secret => {
    const expected = createHmac('sha256', secret).update(payload).digest();
    return signatures.some(signature => {
      const given = Buffer.from(signature, 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  });
}

/** Signs a payload as Stripe does; used by tests and the local fake. */
export function signStripePayload(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

// ---------------------------------------------------------------------------
// Normalizers: one Stripe object to the closed record private.billing_sync accepts.

export const hubApps = Object.freeze(['carebase', 'breathe', 'caremetric-emr', 'caremetric-go', 'caremetric-intel']);
const idOf = value => typeof value === 'string' ? value : value && typeof value === 'object' && typeof value.id === 'string' ? value.id : null;
const appOf = metadata => hubApps.includes(metadata?.app) ? metadata.app : null;
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null;
const int = value => Number.isInteger(value) ? value : null;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : null;
const entitlementKey = value => {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9_.-]{1,64}$/.test(key) ? key : '';
};

export function normalizeCustomer(customer, livemode = customer.livemode) {
  return {
    id: customer.id, tenant_id: uuid(customer.metadata?.hub_tenant_id), email: text(customer.email, 320) ?? '',
    name: text(customer.name, 256) ?? '', delinquent: customer.delinquent === true, balance: int(customer.balance) ?? 0,
    deleted: customer.deleted === true, livemode: livemode === true,
  };
}

export function normalizeProduct(product, livemode = product.livemode) {
  const metadata = Object.fromEntries(Object.entries(product.metadata ?? {})
    .filter(([key, value]) => typeof value === 'string' && key.length <= 40).slice(0, 50).map(([key, value]) => [key, value.slice(0, 500)]));
  const kindValue = metadata.kind ?? metadata.package_kind;
  const kind = ['plan', 'addon', 'fee'].includes(kindValue) ? kindValue : /onboarding|setup|migration/.test(metadata.tier ?? '') ? 'fee' : 'plan';
  return {
    id: product.id, app: appOf(product.metadata), name: text(product.name, 250) || product.id, description: text(product.description, 2000) ?? '',
    active: product.deleted === true ? false : product.active === true, kind,
    entitlement_key: entitlementKey(metadata.entitlement ?? metadata.plan ?? metadata.tier),
    unit_label: text(product.unit_label, 12) ?? '', metadata, livemode: livemode === true, created: int(product.created) ?? 0,
  };
}

export function normalizePrice(price, livemode = price.livemode) {
  const model = ['flat', 'per_unit'].includes(price.metadata?.pricing_model) ? price.metadata.pricing_model
    : price.billing_scheme === 'tiered' ? 'tiered' : price.custom_unit_amount ? 'custom' : price.metadata?.billing_metric && price.metadata.billing_metric !== 'flat' ? 'per_unit' : 'flat';
  return {
    id: price.id, product: idOf(price.product), active: price.deleted === true ? false : price.active === true, currency: price.currency,
    unit_amount: int(price.unit_amount), pricing_model: model, type: price.type === 'one_time' ? 'one_time' : 'recurring',
    interval: price.recurring?.interval ?? null, interval_count: price.recurring ? int(price.recurring.interval_count) ?? 1 : null,
    lookup_key: text(price.lookup_key, 200), nickname: text(price.nickname, 250) ?? '', tenant_id: uuid(price.metadata?.hub_tenant_id),
    replaces: typeof price.metadata?.hub_replaces === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(price.metadata.hub_replaces) ? price.metadata.hub_replaces : null,
    livemode: livemode === true, created: int(price.created) ?? 0,
  };
}

/** An expanded discount's id, coupon and promotion code across API versions (discount.coupon or discount.source.coupon). */
export function discountRef(discount) {
  if (!discount || typeof discount !== 'object' || typeof discount.id !== 'string' || !/^di_[A-Za-z0-9]+$/.test(discount.id)) return null;
  const coupon = idOf(discount.coupon) ?? idOf(discount.source?.coupon);
  return coupon ? { id: discount.id, coupon, promotion_code: idOf(discount.promotion_code) } : null;
}

/**
 * A subscription retrieve includes only the first page of items (10) and sets `items.has_more`
 * when a plan plus add-ons runs past that. The Hub allows 20 prices, so the rest are loaded
 * before any comparison, mirror, or quantity change. A list that is still cut off throws.
 */
export async function withAllSubscriptionItems(live, subscription) {
  if (!subscription?.items?.has_more) return subscription;
  const data = await live.list('/v1/subscription_items', { subscription: subscription.id, expand: ['data.price'] }, 100);
  if (!Array.isArray(data) || data.truncated) {
    throw new StripeError(409, 'invalid_request_error', 'subscription_items_incomplete',
      'This subscription has more prices than the Hub can read in one pass.');
  }
  return { ...subscription, items: { object: 'list', data, has_more: false } };
}

export function normalizeSubscription(subscription, livemode = subscription.livemode) {
  const items = (subscription.items?.data ?? []).map(item => ({
    id: item.id, price: idOf(item.price), product: idOf(item.price?.product), quantity: int(item.quantity) ?? 1,
    unit_amount: int(item.price?.unit_amount), currency: item.price?.currency ?? subscription.currency ?? 'usd',
    interval: item.price?.recurring?.interval ?? null, interval_count: item.price?.recurring ? int(item.price.recurring.interval_count) ?? 1 : null,
  }));
  // Since 2025-03-31 the billing period is on each item; take the span of all items.
  const starts = (subscription.items?.data ?? []).map(item => item.current_period_start).filter(Number.isInteger);
  const ends = (subscription.items?.data ?? []).map(item => item.current_period_end).filter(Number.isInteger);
  return {
    id: subscription.id, customer: idOf(subscription.customer), app: appOf(subscription.metadata), status: subscription.status,
    checkout_required: Object.hasOwn(subscription.metadata ?? {}, 'hub_checkout_quote'),
    checkout_quote: uuid(subscription.metadata?.hub_checkout_quote),
    collection_method: subscription.collection_method === 'send_invoice' ? 'send_invoice' : 'charge_automatically',
    cancel_at_period_end: subscription.cancel_at_period_end === true, cancel_at: int(subscription.cancel_at), canceled_at: int(subscription.canceled_at),
    ended_at: int(subscription.ended_at),
    current_period_start: starts.length ? Math.min(...starts) : int(subscription.current_period_start),
    current_period_end: ends.length ? Math.max(...ends) : int(subscription.current_period_end),
    trial_start: int(subscription.trial_start), trial_end: int(subscription.trial_end),
    pause_behavior: subscription.pause_collection?.behavior ?? null, pause_resumes_at: int(subscription.pause_collection?.resumes_at),
    discounts: (subscription.discounts ?? []).map(discountRef).filter(Boolean),
    items, livemode: livemode === true, created: int(subscription.created) ?? 0,
  };
}

export function normalizeCoupon(coupon, livemode = coupon.livemode) {
  return {
    id: coupon.id, name: text(coupon.name, 40) ?? '', percent_off: typeof coupon.percent_off === 'number' ? coupon.percent_off : null,
    amount_off: int(coupon.amount_off), currency: coupon.amount_off ? coupon.currency : null, duration: coupon.duration,
    duration_in_months: coupon.duration === 'repeating' ? int(coupon.duration_in_months) : null, max_redemptions: int(coupon.max_redemptions),
    times_redeemed: int(coupon.times_redeemed) ?? 0, redeem_by: int(coupon.redeem_by), valid: coupon.deleted === true ? false : coupon.valid === true,
    applies_to: (coupon.applies_to?.products ?? []).filter(value => typeof value === 'string'), app: appOf(coupon.metadata),
    deleted: coupon.deleted === true, livemode: livemode === true, created: int(coupon.created) ?? 0,
  };
}

export function normalizePromotionCode(code, livemode = code.livemode) {
  return {
    id: code.id, code: code.code, coupon: idOf(code.promotion?.coupon) ?? idOf(code.coupon), active: code.active === true,
    customer: idOf(code.customer), max_redemptions: int(code.max_redemptions), times_redeemed: int(code.times_redeemed) ?? 0,
    expires_at: int(code.expires_at), first_time_transaction: code.restrictions?.first_time_transaction === true,
    minimum_amount: int(code.restrictions?.minimum_amount) || null, livemode: livemode === true, created: int(code.created) ?? 0,
  };
}

export function normalizeInvoice(invoice, livemode = invoice.livemode) {
  const subscription = idOf(invoice.parent?.subscription_details?.subscription) ?? idOf(invoice.subscription);
  const https = value => typeof value === 'string' && /^https:\/\/\S{1,1000}$/.test(value) ? value : null;
  return {
    id: invoice.id, customer: idOf(invoice.customer), subscription, app: appOf(invoice.parent?.subscription_details?.metadata ?? invoice.metadata),
    status: invoice.status ?? null, number: text(invoice.number, 100), currency: invoice.currency, total: int(invoice.total) ?? 0,
    subtotal: int(invoice.subtotal) ?? 0, amount_due: int(invoice.amount_due) ?? 0, amount_paid: int(invoice.amount_paid) ?? 0,
    amount_remaining: int(invoice.amount_remaining) ?? 0, hosted_invoice_url: https(invoice.hosted_invoice_url), invoice_pdf: https(invoice.invoice_pdf),
    collection_method: invoice.collection_method ?? null, period_start: int(invoice.period_start), period_end: int(invoice.period_end),
    due_date: int(invoice.due_date), livemode: livemode === true, created: int(invoice.created) ?? 0,
  };
}

/** Which mirrored object an event is about, and how to load its latest state. */
export function eventTarget(event) {
  const object = event?.data?.object;
  const type = event?.type ?? '';
  if (!object || typeof object !== 'object') return null;
  if (type.startsWith('checkout.session.') && object.object === 'checkout.session') return { kind: 'checkout', id: object.id };
  if (type.startsWith('customer.subscription.')) return { kind: 'subscription', id: object.id };
  if (type.startsWith('customer.discount.')) return object.subscription ? { kind: 'subscription', id: idOf(object.subscription) } : null;
  if (type.startsWith('customer.') && object.object === 'customer') return { kind: 'customer', id: object.id };
  if (type.startsWith('product.')) return { kind: 'product', id: object.id };
  if (type.startsWith('price.')) return { kind: 'price', id: object.id };
  if (type.startsWith('coupon.')) return { kind: 'coupon', id: object.id };
  if (type.startsWith('promotion_code.')) return { kind: 'promotion_code', id: object.id };
  if (type.startsWith('invoice.') && object.object === 'invoice') return { kind: 'invoice', id: object.id };
  return null;
}

export const retrievePaths = Object.freeze({
  customer: id => [`/v1/customers/${id}`, {}],
  product: id => [`/v1/products/${id}`, {}],
  price: id => [`/v1/prices/${id}`, {}],
  subscription: id => [`/v1/subscriptions/${id}`, { expand: ['discounts'] }],
  coupon: id => [`/v1/coupons/${id}`, { expand: ['applies_to'] }],
  promotion_code: id => [`/v1/promotion_codes/${id}`, {}],
  invoice: id => [`/v1/invoices/${id}`, {}],
});

export const normalizers = Object.freeze({
  customer: normalizeCustomer, product: normalizeProduct, price: normalizePrice, subscription: normalizeSubscription,
  coupon: normalizeCoupon, promotion_code: normalizePromotionCode, invoice: normalizeInvoice,
});

/** The webhook events the Hub endpoint subscribes to. */
export const webhookEvents = Object.freeze([
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired',
  'customer.created', 'customer.updated', 'customer.deleted',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed', 'customer.subscription.trial_will_end',
  'customer.subscription.pending_update_applied', 'customer.subscription.pending_update_expired',
  'customer.discount.created', 'customer.discount.updated', 'customer.discount.deleted',
  'product.created', 'product.updated', 'product.deleted',
  'price.created', 'price.updated', 'price.deleted',
  'coupon.created', 'coupon.updated', 'coupon.deleted',
  'promotion_code.created', 'promotion_code.updated',
  'invoice.created', 'invoice.finalized', 'invoice.updated', 'invoice.paid', 'invoice.payment_succeeded',
  'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible',
  'invoice.deleted', 'invoice.sent',
]);
