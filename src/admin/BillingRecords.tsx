import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AdminInvoice, AdminInvoiceDetail, AdminSubscriptionVerification, ProviderRead } from "../../supabase/functions/_shared/billingProtocol";
import type { PortfolioClient } from "./portfolioClient";
import { Loading, ReadFailure } from "./AdminReads";
import { PagedRecords } from "./PagedRecords";
import { useAdminRead } from "./useAdminRead";
import { timeLabel } from "./readState";
import { formatBillingMoney } from "./billingMoney";

const fieldLabels = { status: "Invoice status", currency: "Currency", amountDueMinor: "Amount due", amountPaidMinor: "Amount paid", amountRemainingMinor: "Amount remaining", providerStatus: "Subscription provider status" };
const unavailableMessages = {
  unconfigured: "Stripe verification is not configured for this connection.",
  unavailable: "Stripe verification is unavailable. The stored record is still shown.",
  notfound: "Stripe did not find the linked record. The stored record is still shown.",
  identity_mismatch: "The native billing associations and Stripe identity did not match. Provider details are withheld.",
};

function DetailFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className="panel billing-detail" aria-label={title}><div className="panel-heading"><h2 tabIndex={-1} ref={heading}>{title}</h2><button type="button" className="button button-secondary button-small" onClick={onClose}>Close details</button></div><div className="admin-section-body">{children}</div></section>;
}
function ProviderStatus<T>({ provider }: { provider: ProviderRead<T> }) {
  return <div className={`billing-provider-status ${provider.availability === "available" ? "billing-provider-available" : ""}`} role="status"><strong>{provider.availability === "available" ? "Stripe response verified" : "Stripe comparison unavailable"}</strong><p>{provider.availability === "available" ? "This response was checked against the native billing association." : unavailableMessages[provider.availability]}</p><p>Checked {timeLabel(provider.checkedAt)} · Stripe API {provider.apiVersion}</p></div>;
}
function Comparison({ comparison }: { comparison: AdminInvoiceDetail["comparison"] | AdminSubscriptionVerification["comparison"] }) {
  return <p className="billing-comparison"><strong>{comparison.status === "matches" ? "Compared fields match." : comparison.status === "differences" ? "Compared fields differ." : "Provider comparison was not completed."}</strong>{comparison.fields.length > 0 && ` Differences: ${comparison.fields.map(field => fieldLabels[field]).join(", ")}.`}</p>;
}
function Money({ amount, currency }: { amount: string; currency: string }) {
  return <span className="billing-money" title={`${amount} ${currency.toUpperCase()} Stripe minor units`}>{formatBillingMoney(amount, currency)}</span>;
}

export function InvoiceRecords({ portfolio, canGet }: { portfolio: PortfolioClient; canGet: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const read = useCallback((search: string, offset: number, signal: AbortSignal) => portfolio.invoices({ search: search || undefined, offset, limit: 20, signal }), [portfolio]);
  return <>
    {selected && <InvoiceDetail key={selected} id={selected} portfolio={portfolio} onClose={() => setSelected(null)} />}
    <div className="billing-records-intro"><h2>Invoice history</h2><p>These invoices come from CareBase’s stored billing records. Open a record to request a current Stripe comparison. Amounts retain their original currency; unknown currency rules are shown as exact minor units.</p></div>
    <PagedRecords<AdminInvoice> app="CareBase" title="Stored invoices" searchLabel="Search provider invoice IDs" columns={["Organization", "Invoice", "Stored status", "Amount due", "Amount paid", "Remaining", "Issued", ...(canGet ? ["Details"] : [])]} read={read} render={row => <>
      <td>{row.organizationName ?? row.organizationId}</td><td>{row.providerInvoiceId}<small className="billing-record-updated">Updated {timeLabel(row.updatedAt)}</small></td><td>{row.status}</td>
      <td><Money amount={row.amountDueMinor} currency={row.currency} /></td><td><Money amount={row.amountPaidMinor} currency={row.currency} /></td><td><Money amount={row.amountRemainingMinor} currency={row.currency} /></td><td>{timeLabel(row.issuedAt)}</td>
      {canGet && <td><button type="button" className="button button-secondary button-small" onClick={() => setSelected(row.id)} aria-label={`Compare invoice ${row.providerInvoiceId}`}>View and compare</button></td>}
    </>} />
  </>;
}

export function InvoiceDetail({ id, portfolio, onClose }: { id: string; portfolio: PortfolioClient; onClose: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const reader = useCallback((signal: AbortSignal) => { void refresh; return portfolio.invoice({ id, signal }); }, [portfolio, id, refresh]);
  const state = useAdminRead(reader), retry = () => setRefresh(value => value + 1);
  return <DetailFrame title="Invoice comparison" onClose={onClose}>
    {state.status === "loading" && <Loading label="Loading invoice and checking Stripe" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
    {state.status === "ready" && <InvoiceComparison detail={state.data} retry={retry} />}
  </DetailFrame>;
}
function InvoiceComparison({ detail, retry }: { detail: AdminInvoiceDetail; retry: () => void }) {
  const { recorded, provider, comparison } = detail;
  const current = provider.availability === "available" ? provider.data : null;
  return <>
    <p><strong>{recorded.providerInvoiceId}</strong> · {recorded.organizationName ?? recorded.organizationId}</p>
    <p>Stored record updated {timeLabel(recorded.updatedAt)}. This comparison checks invoice status, currency, and amounts only.</p>
    <ProviderStatus provider={provider} /><Comparison comparison={comparison} />
    <div className="portfolio-table-wrap"><table className="billing-comparison-table"><thead><tr><th scope="col">Field</th><th scope="col">Stored in CareBase</th><th scope="col">Verified Stripe response</th></tr></thead><tbody>
      <tr><th scope="row">Invoice status</th><td>{recorded.status}</td><td>{current?.status ?? "Not checked"}</td></tr>
      <tr><th scope="row">Currency</th><td>{recorded.currency.toUpperCase()}</td><td>{current?.currency.toUpperCase() ?? "Not checked"}</td></tr>
      {(["amountDueMinor", "amountPaidMinor", "amountRemainingMinor"] as const).map(field => <tr key={field}><th scope="row">{fieldLabels[field]}</th><td><Money amount={recorded[field]} currency={recorded.currency} /></td><td>{current ? <Money amount={current[field]} currency={current.currency} /> : "Not checked"}</td></tr>)}
      <tr><th scope="row">Issued / created</th><td>{timeLabel(recorded.issuedAt)}</td><td>{current ? timeLabel(current.createdAt) : "Not checked"}</td></tr>
      <tr><th scope="row">Due</th><td>{timeLabel(recorded.dueAt)}</td><td>{current ? timeLabel(current.dueAt) : "Not checked"}</td></tr>
      <tr><th scope="row">Paid</th><td>{timeLabel(recorded.paidAt)}</td><td>{current ? timeLabel(current.paidAt) : "Not checked"}</td></tr>
    </tbody></table></div>
    {current && <p>Stripe mode: <strong>{current.livemode ? "Live" : "Test"}</strong>. Provider subscription: {current.subscriptionId ?? "None"}.</p>}
    <button type="button" className="button button-secondary button-small" onClick={retry}>Check Stripe again</button>
  </>;
}

export function SubscriptionVerification({ id, portfolio, onClose }: { id: string; portfolio: PortfolioClient; onClose: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const reader = useCallback((signal: AbortSignal) => { void refresh; return portfolio.verifySubscription({ id, signal }); }, [portfolio, id, refresh]);
  const state = useAdminRead(reader), retry = () => setRefresh(value => value + 1);
  return <DetailFrame title="Subscription verification" onClose={onClose}>
    {state.status === "loading" && <Loading label="Checking the linked Stripe subscription" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
    {state.status === "ready" && <SubscriptionComparison detail={state.data} retry={retry} />}
  </DetailFrame>;
}
function SubscriptionComparison({ detail, retry }: { detail: AdminSubscriptionVerification; retry: () => void }) {
  const { recorded, applicationAccess, provider, comparison } = detail;
  const current = provider.availability === "available" ? provider.data : null;
  return <>
    <p><strong>{recorded.organizationName ?? recorded.organizationId}</strong> · {recorded.providerSubscriptionId ?? "Provider subscription ID not recorded"}</p>
    <p>Stored subscription updated {timeLabel(recorded.updatedAt)}. This comparison checks the recorded provider status. Application access is shown separately because manual overrides and grace periods can differ from Stripe.</p>
    <ProviderStatus provider={provider} /><Comparison comparison={comparison} />
    <div className="portfolio-table-wrap"><table className="billing-comparison-table"><thead><tr><th scope="col">Field</th><th scope="col">Stored in CareBase</th><th scope="col">Verified Stripe response</th></tr></thead><tbody>
      <tr><th scope="row">Provider status</th><td>{recorded.providerStatus ?? "Not recorded"}</td><td>{current?.status ?? "Not checked"}</td></tr>
      <tr><th scope="row">Cancel at period end</th><td>Not reported</td><td>{current ? current.cancelAtPeriodEnd ? "Yes" : "No" : "Not checked"}</td></tr>
      <tr><th scope="row">Canceled at</th><td>Not reported</td><td>{current ? timeLabel(current.canceledAt) : "Not checked"}</td></tr>
    </tbody></table></div>
    <div className="billing-application-access"><h3>Application access stored in CareBase</h3><dl><div><dt>Billing account state</dt><dd>{applicationAccess.billingState}</dd></div><div><dt>State source</dt><dd>{applicationAccess.stateSource}</dd></div><div><dt>Complimentary access ends</dt><dd>{timeLabel(applicationAccess.compedUntil)}</dd></div><div><dt>Grace period ends</dt><dd>{timeLabel(applicationAccess.graceEndsAt)}</dd></div><div><dt>Account updated</dt><dd>{timeLabel(applicationAccess.updatedAt)}</dd></div></dl></div>
    {current && <p>Stripe mode: <strong>{current.livemode ? "Live" : "Test"}</strong>.</p>}
    <button type="button" className="button button-secondary button-small" onClick={retry}>Check Stripe again</button>
  </>;
}
