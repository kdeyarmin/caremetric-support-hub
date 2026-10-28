import { createHash, randomUUID } from 'node:crypto';
import { HttpError, withSession, transaction } from './sms-auth.mjs';
import { customerBillingRequest, customerBillingWorkspace } from '../src/billing/customerBillingProtocol.ts';
import { aggregateFacilityLines, planFacilityChange } from '../src/billing/facilityAllocations.ts';
import { selfServiceApps } from '../src/self-service/protocol.ts';
import { normalizers, StripeError } from './stripe.mjs';
import { customerCheckoutService } from './customer-checkout.mjs';

const rows = subscription => (subscription.items?.data ?? []).map(item => ({ price: item.price.id ?? item.price, quantity: item.quantity ?? 1 })).sort((a, b) => a.price.localeCompare(b.price));
export const sameBillingLines = (a, b) => JSON.stringify([...a].sort((x, y) => x.price.localeCompare(y.price))) === JSON.stringify([...b].sort((x, y) => x.price.localeCompare(y.price)));
export function subscriptionItemPatch(subscription, selected) {
  const current = subscription.items.data;
  if (new Set(current.map(item => item.price.id ?? item.price)).size !== current.length) throw new HttpError(409, 'Duplicate subscription prices need reconciliation before changing this account.');
  return [...current.map(item => {
    const next = selected.find(line => line.price === (item.price.id ?? item.price));
    return next ? { id: item.id, price: next.price, quantity: next.quantity } : { id: item.id, deleted: true };
  }), ...selected.filter(line => !current.some(item => (item.price.id ?? item.price) === line.price)).map(line => ({ ...line }))];
}
const reference = value => typeof value === 'string' ? value : value?.id;
const renewalOf = sub => sub.items.data[0]?.current_period_end ?? sub.current_period_end;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const scheduleFingerprint = schedule => createHash('sha256').update(JSON.stringify(canonical({
  status: schedule.status, current_phase: schedule.current_phase, phases: schedule.phases, end_behavior: schedule.end_behavior, metadata: schedule.metadata,
}))).digest('hex');
const phaseLines = phase => (phase?.items ?? []).map(item => ({ price: reference(item.price), quantity: item.quantity ?? 1 }));
const defined = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
const accountIdentity = value => value ? defined({ type: value.type, account: reference(value.account) }) : undefined;
// Stripe read responses contain expanded identities and read-only tax fields.
// Retain the current commercial settings using the schedule update's input shape.
function phaseSettings(phase) {
  return defined({
    collection_method: phase.collection_method,
    default_payment_method: reference(phase.default_payment_method),
    default_tax_rates: phase.default_tax_rates?.map(reference),
    automatic_tax: phase.automatic_tax ? defined({ enabled: phase.automatic_tax.enabled, liability: accountIdentity(phase.automatic_tax.liability) }) : undefined,
    discounts: phase.discounts?.map(discount => {
      if (typeof discount === 'string') return { discount };
      if (reference(discount.discount)) return { discount: reference(discount.discount) };
      if (reference(discount.promotion_code)) return { promotion_code: reference(discount.promotion_code) };
      if (reference(discount.coupon)) return { coupon: reference(discount.coupon) };
      throw new HttpError(409, 'This subscription has a discount that needs a billing review.');
    }),
    invoice_settings: phase.invoice_settings ? defined({
      account_tax_ids: phase.invoice_settings.account_tax_ids?.map(reference),
      days_until_due: phase.invoice_settings.days_until_due,
      custom_fields: phase.invoice_settings.custom_fields?.map(field => ({ name: field.name, value: field.value })),
      description: phase.invoice_settings.description, footer: phase.invoice_settings.footer,
      issuer: accountIdentity(phase.invoice_settings.issuer),
    }) : undefined,
    transfer_data: phase.transfer_data ? defined({ amount_percent: phase.transfer_data.amount_percent, destination: reference(phase.transfer_data.destination) }) : undefined,
    application_fee_percent: phase.application_fee_percent,
    on_behalf_of: reference(phase.on_behalf_of),
  });
}
function verifyAccount(subscription, execution) {
  if (reference(subscription.customer) !== execution.customer || subscription.metadata?.app !== execution.app) throw new HttpError(409, 'The subscription account changed. Review a new preview.');
}

/** Browser choices never supply prices, quantities, native permissions, or a provider mutation. */
export function customerBillingService({ pool, stripe, mirrorSubscription, mirrorCustomer, mirrorInvoice, publicOrigin, authorize, now = () => Date.now(), purchasingEnabled = false }) {
  const one = async (db, query, values) => (await db.query(query, values)).rows[0]?.result;
  const rpc = (session, name, values) => withSession(pool, session, async db => {
    await db.query('reset role');
    return one(db, `select private.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`, values);
  });
  const service = (name, values) => transaction(pool, db => one(db, `select private.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`, values));
  const checkout = customerCheckoutService({ stripe, rpc, service, mirrorCustomer, mirrorSubscription, mirrorInvoice, publicOrigin, now });
  const settle = (id, state, sub = null, schedule = null) => service('settle_customer_billing_quote', [id, state, sub, schedule, null]);
  const context = async (session, connection) => {
    const workspace = customerBillingWorkspace.parse(await rpc(session, 'customer_billing_context', [connection]));
    if (workspace.app === 'pennsync') throw new HttpError(403, 'PennSync does not accept payments.');
    if (!selfServiceApps.includes(workspace.app)) throw new HttpError(403, 'This application is independent of the centralized Hub.');
    // Individual and flat organization products need no fabricated native facility.
    // Quantity-based products require their app-owned usage adapter instead.
    if (workspace.mode === 'legacy' && !workspace.facilities.length && !workspace.allocations.length && workspace.subscription?.items.length) {
      const catalog = new Map(workspace.catalog.map(price => [price.id, price]));
      const items = workspace.subscription.items;
      const plans = items.filter(item => catalog.get(item.price)?.kind === 'plan');
      if (plans.length === 1 && items.every(item => item.quantity === 1 && catalog.get(item.price)?.model === 'flat')) {
        workspace.allocations = [{ facility_id: 'organization', facility_name: 'Organization subscription', plan: plans[0].price,
          addons: items.filter(item => catalog.get(item.price)?.kind === 'addon').map(item => item.price), version: 0 }];
      }
    }
    return workspace;
  };
  async function verifyScope(session, workspace, facility) {
    if (workspace.mode === 'legacy' && (facility !== null || workspace.role !== 'organization_admin')) throw new HttpError(403, 'Only the organization administrator can change the shared plan.');
    if (workspace.mode === 'facility' && !workspace.facilities.some(site => site.id === facility && (workspace.role === 'organization_admin' || site.permissions.includes('billing.manage')))) throw new HttpError(403, 'Facility purchasing is not authorized.');
    return authorize(session, workspace.connection_id, facility);
  }
  function publicWorkspace(workspace) {
    if (workspace.role === 'organization_admin') return workspace;
    const permitted = new Set(workspace.facilities.filter(site => site.permissions.includes('billing.manage')).map(site => site.id));
    return { ...workspace, allocations: workspace.allocations.filter(row => permitted.has(row.facility_id)), customer: null, pending_checkout: null,
      subscription: workspace.subscription ? { ...workspace.subscription, items: [] } : null };
  }
  async function providerSubscription(live, workspace) {
    if (!workspace.subscription) throw new HttpError(409, 'A current organization subscription is required before changing its plan.');
    const sub = await live.get(`/v1/subscriptions/${workspace.subscription.id}`, { expand: ['latest_invoice', 'discounts'] });
    if (reference(sub.customer) !== workspace.customer || sub.metadata?.app !== workspace.app) throw new HttpError(409, 'The subscription account changed. Refresh billing.');
    if (!['active'].includes(sub.status) || sub.pause_collection || sub.cancel_at_period_end || sub.pending_update) throw new HttpError(409, 'Resolve the pending payment, cancellation, pause, or trial before changing this subscription.');
    return sub;
  }
  async function preview(session, input) {
    let workspace = await context(session, input.connection_id);
    await verifyScope(session, workspace, input.facility_id);
    workspace = await context(session, input.connection_id);
    if (!workspace.subscription) return checkout.preview(session, input, workspace);
    const live = await stripe(), sub = await providerSubscription(live, workspace);
    const catalog = new Map(workspace.catalog.map(price => [price.id, price]));
    if ([input.plan, ...input.addons].filter(Boolean).some(id => {
      const price = catalog.get(id);
      return price?.model === 'per_unit' && (!workspace.facilities.length || !/^facilit(?:y|ies)$/i.test(price.unit_label));
    })) {
      throw new HttpError(409, 'This product uses quantity-based billing. Its native usage must be verified before changing the subscription.');
    }
    let immediate = workspace.allocations, next = workspace.allocations;
    const targets = workspace.mode === 'legacy' ? workspace.allocations : workspace.allocations.filter(row => row.facility_id === input.facility_id);
    if (!targets.length) throw new HttpError(409, 'Complete facility setup before selecting a subscription.');
    if (!sameBillingLines(aggregateFacilityLines(workspace.allocations, catalog), rows(sub))) throw new HttpError(409, 'Current quantities need reconciliation before changing this account. Existing prices and access are retained.');
    for (const prior of targets) {
      let change;
      try { change = planFacilityChange(immediate, { ...prior, plan: input.plan, addons: input.addons }, workspace.catalog, workspace.subscription); }
      catch (error) { throw new HttpError(400, error.message); }
      immediate = change.immediate;
      next = next.map(row => row.facility_id === prior.facility_id ? { ...row, plan: input.plan, addons: input.addons } : row.pending_at ? { ...row, plan: row.pending_plan ?? null, addons: row.pending_addons ?? [] } : row);
    }
    const immediateLines = aggregateFacilityLines(immediate, catalog), nextLines = aggregateFacilityLines(next, catalog);
    const hasImmediate = !sameBillingLines(rows(sub), immediateLines), hasScheduled = !sameBillingLines(immediateLines, nextLines);
    const cancelSchedule = Boolean(sub.schedule) && !hasImmediate && !hasScheduled;
    if (!hasImmediate && !hasScheduled && !cancelSchedule) throw new HttpError(400, 'The selected services already match your subscription.');
    if (sub.schedule && hasImmediate) throw new HttpError(409, 'This subscription has a scheduled change. Review it before making an immediate purchase.');
    let priorSchedule = null;
    if (sub.schedule) {
      priorSchedule = await live.get(`/v1/subscription_schedules/${reference(sub.schedule)}`);
      if (priorSchedule.metadata?.hub_self_service !== 'true') throw new HttpError(409, 'This contract has a managed billing schedule. Its existing terms are retained.');
    }
    const prorationDate = Math.floor(now() / 1000);
    const invoice = hasImmediate ? await live.post('/v1/invoices/create_preview', { subscription: sub.id,
      subscription_details: { items: subscriptionItemPatch(sub, immediateLines), proration_behavior: 'always_invoice', proration_date: prorationDate } }) : null;
    const id = randomUUID(), renewal = new Date(renewalOf(sub) * 1000).toISOString();
    const visibleLines = workspace.role === 'organization_admin' ? nextLines : aggregateFacilityLines(next.filter(row => row.facility_id === input.facility_id), catalog);
    const quote = { id, facility_name: input.facility_id ? targets[0].facility_name : workspace.facilities.length ? 'All facilities in this organization' : 'Organization subscription', due_now: invoice?.amount_due ?? 0,
      currency: workspace.subscription.currency, recurring_subtotal: visibleLines.reduce((sum, line) => sum + catalog.get(line.price).amount * line.quantity, 0),
      effective_at: hasScheduled ? renewal : null, expires_at: new Date(now() + 300000).toISOString(), has_immediate_change: hasImmediate, has_scheduled_change: hasScheduled, cancels_scheduled_change: cancelSchedule,
      summary: visibleLines.map(line => ({ name: catalog.get(line.price).name, quantity: line.quantity, amount: catalog.get(line.price).amount * line.quantity })) };
    const execution = { mode: workspace.mode, app: workspace.app, customer: workspace.customer, billing_revision: workspace.billing_revision, facility_id: input.facility_id, immediate, next, immediateLines, nextLines,
      intent: { plan: input.plan, addons: [...input.addons].sort() }, originalLines: rows(sub), purchaseItems: subscriptionItemPatch(sub, immediateLines), renewal, prorationDate, interval: workspace.subscription.interval, hasImmediate, hasScheduled, cancelSchedule, maximumDue: quote.due_now, currency: quote.currency, schedule: reference(sub.schedule) ?? null, scheduleFingerprint: priorSchedule ? scheduleFingerprint(priorSchedule) : null };
    return rpc(session, 'save_customer_billing_quote', [id, input.connection_id, input.facility_id, input.request_id, JSON.stringify(quote), JSON.stringify(execution), workspace.subscription.version, sub.id]);
  }
  async function scheduleChange(live, quote, subscription) {
    const execution = quote.execution;
    const key = `hub-customer-${quote.id}`;
    // Replaying creation recovers our schedule after a lost response. Never adopt
    // a schedule attached by somebody else between preview and confirmation.
    if (execution.schedule && reference(subscription.schedule) !== execution.schedule && !(execution.cancelSchedule && !subscription.schedule)) throw new HttpError(409, 'The subscription schedule changed. Review a new preview.');
    let schedule = execution.schedule ? await live.get(`/v1/subscription_schedules/${execution.schedule}`)
      : await live.post('/v1/subscription_schedules', { from_subscription: subscription.id }, { idempotencyKey: `${key}-schedule` });
    const baseline = execution.schedule ? execution.scheduleFingerprint : scheduleFingerprint(schedule);
    if (!execution.schedule) schedule = await live.get(`/v1/subscription_schedules/${schedule.id}`);
    if (execution.cancelSchedule && !subscription.schedule && schedule.status === 'released' && reference(schedule.released_subscription) === subscription.id && schedule.metadata?.hub_self_service === 'true') {
      await settle(quote.id, 'applied', subscription.id); return { state: 'applied' };
    }
    if (execution.schedule && schedule.metadata?.hub_self_service !== 'true') throw new HttpError(409, 'The subscription has a managed schedule.');
    if (reference(schedule.subscription) !== subscription.id) throw new HttpError(409, 'The schedule belongs to another subscription.');
    const phase = schedule.phases.find(item => item.start_date === schedule.current_phase?.start_date);
    if (!phase || phase.end_date !== Math.floor(Date.parse(execution.renewal) / 1000)) throw new HttpError(409, 'The renewal date changed. Review a new preview.');
    if (scheduleFingerprint(schedule) !== baseline) {
      const future = schedule.phases.filter(item => item.start_date >= phase.end_date);
      if (!execution.cancelSchedule && schedule.metadata?.hub_self_service_quote === quote.id
        && sameBillingLines(phaseLines(phase), execution.immediateLines)
        && future.length === (execution.nextLines.length ? 1 : 0)
        && (!future.length || future[0].start_date === phase.end_date && sameBillingLines(phaseLines(future[0]), execution.nextLines))
        && schedule.end_behavior === (execution.nextLines.length ? 'release' : 'cancel')) {
        await settle(quote.id, 'scheduled', subscription.id, schedule.id); return { state: 'scheduled', effective_at: execution.renewal };
      }
      throw new HttpError(409, 'The scheduled selection changed after this preview. Review it again.');
    }
    if (execution.cancelSchedule) {
      await live.post(`/v1/subscription_schedules/${schedule.id}/release`, { preserve_cancel_date: false }, { idempotencyKey: `${key}-release` });
      await settle(quote.id, 'applied', subscription.id); return { state: 'applied' };
    }
    const settings = phaseSettings(phase);
    const phases = [{ ...settings, start_date: phase.start_date, end_date: phase.end_date, items: execution.immediateLines, proration_behavior: 'none' }];
    if (execution.nextLines.length) phases.push({ ...settings, start_date: phase.end_date, duration: { interval: execution.interval, interval_count: 1 }, items: execution.nextLines, proration_behavior: 'none', metadata: { ...subscription.metadata } });
    schedule = await live.post(`/v1/subscription_schedules/${schedule.id}`, { metadata: { hub_self_service: 'true', hub_self_service_quote: quote.id }, proration_behavior: 'none',
      end_behavior: execution.nextLines.length ? 'release' : 'cancel', phases }, { idempotencyKey: `${key}-phases` });
    await settle(quote.id, 'scheduled', subscription.id, schedule.id);
    return { state: 'scheduled', effective_at: execution.renewal };
  }
  async function finish(live, quote, subscription) {
    const execution = quote.execution;
    verifyAccount(subscription, execution);
    if (quote.state === 'scheduled' && quote.schedule
      && (reference(subscription.schedule) && reference(subscription.schedule) !== quote.schedule
        || !subscription.schedule && now() < Date.parse(execution.renewal))) {
      await settle(quote.id, 'superseded', subscription.id);
      return { state: 'superseded' };
    }
    let invoice = null;
    if (execution.hasImmediate && quote.payment_invoice) {
      invoice = await live.get(`/v1/invoices/${quote.payment_invoice}`);
      const receipt = normalizers.invoice(invoice);
      if (receipt.customer !== execution.customer || receipt.subscription !== subscription.id) throw new HttpError(409, 'The payment receipt belongs to another subscription.');
      if (['void', 'uncollectible'].includes(invoice.status) && !subscription.pending_update && sameBillingLines(rows(subscription), execution.originalLines)) {
        await settle(quote.id, 'failed', subscription.id); return { state: 'failed' };
      }
    }
    if (['canceled', 'incomplete_expired'].includes(subscription.status)) {
      const state = subscription.status === 'canceled' && !execution.nextLines.length && now() >= Date.parse(execution.renewal) ? 'applied' : 'failed';
      await settle(quote.id, state, subscription.id); return { state };
    }
    if (!['active', 'trialing'].includes(subscription.status) || subscription.pending_update) {
      await settle(quote.id, 'pending_payment', subscription.id); return { state: 'pending_payment', url: subscription.latest_invoice?.hosted_invoice_url ?? null };
    }
    if (!execution.cancelSchedule && (!execution.hasImmediate || invoice?.status === 'paid') && now() >= Date.parse(execution.renewal) && sameBillingLines(rows(subscription), execution.nextLines)) {
      await settle(quote.id, 'applied', subscription.id); return { state: 'applied' };
    }
    if (!sameBillingLines(rows(subscription), execution.immediateLines)) return { state: 'pending_payment' };
    if (execution.hasImmediate && invoice?.status !== 'paid') {
      await settle(quote.id, 'pending_payment', subscription.id); return { state: 'pending_payment', url: invoice?.hosted_invoice_url ?? null };
    }
    if (execution.hasScheduled || execution.cancelSchedule) return quote.state === 'scheduled' ? { state: 'scheduled', effective_at: execution.renewal } : scheduleChange(live, quote, subscription);
    await settle(quote.id, 'applied', subscription.id); return { state: 'applied' };
  }
  async function confirm(session, input) {
    // This committed reservation survives a provider timeout; retries reuse exactly one provider idempotency key.
    let quote = await rpc(session, 'claim_customer_billing_quote', [input.quote_id, false]);
    if (['applied', 'scheduled', 'failed', 'superseded'].includes(quote.state)) return { state: quote.state };
    const workspace = await context(session, quote.connection_id);
    await verifyScope(session, workspace, quote.execution.facility_id);
    quote = await rpc(session, 'claim_customer_billing_quote', [input.quote_id, true]);
    if (quote.execution.kind === 'checkout') return checkout.start(quote, await context(session, quote.connection_id));
    const live = await stripe();
    let sub = await live.get(`/v1/subscriptions/${quote.subscription}`, { expand: ['latest_invoice', 'discounts'] });
    try { verifyAccount(sub, quote.execution); } catch (error) { await settle(quote.id, 'failed', sub.id); throw error; }
    if (quote.payment_invoice) return finish(live, quote, sub);
    if (quote.execution.hasImmediate) {
      if ((!sameBillingLines(rows(sub), quote.execution.originalLines) && !sameBillingLines(rows(sub), quote.execution.immediateLines)) || reference(sub.schedule) !== (quote.execution.schedule ?? undefined) || sub.status !== 'active' || sub.pause_collection || sub.cancel_at_period_end) {
        await settle(quote.id, 'failed', sub.id); throw new HttpError(409, 'The subscription changed after this preview. Refresh before continuing.');
      }
      if (now() - Date.parse(quote.confirmed_at) >= 23 * 60 * 60 * 1000) throw new HttpError(409, 'This purchase needs payment reconciliation before it can be retried. Open a billing support request.');
      if (!quote.payment_request_started_at) {
        const invoice = await live.post('/v1/invoices/create_preview', { subscription: sub.id,
          subscription_details: { items: quote.execution.purchaseItems, proration_behavior: 'always_invoice', proration_date: quote.execution.prorationDate } });
        if (invoice.currency !== quote.execution.currency || invoice.amount_due > quote.execution.maximumDue) {
          await settle(quote.id, 'failed', sub.id);
          throw new HttpError(409, 'The payment amount increased. Review a new preview before purchasing.');
        }
        await service('mark_customer_purchase_started', [quote.id]);
      }
      let receipt;
      try { receipt = await live.post(`/v1/subscriptions/${sub.id}`, { items: quote.execution.purchaseItems,
        payment_behavior: 'pending_if_incomplete', proration_behavior: 'always_invoice', proration_date: quote.execution.prorationDate,
        expand: ['latest_invoice', 'discounts'] }, { idempotencyKey: `hub-customer-${quote.id}-purchase` }); }
      catch (error) {
        // Transport/5xx/decline outcomes may be ambiguous. Preserve their
        // reservation and key; a definitive invalid request can be re-quoted.
        if (error instanceof StripeError && [400, 404].includes(error.status) && error.type !== 'idempotency_error') await settle(quote.id, 'failed', sub.id);
        throw error;
      }
      verifyAccount(receipt, quote.execution);
      quote.payment_invoice = reference(receipt.latest_invoice);
      await service('record_customer_payment_invoice', [quote.id, quote.payment_invoice]);
      // An idempotent replay can return an old response. Settlement uses the
      // current provider subscription and this purchase's exact invoice.
      sub = await live.get(`/v1/subscriptions/${quote.subscription}`, { expand: ['latest_invoice', 'discounts'] });
    }
    await mirrorSubscription(sub);
    return finish(live, quote, sub);
  }
  async function reconcileSubscription(subscription) {
    if (!selfServiceApps.includes(subscription.metadata?.app)) return;
    const quotes = await service('customer_quotes_for_subscription', [subscription.id]);
    if (!quotes?.length) return;
    const live = await stripe();
    const latest = await live.get(`/v1/subscriptions/${subscription.id}`, { expand: ['latest_invoice', 'discounts'] });
    for (const quote of quotes) if (quote.execution.kind !== 'checkout') await finish(live, quote, latest);
  }
  async function handle(session, input) {
    const parsed = customerBillingRequest.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Review your subscription selection.');
    const request = parsed.data;
    if (request.action === 'workspace') {
      const workspace = await context(session, request.connection_id);
      const facility = workspace.role === 'organization_admin' ? null : workspace.facilities.find(site => site.permissions.includes('billing.manage'))?.id;
      if (facility === undefined) throw new HttpError(403, 'Purchasing permission is required.');
      await authorize(session, request.connection_id, facility);
      return { ...publicWorkspace(await context(session, request.connection_id)), purchasing_enabled: purchasingEnabled };
    }
    if (request.action === 'quote') return preview(session, request);
    if (request.action === 'checkout_resume' || request.action === 'checkout_cancel') {
      const workspace = await context(session, request.connection_id);
      await verifyScope(session, workspace, null);
      const quote = await rpc(session, 'customer_checkout_status', [request.quote_id, request.connection_id]);
      const fresh = await context(session, request.connection_id);
      return request.action === 'checkout_cancel' ? checkout.cancel(quote, fresh) : checkout.start(quote, fresh, { allowCreate: purchasingEnabled });
    }
    if (!purchasingEnabled) throw new HttpError(503, 'Subscription purchasing is not yet enabled. Your existing subscription and payment services remain available.');
    if (request.action === 'confirm') return confirm(session, request);
    const workspace = await context(session, request.connection_id);
    const authority = await authorize(session, request.connection_id, null);
    if (!workspace.can_activate || !authority.capabilities?.includes('facility.entitlements.v1')) throw new HttpError(409, 'Separate facility plans are not yet enabled by this application.');
    if (JSON.stringify([...authority.facilities].sort()) !== JSON.stringify(workspace.allocations.map(row => row.facility_id).sort())) throw new HttpError(409, 'Facility setup changed. Reopen the customer center.');
    const live = await stripe(), sub = await providerSubscription(live, workspace);
    if (sub.schedule) throw new HttpError(409, 'Resolve the scheduled subscription change before enabling separate facility plans.');
    if (!sameBillingLines(rows(sub), aggregateFacilityLines(workspace.allocations, new Map(workspace.catalog.map(price => [price.id, price]))))) throw new HttpError(409, 'Existing billing quantities must match the facility allocation.');
    await rpc(session, 'activate_facility_billing', [request.connection_id, request.expected_version, JSON.stringify(workspace.allocations)]);
    return { state: 'activated' };
  }
  return { handle, reconcileSubscription, reconcileCheckout: checkout.reconcile, reconcileCheckouts: checkout.reconcileAll };
}
