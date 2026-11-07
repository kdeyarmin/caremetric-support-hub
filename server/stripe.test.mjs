import { describe, expect, it, vi } from 'vitest';
import {
  STRIPE_API_VERSION, CHECKOUT_API_VERSION, discountRef, eventTarget, formEncode, keyMode, normalizeInvoice, normalizePrice, normalizeProduct,
  normalizeSubscription, signStripePayload, stripeClient, verifyStripeSignature,
} from './stripe.mjs';

describe('Stripe form encoding', () => {
  it('encodes nested objects, arrays of objects and clears', () => {
    const body = formEncode({ items: [{ price: 'price_1', quantity: 3 }], metadata: { app: 'carebase' }, expand: ['discounts'], coupon: null, skip: undefined });
    expect([...body]).toEqual([
      ['items[0][price]', 'price_1'], ['items[0][quantity]', '3'], ['metadata[app]', 'carebase'], ['expand[0]', 'discounts'], ['coupon', ''],
    ]);
  });
  it('sends an empty array as a clear', () => {
    expect(formEncode({ discounts: [] }).toString()).toBe('discounts=');
  });
});

describe('Stripe keys', () => {
  it('reads the mode from the key and refuses anything else', () => {
    expect([keyMode('sk_live_x'), keyMode('rk_test_x'), keyMode('pk_live_x'), keyMode(undefined)]).toEqual(['live', 'test', null, null]);
    expect(stripeClient({ secretKey: 'pk_live_x' })).toBeNull();
    expect(keyMode('rkcs_test_synthetic')).toBe('test');
    expect(keyMode('rkcs_live_synthetic')).toBeNull();
  });
});

describe('Stripe signatures', () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000_000;
  it('accepts a current signature from any configured secret', () => {
    const header = signStripePayload(body, 'whsec_two', now / 1000);
    expect(verifyStripeSignature(Buffer.from(body), header, ['whsec_one', 'whsec_two'], { now })).toBe(true);
  });
  it('refuses a changed body, a wrong secret, an old timestamp and a malformed header', () => {
    const header = signStripePayload(body, 'whsec_one', now / 1000);
    expect(verifyStripeSignature('{"id":"evt_2"}', header, ['whsec_one'], { now })).toBe(false);
    expect(verifyStripeSignature(body, header, ['whsec_other'], { now })).toBe(false);
    expect(verifyStripeSignature(body, header, ['whsec_one'], { now: now + 301_000 })).toBe(false);
    expect(verifyStripeSignature(body, 'v1=abc', ['whsec_one'], { now })).toBe(false);
    expect(verifyStripeSignature(body, header, [], { now })).toBe(false);
  });
});

describe('Stripe client', () => {
  it('uses the current API for new Checkout without changing legacy requests', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: 'cs_test_synthetic' }));
    const client = stripeClient({ secretKey: 'rk_test_synthetic', fetchImpl });
    await client.post('/v1/checkout/sessions', { mode: 'subscription' }, { apiVersion: CHECKOUT_API_VERSION, idempotencyKey: 'hub-checkout-synthetic' });
    await client.get('/v1/subscriptions/sub_existing');
    expect(fetchImpl.mock.calls.map(([, init]) => init.headers['Stripe-Version'])).toEqual([CHECKOUT_API_VERSION, STRIPE_API_VERSION]);
  });
  it('pins the API version and retries a failed idempotent call once with the same key', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'cus_1' }), { status: 200 }));
    const client = stripeClient({ secretKey: 'sk_test_x', fetchImpl });
    await expect(client.post('/v1/customers', { email: 'a@test.invalid' }, { idempotencyKey: 'hub-1' })).resolves.toEqual({ id: 'cus_1' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.headers['Stripe-Version']).toBe(STRIPE_API_VERSION);
      expect(init.headers['Idempotency-Key']).toBe('hub-1');
    }
  });
  it('sends DELETE parameters in the query string, as Stripe’s SDKs do, with no body', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: 'sub_1', status: 'canceled' }));
    const client = stripeClient({ secretKey: 'sk_test_x', fetchImpl });
    await client.del('/v1/subscriptions/sub_1', { prorate: true, invoice_now: true });
    await client.del('/v1/coupons/co_1');
    const [[cancelUrl, cancel], [couponUrl, coupon]] = fetchImpl.mock.calls;
    expect(new URL(cancelUrl).searchParams.toString()).toBe('prorate=true&invoice_now=true');
    expect([cancel.method, cancel.body, cancel.headers['Content-Type']]).toEqual(['DELETE', undefined, undefined]);
    expect([couponUrl, coupon.body]).toEqual(['https://api.stripe.com/v1/coupons/co_1', undefined]);
  });
  it('never retries a create without an idempotency key and reports Stripe’s message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'No such price' } }), { status: 400 }));
    const client = stripeClient({ secretKey: 'sk_test_x', fetchImpl });
    await expect(client.post('/v1/prices', {})).rejects.toMatchObject({ status: 400, type: 'invalid_request_error', message: 'No such price' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('refuses a path outside the API', async () => {
    const client = stripeClient({ secretKey: 'sk_test_x', fetchImpl: vi.fn() });
    await expect(client.get('https://evil.test/v1/x')).rejects.toThrow('Invalid Stripe path.');
  });
});

describe('Stripe normalizers', () => {
  it('reads the app, kind and entitlement from product metadata', () => {
    expect(normalizeProduct({ id: 'prod_1', name: 'Core', active: true, metadata: { app: 'carebase', package_kind: 'addon', plan: 'EMAR' } }))
      .toMatchObject({ app: 'carebase', kind: 'addon', entitlement_key: 'emar' });
    expect(normalizeProduct({ id: 'prod_2', name: 'Onboarding', active: true, metadata: { app: 'caremetric-intel', tier: 'onboarding_pro' } }))
      .toMatchObject({ app: 'caremetric-intel', kind: 'fee' });
    expect(normalizeProduct({ id: 'prod_3', name: 'X', active: true, metadata: { app: 'PennTrain' } }).app).toBeNull();
    expect(normalizeProduct({ id: 'prod_support', name: 'PennSync', active: true, metadata: { app: 'pennsync' } }).app).toBeNull();
  });
  it('classifies per-unit and flat prices and keeps a customer-specific tenant', () => {
    const tenant = '5f10a61e-3209-411a-8207-d657c8fd936d';
    expect(normalizePrice({ id: 'price_1', product: 'prod_1', active: true, currency: 'usd', unit_amount: 19900, type: 'recurring',
      recurring: { interval: 'month', interval_count: 1 }, metadata: { billing_metric: 'facility', hub_tenant_id: tenant } }))
      .toMatchObject({ pricing_model: 'per_unit', interval: 'month', tenant_id: tenant });
    expect(normalizePrice({ id: 'price_2', product: { id: 'prod_1' }, active: true, currency: 'usd', unit_amount: 50000, type: 'one_time', metadata: {} }))
      .toMatchObject({ pricing_model: 'flat', type: 'one_time', interval: null, product: 'prod_1' });
  });
  it('takes the billing period from the items and the coupon from either discount shape', () => {
    const subscription = normalizeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { app: 'breathe' },
      discounts: [{ id: 'di_1', source: { coupon: { id: 'co_1' } } }, { id: 'di_2', coupon: 'co_2', promotion_code: 'promo_1' }, 'di_bare'],
      items: { data: [
        { id: 'si_1', price: { id: 'price_1', product: 'prod_1', unit_amount: 100, recurring: { interval: 'month' } }, quantity: 2, current_period_start: 10, current_period_end: 20 },
        { id: 'si_2', price: { id: 'price_2', product: 'prod_2', unit_amount: 50, recurring: { interval: 'month' } }, quantity: 1, current_period_start: 5, current_period_end: 30 },
      ] } });
    expect([subscription.current_period_start, subscription.current_period_end]).toEqual([5, 30]);
    expect(subscription.discounts).toEqual([{ id: 'di_1', coupon: 'co_1', promotion_code: null }, { id: 'di_2', coupon: 'co_2', promotion_code: 'promo_1' }]);
    expect(discountRef({ id: 'not-a-discount', coupon: 'co_1' })).toBeNull();
  });
  it('reads the subscription from an invoice’s parent and drops unsafe links', () => {
    expect(normalizeInvoice({ id: 'in_1', customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1', metadata: { app: 'carebase' } } },
      hosted_invoice_url: 'javascript:alert(1)', invoice_pdf: 'https://pay.stripe.com/x.pdf', total: 100 }))
      .toMatchObject({ subscription: 'sub_1', app: 'carebase', hosted_invoice_url: null, invoice_pdf: 'https://pay.stripe.com/x.pdf' });
  });
  it('maps events to the object they change', () => {
    expect(eventTarget({ type: 'customer.discount.created', data: { object: { subscription: 'sub_1' } } })).toEqual({ kind: 'subscription', id: 'sub_1' });
    expect(eventTarget({ type: 'invoice.paid', data: { object: { object: 'invoice', id: 'in_1' } } })).toEqual({ kind: 'invoice', id: 'in_1' });
    expect(eventTarget({ type: 'charge.succeeded', data: { object: { id: 'ch_1' } } })).toBeNull();
    expect(eventTarget({ type: 'checkout.session.async_payment_succeeded', data: { object: { object: 'checkout.session', id: 'cs_test_1' } } })).toEqual({ kind: 'checkout', id: 'cs_test_1' });
  });
  it('keeps malformed checkout markers held instead of treating them as legacy subscriptions', () => {
    expect(normalizeSubscription({ id: 'sub_1', metadata: { hub_checkout_quote: 'invalid' } })).toMatchObject({ checkout_required: true, checkout_quote: null });
    expect(normalizeSubscription({ id: 'sub_legacy', metadata: {} })).toMatchObject({ checkout_required: false, checkout_quote: null });
  });
});
