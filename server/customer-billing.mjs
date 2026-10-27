import { randomUUID } from 'node:crypto';
import { HttpError, withSession, transaction } from './sms-auth.mjs';
import { customerBillingRequest, customerBillingWorkspace } from '../src/billing/customerBillingProtocol.ts';
import { aggregateFacilityLines, planFacilityChange } from '../src/billing/facilityAllocations.ts';
import { selfServiceApps } from '../src/self-service/protocol.ts';

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

/** Browser choices never supply prices, quantities, native permissions, or a provider mutation. */
export function customerBillingService({ pool, stripe, mirrorSubscription, authorize, now = () => Date.now(), purchasingEnabled = false }) {
  const one = async (db, query, values) => (await db.query(query, values)).rows[0]?.result;
  const rpc = (session, name, values) => withSession(pool, session, async db => {
    await db.query('reset role');
    return one(db, `select private.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`, values);
  });
  const service = (name, values) => transaction(pool, db => one(db, `select private.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`, values));
  const settle = (id, state, sub = null, schedule = null) => service('settle_customer_billing_quote', [id, state, sub, schedule, null]);
  const context = async (session, connection) => customerBillingWorkspace.parse(await rpc(session, 'customer_billing_context', [connection]));
  async function verifyScope(session, workspace, facility) {
    if (workspace.mode === 'legacy' && (facility !== null || workspace.role !== 'organization_admin')) throw new HttpError(403, 'Only the organization administrator can change the shared plan.');
    if (workspace.mode === 'facility' && !workspace.facilities.some(site => site.id === facility && (workspace.role === 'organization_admin' || site.permissions.includes('billing.manage')))) throw new HttpError(403, 'Facility purchasing is not authorized.');
    return authorize(session, workspace.connection_id, facility);
  }
  function publicWorkspace(workspace) {
    if (workspace.role === 'organization_admin') return workspace;
    const permitted = new Set(workspace.facilities.filter(site => site.permissions.includes('billing.manage')).map(site => site.id));
    return { ...workspace, allocations: workspace.allocations.filter(row => permitted.has(row.facility_id)), customer: null,
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
    const workspace = await context(session, input.connection_id);
    await verifyScope(session, workspace, input.facility_id);
    const live = await stripe(), sub = await providerSubscription(live, workspace);
    const catalog = new Map(workspace.catalog.map(price => [price.id, price]));
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
    if (!hasImmediate && !hasScheduled) throw new HttpError(400, 'The selected services already match your subscription.');
    if (sub.schedule && hasImmediate) throw new HttpError(409, 'This subscription has a scheduled change. Review it before making an immediate purchase.');
    if (sub.schedule) {
      const schedule = await live.get(`/v1/subscription_schedules/${reference(sub.schedule)}`);
      if (schedule.metadata?.hub_self_service !== 'true') throw new HttpError(409, 'This contract has a managed billing schedule. Its existing terms are retained.');
    }
    const prorationDate = Math.floor(now() / 1000);
    const invoice = hasImmediate ? await live.post('/v1/invoices/create_preview', { subscription: sub.id,
      subscription_details: { items: subscriptionItemPatch(sub, immediateLines), proration_behavior: 'always_invoice', proration_date: prorationDate } }) : null;
    const id = randomUUID(), renewal = new Date(renewalOf(sub) * 1000).toISOString();
    const quote = { id, facility_name: input.facility_id ? targets[0].facility_name : 'All facilities in this organization', due_now: invoice?.amount_due ?? 0,
      currency: workspace.subscription.currency, recurring_subtotal: nextLines.reduce((sum, line) => sum + catalog.get(line.price).amount * line.quantity, 0),
      effective_at: hasScheduled ? renewal : null, expires_at: new Date(now() + 300000).toISOString(), has_immediate_change: hasImmediate, has_scheduled_change: hasScheduled,
      summary: nextLines.map(line => ({ name: catalog.get(line.price).name, quantity: line.quantity, amount: catalog.get(line.price).amount * line.quantity })) };
    const execution = { mode: workspace.mode, app: workspace.app, customer: workspace.customer, facility_id: input.facility_id, immediate, next, immediateLines, nextLines,
      originalLines: rows(sub), renewal, prorationDate, interval: workspace.subscription.interval, hasImmediate, hasScheduled, maximumDue: quote.due_now, currency: quote.currency, schedule: reference(sub.schedule) ?? null };
    return rpc(session, 'save_customer_billing_quote', [id, input.connection_id, input.facility_id, input.request_id, JSON.stringify(quote), JSON.stringify(execution), workspace.subscription.version, sub.id]);
  }
  async function scheduleChange(live, quote, subscription) {
    const execution = quote.execution;
    const key = `hub-customer-${quote.id}`;
    let schedule = subscription.schedule ? await live.get(`/v1/subscription_schedules/${reference(subscription.schedule)}`)
      : await live.post('/v1/subscription_schedules', { from_subscription: subscription.id }, { idempotencyKey: `${key}-schedule` });
    if (execution.schedule && schedule.metadata?.hub_self_service !== 'true') throw new HttpError(409, 'The subscription has a managed schedule.');
    const phase = schedule.phases.find(item => item.start_date === schedule.current_phase?.start_date);
    if (!phase || phase.end_date !== Math.floor(Date.parse(execution.renewal) / 1000)) throw new HttpError(409, 'The renewal date changed. Review a new preview.');
    const settings = Object.fromEntries(['collection_method', 'default_payment_method', 'default_tax_rates', 'automatic_tax', 'discounts', 'invoice_settings', 'transfer_data', 'application_fee_percent', 'on_behalf_of']
      .filter(name => phase[name] !== undefined && phase[name] !== null).map(name => [name, phase[name]]));
    const phases = [{ ...settings, start_date: phase.start_date, end_date: phase.end_date, items: execution.immediateLines, proration_behavior: 'none' }];
    if (execution.nextLines.length) phases.push({ ...settings, start_date: phase.end_date, duration: { interval: execution.interval, interval_count: 1 }, items: execution.nextLines, proration_behavior: 'none', metadata: { ...subscription.metadata } });
    schedule = await live.post(`/v1/subscription_schedules/${schedule.id}`, { metadata: { hub_self_service: 'true' }, proration_behavior: 'none',
      end_behavior: execution.nextLines.length ? 'release' : 'cancel', phases }, { idempotencyKey: `${key}-phases` });
    await settle(quote.id, 'scheduled', subscription.id, schedule.id);
    return { state: 'scheduled', effective_at: execution.renewal };
  }
  async function finish(live, quote, subscription) {
    const execution = quote.execution;
    if (reference(subscription.customer) !== execution.customer || subscription.metadata?.app !== execution.app) throw new HttpError(409, 'The provider receipt belongs to another account.');
    if (subscription.status === 'canceled' && !execution.nextLines.length && now() >= Date.parse(execution.renewal)) {
      await settle(quote.id, 'applied', subscription.id); return { state: 'applied' };
    }
    if (!['active', 'trialing'].includes(subscription.status) || subscription.pending_update) {
      await settle(quote.id, 'pending_payment', subscription.id); return { state: 'pending_payment', url: subscription.latest_invoice?.hosted_invoice_url ?? null };
    }
    if (now() >= Date.parse(execution.renewal) && sameBillingLines(rows(subscription), execution.nextLines)) {
      await settle(quote.id, 'applied', subscription.id); return { state: 'applied' };
    }
    if (!sameBillingLines(rows(subscription), execution.immediateLines)) return { state: 'pending_payment' };
    if (execution.hasImmediate && subscription.latest_invoice?.status !== 'paid') {
      await settle(quote.id, 'pending_payment', subscription.id); return { state: 'pending_payment', url: subscription.latest_invoice?.hosted_invoice_url ?? null };
    }
    if (execution.hasScheduled) return quote.state === 'scheduled' ? { state: 'scheduled', effective_at: execution.renewal } : scheduleChange(live, quote, subscription);
    await settle(quote.id, 'applied', subscription.id); return { state: 'applied' };
  }
  async function confirm(session, input) {
    // This committed reservation survives a provider timeout; retries reuse exactly one provider idempotency key.
    let quote = await rpc(session, 'claim_customer_billing_quote', [input.quote_id, false]);
    if (['applied', 'scheduled', 'failed'].includes(quote.state)) return { state: quote.state };
    const workspace = await context(session, quote.connection_id);
    await verifyScope(session, workspace, quote.execution.facility_id);
    quote = await rpc(session, 'claim_customer_billing_quote', [input.quote_id, true]);
    const live = await stripe();
    let sub = await live.get(`/v1/subscriptions/${quote.subscription}`, { expand: ['latest_invoice', 'discounts'] });
    if (!sameBillingLines(rows(sub), quote.execution.immediateLines)) {
      if (!sameBillingLines(rows(sub), quote.execution.originalLines) || sub.pending_update || reference(sub.schedule) !== (quote.execution.schedule ?? undefined)) throw new HttpError(409, 'The subscription changed after this preview. Refresh before continuing.');
      const invoice = await live.post('/v1/invoices/create_preview', { subscription: sub.id,
        subscription_details: { items: subscriptionItemPatch(sub, quote.execution.immediateLines), proration_behavior: 'always_invoice', proration_date: quote.execution.prorationDate } });
      if (invoice.currency !== quote.execution.currency || invoice.amount_due > quote.execution.maximumDue) {
        await settle(quote.id, 'failed', sub.id);
        throw new HttpError(409, 'The payment amount increased. Review a new preview before purchasing.');
      }
      sub = await live.post(`/v1/subscriptions/${sub.id}`, { items: subscriptionItemPatch(sub, quote.execution.immediateLines),
        payment_behavior: 'pending_if_incomplete', proration_behavior: 'always_invoice', proration_date: quote.execution.prorationDate,
        expand: ['latest_invoice', 'discounts'] }, { idempotencyKey: `hub-customer-${quote.id}-purchase` });
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
    for (const quote of quotes) await finish(live, quote, latest);
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
      return { ...publicWorkspace(workspace), purchasing_enabled: purchasingEnabled };
    }
    if (request.action === 'quote') return preview(session, request);
    if (!purchasingEnabled) throw new HttpError(503, 'Subscription purchasing is not yet enabled. Your existing subscription and payment services remain available.');
    if (request.action === 'confirm') return confirm(session, request);
    const workspace = await context(session, request.connection_id);
    const authority = await authorize(session, request.connection_id, null);
    if (!workspace.can_activate || !authority.capabilities?.includes('facility.entitlements.v1')) throw new HttpError(409, 'Separate facility plans are not yet enabled by this application.');
    if (JSON.stringify([...authority.facilities].sort()) !== JSON.stringify(workspace.allocations.map(row => row.facility_id).sort())) throw new HttpError(409, 'Facility setup changed. Reopen the customer center.');
    const live = await stripe(), sub = await providerSubscription(live, workspace);
    if (!sameBillingLines(rows(sub), aggregateFacilityLines(workspace.allocations, new Map(workspace.catalog.map(price => [price.id, price]))))) throw new HttpError(409, 'Existing billing quantities must match the facility allocation.');
    await rpc(session, 'activate_facility_billing', [request.connection_id, request.expected_version, JSON.stringify(workspace.allocations)]);
    return { state: 'activated' };
  }
  return { handle, reconcileSubscription };
}
