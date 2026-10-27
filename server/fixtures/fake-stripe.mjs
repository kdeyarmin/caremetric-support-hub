import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

/**
 * A small in-memory stand-in for the parts of the Stripe API the Hub uses, for
 * integration tests only. Objects follow the 2026-02-25.clover shapes: billing
 * periods on subscription items, promotion codes pointing at a promotion,
 * invoice subscriptions under parent.subscription_details.
 */
export function parseForm(body) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const path = rawKey.replace(/\]/g, '').split('[');
    let node = out;
    path.forEach((key, index) => {
      if (index === path.length - 1) node[key] = value;
      else node = node[key] ??= {};
    });
  }
  const arrays = node => {
    if (!node || typeof node !== 'object') return node;
    const keys = Object.keys(node);
    if (keys.length && keys.every(key => /^\d+$/.test(key))) return keys.sort((a, b) => a - b).map(key => arrays(node[key]));
    for (const key of keys) node[key] = arrays(node[key]);
    return node;
  };
  return arrays(out);
}
const id = prefix => `${prefix}_${randomBytes(9).toString('hex')}`;
const now = () => Math.floor(Date.now() / 1000);
const month = 30 * 86400;

export function fakeStripe({ accountId = 'acct_1SinLKB06O2UFlNz' } = {}) {
  const store = { customers: new Map(), products: new Map(), prices: new Map(), subscriptions: new Map(), coupons: new Map(), promotion_codes: new Map(), invoices: new Map() };
  const requests = [];
  const idempotent = new Map();
  const events = [];
  const emit = (type, object) => events.push({ id: id('evt'), object: 'event', type, created: now(), livemode: false, data: { object: structuredClone(object) } });
  const notFound = () => ({ status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such object.' } } });
  const bad = message => ({ status: 400, body: { error: { type: 'invalid_request_error', message } } });
  const priceObject = priceId => structuredClone(store.prices.get(priceId));
  function item(subscription, input) {
    const price = store.prices.get(input.price);
    if (!price) return null;
    return { id: id('si'), object: 'subscription_item', subscription: subscription.id, price: structuredClone(price), quantity: Number(input.quantity ?? 1),
      current_period_start: subscription.created, current_period_end: subscription.created + (price.recurring?.interval === 'year' ? 12 * month : month) };
  }
  function discountsFor(subscription, list) {
    if (list === '' || list === undefined) return [];
    return list.map(entry => {
      if (entry.discount) return subscription.discounts.find(existing => existing.id === entry.discount);
      const code = entry.promotion_code ? store.promotion_codes.get(entry.promotion_code) : null;
      const coupon = store.coupons.get(entry.coupon ?? code?.promotion.coupon);
      if (!coupon) throw new Error('No such coupon');
      if (code) code.times_redeemed++;
      coupon.times_redeemed++;
      return { id: id('di'), object: 'discount', source: { type: 'coupon', coupon: structuredClone(coupon) }, promotion_code: code?.id ?? null, subscription: subscription.id };
    }).filter(Boolean);
  }
  // One-time prices added with add_invoice_items, charged on the next invoice.
  const feeTotal = entries => (entries ?? []).reduce((sum, entry) => {
    const price = store.prices.get(entry.price);
    if (!price || price.type !== 'one_time') throw new Error('Invoice items need a one-time price');
    return sum + price.unit_amount * Number(entry.quantity ?? 1);
  }, 0);
  function invoiceFor(subscription, fees = 0) {
    const total = fees + (subscription.status === 'trialing' ? 0 : subscription.items.data.reduce((sum, entry) => sum + (entry.price.unit_amount ?? 0) * entry.quantity, 0));
    const invoice = { id: id('in'), object: 'invoice', customer: subscription.customer, status: total ? 'open' : 'paid', number: `HUB-${store.invoices.size + 1}`,
      currency: 'usd', total, subtotal: total, amount_due: total, amount_paid: total ? 0 : 0, amount_remaining: total, collection_method: subscription.collection_method,
      hosted_invoice_url: `https://invoice.stripe.com/i/${id('test')}`, invoice_pdf: `https://pay.stripe.com/invoice/${id('test')}/pdf`, period_start: now(), period_end: now(),
      due_date: subscription.collection_method === 'send_invoice' ? now() + 30 * 86400 : null, created: now(), livemode: false, metadata: {},
      parent: { type: 'subscription_details', subscription_details: { subscription: subscription.id, metadata: subscription.metadata } } };
    store.invoices.set(invoice.id, invoice);
    emit('invoice.created', invoice);
    return invoice;
  }
  const expand = (subscription, params) => {
    const copy = structuredClone(subscription);
    const fields = [params.expand, params.expand?.[0]].flat().filter(Boolean);
    if (!fields.some(field => /discounts/.test(field))) copy.discounts = copy.discounts.map(entry => entry.id);
    return copy;
  };

  function handle(method, path, params) {
    const parts = path.split('/').filter(Boolean).slice(1);
    const [resource, objectId, action] = parts;
    if (method === 'GET' && resource === 'account') return { status: 200, body: { id: accountId, object: 'account' } };
    if (resource === 'customers') {
      if (method === 'GET' && !objectId) return { status: 200, body: { object: 'list', data: [...store.customers.values()], has_more: false } };
      if (method === 'POST' && !objectId) {
        const customer = { id: id('cus'), object: 'customer', email: params.email ?? null, name: params.name ?? null, metadata: params.metadata ?? {}, delinquent: false, balance: 0, created: now(), livemode: false };
        store.customers.set(customer.id, customer); emit('customer.created', customer); return { status: 200, body: customer };
      }
      const customer = store.customers.get(objectId); if (!customer) return notFound();
      if (method === 'POST') { Object.assign(customer, { email: params.email ?? customer.email, name: params.name ?? customer.name, metadata: { ...customer.metadata, ...params.metadata } }); emit('customer.updated', customer); }
      return { status: 200, body: customer };
    }
    if (resource === 'products') {
      if (method === 'GET' && !objectId) return { status: 200, body: { object: 'list', data: [...store.products.values()], has_more: false } };
      if (method === 'POST' && !objectId) {
        const product = { id: params.id ?? id('prod'), object: 'product', name: params.name, description: params.description ?? null, unit_label: params.unit_label ?? null, active: true, metadata: params.metadata ?? {}, created: now(), livemode: false };
        store.products.set(product.id, product); emit('product.created', product); return { status: 200, body: product };
      }
      const product = store.products.get(objectId); if (!product) return notFound();
      if (method === 'POST') {
        for (const key of ['name', 'description', 'unit_label']) if (key in params) product[key] = params[key] === '' ? null : params[key];
        if ('active' in params) product.active = params.active === 'true';
        if (params.metadata) product.metadata = { ...product.metadata, ...params.metadata };
        emit('product.updated', product);
      }
      return { status: 200, body: product };
    }
    if (resource === 'prices') {
      if (method === 'GET' && !objectId) return { status: 200, body: { object: 'list', data: [...store.prices.values()], has_more: false } };
      if (method === 'POST' && !objectId) {
        if (!store.products.has(params.product)) return bad('No such product');
        if (params.lookup_key) for (const other of store.prices.values()) if (other.lookup_key === params.lookup_key) { if (params.transfer_lookup_key !== 'true') return bad('Lookup key in use'); other.lookup_key = null; }
        const price = { id: id('price'), object: 'price', product: params.product, active: true, currency: params.currency, unit_amount: Number(params.unit_amount), billing_scheme: 'per_unit',
          type: params.recurring ? 'recurring' : 'one_time', recurring: params.recurring ? { interval: params.recurring.interval, interval_count: Number(params.recurring.interval_count ?? 1), usage_type: 'licensed' } : null,
          lookup_key: params.lookup_key ?? null, nickname: params.nickname ?? null, metadata: params.metadata ?? {}, tax_behavior: 'unspecified', created: now(), livemode: false };
        store.prices.set(price.id, price); emit('price.created', price); return { status: 200, body: price };
      }
      const price = store.prices.get(objectId); if (!price) return notFound();
      if (method === 'POST') { if ('active' in params) price.active = params.active === 'true'; emit('price.updated', price); }
      return { status: 200, body: price };
    }
    if (resource === 'subscriptions') {
      if (method === 'GET' && !objectId) {
        let rows = [...store.subscriptions.values()];
        if (params.customer) rows = rows.filter(row => row.customer === params.customer);
        if (params.price) rows = rows.filter(row => row.items.data.some(entry => entry.price.id === params.price));
        return { status: 200, body: { object: 'list', data: rows.map(row => expand(row, { expand: ['discounts'] })), has_more: false } };
      }
      if (method === 'POST' && !objectId) {
        if (!store.customers.has(params.customer)) return bad('No such customer');
        const trialDays = Number(params.trial_period_days ?? 0);
        const subscription = { id: id('sub'), object: 'subscription', customer: params.customer, created: now(), status: trialDays ? 'trialing' : params.collection_method === 'send_invoice' ? 'active' : 'incomplete',
          collection_method: params.collection_method ?? 'charge_automatically', cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
          trial_start: trialDays ? now() : null, trial_end: trialDays ? now() + trialDays * 86400 : null, pause_collection: null, metadata: params.metadata ?? {}, discounts: [], livemode: false,
          items: { object: 'list', data: [] }, latest_invoice: null, currency: 'usd' };
        subscription.items.data = params.items.map(entry => item(subscription, entry));
        if (subscription.items.data.some(entry => !entry || entry.price.type !== 'recurring')) return bad('Subscription items need a recurring price');
        let fees;
        try { fees = feeTotal(params.add_invoice_items); subscription.discounts = discountsFor(subscription, params.discounts); } catch (error) { return bad(error.message); }
        subscription.latest_invoice = invoiceFor(subscription, fees).id;
        store.subscriptions.set(subscription.id, subscription); emit('customer.subscription.created', subscription);
        return { status: 200, body: expand(subscription, params) };
      }
      const subscription = store.subscriptions.get(objectId); if (!subscription) return notFound();
      if (method === 'DELETE') {
        Object.assign(subscription, { status: 'canceled', canceled_at: now(), ended_at: now() });
        emit('customer.subscription.deleted', subscription); return { status: 200, body: expand(subscription, { expand: ['discounts'] }) };
      }
      if (method === 'POST') {
        if ('cancel_at_period_end' in params) { subscription.cancel_at_period_end = params.cancel_at_period_end === 'true'; subscription.cancel_at = subscription.cancel_at_period_end ? subscription.items.data[0].current_period_end : null; }
        if ('trial_end' in params) {
          if (params.trial_end === 'now') Object.assign(subscription, { trial_end: now(), status: 'active' });
          else Object.assign(subscription, { trial_start: subscription.trial_start ?? now(), trial_end: Number(params.trial_end), status: 'trialing' });
        }
        if ('pause_collection' in params) subscription.pause_collection = params.pause_collection === '' ? null : { behavior: params.pause_collection.behavior, resumes_at: params.pause_collection.resumes_at ? Number(params.pause_collection.resumes_at) : null };
        if ('discounts' in params) { try { subscription.discounts = discountsFor(subscription, params.discounts); } catch (error) { return bad(error.message); } }
        if (params.add_invoice_items) { try { subscription.pending_fees = (subscription.pending_fees ?? 0) + feeTotal(params.add_invoice_items); } catch (error) { return bad(error.message); } }
        emit('customer.subscription.updated', subscription);
      }
      return { status: 200, body: expand(subscription, params) };
    }
    if (resource === 'subscription_items') {
      if (method === 'POST' && !objectId) {
        const subscription = store.subscriptions.get(params.subscription); if (!subscription) return notFound();
        const entry = item(subscription, params); if (!entry) return bad('No such price');
        subscription.items.data.push(entry); emit('customer.subscription.updated', subscription); return { status: 200, body: entry };
      }
      const subscription = [...store.subscriptions.values()].find(row => row.items.data.some(entry => entry.id === objectId)); if (!subscription) return notFound();
      const entry = subscription.items.data.find(row => row.id === objectId);
      if (method === 'DELETE') { subscription.items.data = subscription.items.data.filter(row => row.id !== objectId); emit('customer.subscription.updated', subscription); return { status: 200, body: { id: objectId, deleted: true } }; }
      if (params.price) { if (!store.prices.has(params.price)) return bad('No such price'); entry.price = priceObject(params.price); }
      if (params.quantity !== undefined) entry.quantity = Number(params.quantity);
      emit('customer.subscription.updated', subscription);
      return { status: 200, body: entry };
    }
    if (resource === 'coupons') {
      if (method === 'GET' && !objectId) return { status: 200, body: { object: 'list', data: [...store.coupons.values()], has_more: false } };
      if (method === 'POST' && !objectId) {
        const coupon = { id: params.id ?? randomBytes(4).toString('hex'), object: 'coupon', name: params.name ?? null, percent_off: params.percent_off ? Number(params.percent_off) : null,
          amount_off: params.amount_off ? Number(params.amount_off) : null, currency: params.currency ?? null, duration: params.duration, duration_in_months: params.duration_in_months ? Number(params.duration_in_months) : null,
          max_redemptions: params.max_redemptions ? Number(params.max_redemptions) : null, redeem_by: params.redeem_by ? Number(params.redeem_by) : null, times_redeemed: 0, valid: true,
          applies_to: params.applies_to ? { products: params.applies_to.products } : undefined, metadata: params.metadata ?? {}, created: now(), livemode: false };
        store.coupons.set(coupon.id, coupon); emit('coupon.created', coupon); return { status: 200, body: coupon };
      }
      const coupon = store.coupons.get(objectId); if (!coupon) return notFound();
      if (method === 'DELETE') { store.coupons.delete(objectId); emit('coupon.deleted', coupon); return { status: 200, body: { id: objectId, object: 'coupon', deleted: true } }; }
      if (method === 'POST') { if (params.name) coupon.name = params.name; emit('coupon.updated', coupon); }
      return { status: 200, body: { ...coupon, applies_to: coupon.applies_to ?? { products: [] } } };
    }
    if (resource === 'promotion_codes') {
      if (method === 'GET' && !objectId) return { status: 200, body: { object: 'list', data: [...store.promotion_codes.values()], has_more: false } };
      if (method === 'POST' && !objectId) {
        if (!store.coupons.has(params.promotion?.coupon)) return bad('No such coupon');
        const code = { id: id('promo'), object: 'promotion_code', code: params.code, promotion: { type: 'coupon', coupon: params.promotion.coupon }, active: true, customer: params.customer ?? null,
          max_redemptions: params.max_redemptions ? Number(params.max_redemptions) : null, times_redeemed: 0, expires_at: params.expires_at ? Number(params.expires_at) : null,
          restrictions: { first_time_transaction: params.restrictions?.first_time_transaction === 'true', minimum_amount: params.restrictions?.minimum_amount ? Number(params.restrictions.minimum_amount) : null },
          metadata: params.metadata ?? {}, created: now(), livemode: false };
        store.promotion_codes.set(code.id, code); emit('promotion_code.created', code); return { status: 200, body: code };
      }
      const code = store.promotion_codes.get(objectId); if (!code) return notFound();
      if (method === 'POST') { code.active = params.active === 'true'; emit('promotion_code.updated', code); }
      return { status: 200, body: code };
    }
    if (resource === 'invoices') {
      if (method === 'GET' && !objectId) return { status: 200, body: { object: 'list', data: [...store.invoices.values()].filter(row => !params.customer || row.customer === params.customer), has_more: false } };
      const invoice = store.invoices.get(objectId); if (!invoice) return notFound();
      if (method === 'POST' && action === 'send') { if (invoice.collection_method !== 'send_invoice') return bad('You can only manually send an invoice if its collection method is send_invoice.'); emit('invoice.sent', invoice); }
      return { status: 200, body: invoice };
    }
    if (resource === 'billing_portal' && objectId === 'sessions' && method === 'POST') {
      if (!store.customers.has(params.customer)) return bad('No such customer');
      return { status: 200, body: { id: id('bps'), object: 'billing_portal.session', url: `https://billing.stripe.com/p/session/${id('test')}`, return_url: params.return_url } };
    }
    return notFound();
  }

  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://fake');
    const body = Buffer.concat(chunks).toString('utf8');
    const params = req.method === 'GET' ? parseForm(url.searchParams.toString()) : parseForm(body);
    requests.push({ method: req.method, path: url.pathname, params, idempotencyKey: req.headers['idempotency-key'] ?? null, version: req.headers['stripe-version'] });
    if (!/^Bearer sk_test_/.test(req.headers.authorization ?? '')) { res.statusCode = 401; return res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid API key.' } })); }
    const key = req.headers['idempotency-key'];
    let result;
    if (key && idempotent.has(key)) result = idempotent.get(key);
    else { result = handle(req.method, url.pathname, params); if (key) idempotent.set(key, result); }
    res.statusCode = result.status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result.body));
  });
  return {
    store, requests, events,
    async listen() { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; },
    close: () => new Promise(resolve => server.close(resolve)),
    /** Settles a subscription's open invoice as paid and makes it active, as Stripe does after payment. */
    pay(subscriptionId) {
      const subscription = store.subscriptions.get(subscriptionId);
      for (const invoice of store.invoices.values()) if (invoice.parent.subscription_details.subscription === subscriptionId && invoice.status === 'open') {
        Object.assign(invoice, { status: 'paid', amount_paid: invoice.total, amount_remaining: 0 }); emit('invoice.paid', invoice);
      }
      subscription.status = 'active'; emit('customer.subscription.updated', subscription);
    },
  };
}
