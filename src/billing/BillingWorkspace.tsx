import { FoundersSaleNotice } from './FoundersSaleNotice';
import { InvitationsTab } from './Invitations';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { config } from '../lib/config';
import { billingClient, type BillingClient } from './billingClient';
import {
  appLabel, billingTotals, centsToDollars, couponLabel, dateLabel, formatCents, liveStatuses, parseDollars, priceLabel, statusLabels, subscriptionMonthlyCents,
  subscriptionStatuses, type BillingWorkspace as Workspace, type CatalogPrice, type CatalogProduct, type Coupon,
} from './billingModel';
import { appLabels, billingApps, type BillingApp } from './billingProtocol';
import { Notice, Sheet, StatusChip } from './BillingUi';
import { dayAfter, useBillingAction } from './billingActions';
import './billing.css';

type Tab = 'subscriptions' | 'customers' | 'invitations' | 'catalog' | 'discounts' | 'apps';
const tabs: Array<[Tab, string]> = [['subscriptions', 'Subscriptions'], ['customers', 'Customers'], ['invitations', 'Invite a customer'], ['catalog', 'Catalog'], ['discounts', 'Discounts'], ['apps', 'App connections']];

/** The super administrator's Billing workspace: every application's products, prices, subscriptions and discounts. */
export function BillingWorkspace({ client = billingClient, demo = config.demoMode }: { client?: BillingClient; demo?: boolean }) {
  const [params, setParams] = useSearchParams();
  const tab = (tabs.find(([id]) => id === params.get('tab'))?.[0] ?? 'subscriptions') as Tab;
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    client.workspace(controller.signal).then(result => { if (!controller.signal.aborted) { setData(result); setError(''); } })
      .catch(() => { if (!controller.signal.aborted) setError('Billing could not be loaded. Check your administrator sign-in and refresh.'); });
    return () => controller.abort();
  }, [client, demo, revision]);
  const refresh = useCallback((message = '') => { setNotice(message); setRevision(value => value + 1); }, []);
  const choose = (next: Tab) => setParams(previous => { const updated = new URLSearchParams(previous); updated.set('tab', next); return updated; });
  return <div className="billing">
    <div className="page-heading"><div><span className="eyebrow">Super admin</span><h1>Billing</h1>
      <p>Products, prices, subscriptions, discounts and invoices for every CareMetric application. Stripe is the source of truth; changes here are made in Stripe and mirrored back through its webhook.</p></div>
      <button type="button" className="button button-secondary" onClick={() => refresh()} disabled={demo}><RefreshCw size={15} aria-hidden="true" />Refresh</button></div>
    {demo ? <p className="billing-banner">Sign in to the live Hub as a platform administrator to manage billing. The preview has no Stripe connection.</p> : <>
      {data && <ModeBanner data={data} />}
      <FoundersSaleNotice admin />
      <Notice text={notice} error={error} />
      <nav className="billing-tabs" aria-label="Billing sections">{tabs.map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => choose(id)}>{label}</button>)}</nav>
      {!data && !error && <p role="status">Loading billing…</p>}
      {data && tab === 'subscriptions' && <SubscriptionsTab data={data} />}
      {data && tab === 'customers' && <CustomersTab data={data} client={client} refresh={refresh} />}
      {data && tab === 'invitations' && <InvitationsTab data={data} />}
      {data && tab === 'catalog' && <CatalogTab data={data} client={client} refresh={refresh} />}
      {data && tab === 'discounts' && <DiscountsTab data={data} client={client} refresh={refresh} />}
      {data && tab === 'apps' && <AppsTab data={data} client={client} refresh={refresh} />}
    </>}
  </div>;
}

function ModeBanner({ data }: { data: Workspace }) {
  if (data.mode === 'unverified') return <p className="billing-banner billing-banner-warn">Stripe is not verified on the Hub service yet. Set STRIPE_SECRET_KEY for the CareMetric account and redeploy; until then the mirror shows only what the webhook has delivered and changes are unavailable.</p>;
  return <p className={`billing-banner ${data.mode === 'live' ? 'billing-banner-ok' : 'billing-banner-warn'}`}>
    {data.mode === 'live' ? 'Live mode' : 'Test mode — no real charges'} · Stripe account {data.account} · {data.webhook.last_received_at ? `last webhook ${dateLabel(data.webhook.last_received_at)}, ${data.webhook.events_24h} in the last 24 hours` : 'no webhook received yet'}
  </p>;
}

// ---------------------------------------------------------------------------
function SubscriptionsTab({ data }: { data: Workspace }) {
  const [params] = useSearchParams();
  const [app, setApp] = useState<string>(billingApps.some(value => value === params.get('app')) ? params.get('app')! : '');
  const [status, setStatus] = useState<string>('live');
  const [search, setSearch] = useState('');
  const tenants = useMemo(() => new Map(data.tenants.map(tenant => [tenant.id, tenant])), [data.tenants]);
  const query = search.trim().toLowerCase();
  const shown = data.subscriptions.filter(subscription => (!app || subscription.app === app)
    && (status === 'all' || (status === 'live' ? liveStatuses.includes(subscription.status) : subscription.status === status))
    && (!query || [tenants.get(subscription.tenant_id)?.name ?? '', subscription.id, subscription.customer, ...subscription.items.map(item => item.product_name)].some(value => value.toLowerCase().includes(query))));
  const totals = billingTotals(shown, data.coupons);
  return <section className="billing-section" aria-label="Subscriptions">
    <div className="billing-filters">
      <label>Application<select value={app} onChange={event => setApp(event.target.value)}><option value="">All applications</option>{billingApps.map(slug => <option key={slug} value={slug}>{appLabels[slug]}</option>)}</select></label>
      <label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="live">Current (not canceled)</option><option value="all">All statuses</option>{subscriptionStatuses.map(value => <option key={value} value={value}>{statusLabels[value]}</option>)}</select></label>
      <label>Customer<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, plan or Stripe id" /></label>
    </div>
    <div className="billing-totals" aria-label="Subscription totals">
      <div><span>Subscriptions</span><strong>{totals.subscriptions}</strong></div>
      <div><span>MRR</span><strong>{formatCents(totals.mrrCents)}</strong></div>
      <div><span>ARR</span><strong>{formatCents(totals.arrCents)}</strong></div>
      <div><span>In trial (MRR after trial)</span><strong>{formatCents(totals.trialMrrCents)}</strong></div>
    </div>
    <p className="billing-muted">MRR counts active and past-due subscriptions after their discounts, with yearly prices as one twelfth. Trials are shown separately until they convert.</p>
    {!shown.length && <p>{data.subscriptions.length ? 'No subscriptions match these filters.' : 'No subscriptions yet. Open a customer to start one.'}</p>}
    <div className="billing-list">{shown.map(subscription => {
      const tenant = tenants.get(subscription.tenant_id);
      return <article className="billing-card" key={subscription.id}>
        <div className="billing-card-head"><div><h3><Link to={`/admin/billing/customers/${subscription.tenant_id}`}>{tenant?.name ?? 'Unknown tenant'}</Link></h3>
          <p>{appLabel(subscription.app)} · <span className="billing-mono">{subscription.id}</span></p></div>
          <div className="billing-actions"><StatusChip status={subscription.status} label={statusLabels[subscription.status]} />{subscription.cancel_at_period_end && <StatusChip status="canceled" label="Cancels at period end" />}{subscription.pause_behavior && <StatusChip status="paused" label="Collection paused" />}</div></div>
        <ul className="billing-items">{subscription.items.map(item => <li key={item.id}><div><strong>{item.product_name}</strong>{item.custom && <small className="billing-muted"> · custom price</small>}</div>
          <div>{item.quantity > 1 || item.pricing_model === 'per_unit' ? `${item.quantity} × ` : ''}{priceLabel({ ...item, type: item.interval ? 'recurring' : 'one_time', pricing_model: item.pricing_model as CatalogPrice['pricing_model'] }, item.unit_label)}</div></li>)}</ul>
        <p className="billing-muted">{formatCents(subscriptionMonthlyCents(subscription, data.coupons))} per month · {subscription.trial_end && subscription.status === 'trialing' ? `trial ends ${dateLabel(subscription.trial_end)}` : `renews ${dateLabel(subscription.current_period_end)}`}{subscription.discounts.length ? ` · ${subscription.discounts.length} discount${subscription.discounts.length > 1 ? 's' : ''}` : ''}</p>
      </article>;
    })}</div>
  </section>;
}

// ---------------------------------------------------------------------------
function CustomersTab({ data, client, refresh }: { data: Workspace; client: BillingClient; refresh: (message?: string) => void }) {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const query = search.trim().toLowerCase();
  const shown = data.tenants.filter(tenant => !query || [tenant.name, tenant.slug, tenant.customer?.email ?? '', tenant.customer?.id ?? ''].some(value => value.toLowerCase().includes(query)));
  return <section className="billing-section" aria-label="Customers">
    <div className="billing-section-head"><div><h2>Customers</h2><p>Every Hub tenant. Billing starts once a billing contact (Stripe customer) is saved.</p></div>
      <button type="button" className="button button-primary" onClick={() => setCreating(true)}>Set up tenant</button></div>
    <div className="billing-filters"><label>Search<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, slug, email or Stripe id" /></label></div>
    {!shown.length && <p>{data.tenants.length ? 'No tenants match your search.' : 'No tenants yet. Set up a tenant to begin.'}</p>}
    <div className="billing-list">{shown.map(tenant => {
      const subscriptions = data.subscriptions.filter(subscription => subscription.tenant_id === tenant.id && liveStatuses.includes(subscription.status));
      const totals = billingTotals(subscriptions, data.coupons);
      return <article className="billing-card" key={tenant.id}>
        <div className="billing-card-head"><div><h3><Link to={`/admin/billing/customers/${tenant.id}`}>{tenant.name}</Link></h3><p>{tenant.slug}{tenant.industry ? ` · ${tenant.industry}` : ''}</p></div>
          <div className="billing-actions"><StatusChip status={tenant.status === 'active' ? 'active' : 'canceled'} label={tenant.status} />{tenant.customer?.delinquent && <StatusChip status="past_due" label="Delinquent" />}</div></div>
        <p className="billing-muted">{tenant.customer ? <>Billing contact {tenant.customer.email || 'no email'} · <span className="billing-mono">{tenant.customer.id}</span></> : 'No billing contact yet'} · {subscriptions.length} current subscription{subscriptions.length === 1 ? '' : 's'} · {formatCents(totals.mrrCents)} MRR</p>
      </article>;
    })}</div>
    {creating && <TenantSheet client={client} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh('Tenant set up. Open it to add a billing contact and a subscription.'); }} />}
  </section>;
}

const slugify = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
function TenantSheet({ client, onClose, onSaved }: { client: BillingClient; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(''); const [slug, setSlug] = useState(''); const [slugEdited, setSlugEdited] = useState(false); const [industry, setIndustry] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const activeSlug = slugEdited ? slug : slugify(name);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await client.createTenant({ name: name.trim(), slug: activeSlug, industry: industry.trim() }); onSaved(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The tenant could not be saved.'); }
    finally { setBusy(false); }
  }
  return <Sheet title="Set up a tenant" onClose={onClose} busy={busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <label>Name<input required minLength={2} maxLength={180} value={name} onChange={event => setName(event.target.value)} /></label>
    <div className="billing-form-grid"><label>Slug<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={63} value={activeSlug} onChange={event => { setSlugEdited(true); setSlug(event.target.value); }} /><small>Permanent. Lowercase letters, numbers and hyphens.</small></label>
      <label>Industry <small>optional</small><input maxLength={120} value={industry} onChange={event => setIndustry(event.target.value)} /></label></div>
    <Notice error={error} /><div className="billing-actions"><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Set up tenant'}</button></div>
  </form></Sheet>;
}

// ---------------------------------------------------------------------------
type CatalogEditor = { kind: 'product'; product: CatalogProduct | null } | { kind: 'price'; product: CatalogProduct } | { kind: 'change'; price: CatalogPrice; product: CatalogProduct | undefined };
function CatalogTab({ data, client, refresh }: { data: Workspace; client: BillingClient; refresh: (message?: string) => void }) {
  const [editor, setEditor] = useState<CatalogEditor | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const action = useBillingAction();
  const groups = [...billingApps, null].map(app => ({ app, products: data.products.filter(product => product.app === app && (showArchived || product.active)) })).filter(group => group.products.length);
  const archive = async (price: CatalogPrice) => {
    const result = await action.run(['price.archive', price.id, !price.active], request_key => client.command({ action: 'price.archive', price: price.id, active: !price.active, expected_version: price.version, request_key }));
    if (result) refresh(price.active ? 'Price archived. Existing subscribers keep it until you move them.' : 'Price restored.');
  };
  const sync = async () => {
    const result = await action.run(['catalog.sync'], () => client.command({ action: 'catalog.sync' }));
    if (result) refresh(`Catalog refreshed from Stripe (${result.synced ?? 0} objects).`);
  };
  return <section className="billing-section" aria-label="Catalog">
    <div className="billing-section-head"><div><h2>Catalog</h2><p>Products and prices per application. Changing a price creates a new Stripe price and archives the old one; you choose whether current subscribers move now or keep their price.</p></div>
      <div className="billing-actions"><button type="button" className="button button-secondary" disabled={action.busy} onClick={() => void sync()}>Refresh from Stripe</button><button type="button" className="button button-primary" onClick={() => setEditor({ kind: 'product', product: null })}>New product</button></div></div>
    <label className="billing-check"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Show archived products and prices</label>
    <Notice error={action.error} />
    {!groups.length && <p>No products yet. Refresh from Stripe to import the existing catalog, or create a product.</p>}
    {groups.map(group => <div className="billing-app-group" key={group.app ?? 'unassigned'}><h3>{appLabel(group.app)}</h3>
      {group.products.map(product => {
        const prices = data.prices.filter(price => price.product === product.id && (showArchived || price.active));
        return <article className="billing-card" key={product.id}>
          <div className="billing-card-head"><div><h3>{product.name}</h3><p>{product.kind === 'addon' ? 'Add-on' : product.kind === 'fee' ? 'One-time fee' : 'Plan'}{product.entitlement_key ? ` · entitlement “${product.entitlement_key}”` : ''}{product.unit_label ? ` · billed per ${product.unit_label}` : ''} · <span className="billing-mono">{product.id}</span></p></div>
            <div className="billing-actions">{!product.active && <StatusChip status="archived" label="Archived" />}<button type="button" className="button button-secondary button-small" onClick={() => setEditor({ kind: 'product', product })}>Edit</button>{product.active && product.app && <button type="button" className="button button-secondary button-small" onClick={() => setEditor({ kind: 'price', product })}>Add price</button>}</div></div>
          {prices.length ? <ul className="billing-items">{prices.map(price => <li key={price.id}><div><strong>{priceLabel(price, product.unit_label)}</strong>{price.nickname && <small className="billing-muted"> · {price.nickname}</small>}<br /><span className="billing-mono">{price.id}</span>{price.lookup_key && <small className="billing-muted"> · {price.lookup_key}</small>}</div>
            <div className="billing-actions"><span className="billing-muted">{price.subscribers} subscriber{price.subscribers === 1 ? '' : 's'}</span>{!price.active && <StatusChip status="archived" label="Archived" />}
              {price.active && price.unit_amount !== null && <button type="button" className="button button-secondary button-small" onClick={() => setEditor({ kind: 'change', price, product })}>Change price</button>}
              <button type="button" className="button button-secondary button-small" disabled={action.busy} onClick={() => void archive(price)}>{price.active ? 'Archive' : 'Restore'}</button></div></li>)}</ul>
            : <p className="billing-muted">No {showArchived ? '' : 'active '}prices.</p>}
        </article>;
      })}</div>)}
    {editor?.kind === 'product' && <ProductSheet client={client} product={editor.product} onClose={() => setEditor(null)} onSaved={message => { setEditor(null); refresh(message); }} />}
    {editor?.kind === 'price' && <PriceSheet client={client} product={editor.product} tenantId={null} onClose={() => setEditor(null)} onSaved={message => { setEditor(null); refresh(message); }} />}
    {editor?.kind === 'change' && <PriceChangeSheet client={client} price={editor.price} product={editor.product} onClose={() => setEditor(null)} onSaved={message => { setEditor(null); refresh(message); }} />}
  </section>;
}

function ProductSheet({ client, product, onClose, onSaved }: { client: BillingClient; product: CatalogProduct | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [app, setApp] = useState<BillingApp | ''>(product?.app ?? '');
  const [name, setName] = useState(product?.name ?? ''); const [description, setDescription] = useState(product?.description ?? '');
  const [kind, setKind] = useState<CatalogProduct['kind']>(product?.kind ?? 'plan'); const [unit, setUnit] = useState(product?.unit_label ?? '');
  const [key, setKey] = useState(product?.entitlement_key ?? ''); const [active, setActive] = useState(product?.active ?? true);
  const action = useBillingAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!app) { action.setError('Choose the application.'); return; }
    const fields = { name: name.trim(), description: description.trim(), kind, unit_label: unit.trim(), entitlement_key: key.trim().toLowerCase() };
    const result = product
      ? await action.run(['product.update', product.id, app, ...Object.values(fields), active], request_key => client.command({ action: 'product.update', product: product.id, app, ...fields, active, expected_version: product.version, request_key }))
      : await action.run(['product.create', app, ...Object.values(fields)], request_key => client.command({ action: 'product.create', app, ...fields, request_key }));
    if (result) onSaved(product ? 'Product saved.' : 'Product created. Add its prices next.');
  }
  return <Sheet title={product ? `Edit ${product.name}` : 'New product'} onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <div className="billing-form-grid">
      <label>Application<select required value={app} onChange={event => setApp(event.target.value as BillingApp)} disabled={!!product?.app}><option value="">Choose…</option>{billingApps.map(slug => <option key={slug} value={slug}>{appLabels[slug]}</option>)}</select></label>
      <label>Type<select value={kind} onChange={event => setKind(event.target.value as CatalogProduct['kind'])}><option value="plan">Plan</option><option value="addon">Add-on</option><option value="fee">One-time fee</option></select></label>
    </div>
    <label>Name<input required maxLength={250} value={name} onChange={event => setName(event.target.value)} /></label>
    <label>Description <small>shown on invoices and the customer portal</small><textarea maxLength={2000} rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
    <div className="billing-form-grid">
      <label>Unit label <small>for per-unit prices, such as “facility”</small><input maxLength={12} value={unit} onChange={event => setUnit(event.target.value)} /></label>
      <label>Entitlement key <small>what the app checks, such as “core” or “emar”</small><input maxLength={64} pattern="[a-z0-9_.\-]*" value={key} onChange={event => setKey(event.target.value)} /></label>
    </div>
    {product && <label className="billing-check"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} />Active (archived products cannot be sold; existing subscribers keep them)</label>}
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy}>{action.busy ? 'Saving in Stripe…' : product ? 'Save product' : 'Create product'}</button></div>
  </form></Sheet>;
}

export function PriceSheet({ client, product, tenantId, onClose, onSaved }: { client: BillingClient; product: CatalogProduct; tenantId: string | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [model, setModel] = useState<'flat' | 'per_unit'>(product.unit_label ? 'per_unit' : 'flat');
  const [type, setType] = useState<'recurring' | 'one_time'>(product.kind === 'fee' ? 'one_time' : 'recurring');
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [amount, setAmount] = useState(''); const [nickname, setNickname] = useState('');
  const action = useBillingAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const cents = parseDollars(amount);
    if (cents === null) { action.setError('Enter a dollar amount up to $1,000,000.'); return; }
    const fields = { product: product.id, pricing_model: model, type, interval: type === 'recurring' ? interval : null, unit_amount: cents, nickname: nickname.trim(), tenant_id: tenantId };
    const result = await action.run(['price.create', ...Object.values(fields)], request_key => client.command({ action: 'price.create', ...fields, request_key }));
    if (result) onSaved(tenantId ? 'Custom price created for this customer only.' : 'Price created.');
  }
  return <Sheet title={tenantId ? `Custom price · ${product.name}` : `New price · ${product.name}`} onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    {tenantId && <p className="billing-banner">This price is tagged to this customer and appears only on their page.</p>}
    <div className="billing-form-grid">
      <label>Pricing<select value={model} onChange={event => setModel(event.target.value as 'flat' | 'per_unit')}><option value="flat">Flat</option><option value="per_unit">Per {product.unit_label || 'unit'}</option></select></label>
      <label>Billing<select value={type === 'one_time' ? 'one_time' : interval} onChange={event => { const value = event.target.value; if (value === 'one_time') setType('one_time'); else { setType('recurring'); setInterval(value as 'month' | 'year'); } }}><option value="month">Monthly</option><option value="year">Annual</option><option value="one_time">One-time fee</option></select></label>
      <label>Amount (USD)<input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="199.00" /></label>
      <label>Nickname <small>optional</small><input maxLength={250} value={nickname} onChange={event => setNickname(event.target.value)} /></label>
    </div>
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy}>{action.busy ? 'Creating in Stripe…' : 'Create price'}</button></div>
  </form></Sheet>;
}

function PriceChangeSheet({ client, price, product, onClose, onSaved }: { client: BillingClient; price: CatalogPrice; product: CatalogProduct | undefined; onClose: () => void; onSaved: (message: string) => void }) {
  const [amount, setAmount] = useState(centsToDollars(price.unit_amount ?? 0));
  const [migrate, setMigrate] = useState<'grandfather' | 'prorate' | 'no_proration'>('grandfather');
  const action = useBillingAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const cents = parseDollars(amount);
    if (cents === null || cents === price.unit_amount) { action.setError('Enter a new dollar amount.'); return; }
    const result = await action.run(['price.change', price.id, cents, migrate], request_key => client.command({ action: 'price.change', price: price.id, unit_amount: cents, migrate, expected_version: price.version, request_key }));
    if (result) onSaved(migrate === 'grandfather' ? 'New price created; current subscribers keep their old price.' : `New price created; ${result.migrated ?? 0} subscription item(s) moved${result.failed ? `, ${result.failed} could not be moved — retry from the customer page` : ''}${result.incomplete ? '. Stripe had more subscriptions on the old price than one pass reads: move the rest from each customer page' : ''}.`);
  }
  return <Sheet title={`Change price · ${product?.name ?? price.product}`} onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <p>Current: <strong>{priceLabel(price, product?.unit_label)}</strong> · {price.subscribers} subscriber{price.subscribers === 1 ? '' : 's'}. Stripe prices cannot be edited, so a new price is created and this one is archived.</p>
    <label>New amount (USD)<input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></label>
    <fieldset><legend>Existing subscribers</legend>
      <label className="billing-check"><input type="radio" name="migrate" checked={migrate === 'grandfather'} onChange={() => setMigrate('grandfather')} />Grandfather: they keep the current price</label>
      <label className="billing-check"><input type="radio" name="migrate" checked={migrate === 'prorate'} onChange={() => setMigrate('prorate')} />Move them now, with proration</label>
      <label className="billing-check"><input type="radio" name="migrate" checked={migrate === 'no_proration'} onChange={() => setMigrate('no_proration')} />Move them now, new price from their next renewal</label>
    </fieldset>
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy}>{action.busy ? 'Changing in Stripe…' : 'Change price'}</button></div>
  </form></Sheet>;
}

// ---------------------------------------------------------------------------
function DiscountsTab({ data, client, refresh }: { data: Workspace; client: BillingClient; refresh: (message?: string) => void }) {
  const [editor, setEditor] = useState<'coupon' | 'code' | null>(null);
  const action = useBillingAction();
  const toggle = async (id: string, active: boolean, version: number) => {
    const result = await action.run(['promotion_code.update', id, active], request_key => client.command({ action: 'promotion_code.update', promotion_code: id, active, expected_version: version, request_key }));
    if (result) refresh(active ? 'Promotion code reactivated.' : 'Promotion code deactivated.');
  };
  const remove = async (coupon: Coupon) => {
    if (!window.confirm(`Delete coupon “${coupon.name || coupon.id}”? Subscriptions already using it keep their discount; it can no longer be applied.`)) return;
    const result = await action.run(['coupon.delete', coupon.id], request_key => client.command({ action: 'coupon.delete', coupon: coupon.id, expected_version: coupon.version, request_key }));
    if (result) refresh('Coupon deleted.');
  };
  const customerName = (id: string | null) => id ? data.tenants.find(tenant => tenant.customer?.id === id)?.name ?? id : null;
  const current = data.coupons.filter(coupon => !coupon.deleted);
  return <section className="billing-section" aria-label="Discounts">
    <div className="billing-section-head"><div><h2>Discounts</h2><p>Coupons set the discount (percent or amount; once, repeating or forever) and can be limited to an application or products. Promotion codes are the codes customers or staff enter for a coupon.</p></div>
      <div className="billing-actions"><button type="button" className="button button-secondary" onClick={() => setEditor('code')} disabled={!data.coupons.some(coupon => coupon.valid)}>New promotion code</button><button type="button" className="button button-primary" onClick={() => setEditor('coupon')}>New coupon</button></div></div>
    <Notice error={action.error} />
    <h3>Coupons</h3>
    {!current.length && <p>No coupons yet.</p>}
    <div className="billing-list">{current.map(coupon => <article className="billing-card" key={coupon.id}>
      <div className="billing-card-head"><div><h3>{coupon.name || coupon.id}</h3><p>{couponLabel(coupon)} · {coupon.app ? appLabel(coupon.app) : coupon.applies_to.length ? `${coupon.applies_to.length} product(s)` : 'Any product'} · <span className="billing-mono">{coupon.id}</span></p></div>
        <div className="billing-actions">{!coupon.valid && <StatusChip status="archived" label="No longer valid" />}<button type="button" className="button button-secondary button-small" disabled={action.busy} onClick={() => void remove(coupon)}>Delete</button></div></div>
      <p className="billing-muted">Redeemed {coupon.times_redeemed}{coupon.max_redemptions ? ` of ${coupon.max_redemptions}` : ''} times{coupon.redeem_by ? ` · redeem by ${dateLabel(coupon.redeem_by)}` : ''}</p>
    </article>)}</div>
    <h3>Promotion codes</h3>
    {!data.promotion_codes.length && <p>No promotion codes yet.</p>}
    {data.promotion_codes.length > 0 && <div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>Code</th><th>Coupon</th><th>Limits</th><th>Status</th><th></th></tr></thead><tbody>
      {data.promotion_codes.map(code => { const coupon = data.coupons.find(item => item.id === code.coupon); return <tr key={code.id}>
        <td><strong className="billing-mono">{code.code}</strong></td><td>{coupon ? `${coupon.name || coupon.id} (${couponLabel(coupon)})` : code.coupon}</td>
        <td>{[code.max_redemptions ? `${code.times_redeemed}/${code.max_redemptions} used` : `${code.times_redeemed} used`, code.expires_at ? `expires ${dateLabel(code.expires_at)}` : null, code.first_time_transaction ? 'first purchase only' : null, code.minimum_amount ? `minimum ${formatCents(code.minimum_amount)}` : null, customerName(code.customer) ? `only ${customerName(code.customer)}` : null].filter(Boolean).join(' · ')}</td>
        <td><StatusChip status={code.active ? 'active' : 'archived'} label={code.active ? 'Active' : 'Inactive'} /></td>
        <td><button type="button" className="button button-secondary button-small" disabled={action.busy} onClick={() => void toggle(code.id, !code.active, code.version)}>{code.active ? 'Deactivate' : 'Reactivate'}</button></td></tr>; })}
    </tbody></table></div>}
    {editor === 'coupon' && <CouponSheet client={client} products={data.products} onClose={() => setEditor(null)} onSaved={message => { setEditor(null); refresh(message); }} />}
    {editor === 'code' && <PromotionSheet client={client} data={data} onClose={() => setEditor(null)} onSaved={message => { setEditor(null); refresh(message); }} />}
  </section>;
}

function CouponSheet({ client, products, onClose, onSaved }: { client: BillingClient; products: CatalogProduct[]; onClose: () => void; onSaved: (message: string) => void }) {
  const [name, setName] = useState(''); const [kind, setKind] = useState<'percent' | 'amount'>('percent'); const [value, setValue] = useState('');
  const [duration, setDuration] = useState<'once' | 'repeating' | 'forever'>('once'); const [months, setMonths] = useState('3');
  const [max, setMax] = useState(''); const [redeemBy, setRedeemBy] = useState(''); const [app, setApp] = useState<BillingApp | ''>(''); const [chosen, setChosen] = useState<string[]>([]);
  const action = useBillingAction();
  const appProducts = products.filter(product => product.active && (!app || product.app === app));
  async function submit(event: FormEvent) {
    event.preventDefault();
    const percent = kind === 'percent' ? Number(value) : null;
    const amount = kind === 'amount' ? parseDollars(value) : null;
    if (kind === 'percent' && !(percent! > 0 && percent! <= 100)) { action.setError('Enter a percent from 0.01 to 100.'); return; }
    if (kind === 'amount' && !amount) { action.setError('Enter a dollar amount.'); return; }
    const fields = { name: name.trim(), percent_off: percent, amount_off: amount, duration, duration_in_months: duration === 'repeating' ? Number(months) : null,
      max_redemptions: max ? Number(max) : null, redeem_by: redeemBy || null, app: app || null, products: chosen };
    const result = await action.run(['coupon.create', JSON.stringify(fields)], request_key => client.command({ action: 'coupon.create', ...fields, request_key }));
    if (result) onSaved('Coupon created.');
  }
  return <Sheet title="New coupon" onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <label>Name <small>shown to the customer on invoices</small><input required maxLength={40} value={name} onChange={event => setName(event.target.value)} /></label>
    <div className="billing-form-grid">
      <label>Discount<select value={kind} onChange={event => setKind(event.target.value as 'percent' | 'amount')}><option value="percent">Percent off</option><option value="amount">Amount off (USD)</option></select></label>
      <label>{kind === 'percent' ? 'Percent' : 'Amount'}<input required inputMode="decimal" value={value} onChange={event => setValue(event.target.value)} placeholder={kind === 'percent' ? '25' : '100.00'} /></label>
      <label>Duration<select value={duration} onChange={event => setDuration(event.target.value as typeof duration)}><option value="once">Once</option><option value="repeating">Repeating</option><option value="forever">Forever</option></select></label>
      {duration === 'repeating' && <label>Months<input required type="number" min={1} max={120} value={months} onChange={event => setMonths(event.target.value)} /></label>}
      <label>Maximum redemptions <small>optional</small><input type="number" min={1} value={max} onChange={event => setMax(event.target.value)} /></label>
      <label>Redeem by <small>optional</small><input type="date" min={dayAfter(1)} value={redeemBy} onChange={event => setRedeemBy(event.target.value)} /></label>
    </div>
    <fieldset><legend>Limit to</legend>
      <label>Application<select value={app} onChange={event => { setApp(event.target.value as BillingApp | ''); setChosen([]); }}><option value="">Any application</option>{billingApps.map(slug => <option key={slug} value={slug}>{appLabels[slug]}</option>)}</select></label>
      {appProducts.length > 0 && <small>Optionally choose specific products{app ? '; leave all unchecked for every product of this application' : ''}:</small>}
      {appProducts.map(product => <label key={product.id} className="billing-check"><input type="checkbox" checked={chosen.includes(product.id)} onChange={event => setChosen(current => event.target.checked ? [...current, product.id] : current.filter(id => id !== product.id))} />{product.name} <small className="billing-muted">{appLabel(product.app)}</small></label>)}
    </fieldset>
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy}>{action.busy ? 'Creating in Stripe…' : 'Create coupon'}</button></div>
  </form></Sheet>;
}

function PromotionSheet({ client, data, onClose, onSaved }: { client: BillingClient; data: Workspace; onClose: () => void; onSaved: (message: string) => void }) {
  const valid = data.coupons.filter(coupon => coupon.valid);
  const [coupon, setCoupon] = useState(valid[0]?.id ?? ''); const [code, setCode] = useState(''); const [max, setMax] = useState(''); const [expires, setExpires] = useState('');
  const [firstTime, setFirstTime] = useState(false); const [minimum, setMinimum] = useState(''); const [tenant, setTenant] = useState('');
  const action = useBillingAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const minimumCents = minimum ? parseDollars(minimum) : null;
    if (minimum && !minimumCents) { action.setError('Enter a minimum dollar amount.'); return; }
    const fields = { coupon, code: code.trim(), max_redemptions: max ? Number(max) : null, expires_at: expires || null, first_time_transaction: firstTime, minimum_amount: minimumCents, tenant_id: tenant || null };
    const result = await action.run(['promotion_code.create', JSON.stringify(fields)], request_key => client.command({ action: 'promotion_code.create', ...fields, request_key }));
    if (result) onSaved('Promotion code created.');
  }
  return <Sheet title="New promotion code" onClose={onClose} busy={action.busy}><form className="billing-form" onSubmit={event => void submit(event)}>
    <div className="billing-form-grid">
      <label>Coupon<select required value={coupon} onChange={event => setCoupon(event.target.value)}>{valid.map(item => <option key={item.id} value={item.id}>{item.name || item.id} · {couponLabel(item)}{item.app ? ` · ${appLabel(item.app)}` : ''}</option>)}</select><small>To limit a code to an application or product, choose a coupon limited that way.</small></label>
      <label>Code<input required pattern="[A-Za-z0-9\-]{3,50}" value={code} onChange={event => setCode(event.target.value.toUpperCase())} placeholder="FOUNDERS75" /></label>
      <label>Maximum redemptions <small>optional</small><input type="number" min={1} value={max} onChange={event => setMax(event.target.value)} /></label>
      <label>Expires <small>optional</small><input type="date" min={dayAfter(1)} value={expires} onChange={event => setExpires(event.target.value)} /></label>
      <label>Minimum order (USD) <small>optional</small><input inputMode="decimal" value={minimum} onChange={event => setMinimum(event.target.value)} /></label>
      <label>Only for customer <small>optional</small><select value={tenant} onChange={event => setTenant(event.target.value)}><option value="">Any customer</option>{data.tenants.filter(item => item.customer).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    </div>
    <label className="billing-check"><input type="checkbox" checked={firstTime} onChange={event => setFirstTime(event.target.checked)} />First purchase only</label>
    <Notice error={action.error} /><div className="billing-actions"><button className="button button-primary" disabled={action.busy || !coupon}>{action.busy ? 'Creating in Stripe…' : 'Create promotion code'}</button></div>
  </form></Sheet>;
}

// ---------------------------------------------------------------------------
function AppsTab({ data, client, refresh }: { data: Workspace; client: BillingClient; refresh: (message?: string) => void }) {
  const [issued, setIssued] = useState<{ app: string; key: string } | null>(null);
  const action = useBillingAction();
  const issue = async (app: BillingApp) => {
    const result = await action.run(['app_key.issue', app], () => client.command({ action: 'app_key.issue', app }));
    if (result?.key) { setIssued({ app, key: result.key }); refresh(); }
  };
  const revoke = async (id: string) => {
    if (!window.confirm('Revoke this key? The application stops receiving entitlements until it has a new key.')) return;
    const result = await action.run(['app_key.revoke', id], () => client.command({ action: 'app_key.revoke', key_id: id }));
    if (result) refresh('Key revoked.');
  };
  return <section className="billing-section" aria-label="App connections">
    <div className="billing-section-head"><div><h2>App connections</h2><p>Each application asks the Hub what a tenant has (POST /api/apps/entitlements), reports billable quantities such as active facilities (POST /api/apps/usage) and starts self-service trials (POST /api/apps/trials) with its own key. Link an application account to a tenant on the customer's page.</p></div></div>
    <Notice error={action.error} />
    {issued && <div className="billing-banner billing-banner-warn" role="status"><p>New key for {appLabel(issued.app)}. Copy it into the application's HUB_BILLING_API_KEY now — it is not shown again.</p><p className="billing-key">{issued.key}</p><button type="button" className="button button-secondary button-small" onClick={() => setIssued(null)}>I saved it</button></div>}
    <div className="billing-list">{billingApps.map(app => {
      const keys = data.app_keys.filter(key => key.app === app);
      const live = keys.filter(key => !key.revoked_at);
      return <article className="billing-card" key={app}>
        <div className="billing-card-head"><div><h3>{appLabels[app]}</h3><p>{live.length ? `${live.length} active key${live.length > 1 ? 's' : ''}` : 'Not connected'}</p></div>
          <button type="button" className="button button-secondary button-small" disabled={action.busy || live.length >= 2} onClick={() => void issue(app)}>Issue key</button></div>
        {keys.length > 0 && <ul className="billing-items">{keys.map(key => <li key={key.id}><div><span className="billing-mono">cmb_…{key.hint}</span><br /><small className="billing-muted">Issued {dateLabel(key.created_at)} · {key.last_used_at ? `last used ${dateLabel(key.last_used_at)}` : 'never used'}</small></div>
          <div>{key.revoked_at ? <StatusChip status="archived" label={`Revoked ${dateLabel(key.revoked_at)}`} /> : <button type="button" className="button button-secondary button-small" disabled={action.busy} onClick={() => void revoke(key.id)}>Revoke</button>}</div></li>)}</ul>}
      </article>;
    })}</div>
  </section>;
}


