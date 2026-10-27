import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { config } from '../lib/config';
import { appRequest } from '../lib/appSession';
import { selfServiceClient } from '../self-service/client';
import type { SelfServiceWorkspace } from '../self-service/protocol';
import { customerBillingWorkspace, customerQuoteSchema, type CustomerBillingWorkspace, type CustomerQuote } from './customerBillingProtocol';
import { formatCents, dateLabel } from './billingModel';

export function Subscriptions() {
  const [connections, setConnections] = useState<SelfServiceWorkspace['connections']>([]);
  const [connection, setConnection] = useState('');
  const [workspace, setWorkspace] = useState<CustomerBillingWorkspace | null>(null);
  const [facility, setFacility] = useState('');
  const [plan, setPlan] = useState('');
  const [addons, setAddons] = useState<string[]>([]);
  const [quote, setQuote] = useState<CustomerQuote | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    if (!config.demoMode) void selfServiceClient.workspace(controller.signal).then(result => setConnections(result.connections.filter(row => row.role !== 'member'))).catch(() => { if (!controller.signal.aborted) setError('Connections could not be loaded. Reopen the customer center from your application.'); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!quote) return;
    const timeout = window.setTimeout(() => { setQuote(null); setMessage('Your price preview expired. Review a new preview before purchasing.'); }, Math.max(0, Date.parse(quote.expires_at) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [quote]);
  async function run(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Billing is unavailable. Try again.'); } finally { setBusy(false); }
  }
  function chooseScope(data: CustomerBillingWorkspace, id: string) {
    const selection = data.allocations.find(row => row.facility_id === id) ?? data.allocations[0];
    setFacility(id); setPlan(selection?.plan ?? ''); setAddons(selection?.addons ?? []); setQuote(null);
  }
  async function load(id: string) {
    const data = customerBillingWorkspace.parse(await appRequest('billing/customer', { action: 'workspace', connection_id: id }));
    setWorkspace(data); chooseScope(data, data.mode === 'facility' ? data.facilities.find(site => data.role === 'organization_admin' || site.permissions.includes('billing.manage'))?.id ?? '' : '');
  }
  const current = workspace?.allocations.find(row => row.facility_id === facility) ?? workspace?.allocations[0];
  const base = workspace?.catalog.find(price => price.id === plan);
  const choices = workspace?.catalog.filter(price => price.active && (workspace.facilities.length > 0 || price.model === 'flat') && (!workspace.subscription || price.interval === workspace.subscription.interval && price.currency === workspace.subscription.currency)) ?? [];
  const mayPurchase = workspace?.mode === 'facility' || workspace?.role === 'organization_admin';
  return <div className="learning-workspace"><header><span className="eyebrow">Customer self-service</span><h1>Plans &amp; add-ons</h1><p>Published prices and your current services. Review a server-calculated preview before confirming a purchase.</p>{workspace?.role === 'organization_admin' && <Link to="/billing">Invoices, payment methods &amp; payment recovery</Link>}</header>
    {error && <p className="panel" role="alert">{error}</p>}{message && <p className="panel" role="status">{message}</p>}
    <label>Application<select value={connection} disabled={busy} onChange={event => { const id = event.target.value; setConnection(id); setWorkspace(null); setQuote(null); setMessage(''); if (id) void run(() => load(id)); }}><option value="">Choose a connected application</option>{connections.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
    {!connections.length && <p>Open self-service from your application with an authorized administrator account to connect it.</p>}
    {workspace && <section className="panel"><h2>{workspace.mode === 'facility' ? 'Facility subscription' : 'Organization subscription'}</h2>
      {workspace.mode === 'legacy' && <p>Your organization shares this plan and billing cycle. Your existing prices and contract remain in place until you confirm a change.</p>}
      {workspace.mode === 'facility' && <label>Facility<select disabled={busy} value={facility} onChange={event => chooseScope(workspace, event.target.value)}>{workspace.facilities.filter(site => workspace.role === 'organization_admin' || site.permissions.includes('billing.manage')).map(site => <option value={site.id} key={site.id}>{site.name}</option>)}</select></label>}
      <p>Subscription: {workspace.subscription?.status ?? 'Not set up'}{workspace.subscription?.current_period_end ? ` · renews ${dateLabel(workspace.subscription.current_period_end)}` : ''}</p>
      {!workspace.purchasing_enabled && <p>Plan purchasing is being enabled. You can compare published prices and review previews while existing billing and payment services remain available.</p>}
      {current?.pending_at && <p>Scheduled selection takes effect {dateLabel(current.pending_at)}.</p>}
      <form className="sign-in-form" onSubmit={event => { event.preventDefault(); void run(async () => setQuote(customerQuoteSchema.parse(await appRequest('billing/customer', { action: 'quote', connection_id: connection, facility_id: workspace.mode === 'facility' ? facility : null, plan: plan || null, addons, request_id: crypto.randomUUID() })))); }}>
        <label>Base plan<select value={plan} disabled={busy || !mayPurchase} onChange={event => { setPlan(event.target.value); setAddons([]); setQuote(null); }}><option value="">Cancel at renewal</option>{workspace.catalog.filter(price => price.kind === 'plan' && (choices.includes(price) || price.id === current?.plan)).map(price => <option key={price.id} value={price.id}>{price.name} · {formatCents(price.amount, price.currency)}/{price.interval}{price.model === 'per_unit' ? ` per ${price.unit_label || 'facility'}` : ''}{!price.active ? ' (current contract)' : ''}</option>)}</select></label>
        {base && <div><p>{base.description}</p>{base.features.length > 0 && <p>Includes: {base.features.join(', ')}</p>}</div>}
        <fieldset disabled={busy || !mayPurchase || !base?.allows_addons}><legend>Add-ons</legend>{choices.filter(price => price.kind === 'addon').map(price => <label key={price.id} className="checkbox-label"><input type="checkbox" checked={addons.includes(price.id)} onChange={event => { setAddons(value => event.target.checked ? [...value, price.id] : value.filter(id => id !== price.id)); setQuote(null); }} />{price.name} · {formatCents(price.amount, price.currency)}/{price.interval}{price.model === 'per_unit' ? ` per ${price.unit_label || 'facility'}` : ''}<small>{price.description}</small></label>)}</fieldset>
        <p>Additions and upgrades start after payment is confirmed. Removals, downgrades, and cancellation start at renewal.</p>
        {!mayPurchase && <p>Your organization administrator manages this shared plan.</p>}
        <button className="button button-primary" disabled={busy || !mayPurchase || !workspace.subscription}>Review change</button>
      </form>
      {workspace.can_activate && workspace.mode === 'legacy' && <details><summary>Choose different plans for each facility</summary><p>This preserves current prices and charges and enables facility purchasing. Your application must first verify that it enforces each facility’s paid access.</p><button className="button button-secondary" disabled={busy} onClick={() => void run(async () => { await appRequest('billing/customer', { action: 'activate_facility_billing', connection_id: connection, confirmed: true, expected_version: workspace.configuration_version }); await load(connection); })}>Confirm separate facility selections</button></details>}
    </section>}
    {quote && <section className="panel" aria-label="Confirm subscription change"><h2>Review for {quote.facility_name}</h2><p>Due now: <strong>{formatCents(quote.due_now, quote.currency)}</strong></p><p>Recurring subtotal: {formatCents(quote.recurring_subtotal, quote.currency)} before taxes and discounts.</p><ul>{quote.summary.map((line, index) => <li key={index}>{line.quantity} × {line.name}: {formatCents(line.amount, quote.currency)}</li>)}</ul>{quote.cancels_scheduled_change && <p>The current services stay in place and the scheduled change will be removed. No payment is due for this action.</p>}{quote.has_scheduled_change && <p>Scheduled changes: {dateLabel(quote.effective_at)}.</p>}<p>This preview expires {new Date(quote.expires_at).toLocaleTimeString()}.</p>
      <button className="button button-primary" disabled={busy || !workspace?.purchasing_enabled} onClick={() => void run(async () => {
        const receipt = z.object({ state: z.enum(['pending_payment', 'scheduled', 'applied', 'failed', 'superseded']), url: z.string().nullable().optional() }).parse(await appRequest('billing/customer', { action: 'confirm', quote_id: quote.id, confirmed: true }));
        setMessage(receipt.state === 'superseded' ? 'A later selection replaced this change. Review the current subscription.' : receipt.state === 'pending_payment' ? 'Payment is pending. Your existing access is retained until payment is confirmed. Open invoices to complete payment.' : receipt.state === 'scheduled' ? 'Your change is scheduled for renewal.' : receipt.state === 'failed' ? 'This change could not be completed. Review your subscription and invoices before trying again.' : 'Your subscription change is confirmed.');
        setQuote(null); await load(connection);
      })}>Confirm subscription change</button> <button className="button button-secondary" disabled={busy} onClick={() => setQuote(null)}>Cancel</button>
    </section>}
  </div>;
}
