import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './sms-auth.mjs';
import { initialSubscriptionLines } from '../src/billing/facilityAllocations.ts';
import { assertPlanFits } from '../src/billing/planSize.ts';
import { selfServiceApps } from '../src/self-service/protocol.ts';
import { CHECKOUT_API_VERSION, normalizers, StripeError, withAllSubscriptionItems } from './stripe.mjs';

const reference = value => typeof value === 'string' ? value : value?.id;
const linesOf = subscription => (subscription.items?.data ?? []).map(item => ({ price: reference(item.price), quantity: item.quantity ?? 1 }));
const sameLines = (left, right) => JSON.stringify([...left].sort((a, b) => a.price.localeCompare(b.price))) === JSON.stringify([...right].sort((a, b) => a.price.localeCompare(b.price)));
const options = { apiVersion: CHECKOUT_API_VERSION };
const terminal = state => ['applied', 'failed', 'superseded'].includes(state);
const integrationIdentifier = id => `caremetric_support_checkout_${createHash('sha256').update(id).digest().subarray(0, 8).reduce((text, byte) => text + String.fromCharCode(97 + byte % 26), '')}`;
export function checkoutUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://checkout.stripe.com' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** A browser return URL is navigation only. Only a verified provider receipt grants access. */
export function customerCheckoutService({ stripe, service, mirrorCustomer, mirrorSubscription, mirrorInvoice, publicOrigin, now = () => Date.now() }) {
  const work = async id => (await service('customer_checkout_work', [id])) ?? [];
  const bind = (id, customer, session = null) => service('bind_customer_checkout', [id, customer, session]);
  const fail = id => service('settle_customer_billing_quote', [id, 'failed', null, null, null]);

  async function noExistingSubscription(live, workspace, ownQuote = null) {
    if (!workspace.customer) return;
    const subscriptions = await live.list('/v1/subscriptions', { customer: workspace.customer, status: 'all' }, 1000);
    // Never interpret a truncated provider result as proof that an account is new.
    if (subscriptions.truncated) throw new HttpError(409, 'This account needs billing reconciliation before starting a subscription.');
    const products = new Set(workspace.catalog.map(price => price.product));
    if (subscriptions.some(sub => !['canceled', 'incomplete_expired'].includes(sub.status)
      && !(ownQuote && sub.metadata?.hub_checkout_quote === ownQuote)
      && (!sub.metadata?.app || sub.metadata.app === workspace.app || workspace.app === 'caremetric-emr' && sub.metadata.app === 'caremetric-go'
        || sub.items?.data?.some(item => products.has(reference(item.price?.product)))))) {
      throw new HttpError(409, 'An existing subscription or trial must be resolved before starting a new subscription. Refresh billing.');
    }
  }

  // The requester saves the quote under its own identity: a Hub customer session, or an application administrator.
  async function preview(requester, input, workspace, authority) {
    if (!selfServiceApps.includes(workspace.app) || workspace.mode !== 'legacy' || workspace.role !== 'organization_admin' || input.facility_id !== null) throw new HttpError(403, 'An organization administrator must set up the shared subscription.');
    if (workspace.pending_checkout) throw new HttpError(409, 'Resume or cancel the pending checkout before selecting another plan.');
    let lines;
    try {
      lines = initialSubscriptionLines(input.plan, input.addons, workspace.catalog, workspace.facilities.length);
      assertPlanFits(workspace.catalog.find(price => price.id === input.plan), authority, null);
    } catch (error) { throw new HttpError(400, error.message); }
    const live = await stripe();
    await noExistingSubscription(live, workspace);
    const catalog = new Map(workspace.catalog.map(price => [price.id, price]));
    const currency = catalog.get(input.plan).currency;
    const invoice = await live.post('/v1/invoices/create_preview', { ...(workspace.customer ? { customer: workspace.customer } : {}),
      subscription_details: { items: lines }, currency });
    if (invoice.currency !== currency || !Number.isSafeInteger(invoice.amount_due) || invoice.amount_due < 0) throw new HttpError(409, 'The billing preview could not be verified. Refresh billing.');
    const id = randomUUID();
    const quote = { id, kind: 'checkout', facility_name: 'Organization subscription', due_now: invoice.amount_due, currency,
      recurring_subtotal: lines.reduce((total, line) => total + catalog.get(line.price).amount * line.quantity, 0), effective_at: null,
      expires_at: new Date(now() + 300000).toISOString(), has_immediate_change: true, has_scheduled_change: false,
      summary: lines.map(line => ({ name: catalog.get(line.price).name, quantity: line.quantity, amount: catalog.get(line.price).amount * line.quantity })) };
    // An application's customer returns from Checkout to the application's own page, fixed here so every retry of the
    // idempotent session request sends identical parameters. Hub customers return to the customer center.
    const execution = { kind: 'checkout', mode: 'legacy', app: workspace.app, customer: workspace.customer, account_name: workspace.account_name,
      billing_revision: workspace.billing_revision, facility_id: null, lines, intent: { plan: input.plan, addons: [...input.addons].sort() },
      maximumDue: quote.due_now, currency, interval: catalog.get(input.plan).interval, facility_ids: workspace.facilities.map(site => site.id).sort(),
      ...(requester.returnUrl ? { return_url: requester.returnUrl } : {}) };
    return requester.saveQuote(id, input.connection_id, null, input.request_id, quote, execution, 0, null);
  }

  function verifySessionIdentity(checkout, quote) {
    if (checkout.id !== quote.checkout || checkout.mode !== 'subscription' || reference(checkout.customer) !== quote.execution.customer
      || checkout.client_reference_id !== quote.id || checkout.metadata?.hub_checkout_quote !== quote.id
      || checkout.metadata?.app !== quote.execution.app || checkout.metadata?.hub_tenant_id !== quote.tenant_id) {
      throw new HttpError(409, 'The checkout receipt does not match the confirmed selection. Open a billing support request.');
    }
  }

  async function receipt(live, quote, checkout) {
    verifySessionIdentity(checkout, quote);
    if (terminal(quote.state)) return { state: quote.state };
    if (checkout.status === 'expired') { await fail(quote.id); return { state: 'failed' }; }
    if (checkout.currency !== quote.execution.currency || !Number.isSafeInteger(checkout.amount_total)
      || checkout.amount_total > quote.execution.maximumDue || checkout.amount_total < 0) throw new HttpError(409, 'The payment amount changed. Cancel this checkout and review a new preview.');
    if (checkout.status === 'open') {
      const url = checkoutUrl(checkout.url);
      if (!url) throw new HttpError(503, 'The payment page could not be verified. Resume checkout to try again.');
      return { state: 'pending_payment', url };
    }
    if (checkout.status !== 'complete') throw new HttpError(409, 'The payment status could not be verified.');
    if (!['paid', 'no_payment_required'].includes(checkout.payment_status)) return { state: 'pending_payment' };
    const subscriptionId = reference(checkout.subscription), invoiceId = reference(checkout.invoice);
    if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId ?? '') || !/^in_[A-Za-z0-9]+$/.test(invoiceId ?? '')) throw new HttpError(409, 'The initial subscription receipt is unavailable.');
    let subscription = await live.get(`/v1/subscriptions/${subscriptionId}`);
    try { subscription = await withAllSubscriptionItems(live, subscription); }
    catch (error) {
      if (error instanceof StripeError && error.code === 'subscription_items_incomplete') {
        throw new HttpError(409, 'Payment and subscription details need reconciliation before access can be granted. Open a billing support request.');
      }
      throw error;
    }
    const invoice = await live.get(`/v1/invoices/${invoiceId}`);
    const normalized = normalizers.invoice(invoice);
    const lines = await live.list(`/v1/checkout/sessions/${checkout.id}/line_items`, {}, 100);
    if (reference(subscription.customer) !== quote.execution.customer || subscription.metadata?.hub_checkout_quote !== quote.id
      || subscription.metadata?.hub_tenant_id !== quote.tenant_id || subscription.metadata?.app !== quote.execution.app
      || subscription.status !== 'active' || subscription.pending_update || subscription.items?.has_more
      || !sameLines(linesOf(subscription), quote.execution.lines)
      || !sameLines(lines.map(line => ({ price: reference(line.price), quantity: line.quantity })), quote.execution.lines)
      || normalized.subscription !== subscription.id || normalized.customer !== quote.execution.customer || invoice.status !== 'paid'
      || invoice.billing_reason !== 'subscription_create' || invoice.currency !== quote.execution.currency
      || !Number.isSafeInteger(invoice.amount_due) || invoice.amount_due > quote.execution.maximumDue || invoice.amount_remaining !== 0) {
      throw new HttpError(409, 'Payment and subscription details need reconciliation before access can be granted. Open a billing support request.');
    }
    await mirrorSubscription(subscription);
    await mirrorInvoice(invoice);
    // SQL checks the same tenant, app, customer, subscription and paid invoice atomically.
    await service('complete_customer_checkout', [quote.id, checkout.id, subscription.id, invoice.id]);
    return { state: 'applied' };
  }

  async function start(quote, workspace, { allowCreate = true } = {}) {
    if (terminal(quote.state)) return { state: quote.state };
    if (workspace.role !== 'organization_admin' || workspace.mode !== 'legacy' || !selfServiceApps.includes(workspace.app)) throw new HttpError(403, 'Organization purchasing is required.');
    const live = await stripe();
    if (quote.checkout) return receipt(live, quote, await live.get(`/v1/checkout/sessions/${quote.checkout}`, {}, options));
    const execution = quote.execution;
    if (execution.app !== workspace.app || quote.tenant_id !== workspace.tenant_id
      || JSON.stringify(execution.facility_ids) !== JSON.stringify(workspace.facilities.map(site => site.id).sort())) throw new HttpError(409, 'Facility setup changed. Cancel this checkout and review a new selection.');
    await noExistingSubscription(live, workspace, quote.id);
    let customer = execution.customer ?? workspace.customer;
    if (!customer) {
      const created = await live.post('/v1/customers', { name: execution.account_name, metadata: { hub_tenant_id: quote.tenant_id } },
        { idempotencyKey: `hub-customer-${quote.tenant_id}` });
      customer = created.id;
      await mirrorCustomer(created);
      quote = await bind(quote.id, customer);
    }
    if (quote.execution.customer !== customer) quote = await bind(quote.id, customer);
    const account = await live.get(`/v1/customers/${customer}`);
    if (account.deleted || account.metadata?.hub_tenant_id !== quote.tenant_id) throw new HttpError(409, 'The payment account changed. Open a billing support request.');
    const age = now() - Date.parse(quote.confirmed_at);
    let checkout;
    if (age >= 30 * 60 * 1000 || !allowCreate) {
      // A delayed retry must never create a new session after Stripe's idempotency window.
      const sessions = await live.list('/v1/checkout/sessions', { customer }, 1000);
      const matches = sessions.filter(item => item.metadata?.hub_checkout_quote === quote.id);
      if (matches.length !== 1) throw new HttpError(409, 'This checkout needs payment reconciliation before it can be retried. Open a billing support request.');
      checkout = matches[0];
    } else {
      let back;
      try { back = execution.return_url ? new URL(execution.return_url) : new URL('/subscriptions', new URL(publicOrigin).origin); }
      catch { throw new HttpError(503, 'The customer center address is not configured.'); }
      if (back.protocol !== 'https:' || back.username || back.password) throw new HttpError(503, 'The customer center address is not configured.');
      const returned = new URL(back), cancelled = new URL(back);
      returned.searchParams.set('checkout', 'returned'); cancelled.searchParams.set('checkout', 'cancelled');
      await service('mark_customer_purchase_started', [quote.id]);
      try { checkout = await live.post('/v1/checkout/sessions', { mode: 'subscription', customer, line_items: execution.lines,
        client_reference_id: quote.id, integration_identifier: integrationIdentifier(quote.id),
        metadata: { hub_checkout_quote: quote.id, hub_tenant_id: quote.tenant_id, app: execution.app },
        subscription_data: { metadata: { hub_checkout_quote: quote.id, hub_tenant_id: quote.tenant_id, app: execution.app } },
        expires_at: Math.floor(Date.parse(quote.confirmed_at) / 1000) + 3600,
        success_url: returned.href, cancel_url: cancelled.href,
      }, { ...options, idempotencyKey: `hub-checkout-${quote.id}` }); }
      catch (error) {
        if (error instanceof StripeError && error.type === 'invalid_request_error' && [400, 404].includes(error.status)) await fail(quote.id);
        throw error;
      }
    }
    // Persist the provider identity before giving the browser a payment URL.
    quote = await bind(quote.id, customer, checkout.id);
    return receipt(live, quote, await live.get(`/v1/checkout/sessions/${checkout.id}`, {}, options));
  }

  async function cancel(quote, workspace) {
    if (terminal(quote.state)) return { state: quote.state };
    if (!quote.checkout && !quote.payment_request_started_at) { await fail(quote.id); return { state: 'failed' }; }
    if (!quote.checkout) {
      await start(quote, workspace);
      [quote] = await work(quote.id);
      if (!quote || terminal(quote.state)) return { state: quote?.state ?? 'failed' };
    }
    const live = await stripe();
    let checkout = await live.get(`/v1/checkout/sessions/${quote.checkout}`, {}, options);
    verifySessionIdentity(checkout, quote);
    if (checkout.status === 'open') {
      try { await live.post(`/v1/checkout/sessions/${checkout.id}/expire`, {}, { ...options, idempotencyKey: `hub-checkout-${quote.id}-expire` }); }
      catch (error) {
        // Payment may have won the race with cancellation. The latest receipt decides.
        checkout = await live.get(`/v1/checkout/sessions/${checkout.id}`, {}, options);
        if (checkout.status === 'open') throw error;
      }
      checkout = await live.get(`/v1/checkout/sessions/${checkout.id}`, {}, options);
    }
    return receipt(live, quote, checkout);
  }

  async function reconcile(checkoutId) {
    const quotes = await service('customer_checkout_for_session', [checkoutId]);
    if (!quotes?.length) return;
    const live = await stripe();
    for (const quote of quotes) await receipt(live, quote, await live.get(`/v1/checkout/sessions/${checkoutId}`, {}, options));
  }
  async function reconcileAll() {
    const quotes = await work(null);
    let failed = 0, unbound = 0;
    for (let quote of quotes) {
      try {
        if (!quote.checkout && quote.execution.customer && quote.payment_request_started_at) {
          const live = await stripe();
          const sessions = await live.list('/v1/checkout/sessions', { customer: quote.execution.customer }, 1000);
          const matches = sessions.filter(item => item.metadata?.hub_checkout_quote === quote.id);
          if (matches.length > 1) throw new HttpError(409, 'Duplicate checkout identities need reconciliation.');
          if (matches.length === 1) {
            verifySessionIdentity(matches[0], { ...quote, checkout: matches[0].id });
            quote = await bind(quote.id, quote.execution.customer, matches[0].id);
          }
        }
        if (quote.checkout) await reconcile(quote.checkout);
        else unbound++;
      } catch { failed++; }
    }
    return { pending: quotes.length, failed, unbound };
  }
  return { preview, start, cancel, reconcile, reconcileAll };
}
