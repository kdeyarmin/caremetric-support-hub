import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { config } from '../lib/config';
import { billingClient, type BillingClient } from './billingClient';
import {
  appLabel, couponLabel, dateLabel, formatCents, liveStatuses, priceLabel, statusLabels, subscriptionMonthlyCents,
  type BillingWorkspace, type CatalogPrice, type CustomerDetail, type Subscription, type SubscriptionItem,
} from './billingModel';
import { appLabels, billingApps, type BillingApp } from './billingProtocol';
import { PriceSheet } from './BillingWorkspace';
import { Notice, Sheet, StatusChip } from './BillingUi';
import { dayAfter, useBillingAction } from './billingActions';
import './billing.css';

type Editor =
  | { kind: 'contact' } | { kind: 'tenant' } | { kind: 'new' } | { kind: 'custom' } | { kind: 'link'; app: BillingApp }
  | { kind: 'item'; subscription: Subscription; item: SubscriptionItem | null }
  | { kind: 'trial' | 'cancel' | 'pause' | 'discount'; subscription: Subscription };

/** One customer's billing: contact, subscriptions, custom prices, discounts, invoices and application links. */
export function CustomerBilling({ client = billingClient, demo = config.demoMode }: { client?: BillingClient; demo?: boolean }) {
  const { tenantId = '' } = useParams();
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [catalog, setCatalog] = useState<BillingWorkspace | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const action = useBillingAction();
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    Promise.all([client.customer(tenantId, controller.signal), client.workspace(controller.signal)])
      .then(([customer, workspace]) => { if (!controller.signal.aborted) { setDetail(customer); setCatalog(workspace); setError(''); } })
      .catch(() => { if (!controller.signal.aborted) setError('This customer could not be loaded. Check your administrator sign-in and refresh.'); });
    return () => controller.abort();
  }, [client, demo, revision, tenantId]);
  const refresh = useCallback((message = '') => { setEditor(null); setNotice(message); setRevision(value => value + 1); }, []);
  const done = (message: string) => refresh(message);

  if (demo) return <div className="billing"><p className="billing-banner">Sign in to the live Hub to manage customer billing.</p></div>;
  const sync = async () => { const result = await action.run(['customer.sync', tenantId], () => client.command({ action: 'customer.sync', tenant_id: tenantId })); if (result) refresh(`Refreshed from Stripe (${result.synced ?? 0} records).`); };
  const portal = async () => { const result = await action.run(['customer.portal', tenantId], () => client.command({ action: 'customer.portal', tenant_id: tenantId })); if (result?.url) window.open(result.url, '_blank', 'noopener'); };
  const sendInvoice = async (invoiceId: string, version: number) => {
    const result = await action.run(['invoice.send', invoiceId], request_key => client.command({ action: 'invoice.send', invoice: invoiceId, expected_version: version, request_key }));
    if (!result) return;
    if (result.url) { try { await navigator.clipboard.writeText(result.url); } catch { /* the link is also shown below */ } }
    refresh(result.id === 'emailed' ? 'Invoice emailed to the billing contact with its payment link.' : `Payment link copied: ${result.url ?? 'open the invoice to pay'}`);
  };

  const products = catalog?.products ?? [];
  const productOf = (price: CatalogPrice) => products.find(product => product.id === price.product);
  return <div className="billing">
    <Link to="/admin/billing?tab=customers" className="text-link"><ArrowLeft size={14} aria-hidden="true" /> Billing</Link>
    <Notice text={notice} error={error || action.error} />
    {!detail && !error && <p role="status">Loading customer…</p>}
    {detail && catalog && <>
      <div className="page-heading"><div><span className="eyebrow">Customer</span><h1>{detail.name}</h1><p>{detail.slug}{detail.industry ? ` · ${detail.industry}` : ''} · {detail.status}</p></div>
        <div className="billing-actions"><button type="button" className="button button-secondary" onClick={() => setEditor({ kind: 'tenant' })}>Edit tenant</button>
          <button type="button" className="button button-secondary" disabled={action.busy || !detail.customer} onClick={() => void sync()}><RefreshCw size={15} aria-hidden="true" />Refresh from Stripe</button></div></div>

      <section className="billing-card" aria-label="Billing contact">
        <div className="billing-card-head"><div><h2>Billing contact</h2><p>{detail.customer ? <>{detail.customer.name} · {detail.customer.email || 'no email'} · <span className="billing-mono">{detail.customer.id}</span></> : 'Not set up. Save a billing contact to create the Stripe customer.'}</p></div>
          <div className="billing-actions"><button type="button" className="button button-secondary button-small" onClick={() => setEditor({ kind: 'contact' })}>{detail.customer ? 'Edit' : 'Set up billing'}</button>
            {detail.customer && <button type="button" className="button button-secondary button-small" disabled={action.busy} onClick={() => void portal()}>Open Stripe customer portal</button>}</div></div>
        {detail.customer?.delinquent && <p className="billing-error">Stripe marks this customer delinquent: a payment failed.</p>}
      </section>

      <section className="billing-section" aria-label="Application accounts">
        <div className="billing-section-head"><div><h2>Application accounts</h2><p>Link each application's own account id so the application can ask the Hub what this customer has.</p></div></div>
        <ul className="billing-items">{billingApps.map(app => { const link = detail.links.find(item => item.app === app); return <li key={app}>
          <div><strong>{appLabels[app]}</strong> <span className="billing-muted">{link ? `linked to …${link.hint} on ${dateLabel(link.linked_at)}` : 'not linked'}</span></div>
          <div className="billing-actions"><button type="button" className="button button-secondary button-small" onClick={() => setEditor({ kind: 'link', app })}>{link ? 'Change' : 'Link'}</button>
            {link && <button type="button" className="button button-secondary button-small" disabled={action.busy} onClick={() => void (async () => { if (!window.confirm(`Unlink ${appLabels[app]}? It will report no entitlements for this customer.`)) return; const result = await action.run(['account.unlink', app], () => client.command({ action: 'account.unlink', tenant_id: tenantId, app, expected_version: link.version })); if (result) refresh('Account unlinked.'); })()}>Unlink</button>}</div></li>; })}</ul>
        {detail.usage.length > 0 && <p className="billing-muted">Latest reported usage: {detail.usage.slice(0, 3).map(item => `${appLabel(item.app)} ${item.quantity} ${item.metric} (${item.outcome.replaceAll('_', ' ')}, ${dateLabel(item.reported_at)})`).join(' · ')}</p>}
      </section>

      <section className="billing-section" aria-label="Subscriptions">
        <div className="billing-section-head"><div><h2>Subscriptions</h2><p>Plans and add-ons per application. Changes are made in Stripe immediately.</p></div>
          <button type="button" className="button button-primary" disabled={!detail.customer || detail.status !== 'active'} onClick={() => setEditor({ kind: 'new' })}>New subscription</button></div>
        {!detail.subscriptions.length && <p>No subscriptions yet.</p>}
        <div className="billing-list">{detail.subscriptions.map(subscription => <SubscriptionCard key={subscription.id} subscription={subscription} coupons={catalog.coupons} busy={action.busy}
          onEdit={next => setEditor(next)} onResume={() => void (async () => { const result = await action.run(['subscription.resume', subscription.id], request_key => client.command({ action: 'subscription.resume', subscription: subscription.id, expected_version: subscription.version, request_key })); if (result) refresh('Collection resumed.'); })()} />)}</div>
      </section>

      <section className="billing-section" aria-label="Custom prices">
        <div className="billing-section-head"><div><h2>Custom prices</h2><p>Prices for this customer only, such as a negotiated rate or complimentary access ($0).</p></div>
          <button type="button" className="button button-secondary" onClick={() => setEditor({ kind: 'custom' })}>New custom price</button></div>
        {detail.custom_prices.length ? <ul className="billing-items">{detail.custom_prices.map(price => <li key={price.id}><div><strong>{productOf(price)?.name ?? price.product}</strong> · {priceLabel(price, productOf(price)?.unit_label)}{price.nickname && <small className="billing-muted"> · {price.nickname}</small>}</div><div>{!price.active && <StatusChip status="archived" label="Archived" />} <span className="billing-muted">{price.subscribers} in use</span></div></li>)}</ul> : <p className="billing-muted">None.</p>}
      </section>

      <section className="billing-section" aria-label="Invoices">
        <div className="billing-section-head"><div><h2>Invoices</h2><p>Open invoices can be paid through their Stripe payment link.</p></div></div>
        {detail.invoices.length ? <div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>Invoice</th><th>Status</th><th>Total</th><th>Due</th><th></th></tr></thead><tbody>
          {detail.invoices.map(invoice => <tr key={invoice.id}><td>{invoice.number ?? 'Draft'}<br /><small className="billing-muted">{appLabel(invoice.app)} · {dateLabel(invoice.created)}</small></td>
            <td><StatusChip status={invoice.status} /></td><td>{formatCents(invoice.total, invoice.currency)}{invoice.amount_remaining > 0 && invoice.status === 'open' ? <><br /><small className="billing-muted">{formatCents(invoice.amount_remaining, invoice.currency)} remaining</small></> : null}</td>
            <td>{dateLabel(invoice.due_date)}</td>
            <td><div className="billing-actions">{invoice.status === 'open' && <button type="button" className="button button-secondary button-small" disabled={action.busy} onClick={() => void sendInvoice(invoice.id, invoice.version)}>{invoice.collection_method === 'send_invoice' ? 'Email payment link' : 'Copy payment link'}</button>}
              {invoice.hosted_invoice_url && <a className="button button-secondary button-small" href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">View</a>}
              {invoice.invoice_pdf && <a className="button button-secondary button-small" href={invoice.invoice_pdf} target="_blank" rel="noreferrer">PDF</a>}</div></td></tr>)}
        </tbody></table></div> : <p className="billing-muted">No invoices yet.</p>}
      </section>

      {editor?.kind === 'contact' && <ContactSheet client={client} detail={detail} onClose={() => setEditor(null)} onSaved={() => done('Billing contact saved in Stripe.')} />}
      {editor?.kind === 'tenant' && <TenantEditSheet client={client} detail={detail} onClose={() => setEditor(null)} onSaved={() => done('Tenant saved.')} />}
      {editor?.kind === 'link' && <LinkSheet client={client} tenantId={tenantId} app={editor.app} version={detail.links.find(item => item.app === editor.app)?.version ?? 0} onClose={() => setEditor(null)} onSaved={() => done('Application account linked.')} />}
      {editor?.kind === 'new' && <NewSubscriptionSheet client={client} detail={detail} catalog={catalog} onClose={() => setEditor(null)} onSaved={() => done('Subscription created in Stripe.')} />}
      {editor?.kind === 'custom' && <CustomPricePicker client={client} tenantId={tenantId} catalog={catalog} onClose={() => setEditor(null)} onSaved={done} />}
      {editor?.kind === 'item' && <ItemSheet client={client} subscription={editor.subscription} item={editor.item} prices={[...catalog.prices, ...detail.custom_prices]} products={products} onClose={() => setEditor(null)} onSaved={done} />}
      {editor?.kind === 'trial' && <TrialSheet client={client} subscription={editor.subscription} onClose={() => setEditor(null)} onSaved={done} />}
      {editor?.kind === 'cancel' && <CancelSheet client={client} subscription={editor.subscription} onClose={() => setEditor(null)} onSaved={done} />}
      {editor?.kind === 'pause' && <PauseSheet client={client} subscription={editor.subscription} onClose={() => setEditor(null)} onSaved={done} />}
      {editor?.kind === 'discount' && <DiscountSheet client={client} subscription={editor.subscription} catalog={catalog} onClose={() => setEditor(null)} onSaved={done} />}
    </>}
  </div>;
}

function SubscriptionCard({ subscription, coupons, busy, onEdit, onResume }: { subscription: Subscription; coupons: BillingWorkspace['coupons']; busy: boolean; onEdit: (editor: Editor) => void; onResume: () => void }) {
  const live = liveStatuses.includes(subscription.status);
  return <article className="billing-card">
    <div className="billing-card-head"><div><h3>{appLabel(subscription.app)}</h3><p><span className="billing-mono">{subscription.id}</span> · {subscription.collection_method === 'send_invoice' ? 'invoices emailed' : 'card charged automatically'}</p></div>
      <div className="billing-actions"><StatusChip status={subscription.status} label={statusLabels[subscription.status]} />{subscription.cancel_at_period_end && <StatusChip status="canceled" label={`Cancels ${dateLabel(subscription.cancel_at ?? subscription.current_period_end)}`} />}{subscription.pause_behavior && <StatusChip status="paused" label="Collection paused" />}</div></div>
    <ul className="billing-items">{subscription.items.map(item => <li key={item.id}><div><strong>{item.product_name}</strong>{item.kind === 'addon' && <small className="billing-muted"> · add-on</small>}{item.custom && <small className="billing-muted"> · custom price</small>}<br />
      <small className="billing-muted">{item.quantity} × {priceLabel({ ...item, type: item.interval ? 'recurring' : 'one_time', pricing_model: item.pricing_model as CatalogPrice['pricing_model'] }, item.unit_label)}</small></div>
      {live && <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => onEdit({ kind: 'item', subscription, item })}>Change</button>}</li>)}</ul>
    <p className="billing-muted">{formatCents(subscriptionMonthlyCents(subscription, coupons))} per month after discounts · {subscription.status === 'trialing' && subscription.trial_end ? `trial ends ${dateLabel(subscription.trial_end)}` : subscription.ended_at ? `ended ${dateLabel(subscription.ended_at)}` : `current period ends ${dateLabel(subscription.current_period_end)}`}
      {subscription.discounts.length > 0 && ` · discounts: ${subscription.discounts.map(discount => { const coupon = coupons.find(item => item.id === discount.coupon); return coupon ? `${coupon.name || coupon.id} (${couponLabel(coupon)})` : discount.coupon; }).join(', ')}`}</p>
    {live && <div className="billing-actions">
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => onEdit({ kind: 'item', subscription, item: null })}>Add add-on or fee</button>
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => onEdit({ kind: 'trial', subscription })}>{subscription.status === 'trialing' ? 'Change trial' : 'Start trial'}</button>
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => onEdit({ kind: 'discount', subscription })}>Discounts</button>
      {subscription.pause_behavior ? <button type="button" className="button button-secondary button-small" disabled={busy} onClick={onResume}>Resume collection</button>
        : <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => onEdit({ kind: 'pause', subscription })}>Pause</button>}
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => onEdit({ kind: 'cancel', subscription })}>{subscription.cancel_at_period_end ? 'Undo or cancel now' : 'Cancel'}</button>
    </div>}
  </article>;
}

function ContactSheet({ client, detail, onClose, onSaved }: { client: BillingClient; detail: CustomerDetail; onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState(detail.customer?.email ?? ''); const [name, setName] = useState(detail.customer?.name || detail.name);
  const action = useBillingAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await action.run(['customer.save', email, name], request_key => client.command({ action: 'customer.save', tenant_id: detail.id, email: email.trim(), name: name.trim(), expected_version: detail.customer?.version ?? 0, request_key }));
    if (result) onSaved();
  }
  return <Sheet title="Billing contact" onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <label>Billing name <small>on invoices</small><input required maxLength={256} value={name} onChange={event => setName(event.target.value)} /></label>
    <label>Billing email <small>receives invoices and payment links</small><input required type="email" maxLength={320} value={email} onChange={event => setEmail(event.target.value)} /></label>
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy}>{action.busy ? 'Saving in Stripe…' : 'Save'}</button></div>
  </form></Sheet>;
}

function TenantEditSheet({ client, detail, onClose, onSaved }: { client: BillingClient; detail: CustomerDetail; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(detail.name); const [industry, setIndustry] = useState(detail.industry); const [status, setStatus] = useState(detail.status);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await client.saveTenant(detail.id, { name: name.trim(), industry: industry.trim(), status }, detail.updated_at); onSaved(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The tenant could not be saved.'); }
    finally { setBusy(false); }
  }
  return <Sheet title="Edit tenant" onClose={onClose} busy={busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <label>Name<input required minLength={2} maxLength={180} value={name} onChange={event => setName(event.target.value)} /></label>
    <div className="billing-form-grid"><label>Industry<input maxLength={120} value={industry} onChange={event => setIndustry(event.target.value)} /></label>
      <label>Status<select value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="active">Active</option><option value="suspended">Suspended</option><option value="closed">Closed</option></select><small>A suspended or closed tenant reports no entitlements to its applications.</small></label></div>
    <Notice error={error} /><div className="billing-actions"><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save tenant'}</button></div>
  </form></Sheet>;
}

function LinkSheet({ client, tenantId, app, version, onClose, onSaved }: { client: BillingClient; tenantId: string; app: BillingApp; version: number; onClose: () => void; onSaved: () => void }) {
  const [account, setAccount] = useState('');
  const action = useBillingAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await action.run(['account.link', app, account], () => client.command({ action: 'account.link', tenant_id: tenantId, app, account: account.trim(), expected_version: version }));
    if (result) onSaved();
  }
  const hint = app === 'carebase' || app === 'breathe' ? 'the organization id (a UUID)' : app === 'caremetric-intel' ? 'the organization id' : 'the account id';
  return <Sheet title={`Link ${appLabels[app]} account`} onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <label>Account id <small>{hint}, exactly as the application shows it</small><input required pattern="[A-Za-z0-9_\-]{1,128}" value={account} onChange={event => setAccount(event.target.value)} /></label>
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy}>{action.busy ? 'Linking…' : 'Link account'}</button></div>
  </form></Sheet>;
}

function NewSubscriptionSheet({ client, detail, catalog, onClose, onSaved }: { client: BillingClient; detail: CustomerDetail; catalog: BillingWorkspace; onClose: () => void; onSaved: () => void }) {
  const [app, setApp] = useState<BillingApp>('carebase');
  const [lines, setLines] = useState<Array<{ price: string; quantity: number }>>([{ price: '', quantity: 1 }]);
  const [trial, setTrial] = useState('0'); const [collection, setCollection] = useState<'send_invoice' | 'charge_automatically'>('send_invoice'); const [days, setDays] = useState('30');
  const [discount, setDiscount] = useState('');
  const action = useBillingAction();
  const prices = [...catalog.prices, ...detail.custom_prices].filter(price => price.active && catalog.products.some(product => product.id === price.product && product.app === app && product.active));
  const recurring = prices.filter(price => price.type === 'recurring');
  const label = (price: CatalogPrice) => { const product = catalog.products.find(item => item.id === price.product); return `${product?.name ?? price.product} · ${priceLabel(price, product?.unit_label)}${price.tenant_id ? ' · custom' : ''}`; };
  async function submit(event: FormEvent) {
    event.preventDefault();
    const items = lines.filter(line => line.price);
    if (!items.some(line => recurring.some(price => price.id === line.price))) { action.setError('Choose a plan price.'); return; }
    const coupon = discount.startsWith('coupon:') ? discount.slice(7) : null; const promotion = discount.startsWith('promo:') ? discount.slice(6) : null;
    const fields = { tenant_id: detail.id, app, items, trial_days: Number(trial) || 0, collection_method: collection, days_until_due: Number(days) || 30, coupon, promotion_code: promotion };
    const result = await action.run(['subscription.create', JSON.stringify(fields)], request_key => client.command({ action: 'subscription.create', ...fields, request_key }));
    if (result) onSaved();
  }
  return <Sheet title="New subscription" onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <label>Application<select value={app} onChange={event => { setApp(event.target.value as BillingApp); setLines([{ price: '', quantity: 1 }]); }}>{billingApps.map(slug => <option key={slug} value={slug}>{appLabels[slug]}</option>)}</select></label>
    <fieldset><legend>Plan and add-ons</legend>
      {lines.map((line, index) => <div className="billing-form-grid" key={index}>
        <label>{index === 0 ? 'Plan' : 'Add-on or one-time fee'}<select value={line.price} onChange={event => setLines(current => current.map((entry, at) => at === index ? { ...entry, price: event.target.value } : entry))}><option value="">Choose…</option>{(index === 0 ? recurring : prices).map(price => <option key={price.id} value={price.id}>{label(price)}</option>)}</select></label>
        <label>Quantity<input type="number" min={1} max={100000} value={line.quantity} onChange={event => setLines(current => current.map((entry, at) => at === index ? { ...entry, quantity: Math.max(1, Number(event.target.value) || 1) } : entry))} /></label>
      </div>)}
      {lines.length < 20 && <button type="button" className="button button-secondary button-small" onClick={() => setLines(current => [...current, { price: '', quantity: 1 }])}>Add another add-on or fee</button>}
      {!recurring.length && <small>{appLabels[app]} has no active recurring prices. Add them in Catalog first.</small>}
      <small className="billing-muted">One-time fees, such as onboarding, are charged on the first invoice.</small>
    </fieldset>
    <div className="billing-form-grid">
      <label>Free trial (days)<input type="number" min={0} max={730} value={trial} onChange={event => setTrial(event.target.value)} /></label>
      <label>Payment<select value={collection} onChange={event => setCollection(event.target.value as typeof collection)}><option value="send_invoice">Email invoices (pay by link)</option><option value="charge_automatically">Charge the card on file</option></select></label>
      {collection === 'send_invoice' && <label>Days to pay each invoice<input type="number" min={1} max={365} value={days} onChange={event => setDays(event.target.value)} /></label>}
      <label>Discount <small>optional</small><select value={discount} onChange={event => setDiscount(event.target.value)}><option value="">None</option>
        {catalog.coupons.filter(coupon => coupon.valid).map(coupon => <option key={coupon.id} value={`coupon:${coupon.id}`}>Coupon · {coupon.name || coupon.id} · {couponLabel(coupon)}</option>)}
        {catalog.promotion_codes.filter(code => code.active).map(code => <option key={code.id} value={`promo:${code.id}`}>Code · {code.code}</option>)}</select></label>
    </div>
    {collection === 'charge_automatically' && <p className="billing-muted">Without a saved card the first invoice waits for payment; send its payment link from Invoices within 23 hours or Stripe expires the subscription.</p>}
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy}>{action.busy ? 'Creating in Stripe…' : 'Create subscription'}</button></div>
  </form></Sheet>;
}

function CustomPricePicker({ client, tenantId, catalog, onClose, onSaved }: { client: BillingClient; tenantId: string; catalog: BillingWorkspace; onClose: () => void; onSaved: (message: string) => void }) {
  const [productId, setProductId] = useState('');
  const product = catalog.products.find(item => item.id === productId);
  if (product) return <PriceSheet client={client} product={product} tenantId={tenantId} onClose={onClose} onSaved={onSaved} />;
  return <Sheet title="Custom price" onClose={onClose}><div className="billing-form">
    <label>Product<select value={productId} onChange={event => setProductId(event.target.value)}><option value="">Choose…</option>{catalog.products.filter(item => item.active && item.app).map(item => <option key={item.id} value={item.id}>{appLabel(item.app)} · {item.name}</option>)}</select></label>
  </div></Sheet>;
}

const prorationOptions = [['create_prorations', 'Prorate on the next invoice'], ['always_invoice', 'Prorate and invoice now'], ['none', 'No proration (from next renewal)']] as const;
function ItemSheet({ client, subscription, item, prices, products, onClose, onSaved }: { client: BillingClient; subscription: Subscription; item: SubscriptionItem | null; prices: CatalogPrice[]; products: BillingWorkspace['products']; onClose: () => void; onSaved: (message: string) => void }) {
  // A one-time fee can be added (it goes on the next invoice) but never replaces a recurring item.
  const choices = prices.filter(price => price.active && (price.type === 'recurring' || !item) && products.some(product => product.id === price.product && product.app === subscription.app && product.active) && (!price.tenant_id || price.tenant_id === subscription.tenant_id));
  const oneTime = (id: string) => prices.some(entry => entry.id === id && entry.type === 'one_time');
  const [price, setPrice] = useState(item?.price ?? ''); const [quantity, setQuantity] = useState(String(item?.quantity ?? 1));
  const [proration, setProration] = useState<typeof prorationOptions[number][0]>('create_prorations');
  const action = useBillingAction();
  const label = (entry: CatalogPrice) => { const product = products.find(candidate => candidate.id === entry.product); return `${product?.name ?? entry.product} · ${priceLabel(entry, product?.unit_label)}${entry.tenant_id ? ' · custom' : ''}`; };
  async function submit(event: FormEvent) {
    event.preventDefault();
    const amount = Math.max(1, Number(quantity) || 1);
    const base = { subscription: subscription.id, expected_version: subscription.version, proration };
    const result = item
      ? await action.run(['subscription.item.update', item.id, price, amount, proration], request_key => client.command({ action: 'subscription.item.update', ...base, item: item.id, price: price !== item.price ? price : null, quantity: amount !== item.quantity ? amount : null, request_key }))
      : await action.run(['subscription.item.add', price, amount, proration], request_key => client.command({ action: 'subscription.item.add', ...base, price, quantity: amount, request_key }));
    if (result) onSaved(item ? 'Subscription item updated.' : oneTime(price) ? 'Fee added to the next invoice.' : 'Add-on added.');
  }
  const remove = async () => {
    if (!item || !window.confirm(`Remove ${item.product_name} from this subscription?`)) return;
    const result = await action.run(['subscription.item.remove', item.id, proration], request_key => client.command({ action: 'subscription.item.remove', subscription: subscription.id, item: item.id, proration, expected_version: subscription.version, request_key }));
    if (result) onSaved('Item removed.');
  };
  return <Sheet title={item ? `Change ${item.product_name}` : 'Add an add-on or fee'} onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <label>Price<select required value={price} onChange={event => setPrice(event.target.value)}><option value="">Choose…</option>{item && !choices.some(entry => entry.id === item.price) && <option value={item.price}>Current price (archived)</option>}{choices.map(entry => <option key={entry.id} value={entry.id}>{label(entry)}</option>)}</select></label>
    <label>Quantity{item?.unit_label ? ` (${item.unit_label}s)` : ''}<input type="number" min={1} max={100000} value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
    {oneTime(price) ? <p className="billing-muted">A one-time fee is charged on the subscription's next invoice.</p>
      : <label>Proration<select value={proration} onChange={event => setProration(event.target.value as typeof proration)}>{prorationOptions.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>}
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy || !price}>{action.busy ? 'Saving in Stripe…' : item ? 'Save change' : 'Add'}</button>
      {item && subscription.items.length > 1 && <button type="button" className="button button-secondary" disabled={action.busy} onClick={() => void remove()}>Remove item</button>}</div>
  </form></Sheet>;
}

function TrialSheet({ client, subscription, onClose, onSaved }: { client: BillingClient; subscription: Subscription; onClose: () => void; onSaved: (message: string) => void }) {
  const [end, setEnd] = useState(dayAfter(14));
  const action = useBillingAction();
  const save = async (trialEnd: string) => {
    const result = await action.run(['subscription.trial', subscription.id, trialEnd], request_key => client.command({ action: 'subscription.trial', subscription: subscription.id, trial_end: trialEnd, expected_version: subscription.version, request_key }));
    if (result) onSaved(trialEnd === 'now' ? 'Trial ended; billing starts now.' : `Trial runs through ${trialEnd}.`);
  };
  return <Sheet title="Trial" onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => { event.preventDefault(); void save(end); }}>
    <p>{subscription.status === 'trialing' ? `The trial currently ends ${dateLabel(subscription.trial_end)}.` : 'Start a free trial on this subscription; no charges until it ends.'}</p>
    <label>Trial ends<input type="date" required min={dayAfter(1)} value={end} onChange={event => setEnd(event.target.value)} /></label>
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy}>{subscription.status === 'trialing' ? 'Change trial end' : 'Start trial'}</button>
      {subscription.status === 'trialing' && <button type="button" className="button button-secondary" disabled={action.busy} onClick={() => void save('now')}>End trial now</button>}</div>
  </form></Sheet>;
}

function CancelSheet({ client, subscription, onClose, onSaved }: { client: BillingClient; subscription: Subscription; onClose: () => void; onSaved: (message: string) => void }) {
  const [when, setWhen] = useState<'period_end' | 'immediately' | 'undo'>(subscription.cancel_at_period_end ? 'undo' : 'period_end');
  const [prorate, setProrate] = useState(false);
  const action = useBillingAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (when === 'immediately' && !window.confirm('Cancel immediately? The customer loses access now.')) return;
    const result = await action.run(['subscription.cancel', subscription.id, when, prorate], request_key => client.command({ action: 'subscription.cancel', subscription: subscription.id, when, prorate: when === 'immediately' && prorate, expected_version: subscription.version, request_key }));
    if (result) onSaved(when === 'undo' ? 'Cancellation undone.' : when === 'period_end' ? 'Subscription cancels at the end of its period.' : 'Subscription canceled.');
  }
  return <Sheet title="Cancel subscription" onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <fieldset><legend>When</legend>
      {subscription.cancel_at_period_end && <label className="billing-check"><input type="radio" name="when" checked={when === 'undo'} onChange={() => setWhen('undo')} />Keep it: undo the scheduled cancellation</label>}
      {!subscription.cancel_at_period_end && <label className="billing-check"><input type="radio" name="when" checked={when === 'period_end'} onChange={() => setWhen('period_end')} />At the end of the current period ({dateLabel(subscription.current_period_end)})</label>}
      <label className="billing-check"><input type="radio" name="when" checked={when === 'immediately'} onChange={() => setWhen('immediately')} />Immediately</label>
      {when === 'immediately' && <label className="billing-check"><input type="checkbox" checked={prorate} onChange={event => setProrate(event.target.checked)} />Credit unused time on a final invoice</label>}
    </fieldset>
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy}>{action.busy ? 'Saving in Stripe…' : 'Confirm'}</button></div>
  </form></Sheet>;
}

function PauseSheet({ client, subscription, onClose, onSaved }: { client: BillingClient; subscription: Subscription; onClose: () => void; onSaved: (message: string) => void }) {
  const [behavior, setBehavior] = useState<'void' | 'keep_as_draft' | 'mark_uncollectible'>('void'); const [resumes, setResumes] = useState('');
  const action = useBillingAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await action.run(['subscription.pause', subscription.id, behavior, resumes], request_key => client.command({ action: 'subscription.pause', subscription: subscription.id, behavior, resumes_at: resumes || null, expected_version: subscription.version, request_key }));
    if (result) onSaved('Payment collection paused.');
  }
  return <Sheet title="Pause payment collection" onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <p>The subscription stays in place and the customer keeps access; invoices are handled as chosen until collection resumes.</p>
    <label>While paused<select value={behavior} onChange={event => setBehavior(event.target.value as typeof behavior)}><option value="void">Void invoices (no charge)</option><option value="keep_as_draft">Keep invoices as drafts</option><option value="mark_uncollectible">Mark invoices uncollectible</option></select></label>
    <label>Resume automatically on <small>optional</small><input type="date" min={dayAfter(1)} value={resumes} onChange={event => setResumes(event.target.value)} /></label>
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy}>{action.busy ? 'Saving in Stripe…' : 'Pause collection'}</button></div>
  </form></Sheet>;
}

function DiscountSheet({ client, subscription, catalog, onClose, onSaved }: { client: BillingClient; subscription: Subscription; catalog: BillingWorkspace; onClose: () => void; onSaved: (message: string) => void }) {
  const [choice, setChoice] = useState('');
  const action = useBillingAction();
  const send = async (op: 'apply' | 'remove', value: string) => {
    const coupon = value.startsWith('coupon:') ? value.slice(7) : null; const promotion = value.startsWith('promo:') ? value.slice(6) : null;
    const result = await action.run(['subscription.discount', subscription.id, op, value], request_key => client.command({ action: 'subscription.discount', subscription: subscription.id, op, coupon, promotion_code: promotion, expected_version: subscription.version, request_key }));
    if (result) onSaved(op === 'apply' ? 'Discount applied.' : 'Discount removed.');
  };
  return <Sheet title="Discounts" onClose={onClose} busy={action.busy}><div className="billing-form">
    {subscription.discounts.length ? <ul className="billing-items">{subscription.discounts.map(discount => { const coupon = catalog.coupons.find(item => item.id === discount.coupon); const code = catalog.promotion_codes.find(item => item.id === discount.promotion_code); return <li key={discount.id}>
      <div><strong>{coupon ? coupon.name || coupon.id : discount.coupon}</strong>{coupon && <small className="billing-muted"> · {couponLabel(coupon)}</small>}{code && <small className="billing-muted"> · code {code.code}</small>}</div>
      <button type="button" className="button button-secondary button-small" disabled={action.busy} onClick={() => void send('remove', discount.promotion_code ? `promo:${discount.promotion_code}` : `coupon:${discount.coupon}`)}>Remove</button></li>; })}</ul> : <p className="billing-muted">No discounts on this subscription.</p>}
    <label>Apply<select value={choice} onChange={event => setChoice(event.target.value)}><option value="">Choose a coupon or code…</option>
      {catalog.coupons.filter(coupon => coupon.valid && (!coupon.app || coupon.app === subscription.app)).map(coupon => <option key={coupon.id} value={`coupon:${coupon.id}`}>Coupon · {coupon.name || coupon.id} · {couponLabel(coupon)}</option>)}
      {catalog.promotion_codes.filter(code => code.active).map(code => <option key={code.id} value={`promo:${code.id}`}>Code · {code.code}</option>)}</select></label>
    <Notice error={action.error} /><div className="billing-actions"><button type="button" className="button button-primary" disabled={action.busy || !choice} onClick={() => void send('apply', choice)}>Apply discount</button></div>
  </div></Sheet>;
}
