import { createHash, randomBytes } from 'node:crypto';
import { HttpError, transaction, withSession } from './sms-auth.mjs';
import { billingCommandSchema, localBillingActions, entitlementRequestSchema, usageReportSchema, trialRequestSchema } from '../src/billing/billingProtocol.ts';
import { stripeClient, StripeError, STRIPE_ACCOUNT_ID, verifyStripeSignature, eventTarget, retrievePaths, normalizers } from './stripe.mjs';
import { customerBillingService } from './customer-billing.mjs';

/**
 * Platform billing for every CareMetric application. Stripe is the source of
 * truth; this service changes Stripe for an authorized administrator, mirrors
 * what Stripe returns, applies signed webhook events once, opens the customer
 * portal for a tenant administrator, and answers the applications'
 * entitlement, usage and trial requests.
 */
export const appKeyPattern = /^cmb_[A-Za-z0-9_-]{43}$/;
const trialDays = { carebase: 30, breathe: 14, pennsync: 14, 'caremetric-emr': 14, 'caremetric-go': 14, 'caremetric-intel': 14 };
export const entitlementCacheSeconds = 300;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const unixEndOfDay = day => Math.floor(Date.parse(`${day}T23:59:59Z`) / 1000);

function firstIssue(error) {
  const issue = error?.issues?.[0];
  return typeof issue?.message === 'string' && issue.code === 'custom' ? issue.message : 'Check the billing form and try again.';
}
function asHttpError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof StripeError) {
    return error.status >= 500 || error.type === 'api_connection_error'
      ? new HttpError(503, 'Stripe is temporarily unavailable. Try again.')
      : new HttpError(400, `Stripe: ${error.message}`);
  }
  if (error?.code === '28000') return new HttpError(401, 'Sign in with an SMS code to continue.');
  if (error?.code === '42501') return new HttpError(403, 'You do not have access to this billing account.');
  if (error?.code === '40001') return new HttpError(409, 'Billing changed. Refresh and review before saving.');
  if (error?.code === 'P0002') return new HttpError(404, 'That billing record was not found.');
  if (error?.code === '23505') return new HttpError(409, 'That account is already linked to another tenant.');
  if (error?.code === '22023' && typeof error.message === 'string' && error.message.length < 200) return new HttpError(400, error.message);
  return error;
}

export function platformBilling({ pool, secretKey, webhookSecrets = [], accountId = STRIPE_ACCOUNT_ID, portalConfiguration,
  publicOrigin, fetchImpl = fetch, apiBase, now = () => Date.now(), log = console, authorizeCustomerBilling, customerPurchasingEnabled = false }) {
  const client = stripeClient({ secretKey, fetchImpl, ...(apiBase ? { apiBase } : {}) });
  let state = client ? 'pending' : 'unconfigured';
  let verifying = null;

  // A key is used only after GET /v1/account proves it belongs to the CareMetric account.
  async function verify() {
    if (!client) return false;
    if (state === 'ready') return true;
    if (state === 'account_mismatch') return false;
    verifying ??= (async () => {
      try {
        const account = await client.get('/v1/account');
        if (account?.id !== accountId) {
          state = 'account_mismatch';
          log.warn('STRIPE_SECRET_KEY belongs to a different Stripe account; platform billing is disabled.');
          return false;
        }
        await transaction(pool, db => db.query('select private.billing_set_account($1,$2)', [account.id, client.mode === 'live']));
        state = 'ready';
        return true;
      } catch {
        state = 'unreachable';
        return false;
      } finally { verifying = null; }
    })();
    return verifying;
  }
  async function stripe() {
    if (!client) throw new HttpError(503, 'Stripe is not configured. Set STRIPE_SECRET_KEY on the Hub service.');
    if (!(await verify())) {
      throw new HttpError(503, state === 'account_mismatch'
        ? 'The Stripe key on the Hub service belongs to a different Stripe account.'
        : 'Stripe could not be verified. Try again shortly.');
    }
    return client;
  }

  const one = async (db, sql, values) => (await db.query(sql, values)).rows[0];
  const lookup = async (db, kind, id) => (await one(db, 'select private.billing_lookup($1,$2) as v', [kind, id])).v;
  const audit = (db, actor, action, tenant, product, metadata) =>
    db.query('select private.billing_audit($1,$2,$3,$4,$5::jsonb)', [actor ?? null, action, tenant ?? null, product ?? null, JSON.stringify(metadata ?? {})]);
  const lock = (db, kind, id, version) => db.query('select private.billing_lock($1,$2,$3)', [kind, id, version]);

  /** Mirrors one Stripe object, first loading the customer or product it depends on. */
  async function mirror(db, kind, object, seen, { livemode = object?.livemode, live } = {}) {
    const record = normalizers[kind](object, livemode);
    const apply = async () => (await one(db, 'select private.billing_sync($1,$2::jsonb,$3) as outcome', [kind, JSON.stringify(record), seen])).outcome;
    let outcome = await apply();
    if (outcome === 'ignored' && live) {
      if ((kind === 'subscription' || kind === 'invoice') && record.customer) {
        const customer = await live.get(`/v1/customers/${record.customer}`);
        if (!customer.deleted) await mirror(db, 'customer', customer, new Date(now()), { live });
        outcome = await apply();
      } else if (kind === 'price' && record.product) {
        await mirror(db, 'product', await live.get(`/v1/products/${record.product}`), new Date(now()), { live });
        outcome = await apply();
      }
    }
    return outcome;
  }
  /** Loads the latest state of an object from Stripe and mirrors it. */
  async function refresh(db, live, kind, id) {
    const [path, params] = retrievePaths[kind](id);
    const object = await live.get(path, params);
    await mirror(db, kind, object, new Date(now()), { live });
    return object;
  }

  const customerSelfService = customerBillingService({ pool, stripe, now, publicOrigin, purchasingEnabled: customerPurchasingEnabled,
    authorize: authorizeCustomerBilling ?? (() => { throw new HttpError(503, 'Native purchasing verification is unavailable.'); }),
    mirrorSubscription: subscription => transaction(pool, db => mirror(db, 'subscription', subscription, new Date(now()), { live: client })),
    mirrorCustomer: customer => transaction(pool, db => mirror(db, 'customer', customer, new Date(now()), { live: client })),
    mirrorInvoice: invoice => transaction(pool, db => mirror(db, 'invoice', invoice, new Date(now()), { live: client })),
  });

  // ---------------------------------------------------------------------------
  // Webhook: verified, applied once by event id, latest state from Stripe when
  // the key is available (so delivery order never matters), else the event's own
  // snapshot, applied only when newer than what the mirror holds.
  async function webhook(rawBody, signature) {
    if (!webhookSecrets.length) throw new HttpError(503, 'Billing webhooks are not configured.');
    if (!verifyStripeSignature(rawBody, signature, webhookSecrets, { now: now() })) throw new HttpError(400, 'Invalid signature.');
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'Invalid event.'); }
    if (typeof event?.id !== 'string' || !/^evt_[A-Za-z0-9]{1,250}$/.test(event.id) || typeof event.type !== 'string'
      || !Number.isInteger(event.created) || !event.data?.object) throw new HttpError(400, 'Invalid event.');
    const live = client && (await verify()) ? client : null;
    try {
      const receipt = await transaction(pool, async db => {
        await db.query("select pg_advisory_xact_lock(hashtextextended('billing_event:'||$1,0))", [event.id]);
        if ((await one(db, 'select private.billing_event_seen($1) as seen', [event.id])).seen) return { received: true, duplicate: true };
        const target = eventTarget(event);
        let outcome = 'ignored';
        if (target?.id && target.kind !== 'checkout') outcome = await applyEvent(db, live, event, target);
        if (/^[a-z_]+(\.[a-z_]+){1,4}$/.test(event.type)) {
          await db.query('select private.billing_record_event($1,$2,$3,$4,$5,$6)', [event.id, event.type, event.livemode === true,
            target?.id && /^[A-Za-z0-9_-]{1,255}$/.test(target.id) ? target.id : null, new Date(event.created * 1000), outcome]);
        }
        return { received: true };
      });
      // A duplicate receipt can retry reconciliation after a prior provider/database timeout.
      if (eventTarget(event)?.kind === 'checkout') await customerSelfService.reconcileCheckout(event.data.object.id);
      if (live && event.data.object.metadata?.app !== 'caremetric-go' && normalizers.invoice(event.data.object).app !== 'caremetric-go') {
        const target = eventTarget(event);
        if (target?.kind === 'subscription') await customerSelfService.reconcileSubscription(await live.get(`/v1/subscriptions/${target.id}`, { expand: ['latest_invoice', 'discounts'] }));
        if (target?.kind === 'invoice') {
          const invoice = normalizers.invoice(event.data.object);
          if (invoice.subscription) await customerSelfService.reconcileSubscription(await live.get(`/v1/subscriptions/${invoice.subscription}`, { expand: ['latest_invoice', 'discounts'] }));
        }
      }
      return receipt;
    } catch (error) {
      // A failure rolls back and returns an error so Stripe retries the same event.
      log.warn(`Billing webhook ${event.type} could not be applied; Stripe will retry.`);
      throw error instanceof HttpError ? error : new HttpError(503, 'The event could not be applied. Stripe will retry.');
    }
  }
  async function applyEvent(db, live, event, { kind, id }) {
    if (event.type === 'invoice.deleted') {
      await db.query('select private.billing_forget_invoice($1)', [id]);
      return 'applied';
    }
    const deleted = event.type.endsWith('.deleted') && ['customer', 'product', 'price', 'coupon'].includes(kind);
    if (live && !deleted) {
      try {
        const [path, params] = retrievePaths[kind](id);
        const latest = await live.get(path, params);
        return mirror(db, kind, latest, new Date(now()), { live, livemode: event.livemode });
      } catch (error) {
        if (!(error instanceof StripeError && error.status === 404)) throw error;
      }
    }
    if (kind === 'coupon' && deleted) { await db.query('select private.billing_mark_coupon_deleted($1)', [id]); return 'applied'; }
    const snapshot = deleted ? { ...event.data.object, deleted: true } : event.data.object;
    return mirror(db, kind, snapshot, new Date(event.created * 1000), { livemode: event.livemode, live });
  }

  // ---------------------------------------------------------------------------
  // Administrator commands.
  async function command(sessionToken, input) {
    let request;
    try { request = billingCommandSchema.parse(input); } catch (error) { throw new HttpError(400, firstIssue(error)); }
    const live = localBillingActions.has(request.action) ? null : await stripe();
    let followUp = null;
    try {
      const result = await withSession(pool, sessionToken, async db => {
        const actor = (await one(db, 'select hub.authorize_app_command() as actor')).actor;
        await db.query('reset role');
        const outcome = await run(db, live, actor.user_id, request);
        followUp = outcome.followUp ?? null;
        return outcome.result;
      });
      if (followUp) Object.assign(result, await followUp());
      return result;
    } catch (error) { throw asHttpError(error); }
  }

  const idem = (request, suffix = '') => `hub-${request.action}-${request.request_key}${suffix}`;
  async function subscriptionFor(db, request) {
    const subscription = await lookup(db, 'subscription', request.subscription);
    if (!subscription) throw new HttpError(404, 'That subscription was not found. Refresh and try again.');
    await lock(db, 'subscription', request.subscription, request.expected_version);
    return subscription;
  }
  async function priceFor(db, priceId, { app, tenant }) {
    const price = await lookup(db, 'price', priceId);
    if (!price || !price.active || !price.product_active) throw new HttpError(400, 'Choose an active price.');
    if (app && price.app !== app) throw new HttpError(400, 'Choose a price from this application.');
    if (price.tenant_id && price.tenant_id !== tenant) throw new HttpError(400, 'That custom price belongs to another customer.');
    return price;
  }
  const appId = async (db, slug) => {
    const app = await lookup(db, 'app', slug);
    if (!app) throw new HttpError(400, 'Choose an application that bills.');
    return app.id;
  };

  async function run(db, live, actor, request) {
    const done = (extra = {}) => ({ result: { ok: true, ...extra } });
    switch (request.action) {
      case 'customer.save': {
        const context = await one(db, 'select private.billing_context($1) as c', [request.tenant_id]).then(row => row.c);
        await lock(db, 'customer', request.tenant_id, request.expected_version);
        const fields = { email: request.email, name: request.name, metadata: { hub_tenant_id: request.tenant_id } };
        const customer = context.stripe_customer_id
          ? await live.post(`/v1/customers/${context.stripe_customer_id}`, fields, { idempotencyKey: idem(request) })
          : await live.post('/v1/customers', fields, { idempotencyKey: idem(request) });
        await mirror(db, 'customer', customer, new Date(now()), { live });
        await audit(db, actor, 'billing.customer.save', request.tenant_id, null, { customer: customer.id, created: !context.stripe_customer_id });
        return done({ id: customer.id });
      }
      case 'subscription.create': {
        const context = await one(db, 'select private.billing_context($1) as c', [request.tenant_id]).then(row => row.c);
        if (!context.stripe_customer_id) throw new HttpError(400, "Save the customer's billing contact first.");
        if (context.tenant_status !== 'active') throw new HttpError(400, 'Only an active tenant can start a subscription.');
        const app = await appId(db, request.app);
        // One-time prices (onboarding, setup) go on the first invoice; the subscription needs a recurring price.
        const recurring = [], fees = [];
        for (const item of request.items) {
          const price = await priceFor(db, item.price, { app: request.app, tenant: request.tenant_id });
          (price.type === 'recurring' ? recurring : fees).push({ price: item.price, quantity: item.quantity });
        }
        if (!recurring.length) throw new HttpError(400, 'Choose at least one plan or add-on with a recurring price.');
        const charge = request.collection_method === 'charge_automatically';
        const subscription = await live.post('/v1/subscriptions', {
          customer: context.stripe_customer_id, items: recurring, ...(fees.length ? { add_invoice_items: fees } : {}),
          collection_method: request.collection_method, ...(charge ? { payment_behavior: 'allow_incomplete' } : { days_until_due: request.days_until_due }),
          ...(request.trial_days ? { trial_period_days: request.trial_days, trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } } } : {}),
          ...(request.coupon || request.promotion_code ? { discounts: [request.coupon ? { coupon: request.coupon } : { promotion_code: request.promotion_code }] } : {}),
          payment_settings: { save_default_payment_method: 'on_subscription' },
          metadata: { app: request.app, hub_tenant_id: request.tenant_id }, expand: ['discounts'],
        }, { idempotencyKey: idem(request) });
        await mirror(db, 'subscription', subscription, new Date(now()), { live });
        if (subscription.latest_invoice) await refresh(db, live, 'invoice', typeof subscription.latest_invoice === 'string' ? subscription.latest_invoice : subscription.latest_invoice.id);
        await audit(db, actor, 'billing.subscription.create', request.tenant_id, app, {
          subscription: subscription.id, status: subscription.status, items: recurring.length, fees: fees.length, trial_days: request.trial_days,
          collection_method: request.collection_method, coupon: request.coupon, promotion_code: request.promotion_code,
        });
        return done({ id: subscription.id });
      }
      case 'subscription.item.add':
      case 'subscription.item.update':
      case 'subscription.item.remove': {
        const subscription = await subscriptionFor(db, request);
        const isItem = request.action !== 'subscription.item.add';
        if (isItem && !subscription.items.some(item => item.id === request.item)) throw new HttpError(400, 'That item is not on this subscription.');
        const price = request.price ? await priceFor(db, request.price, { app: subscription.app, tenant: subscription.tenant_id }) : null;
        if (price && price.type !== 'recurring' && request.action !== 'subscription.item.add') throw new HttpError(400, 'Choose a recurring price.');
        if (request.action === 'subscription.item.add' && price.type !== 'recurring') {
          // A one-time fee is charged on the subscription's next invoice.
          await live.post(`/v1/subscriptions/${request.subscription}`, { add_invoice_items: [{ price: request.price, quantity: request.quantity }], proration_behavior: 'none' }, { idempotencyKey: idem(request) });
        } else if (request.action === 'subscription.item.add') {
          await live.post('/v1/subscription_items', { subscription: request.subscription, price: request.price, quantity: request.quantity, proration_behavior: request.proration }, { idempotencyKey: idem(request) });
        } else if (request.action === 'subscription.item.update') {
          await live.post(`/v1/subscription_items/${request.item}`, {
            ...(request.price ? { price: request.price } : {}), ...(request.quantity ? { quantity: request.quantity } : {}), proration_behavior: request.proration,
          }, { idempotencyKey: idem(request) });
        } else {
          if (subscription.items.length < 2) throw new HttpError(400, 'A subscription keeps at least one item. Cancel it instead.');
          await live.del(`/v1/subscription_items/${request.item}`, { proration_behavior: request.proration });
        }
        const latest = await refresh(db, live, 'subscription', request.subscription);
        await audit(db, actor, `billing.${request.action}`, subscription.tenant_id, null, {
          subscription: request.subscription, item: isItem ? request.item : null, price: request.price ?? null,
          quantity: request.quantity ?? null, proration: request.proration, status: latest.status,
        });
        return done();
      }
      case 'subscription.trial': {
        const subscription = await subscriptionFor(db, request);
        const trialEnd = request.trial_end === 'now' ? 'now' : unixEndOfDay(request.trial_end);
        if (trialEnd !== 'now' && trialEnd <= Math.floor(now() / 1000)) throw new HttpError(400, 'Choose a trial end date in the future.');
        await live.post(`/v1/subscriptions/${request.subscription}`, { trial_end: trialEnd, proration_behavior: 'none' }, { idempotencyKey: idem(request) });
        const latest = await refresh(db, live, 'subscription', request.subscription);
        await audit(db, actor, 'billing.subscription.trial', subscription.tenant_id, null, { subscription: request.subscription, trial_end: latest.trial_end, status: latest.status });
        return done();
      }
      case 'subscription.cancel': {
        const subscription = await subscriptionFor(db, request);
        let latest;
        if (request.when === 'immediately') {
          latest = await live.del(`/v1/subscriptions/${request.subscription}`, { prorate: request.prorate, invoice_now: request.prorate });
          await mirror(db, 'subscription', latest, new Date(now()), { live });
        } else {
          await live.post(`/v1/subscriptions/${request.subscription}`, { cancel_at_period_end: request.when === 'period_end' }, { idempotencyKey: idem(request) });
          latest = await refresh(db, live, 'subscription', request.subscription);
        }
        await audit(db, actor, 'billing.subscription.cancel', subscription.tenant_id, null, { subscription: request.subscription, when: request.when, prorate: request.prorate, status: latest.status });
        return done();
      }
      case 'subscription.pause':
      case 'subscription.resume': {
        const subscription = await subscriptionFor(db, request);
        const pause = request.action === 'subscription.pause'
          ? { behavior: request.behavior, ...(request.resumes_at ? { resumes_at: unixEndOfDay(request.resumes_at) } : {}) } : null;
        await live.post(`/v1/subscriptions/${request.subscription}`, { pause_collection: pause }, { idempotencyKey: idem(request) });
        const latest = await refresh(db, live, 'subscription', request.subscription);
        await audit(db, actor, `billing.${request.action}`, subscription.tenant_id, null, { subscription: request.subscription, behavior: pause?.behavior ?? null, status: latest.status });
        return done();
      }
      case 'subscription.discount': {
        const subscription = await subscriptionFor(db, request);
        const keep = subscription.discounts.filter(discount => request.op === 'apply'
          || (request.coupon ? discount.coupon !== request.coupon : discount.promotion_code !== request.promotion_code));
        if (request.op === 'remove' && keep.length === subscription.discounts.length) throw new HttpError(400, 'That discount is not on this subscription.');
        const discounts = [...keep.map(discount => ({ discount: discount.id })),
          ...(request.op === 'apply' ? [request.coupon ? { coupon: request.coupon } : { promotion_code: request.promotion_code }] : [])];
        await live.post(`/v1/subscriptions/${request.subscription}`, { discounts: discounts.length ? discounts : null }, { idempotencyKey: idem(request) });
        const latest = await refresh(db, live, 'subscription', request.subscription);
        // Redemption counts change without a catalog event; refresh what was applied.
        if (request.op === 'apply') {
          const applied = latest.discounts?.map?.(entry => entry?.source?.coupon ?? entry?.coupon).map(value => typeof value === 'string' ? value : value?.id).filter(Boolean) ?? [];
          for (const coupon of new Set([request.coupon, ...applied].filter(Boolean))) await refresh(db, live, 'coupon', coupon);
          if (request.promotion_code) await refresh(db, live, 'promotion_code', request.promotion_code);
        }
        await audit(db, actor, `billing.discount.${request.op}`, subscription.tenant_id, null, { subscription: request.subscription, coupon: request.coupon, promotion_code: request.promotion_code });
        return done();
      }
      case 'product.create': {
        const app = await appId(db, request.app);
        const product = await live.post('/v1/products', {
          name: request.name, ...(request.description ? { description: request.description } : {}), ...(request.unit_label ? { unit_label: request.unit_label } : {}),
          metadata: { app: request.app, kind: request.kind, entitlement: request.entitlement_key, hub_managed: 'true' },
        }, { idempotencyKey: idem(request) });
        await mirror(db, 'product', product, new Date(now()), { live });
        await audit(db, actor, 'billing.product.create', null, app, { product: product.id, kind: request.kind });
        return done({ id: product.id });
      }
      case 'product.update': {
        const product = await lookup(db, 'product', request.product);
        if (!product) throw new HttpError(404, 'That product was not found. Refresh and try again.');
        await lock(db, 'product', request.product, request.expected_version);
        const app = request.app ?? product.app;
        if (!app) throw new HttpError(400, 'Choose the application this product belongs to.');
        const updated = await live.post(`/v1/products/${request.product}`, {
          name: request.name, description: request.description || null, unit_label: request.unit_label || null, active: request.active,
          metadata: { app, kind: request.kind, entitlement: request.entitlement_key },
        }, { idempotencyKey: idem(request) });
        await mirror(db, 'product', updated, new Date(now()), { live });
        await audit(db, actor, 'billing.product.update', null, await appId(db, app), { product: request.product, active: request.active, kind: request.kind });
        return done();
      }
      case 'price.create': {
        const product = await lookup(db, 'product', request.product);
        if (!product?.active || !product.app) throw new HttpError(400, 'Choose an active product that belongs to an application.');
        if (request.tenant_id) await one(db, 'select private.billing_context($1) as c', [request.tenant_id]);
        const price = await live.post('/v1/prices', {
          product: request.product, currency: 'usd', unit_amount: request.unit_amount,
          ...(request.type === 'recurring' ? { recurring: { interval: request.interval } } : {}),
          ...(request.nickname ? { nickname: request.nickname } : {}),
          metadata: { app: product.app, pricing_model: request.pricing_model, billing_metric: request.pricing_model === 'per_unit' ? (product.unit_label || 'unit') : 'flat',
            ...(request.tenant_id ? { hub_tenant_id: request.tenant_id } : {}) },
        }, { idempotencyKey: idem(request) });
        await mirror(db, 'price', price, new Date(now()), { live });
        await audit(db, actor, request.tenant_id ? 'billing.price.custom' : 'billing.price.create', request.tenant_id, await appId(db, product.app), {
          price: price.id, unit_amount: request.unit_amount, interval: request.interval, pricing_model: request.pricing_model,
        });
        return done({ id: price.id });
      }
      case 'price.change': {
        const price = await lookup(db, 'price', request.price);
        if (!price?.active) throw new HttpError(400, 'Choose an active price.');
        if (price.unit_amount === null) throw new HttpError(400, 'Tiered and customer-entered prices change in the Stripe Dashboard.');
        await lock(db, 'price', request.price, request.expected_version);
        const current = await live.get(`/v1/prices/${request.price}`);
        const replacement = await live.post('/v1/prices', {
          product: price.product, currency: current.currency, unit_amount: request.unit_amount,
          ...(current.recurring ? { recurring: { interval: current.recurring.interval, interval_count: current.recurring.interval_count } } : {}),
          ...(current.nickname ? { nickname: current.nickname } : {}),
          ...(current.lookup_key ? { lookup_key: current.lookup_key, transfer_lookup_key: true } : {}),
          ...(current.tax_behavior && current.tax_behavior !== 'unspecified' ? { tax_behavior: current.tax_behavior } : {}),
          metadata: { ...current.metadata, hub_replaces: request.price },
        }, { idempotencyKey: idem(request) });
        const archived = await live.post(`/v1/prices/${request.price}`, { active: false }, { idempotencyKey: idem(request, '-archive') });
        await mirror(db, 'price', replacement, new Date(now()), { live });
        await mirror(db, 'price', archived, new Date(now()), { live });
        await audit(db, actor, 'billing.price.change', price.tenant_id, price.app ? await appId(db, price.app) : null, {
          price_from: request.price, price_to: replacement.id, unit_amount_from: price.unit_amount, unit_amount_to: request.unit_amount, migrate: request.migrate,
        });
        if (request.migrate === 'grandfather' || current.type !== 'recurring') return done({ id: replacement.id, migrated: 0, failed: 0 });
        return { result: { ok: true, id: replacement.id }, followUp: () => migrateSubscribers(live, actor, request, replacement.id, price) };
      }
      case 'price.archive': {
        const price = await lookup(db, 'price', request.price);
        if (!price) throw new HttpError(404, 'That price was not found. Refresh and try again.');
        await lock(db, 'price', request.price, request.expected_version);
        const updated = await live.post(`/v1/prices/${request.price}`, { active: request.active }, { idempotencyKey: idem(request) });
        await mirror(db, 'price', updated, new Date(now()), { live });
        await audit(db, actor, request.active ? 'billing.price.restore' : 'billing.price.archive', price.tenant_id, null, { price: request.price });
        return done();
      }
      case 'coupon.create': {
        const products = request.products.length ? request.products : request.app ? await lookup(db, 'app_products', request.app) : [];
        if (request.app && !products.length) throw new HttpError(400, 'That application has no active products to discount yet.');
        for (const product of request.products) {
          const found = await lookup(db, 'product', product);
          if (!found || (request.app && found.app !== request.app)) throw new HttpError(400, 'Choose products from the selected application.');
        }
        const coupon = await live.post('/v1/coupons', {
          name: request.name, duration: request.duration,
          ...(request.percent_off !== null ? { percent_off: request.percent_off } : { amount_off: request.amount_off, currency: 'usd' }),
          ...(request.duration_in_months ? { duration_in_months: request.duration_in_months } : {}),
          ...(request.max_redemptions ? { max_redemptions: request.max_redemptions } : {}),
          ...(request.redeem_by ? { redeem_by: unixEndOfDay(request.redeem_by) } : {}),
          ...(products.length ? { applies_to: { products } } : {}),
          metadata: { ...(request.app ? { app: request.app } : {}), hub_managed: 'true' },
        }, { idempotencyKey: idem(request) });
        await refresh(db, live, 'coupon', coupon.id);
        await audit(db, actor, 'billing.coupon.create', null, request.app ? await appId(db, request.app) : null, {
          coupon: coupon.id, percent_off: request.percent_off, amount_off: request.amount_off, duration: request.duration,
          duration_in_months: request.duration_in_months, products: products.length,
        });
        return done({ id: coupon.id });
      }
      case 'coupon.update':
      case 'coupon.delete': {
        const coupon = await lookup(db, 'coupon', request.coupon);
        if (!coupon || coupon.deleted) throw new HttpError(404, 'That coupon was not found. Refresh and try again.');
        await lock(db, 'coupon', request.coupon, request.expected_version);
        if (request.action === 'coupon.update') {
          await live.post(`/v1/coupons/${request.coupon}`, { name: request.name }, { idempotencyKey: idem(request) });
          await refresh(db, live, 'coupon', request.coupon);
        } else {
          await live.del(`/v1/coupons/${request.coupon}`);
          await db.query('select private.billing_mark_coupon_deleted($1)', [request.coupon]);
        }
        await audit(db, actor, `billing.${request.action}`, null, null, { coupon: request.coupon });
        return done();
      }
      case 'promotion_code.create': {
        const coupon = await lookup(db, 'coupon', request.coupon);
        if (!coupon?.valid) throw new HttpError(400, 'Choose a valid coupon.');
        const customer = request.tenant_id ? (await one(db, 'select private.billing_context($1) as c', [request.tenant_id])).c.stripe_customer_id : null;
        if (request.tenant_id && !customer) throw new HttpError(400, "That customer's billing contact is not set up yet.");
        const code = await live.post('/v1/promotion_codes', {
          promotion: { type: 'coupon', coupon: request.coupon }, code: request.code,
          ...(request.max_redemptions ? { max_redemptions: request.max_redemptions } : {}),
          ...(request.expires_at ? { expires_at: unixEndOfDay(request.expires_at) } : {}),
          ...(customer ? { customer } : {}),
          restrictions: { first_time_transaction: request.first_time_transaction,
            ...(request.minimum_amount ? { minimum_amount: request.minimum_amount, minimum_amount_currency: 'usd' } : {}) },
          metadata: { hub_managed: 'true' },
        }, { idempotencyKey: idem(request) });
        await mirror(db, 'promotion_code', code, new Date(now()), { live });
        await audit(db, actor, 'billing.promotion_code.create', request.tenant_id, null, { promotion_code: code.id, coupon: request.coupon, max_redemptions: request.max_redemptions });
        return done({ id: code.id });
      }
      case 'promotion_code.update': {
        const code = await lookup(db, 'promotion_code', request.promotion_code);
        if (!code) throw new HttpError(404, 'That promotion code was not found. Refresh and try again.');
        await lock(db, 'promotion_code', request.promotion_code, request.expected_version);
        const updated = await live.post(`/v1/promotion_codes/${request.promotion_code}`, { active: request.active }, { idempotencyKey: idem(request) });
        await mirror(db, 'promotion_code', updated, new Date(now()), { live });
        await audit(db, actor, 'billing.promotion_code.update', null, null, { promotion_code: request.promotion_code, active: request.active });
        return done();
      }
      case 'invoice.send': {
        const invoice = await lookup(db, 'invoice', request.invoice);
        if (!invoice) throw new HttpError(404, 'That invoice was not found. Refresh and try again.');
        await lock(db, 'invoice', request.invoice, request.expected_version);
        if (invoice.status !== 'open') throw new HttpError(400, 'Only an open invoice has a payment link.');
        let sent = false;
        if (invoice.collection_method === 'send_invoice') {
          await live.post(`/v1/invoices/${request.invoice}/send`, {}, { idempotencyKey: idem(request) });
          sent = true;
        }
        const latest = await refresh(db, live, 'invoice', request.invoice);
        await audit(db, actor, 'billing.invoice.send', invoice.tenant_id, null, { invoice: request.invoice, emailed: sent, amount_remaining: latest.amount_remaining });
        return done({ url: latest.hosted_invoice_url ?? undefined, id: sent ? 'emailed' : 'link' });
      }
      case 'customer.portal': {
        const context = (await one(db, 'select private.billing_context($1) as c', [request.tenant_id])).c;
        if (!context.stripe_customer_id) throw new HttpError(400, "Save the customer's billing contact first.");
        const session = await live.post('/v1/billing_portal/sessions', {
          customer: context.stripe_customer_id, return_url: `${publicOrigin}/admin/billing/customers/${request.tenant_id}`,
          ...(portalConfiguration ? { configuration: portalConfiguration } : {}),
        });
        await audit(db, actor, 'billing.portal.admin', request.tenant_id, null, { customer: context.stripe_customer_id });
        return done({ url: session.url });
      }
      case 'customer.sync': {
        const context = (await one(db, 'select private.billing_context($1) as c', [request.tenant_id])).c;
        if (!context.stripe_customer_id) throw new HttpError(400, 'This tenant has no Stripe customer yet.');
        let synced = 0;
        await refresh(db, live, 'customer', context.stripe_customer_id); synced++;
        for (const subscription of await live.list('/v1/subscriptions', { customer: context.stripe_customer_id, status: 'all', expand: ['data.discounts'] }, 200)) {
          await mirror(db, 'subscription', subscription, new Date(now()), { live }); synced++;
        }
        for (const invoice of await live.list('/v1/invoices', { customer: context.stripe_customer_id }, 200)) {
          await mirror(db, 'invoice', invoice, new Date(now()), { live }); synced++;
        }
        await audit(db, actor, 'billing.customer.sync', request.tenant_id, null, { synced });
        return done({ synced });
      }
      case 'catalog.sync': {
        let synced = 0;
        for (const product of await live.list('/v1/products', {}, 1000)) { await mirror(db, 'product', product, new Date(now()), { live }); synced++; }
        for (const price of await live.list('/v1/prices', {}, 2000)) { await mirror(db, 'price', price, new Date(now()), { live }); synced++; }
        for (const coupon of await live.list('/v1/coupons', { expand: ['data.applies_to'] }, 1000)) { await mirror(db, 'coupon', coupon, new Date(now()), { live }); synced++; }
        for (const code of await live.list('/v1/promotion_codes', {}, 1000)) { await mirror(db, 'promotion_code', code, new Date(now()), { live }); synced++; }
        await audit(db, actor, 'billing.catalog.sync', null, null, { synced });
        return done({ synced });
      }
      case 'account.link':
        await db.query('select private.billing_link_account($1,$2,$3,$4,$5)', [actor, request.tenant_id, await appId(db, request.app), request.account, request.expected_version]);
        return done();
      case 'account.unlink':
        await db.query('select private.billing_unlink_account($1,$2,$3,$4)', [actor, request.tenant_id, await appId(db, request.app), request.expected_version]);
        return done();
      case 'app_key.issue': {
        const key = `cmb_${randomBytes(32).toString('base64url')}`;
        const id = (await one(db, 'select private.billing_issue_app_key($1,$2,$3,$4) as id', [actor, await appId(db, request.app), sha256(key), key.slice(-4)])).id;
        return done({ key, id });
      }
      case 'app_key.revoke':
        await db.query('select private.billing_revoke_app_key($1,$2)', [actor, request.key_id]);
        return done();
    }
    throw new HttpError(400, 'Unsupported billing command.');
  }

  // Moves every live subscription item on the old price to the new one, each in
  // its own transaction, after the price change has committed.
  async function migrateSubscribers(live, actor, request, newPrice, oldPrice) {
    let migrated = 0, failed = 0;
    const subscriptions = await live.list('/v1/subscriptions', { price: request.price, status: 'all' }, 1000);
    for (const subscription of subscriptions) {
      if (['canceled', 'incomplete_expired'].includes(subscription.status)) continue;
      for (const item of subscription.items.data.filter(entry => (entry.price?.id ?? entry.price) === request.price)) {
        try {
          await live.post(`/v1/subscription_items/${item.id}`, { price: newPrice, quantity: item.quantity,
            proration_behavior: request.migrate === 'prorate' ? 'create_prorations' : 'none' }, { idempotencyKey: idem(request, `-${item.id}`) });
          await transaction(pool, db => refresh(db, live, 'subscription', subscription.id));
          migrated++;
        } catch { failed++; }
      }
    }
    await transaction(pool, db => audit(db, actor, 'billing.price.migrate', oldPrice.tenant_id, null, { price_from: request.price, price_to: newPrice, migrated, failed }));
    return { migrated, failed };
  }

  // ---------------------------------------------------------------------------
  // Tenant administrators: the Stripe customer portal for their own tenant.
  async function customerPortal(sessionToken, input) {
    if (!input || typeof input !== 'object' || Object.keys(input).join(',') !== 'tenant_id'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.tenant_id)) throw new HttpError(400, 'Choose an organization.');
    const live = await stripe();
    try {
      return await withSession(pool, sessionToken, async db => {
        const authority = (await one(db, 'select hub.authorize_tenant_billing($1) as a', [input.tenant_id])).a;
        await db.query('reset role');
        const session = await live.post('/v1/billing_portal/sessions', {
          customer: authority.stripe_customer_id, return_url: `${publicOrigin}/billing`, ...(portalConfiguration ? { configuration: portalConfiguration } : {}),
        });
        await audit(db, authority.user_id, 'billing.portal.open', input.tenant_id, null, { customer: authority.stripe_customer_id });
        return { url: session.url };
      });
    } catch (error) { throw asHttpError(error); }
  }

  // ---------------------------------------------------------------------------
  // Applications, authenticated by their application key.
  async function authenticateApp(db, authorization) {
    const key = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!appKeyPattern.test(key)) throw new HttpError(401, 'Application key required.');
    const app = (await one(db, 'select private.billing_authenticate_app($1) as app', [sha256(key)])).app;
    if (!app) throw new HttpError(401, 'Application key required.');
    return app;
  }
  const appResponse = entitlement => ({ ...entitlement, cache_ttl_seconds: entitlementCacheSeconds, checked_at: new Date(now()).toISOString() });

  async function entitlements(authorization, input) {
    const parsed = entitlementRequestSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Send the application account id.');
    return transaction(pool, async db => {
      const app = await authenticateApp(db, authorization);
      return appResponse((await one(db, 'select private.billing_app_entitlements($1,$2) as e', [app.product_id, parsed.data.account])).e);
    });
  }

  async function usage(authorization, input) {
    const parsed = usageReportSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Send the account, metric, quantity and a request key.');
    const report = parsed.data;
    const plan = await transaction(pool, async db => {
      const app = await authenticateApp(db, authorization);
      const seen = (await one(db, 'select private.billing_usage_seen($1,$2) as s', [app.product_id, report.request_key])).s;
      const targets = seen ? null : (await one(db, 'select private.billing_usage_targets($1,$2,$3) as t', [app.product_id, report.account, report.metric])).t;
      return { app, seen, targets };
    });
    if (plan.seen) return { ...plan.seen, duplicate: true };
    if (!plan.targets.tenant_id) return { outcome: 'not_linked', items_updated: 0, quantity: report.quantity };
    const changes = plan.targets.items.filter(item => item.quantity !== report.quantity);
    const outcome = plan.targets.items.length ? (changes.length ? 'updated' : 'unchanged') : 'no_subscription';
    if (changes.length) {
      // As CareBase billed it: the measured count applies from the next billing
      // period, without a mid-period proration.
      const live = await stripe();
      try {
        for (const item of changes) {
          await live.post(`/v1/subscription_items/${item.item}`, { quantity: report.quantity, proration_behavior: 'none' },
            { idempotencyKey: `hub-usage-${report.request_key}-${item.item}` });
          await transaction(pool, db => refresh(db, live, 'subscription', item.subscription));
        }
      } catch (error) {
        await transaction(pool, db => audit(db, null, 'billing.usage.failed', plan.targets.tenant_id, plan.app.product_id, { metric: report.metric, quantity: report.quantity }));
        throw asHttpError(error);
      }
    }
    const applied = outcome === 'updated' ? changes.length : 0;
    await transaction(pool, db => db.query('select private.billing_record_usage($1,$2,$3,$4,$5,$6,$7)',
      [plan.app.product_id, plan.targets.tenant_id, report.metric, report.quantity, report.request_key, outcome, applied]));
    return { outcome, items_updated: applied, quantity: report.quantity };
  }

  // A self-service signup in an application starts its trial here, once per account.
  async function trial(authorization, input) {
    const parsed = trialRequestSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Send the account id, organization name, contact email and plan.');
    const request = parsed.data;
    const live = await stripe();
    try {
      const prepared = await transaction(pool, async db => {
        const app = await authenticateApp(db, authorization);
        const tenant = (await one(db, 'select private.billing_app_tenant($1,$2,$3) as t', [app.product_id, request.account, request.name])).t;
        const current = (await one(db, 'select private.billing_app_entitlements($1,$2) as e', [app.product_id, request.account])).e;
        const context = (await one(db, 'select private.billing_context($1) as c', [tenant])).c;
        const price = current.status === 'none' ? await lookup(db, 'trial_price', `${app.slug}:${request.plan ?? ''}`) : null;
        return { app, tenant, current, context, price };
      });
      if (prepared.current.status !== 'none') return appResponse(prepared.current);
      if (!prepared.price) throw new HttpError(409, 'No trial plan is configured for this application in the Hub.');
      const accountKey = sha256(`${prepared.app.slug}:${request.account}`).slice(0, 32);
      return await transaction(pool, async db => {
        await db.query('select private.lock_customer_subscription_start($1,$2)', [prepared.tenant, prepared.app.product_id]);
        const current = (await one(db, 'select private.billing_app_entitlements($1,$2) as e', [prepared.app.product_id, request.account])).e;
        if (current.status !== 'none') return appResponse(current);
        const context = (await one(db, 'select private.billing_context($1) as c', [prepared.tenant])).c;
        let customer = context.stripe_customer_id;
        if (!customer) {
          const created = await live.post('/v1/customers', { name: request.name, ...(request.email ? { email: request.email } : {}),
            metadata: { hub_tenant_id: prepared.tenant, app: prepared.app.slug } }, { idempotencyKey: `hub-trial-customer-${accountKey}` });
          await mirror(db, 'customer', created, new Date(now()), { live });
          customer = created.id;
        }
        const subscription = await live.post('/v1/subscriptions', {
          customer, items: [{ price: prepared.price.price, quantity: 1 }],
          trial_period_days: prepared.price.trial_days ?? trialDays[prepared.app.slug] ?? 14,
          trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          payment_settings: { save_default_payment_method: 'on_subscription' },
          metadata: { app: prepared.app.slug, hub_tenant_id: prepared.tenant, hub_source: 'app_trial' }, expand: ['discounts'],
        }, { idempotencyKey: `hub-trial-subscription-${accountKey}` });
        await mirror(db, 'subscription', subscription, new Date(now()), { live });
        await audit(db, null, 'billing.trial.start', prepared.tenant, prepared.app.product_id, { subscription: subscription.id, trial_end: subscription.trial_end });
        return appResponse((await one(db, 'select private.billing_app_entitlements($1,$2) as e', [prepared.app.product_id, request.account])).e);
      });
    } catch (error) { throw asHttpError(error); }
  }

  // After a verified start: bring the mirror up to date with Stripe, so a catalog
  // edited in the Dashboard or a subscription changed while the Hub was down, or
  // before its webhook existed, is never missing. Each object commits on its own.
  async function reconcile() {
    if (!(await verify())) return null;
    const live = client;
    let synced = 0, failed = 0;
    const each = async (kind, rows) => {
      for (const row of rows) {
        try { await transaction(pool, db => mirror(db, kind, row, new Date(now()), { live })); if (kind === 'subscription') await customerSelfService.reconcileSubscription(row); synced++; }
        catch { failed++; }
      }
    };
    try {
      await each('product', await live.list('/v1/products', {}, 1000));
      await each('price', await live.list('/v1/prices', {}, 2000));
      await each('coupon', await live.list('/v1/coupons', { expand: ['data.applies_to'] }, 1000));
      await each('promotion_code', await live.list('/v1/promotion_codes', {}, 1000));
      // Only customers the Hub created or adopted carry a Hub tenant.
      const customers = (await live.list('/v1/customers', {}, 5000)).filter(customer => normalizers.customer(customer).tenant_id);
      await each('customer', customers);
      for (const customer of customers) {
        await each('subscription', await live.list('/v1/subscriptions', { customer: customer.id, status: 'all', expand: ['data.discounts'] }, 200));
        await each('invoice', await live.list('/v1/invoices', { customer: customer.id }, 200));
      }
      const checkouts = await customerSelfService.reconcileCheckouts();
      failed += checkouts.failed;
    } catch { log.warn('Platform billing could not finish refreshing from Stripe; the webhook and Sync from Stripe keep it current.'); }
    if (failed) log.warn(`Platform billing skipped ${failed} Stripe records it could not mirror.`);
    return { synced, failed };
  }

  return {
    start: verify, reconcile,
    reconcileCustomerCheckouts: async () => {
      const result = await customerSelfService.reconcileCheckouts();
      if (result.failed || result.unbound) log.warn(`Customer Checkout reconciliation: ${result.failed} failed and ${result.unbound} unbound pending purchases.`);
      return result;
    },
    status: () => ({ configured: !!client, state, mode: client?.mode ?? null, account: state === 'ready' ? accountId : null,
      webhook: webhookSecrets.length > 0, portal_configuration: !!portalConfiguration }),
    webhook, command, customerPortal, entitlements, usage, trial,
    customer: async (session, input) => { try { return await customerSelfService.handle(session, input); } catch (error) { throw asHttpError(error); } },
  };
}
