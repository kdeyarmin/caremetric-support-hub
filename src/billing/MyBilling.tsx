import { useEffect, useState } from 'react';
import { CreditCard } from 'lucide-react';
import { config } from '../lib/config';
import { customerBillingClient, type CustomerBillingClient, type MyBilling as MyBillingData } from './billingClient';
import { dateLabel, formatCents, priceLabel, statusLabels, type SubscriptionStatus } from './billingModel';
import { Notice, StatusChip } from './BillingUi';
import './billing.css';

type MyBillingItem = MyBillingData['tenants'][number]['subscriptions'][number]['items'][number];
/**
 * Billing for a customer's own organization: plans, quantities and invoices,
 * with open invoices payable through Stripe and the payment method managed in
 * the Stripe customer portal. Tenant administrators only; there is no checkout.
 */
/** One subscription item's price in plain words, with the quantity only where it multiplies the price. */
function itemPrice(item: MyBillingItem): string {
  const pricingModel = item.pricing_model ?? (item.unit_label ? 'per_unit' : 'flat');
  const quantity = item.quantity > 1 || pricingModel === 'per_unit' ? `${item.quantity} × ` : '';
  return quantity + priceLabel({ unit_amount: item.unit_amount, currency: item.currency, type: item.interval ? 'recurring' : 'one_time', interval: item.interval as 'month' | 'year' | null, interval_count: item.interval_count, pricing_model: pricingModel }, item.unit_label);
}

export function MyBilling({ client = customerBillingClient, demo = config.demoMode }: { client?: CustomerBillingClient; demo?: boolean }) {
  const [data, setData] = useState<MyBillingData | null>(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    client.read(controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(() => { if (!controller.signal.aborted) setError('Billing could not be loaded. Sign in again and refresh.'); });
    return () => controller.abort();
  }, [client, demo]);
  const openPortal = async (tenantId: string) => {
    setOpening(tenantId); setError('');
    try { window.location.assign(await client.portal(tenantId)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The billing portal could not be opened.'); setOpening(null); }
  };
  return <div className="billing">
    <div className="page-heading"><div><span className="eyebrow">Your organization</span><h1>Billing</h1>
      <p>Your CareMetric plans and invoices. Pay an open invoice or update your payment method through Stripe's secure pages.</p></div></div>
    {demo && <p className="billing-banner">Sign in to see your organization's billing.</p>}
    <Notice error={error} />
    {!demo && !data && !error && <p role="status">Loading billing…</p>}
    {data && !data.tenants.length && <p className="billing-banner">Billing is available to your organization's administrators. Ask CareMetric support if you should have access.</p>}
    {data?.tenants.map(tenant => <section key={tenant.id} className="billing-section" aria-label={`${tenant.name} billing`}>
      <div className="billing-section-head"><div><h2>{tenant.name}</h2></div>
        {tenant.has_customer && <button type="button" className="button button-primary" disabled={opening !== null} onClick={() => void openPortal(tenant.id)}><CreditCard size={15} aria-hidden="true" />{opening === tenant.id ? 'Opening…' : 'Payment method & billing details'}</button>}</div>
      {!tenant.has_customer && <p className="billing-muted">Billing is not set up for this organization yet.</p>}
      {tenant.subscriptions.length ? <div className="billing-list">{tenant.subscriptions.map((subscription, index) => <article className="billing-card" key={index}>
        <div className="billing-card-head"><div><h3>{subscription.app ?? 'CareMetric'}</h3>
          <p>{subscription.status === 'canceled' ? '' : subscription.status === 'trialing' && subscription.trial_end ? `Free trial through ${dateLabel(subscription.trial_end)}` : subscription.cancel_at_period_end ? `Ends ${dateLabel(subscription.current_period_end)}` : subscription.current_period_end && subscription.status !== 'paused' ? `Renews ${dateLabel(subscription.current_period_end)}` : ''}</p></div>
          <div className="billing-actions"><StatusChip status={subscription.status} label={statusLabels[subscription.status as SubscriptionStatus] ?? subscription.status} />{subscription.paused && <StatusChip status="paused" label="Collection paused" />}</div></div>
        <ul className="billing-items">{subscription.items.map((item, itemIndex) => <li key={itemIndex}><div><strong>{item.name}</strong>{item.kind === 'addon' && <small className="billing-muted"> · add-on</small>}</div>
          <div>{itemPrice(item)}</div></li>)}</ul>
        {subscription.status === 'past_due' && <p className="billing-error">A payment is past due. Pay the open invoice below or update your payment method.</p>}
      </article>)}</div> : tenant.has_customer && <p className="billing-muted">No current subscriptions.</p>}
      {tenant.invoices.length > 0 && <div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>Invoice</th><th>Status</th><th>Total</th><th></th></tr></thead><tbody>
        {tenant.invoices.map(invoice => <tr key={invoice.id}><td>{invoice.number ?? '—'}<br /><small className="billing-muted">{dateLabel(invoice.created)}{invoice.status === 'open' && invoice.due_date ? ` · due ${dateLabel(invoice.due_date)}` : ''}</small></td>
          <td><StatusChip status={invoice.status} /></td><td>{formatCents(invoice.total, invoice.currency)}</td>
          <td><div className="billing-actions">{invoice.status === 'open' && invoice.hosted_invoice_url && <a className="button button-primary button-small" href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">Pay {formatCents(invoice.amount_remaining, invoice.currency)}</a>}
            {invoice.status !== 'open' && invoice.hosted_invoice_url && <a className="button button-secondary button-small" href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">View</a>}
            {invoice.invoice_pdf && <a className="button button-secondary button-small" href={invoice.invoice_pdf} target="_blank" rel="noreferrer">PDF</a>}</div></td></tr>)}
      </tbody></table></div>}
    </section>)}
  </div>;
}
