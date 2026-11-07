import { describe, expect, it, vi } from 'vitest';
import { customerBillingService } from './customer-billing.mjs';
import { checkoutUrl } from './customer-checkout.mjs';
import { CHECKOUT_API_VERSION, StripeError } from './stripe.mjs';

const connection = '95000000-0000-4000-8000-000000000011', tenant = '95000000-0000-4000-8000-000000000012';
function fixture({ customer = null, role = 'organization_admin', enabled = true } = {}) {
  const quotes = new Map(), events = [], requests = new Map();
  let time = Date.parse('2026-10-27T00:00:00Z'), checkout, subscription, invoice;
  let subscriptions = [], otherSessions = [];
  const workspace = { connection_id: connection, tenant_id: tenant, app: 'carebase', role, mode: 'legacy', can_activate: false,
    configuration_version: 0, billing_revision: 0, account_name: 'Synthetic organization', pending_checkout: null,
    facilities: ['site-a', 'site-b'].map(id => ({ id, name: id, permissions: ['billing.manage'] })), allocations: [], subscription: null,
    customer, loaded_at: new Date(time).toISOString(), catalog: [{ id: 'price_core', product: 'prod_core', name: 'Core', description: '', kind: 'plan',
      key: 'core', features: [], allows_addons: true, active: true, amount: 1000, currency: 'usd', interval: 'month', interval_count: 1, model: 'per_unit', unit_label: 'facility' }] };
  const query = vi.fn(async (sql, args = []) => {
    let result;
    if (sql.includes('private.customer_billing_context')) result = structuredClone(workspace);
    if (sql.includes('private.save_customer_billing_quote')) {
      const quote = JSON.parse(args[4]), execution = JSON.parse(args[5]);
      quotes.set(args[0], { id: args[0], state: 'preview', execution, tenant_id: tenant, connection_id: connection, checkout: null });
      events.push('preview'); result = quote;
    }
    if (sql.includes('private.claim_customer_billing_quote')) {
      const quote = quotes.get(args[0]);
      if (args[1] && quote.state === 'preview') { quote.state = 'confirming'; quote.confirmed_at = new Date(time).toISOString(); events.push('reserved'); }
      result = structuredClone(quote);
    }
    if (sql.includes('private.bind_customer_checkout')) {
      const quote = quotes.get(args[0]); quote.execution.customer = args[1];
      if (args[2]) { quote.checkout = args[2]; quote.state = 'pending_payment'; events.push('bound'); }
      result = structuredClone(quote);
    }
    if (sql.includes('private.mark_customer_purchase_started')) quotes.get(args[0]).payment_request_started_at = new Date(time).toISOString();
    if (sql.includes('private.customer_checkout_status')) result = structuredClone(quotes.get(args[0]));
    if (sql.includes('private.customer_checkout_work')) result = [...quotes.values()].filter(quote => args[0] ? quote.id === args[0] : ['confirming', 'pending_payment'].includes(quote.state));
    if (sql.includes('private.customer_checkout_for_session')) result = [...quotes.values()].filter(quote => quote.checkout === args[0]);
    if (sql.includes('private.settle_customer_billing_quote')) { quotes.get(args[0]).state = args[1]; events.push(args[1]); }
    if (sql.includes('private.complete_customer_checkout')) { quotes.get(args[0]).state = 'applied'; events.push('applied'); }
    return { rows: [{ result }] };
  });
  const live = {
    list: vi.fn(async path => structuredClone(path === '/v1/subscriptions' ? subscriptions : path === '/v1/checkout/sessions' ? [...otherSessions, ...(checkout ? [checkout] : [])]
      : workspace.catalog.filter(price => price.id === 'price_core').map(price => ({ price: { id: price.id }, quantity: price.model === 'flat' ? 1 : 2 })))),
    get: vi.fn(async path => structuredClone(path.startsWith('/v1/checkout/sessions/') ? checkout : path.startsWith('/v1/subscriptions/') ? subscription
      : path.startsWith('/v1/invoices/') ? invoice : { id: workspace.customer, metadata: { hub_tenant_id: tenant } })),
    post: vi.fn(async (path, params, options) => {
      if (path === '/v1/invoices/create_preview') return { amount_due: 2000, currency: 'usd' };
      if (path === '/v1/customers') { events.push('customer'); return { id: 'cus_new', name: params.name, metadata: params.metadata }; }
      if (path === '/v1/checkout/sessions') {
        expect(events).toContain('reserved');
        const prior = requests.get(options.idempotencyKey);
        if (prior) { expect(params).toEqual(prior); return structuredClone(checkout); }
        requests.set(options.idempotencyKey, structuredClone(params)); events.push('checkout_created');
        checkout = { id: 'cs_test_new', object: 'checkout.session', mode: params.mode, customer: params.customer,
          client_reference_id: params.client_reference_id, metadata: params.metadata, currency: 'usd', amount_total: 2000,
          status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/c/pay/cs_test_new' };
        return structuredClone(checkout);
      }
      if (path === '/v1/checkout/sessions/cs_test_new/expire') { events.push('expired'); checkout.status = 'expired'; return structuredClone(checkout); }
      throw new Error(`Unexpected operation ${path}`);
    }),
  };
  const authorize = vi.fn(async () => ({ authorized: true }));
  const service = customerBillingService({ pool: { connect: async () => ({ query, release() {} }) }, stripe: async () => live,
    mirrorCustomer: async value => { workspace.customer = value.id; events.push('customer_mirrored'); },
    mirrorSubscription: async () => { events.push('subscription_mirrored'); }, mirrorInvoice: async () => { events.push('invoice_mirrored'); },
    authorize, now: () => time, purchasingEnabled: enabled, publicOrigin: 'https://hub.test' });
  const preview = () => service.handle('session', { action: 'quote', connection_id: connection, facility_id: null, plan: 'price_core', addons: [], request_id: crypto.randomUUID() });
  const confirm = quote => service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true });
  const manage = (quote, action = 'checkout_resume') => service.handle('new-session', { action, connection_id: connection, quote_id: quote.id, ...(action === 'checkout_cancel' ? { confirmed: true } : {}) });
  function complete(paymentStatus = 'paid') {
    checkout = { ...checkout, status: 'complete', payment_status: paymentStatus, subscription: 'sub_new', invoice: 'in_new', url: null };
    subscription = { id: 'sub_new', customer: 'cus_new', metadata: checkout.metadata, status: 'active', items: { data: [{ id: 'si_new', price: { id: 'price_core' }, quantity: 2 }] } };
    invoice = { id: 'in_new', customer: 'cus_new', subscription: 'sub_new', status: 'paid', billing_reason: 'subscription_create', currency: 'usd', amount_due: 2000, amount_remaining: 0 };
  }
  return { service, workspace, live, events, quotes, authorize, query, preview, confirm, manage, complete,
    mutateCheckout: values => { checkout = { ...checkout, ...values }; }, mutateSubscription: values => { subscription = { ...subscription, ...values }; },
    mutateInvoice: values => { invoice = { ...invoice, ...values }; }, existingSubscriptions: values => { subscriptions = values; },
    otherSessions: values => { otherSessions = values; }, advance: milliseconds => { time += milliseconds; } };
}

describe('initial subscription Checkout', () => {
  it('refuses PennSync before any payment provider request', async () => {
    const test = fixture(); test.workspace.app = 'pennsync';
    await expect(test.service.handle('session', { action: 'workspace', connection_id: connection })).rejects.toMatchObject({ status: 403 });
    expect(test.live.get).not.toHaveBeenCalled();
    expect(test.live.post).not.toHaveBeenCalled();
  });
  it('reserves before provider work and binds a recoverable payment URL without granting access', async () => {
    const test = fixture(), quote = await test.preview();
    expect(quote).toMatchObject({ kind: 'checkout', due_now: 2000, recurring_subtotal: 2000 });
    await expect(test.confirm(quote)).resolves.toEqual({ state: 'pending_payment', url: 'https://checkout.stripe.com/c/pay/cs_test_new' });
    expect(test.events).toEqual(['preview', 'reserved', 'customer', 'customer_mirrored', 'checkout_created', 'bound']);
    const [, params, options] = test.live.post.mock.calls.find(([path]) => path === '/v1/checkout/sessions');
    expect(options).toMatchObject({ apiVersion: CHECKOUT_API_VERSION, idempotencyKey: `hub-checkout-${quote.id}` });
    expect(params).toMatchObject({ mode: 'subscription', line_items: [{ price: 'price_core', quantity: 2 }], subscription_data: { metadata: { hub_checkout_quote: quote.id } } });
    expect(params.integration_identifier).toMatch(/^caremetric_support_checkout_[a-z]{8}$/);
    expect(params).not.toHaveProperty('payment_method_types'); expect(params).not.toHaveProperty('automatic_tax');
    expect(params.success_url).toBe('https://hub.test/subscriptions?checkout=returned');
    await test.manage(quote); expect(test.events.filter(event => event === 'checkout_created')).toHaveLength(1);
  });
  it.each(['active', 'trialing', 'incomplete', 'paused', 'past_due'])('refuses a second subscription when the provider has an existing %s account', async status => {
    const test = fixture({ customer: 'cus_new' }); test.existingSubscriptions([{ id: 'sub_prior', status, metadata: { app: 'carebase' } }]);
    await expect(test.preview()).rejects.toMatchObject({ status: 409 }); expect(test.events).toEqual([]);
  });
  it('refuses EMR purchases because it is outside the centralized Hub', async () => {
    const test = fixture({ customer: 'cus_new' }); test.workspace.app = 'caremetric-emr';
    test.existingSubscriptions([{ id: 'sub_shared', status: 'active', metadata: { app: 'caremetric-go' } }]);
    await expect(test.preview()).rejects.toMatchObject({ status: 403 });
  });
  it('allows another known application on a consolidated customer without duplicating its charges', async () => {
    const test = fixture({ customer: 'cus_new' }); test.existingSubscriptions([{ id: 'sub_other_app', status: 'active', metadata: { app: 'breathe' } }]);
    await expect(test.preview()).resolves.toMatchObject({ kind: 'checkout' });
  });
  it('refreshes native quantities after the authorization callback', async () => {
    const test = fixture(); test.authorize.mockImplementation(async () => { test.workspace.facilities = []; return { authorized: true }; });
    await expect(test.preview()).rejects.toMatchObject({ status: 400 }); expect(test.live.post).not.toHaveBeenCalled();
  });
  it('keeps flat products at quantity one for an organization with no roster or facilities', async () => {
    const test = fixture(); test.workspace.facilities = []; test.workspace.catalog[0].model = 'flat';
    expect((await test.preview()).summary).toMatchObject([{ quantity: 1 }]);
  });
  it.each(['patient', 'seat', 'employee', ''])('refuses to invent a quantity for the %s billing basis', async unit_label => {
    const test = fixture(); test.workspace.catalog[0].unit_label = unit_label;
    await expect(test.preview()).rejects.toMatchObject({ status: 400 }); expect(test.live.post).not.toHaveBeenCalled();
  });
  it('sells a small-home plan only when the application confirms every facility is under the bed limit', async () => {
    const test = fixture(); test.workspace.catalog[0] = { ...test.workspace.catalog[0], key: 'small_home', name: 'Small Home' };
    await expect(test.preview()).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/could not confirm/) });
    const size = { small_home_bed_limit: 20, active_facilities: 2, small_home_eligible: false, single_facility_eligible: false,
      facilities: [{ facility_id: 'site-a', licensed_beds: 12, small_home: true }, { facility_id: 'site-b', licensed_beds: 24, small_home: false }] };
    test.authorize.mockResolvedValue({ authorized: true, plan_size: size });
    await expect(test.preview()).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/fewer than 20 beds/) });
    expect(test.live.post).not.toHaveBeenCalled(); expect(test.events).toEqual([]);
    test.authorize.mockResolvedValue({ authorized: true, plan_size: { ...size, small_home_eligible: true } });
    await expect(test.preview()).resolves.toMatchObject({ kind: 'checkout' });
  });
  it('sells Train Single Facility only to an organization with one active facility', async () => {
    const test = fixture(); test.workspace.catalog[0] = { ...test.workspace.catalog[0], key: 'train_single_facility', name: 'Train Single Facility', model: 'flat', unit_label: '' };
    const size = { small_home_bed_limit: 20, active_facilities: 2, small_home_eligible: false, single_facility_eligible: false, facilities: [] };
    test.authorize.mockResolvedValue({ authorized: true, plan_size: size });
    await expect(test.preview()).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/one active facility/) });
    test.workspace.facilities = test.workspace.facilities.slice(0, 1);
    test.authorize.mockResolvedValue({ authorized: true, plan_size: { ...size, active_facilities: 1, single_facility_eligible: true } });
    expect((await test.preview()).summary).toMatchObject([{ quantity: 1 }]);
  });
  it('blocks purchasing by a facility admin and keeps the rollout flag authoritative', async () => {
    const facility = fixture({ role: 'facility_admin' }); await expect(facility.preview()).rejects.toMatchObject({ status: 403 });
    const disabled = fixture({ enabled: false }), quote = await disabled.preview();
    await expect(disabled.confirm(quote)).rejects.toMatchObject({ status: 503 }); expect(disabled.events).toEqual(['preview']);
  });
  it('recovers a lost provider response with exactly the same parameters and one session', async () => {
    const test = fixture(), quote = await test.preview(), provider = test.live.post.getMockImplementation(); let lost = false;
    test.live.post.mockImplementation(async (...args) => { const value = await provider(...args); if (args[0] === '/v1/checkout/sessions' && !lost) { lost = true; throw new Error('Lost provider response'); } return value; });
    await expect(test.confirm(quote)).rejects.toThrow(/Lost/); test.advance(10000);
    await expect(test.manage(quote)).resolves.toMatchObject({ state: 'pending_payment' });
    expect(test.events.filter(event => event === 'checkout_created')).toHaveLength(1);
  });
  it('releases a reservation after a definitive rejection that created no payment session', async () => {
    const test = fixture(), quote = await test.preview(), provider = test.live.post.getMockImplementation();
    test.live.post.mockImplementation((...args) => args[0] === '/v1/checkout/sessions' ? Promise.reject(new StripeError(400, 'invalid_request_error', 'resource_missing', 'Price archived')) : provider(...args));
    await expect(test.confirm(quote)).rejects.toThrow('Price archived'); expect(test.quotes.get(quote.id).state).toBe('failed');
    expect(test.events).not.toContain('checkout_created');
  });
  it('does not recreate a session after the retry window and retains uncertain reservations', async () => {
    const test = fixture(), quote = await test.preview();
    const saved = test.quotes.get(quote.id); saved.state = 'confirming'; saved.confirmed_at = '2026-10-26T00:00:00Z'; saved.payment_request_started_at = saved.confirmed_at;
    test.advance(86400000);
    await expect(test.manage(quote)).rejects.toMatchObject({ status: 409 }); expect(test.events).not.toContain('checkout_created');
    expect(saved.state).toBe('confirming');
  });
  it('recovers an unbound session in the background after a lost provider response', async () => {
    const test = fixture(), quote = await test.preview(), provider = test.live.post.getMockImplementation();
    test.live.post.mockImplementation(async (...args) => { const value = await provider(...args); if (args[0] === '/v1/checkout/sessions') throw new Error('Lost provider response'); return value; });
    await expect(test.confirm(quote)).rejects.toThrow(/Lost/); test.complete();
    await expect(test.service.reconcileCheckouts()).resolves.toEqual({ pending: 1, failed: 0, unbound: 0 });
    expect(test.events).toContain('applied'); expect(test.events.filter(event => event === 'checkout_created')).toHaveLength(1);
  });
  it('grants access when the paid subscription’s prices continue past Stripe’s first item page', async () => {
    const test = fixture(), quote = await test.preview();
    await test.confirm(quote);
    test.complete();
    test.mutateSubscription({ items: { data: [{ id: 'si_page', price: { id: 'price_other' }, quantity: 1 }], has_more: true } });
    const listed = [{ id: 'si_new', price: { id: 'price_core' }, quantity: 2 }];
    const original = test.live.list.getMockImplementation();
    test.live.list.mockImplementation(async path => path === '/v1/subscription_items' ? listed : original(path));
    await test.service.reconcileCheckout('cs_test_new');
    expect(test.events).toContain('applied');
    expect(test.live.list).toHaveBeenCalledWith('/v1/subscription_items', { subscription: 'sub_new', expand: ['data.price'] }, 100);
  });
  it('waits through delayed payment and grants only after the exact initial paid invoice', async () => {
    const test = fixture(), quote = await test.preview(); await test.confirm(quote); test.complete('unpaid');
    await test.service.reconcileCheckout('cs_test_new'); expect(test.events).not.toContain('applied');
    test.mutateCheckout({ payment_status: 'paid' }); await test.service.reconcileCheckout('cs_test_new');
    expect(test.events.slice(-3)).toEqual(['subscription_mirrored', 'invoice_mirrored', 'applied']);
    await test.service.reconcileCheckout('cs_test_new'); expect(test.events.filter(event => event === 'applied')).toHaveLength(1);
  });
  it.each([{ customer: 'cus_other' }, { subscription: 'sub_other' }, { status: 'open' }, { billing_reason: 'subscription_cycle' }, { currency: 'eur' }, { amount_due: 2100 }])('rejects a mismatched or unpaid initial invoice: %j', async mutation => {
    const test = fixture(), quote = await test.preview(); await test.confirm(quote); test.complete(); test.mutateInvoice(mutation);
    await expect(test.service.reconcileCheckout('cs_test_new')).rejects.toMatchObject({ status: 409 }); expect(test.events).not.toContain('applied');
  });
  it('rejects paid receipts for a changed subscription selection', async () => {
    const test = fixture(), quote = await test.preview(); await test.confirm(quote); test.complete();
    test.mutateSubscription({ items: { data: [{ price: { id: 'price_core' }, quantity: 3 }] } });
    await expect(test.service.reconcileCheckout('cs_test_new')).rejects.toMatchObject({ status: 409 }); expect(test.events).not.toContain('applied');
  });
  it('ignores unbound sessions rather than trusting their event metadata', async () => {
    const test = fixture(); await test.preview(); await test.service.reconcileCheckout('cs_test_unknown'); expect(test.live.get).not.toHaveBeenCalled();
  });
  it('lets an admin cancel a price mismatch only after provider expiration is confirmed', async () => {
    const test = fixture(), quote = await test.preview(); await test.confirm(quote); test.mutateCheckout({ amount_total: 2100 });
    await expect(test.manage(quote)).rejects.toMatchObject({ status: 409 }); expect(test.events).not.toContain('failed');
    await expect(test.manage(quote, 'checkout_cancel')).resolves.toEqual({ state: 'failed' });
    expect(test.events.slice(-2)).toEqual(['expired', 'failed']);
  });
  it('does not release an open payment session when expiration cannot be verified', async () => {
    const test = fixture(), quote = await test.preview(); await test.confirm(quote);
    const provider = test.live.post.getMockImplementation(); test.live.post.mockImplementation((...args) => args[0].endsWith('/expire') ? Promise.reject(new Error('Provider unavailable')) : provider(...args));
    await expect(test.manage(quote, 'checkout_cancel')).rejects.toThrow(/unavailable/); expect(test.events).not.toContain('failed');
  });
  it('recovers a lost expiration response and a payment that wins the cancellation race', async () => {
    const test = fixture(), quote = await test.preview(); await test.confirm(quote);
    const provider = test.live.post.getMockImplementation(); test.live.post.mockImplementation(async (...args) => { if (args[0].endsWith('/expire')) { test.complete(); throw new Error('Already complete'); } return provider(...args); });
    await expect(test.manage(quote, 'checkout_cancel')).resolves.toEqual({ state: 'applied' }); expect(test.events).not.toContain('failed');
  });
  it('never returns an untrusted payment URL', async () => {
    const test = fixture(), quote = await test.preview(); await test.confirm(quote); test.mutateCheckout({ url: 'https://checkout.stripe.com.evil.invalid/pay' });
    await expect(test.manage(quote)).rejects.toMatchObject({ status: 503 });
    expect(checkoutUrl('javascript:alert(1)')).toBeNull(); expect(checkoutUrl('https://user:pass@checkout.stripe.com/pay')).toBeNull();
  });
});
