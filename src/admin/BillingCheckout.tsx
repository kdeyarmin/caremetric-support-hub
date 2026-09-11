import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { checkoutResultMetadata, parseCheckoutUrl } from "../../supabase/functions/_shared/checkoutCommandProtocol";
import type { CheckoutIntent, CheckoutPreviewRequest } from "../../supabase/functions/_shared/checkoutCommandProtocol";
import type { BillingPackageChoice } from "../../supabase/functions/_shared/checkoutCatalogProtocol";
import { checkoutCommandClient } from "./checkoutCommandClient";
import type { CheckoutCommandClient } from "./checkoutCommandClient";
import type { BillingPortalTarget } from "./BillingPortal";
import { PagedRecords } from "./PagedRecords";
import { formatBillingMoney } from "./billingMoney";
import { timeLabel } from "./readState";

const checkoutCadence = (interval: "month" | "year", count: number) => `Every ${count} ${interval}${count === 1 ? "" : "s"}`;
const navigateToCheckout = (url: string) => window.location.assign(url);
function failure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["401", "403", "unauthenticated", "forbidden"].includes(code)) return "Current administrator access could not be verified. Sign in with an SMS code before continuing.";
  if (code === "conflict") return "CareBase could not accept this observation. Recover the same review and check its current state before starting another checkout.";
  if (code === "invalid_request") return "Check the selected native plan and administrative reason.";
  return "Checkout is unconfirmed or unavailable. Keep this request identity and check its status. Provider configuration or connectivity may be unavailable.";
}
export function BillingCheckout({ target, client = checkoutCommandClient, onClose, navigate = navigateToCheckout }: {
  target: BillingPortalTarget; client?: CheckoutCommandClient; onClose: () => void; navigate?: (url: string) => void;
}) {
  const [intent, setIntent] = useState<CheckoutIntent | null>(null);
  const [request, setRequest] = useState<CheckoutPreviewRequest | null>(null);
  const [choice, setChoice] = useState<BillingPackageChoice | null>(null);
  const [reason, setReason] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [started, setStarted] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [retryAt, setRetryAt] = useState(0);
  const [reload, setReload] = useState(0);
  const controller = useRef(new AbortController());
  const inFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const readPackages = useCallback((search: string, offset: number, signal: AbortSignal) => client.packages(search, offset, signal), [client]);
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    let active = true;
    client.resume(target.id, current.signal).then(saved => {
      if (!active) return;
      setIntent(saved); setRequest(saved?.request ?? null); setReason(saved?.request.reason ?? "");
      setStarted(saved?.dispatchedAt !== null && saved?.dispatchedAt !== undefined);
      setRetryAt(saved?.retryAt ? Date.parse(saved.retryAt) : 0); setConfirmed(false); setReady(true); setError("");
    }).catch(caught => { if (active) { setReady(false); setError(failure(caught)); } });
    return () => { active = false; current.abort(); };
  }, [client, target.id, reload]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { heading.current?.focus(); }, [intent?.preview?.commandId, intent?.result?.outcome]);
  const preview = intent?.preview ?? null, result = intent?.result ?? null;
  const expired = preview ? now >= Date.parse(preview.expiresAt) : !!intent && now >= Date.parse(intent.createdAt) + 360000;
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const canStartNew = result?.canStartNewCheckout === true || expired && !started;

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !request && (!choice || choice.availability !== "mapped")) return;
    inFlight.current = true; const signal = controller.current.signal;
    setBusy(true); setError("");
    const original = request ?? { operation: "preview" as const, requestId: crypto.randomUUID(), action: "billing.checkout.create" as const,
      targetId: target.id, parameters: { packageId: choice!.packageId, billingInterval: choice!.billingInterval }, reason: reason.trim() };
    setRequest(original);
    try {
      const saved = await client.preview(original, signal);
      if (!signal.aborted) { setIntent(saved); setConfirmed(false); }
    } catch (caught) { if (!signal.aborted) setError(failure(caught)); }
    finally { inFlight.current = false; if (!signal.aborted) setBusy(false); }
  }
  async function observe(kind: "apply" | "check", open = false) {
    if (!preview || inFlight.current || kind === "check" && !started) return;
    inFlight.current = true; const signal = controller.current.signal;
    setBusy(true); setError(""); if (kind === "apply") setStarted(true);
    try {
      const identity = { action: "billing.checkout.create" as const, commandId: preview.commandId, expectedDigest: preview.previewDigest };
      const response = kind === "check" ? await client.check({ ...identity, operation: "check" }, preview, signal)
        : await client.apply({ ...identity, operation: "apply" }, preview, signal);
      if (signal.aborted) return;
      const nextRetry = response.outcome === "pending" ? Date.now() + 30000 : 0;
      setRetryAt(nextRetry); setNow(Date.now());
      setIntent(value => value ? { ...value, result: checkoutResultMetadata(response), dispatchedAt: value.dispatchedAt ?? new Date().toISOString(),
        retryAt: nextRetry ? new Date(nextRetry).toISOString() : null } : value);
      // Opening uses check only. The provider URL is never cached in React state,
      // a reusable href, local storage, or session storage.
      if (open && response.outcome === "open" && response.session && Date.parse(response.session.expiresAt) > Date.now()) {
        navigate(parseCheckoutUrl(response.session.url, response.session.id));
      }
    } catch (caught) { if (!signal.aborted) { setError(failure(caught)); setRetryAt(Date.now() + 30000); } }
    finally { inFlight.current = false; if (!signal.aborted) setBusy(false); }
  }
  async function discard() {
    if (!intent || intent.previewDispatchedAt !== null || intent.dispatchedAt !== null || inFlight.current) return;
    inFlight.current = true; const signal = controller.current.signal; setBusy(true); setError("");
    try {
      await client.discard(intent.request.requestId, signal);
      if (!signal.aborted) { setIntent(null); setRequest(null); setReason(""); setChoice(null); }
    } catch (caught) { if (!signal.aborted) setError(failure(caught)); }
    finally { inFlight.current = false; if (!signal.aborted) setBusy(false); }
  }
  function newReview() { setIntent(null); setRequest(null); setReason(""); setChoice(null); setStarted(false); setConfirmed(false); setRetryAt(0); setError(""); }
  return <section className="panel access-command" aria-label="Review subscription checkout">
    <div className="panel-heading"><h2 ref={heading} tabIndex={-1}>Subscription checkout · {target.label}</h2><button type="button" className="button button-secondary button-small" disabled={busy} onClick={onClose}>Close</button></div>
    <p>Choose a native CareBase plan and review a Stripe subscription checkout. Recorded catalog amounts are a reference; confirm the final price, trial terms and taxes in Stripe before subscribing.</p>
    {!ready ? <><p role="status">{error ? "Saved checkout review could not be loaded." : "Checking for a saved checkout review…"}</p>{error && <button type="button" className="button button-secondary" onClick={() => setReload(value => value + 1)}>Recover checkout review</button>}</>
      : preview ? <>
        <dl><dt>Organization</dt><dd>{preview.summary.organizationName}</dd><dt>Native package</dt><dd>{preview.summary.packageId}</dd><dt>Stripe price</dt><dd>{preview.summary.providerPriceId}</dd><dt>Cadence</dt><dd>{checkoutCadence(preview.summary.billingInterval, preview.summary.intervalCount)}</dd><dt>Currency</dt><dd>{preview.summary.currency.toUpperCase()}</dd><dt>Quantity and billing metric</dt><dd>{preview.summary.quantity} · {preview.summary.billingMetric.replaceAll("_", " ")}</dd><dt>Trial</dt><dd>{preview.summary.trialDays} days</dd><dt>Existing Stripe customer</dt><dd>{preview.summary.providerCustomerId ?? "No customer mapping recorded"}</dd><dt>Reason</dt><dd>{preview.reason}</dd></dl>
        {!started ? <><p>Review expires {timeLabel(preview.expiresAt)}.</p><label><input type="checkbox" checked={confirmed} disabled={busy || expired} onChange={event => setConfirmed(event.target.checked)} />I reviewed this organization, native price, cadence, quantity and trial, and authorize creating its subscription checkout.</label><button type="button" className="button button-primary" disabled={busy || !confirmed || expired} onClick={() => void observe("apply")}>{busy ? "Creating reviewed checkout…" : "Create reviewed checkout"}</button>{expired && <p role="status">This preview expired before an apply request was dispatched.</p>}</>
          : <>
            <p role="status">{result ? `Native checkout status: ${result.outcome}. Observation ${result.availability}; last checked ${timeLabel(result.checkedAt)}.` : "The original checkout result is unconfirmed."}</p>
            {result?.outcome === "complete" && <p>Checkout is complete. CareBase handles payment settlement and application access updates.</p>}
            {result?.outcome === "open" && result.session && <><p>{result.session.livemode ? "Live" : "Test"} checkout · expires {timeLabel(result.session.expiresAt)}. Opening checks the current provider session again.</p><button type="button" className="button button-primary" disabled={busy || remaining > 0} onClick={() => void observe("check", true)}>Open Stripe checkout</button></>}
            <button type="button" className="button button-secondary" disabled={busy || remaining > 0} onClick={() => void observe("check")}>{busy ? "Checking checkout…" : remaining > 0 ? `Check available in ${remaining}s` : "Check checkout status"}</button><p>A status check retrieves native/provider evidence and cannot create a checkout session.</p>
            {(!result || result.outcome === "pending") && <><button type="button" className="button button-secondary" disabled={busy || remaining > 0} onClick={() => void observe("apply")}>Retry original creation</button><p>This uses the same reviewed command and provider reservation. A missing response never selects a new key or plan automatically.</p></>}
            {result && !result.canStartNewCheckout && <p>CareBase has not released this organization for a new checkout. Continue checking this same review.</p>}
          </>}
      </> : <>
        {!request && <><p>CareBase application database · provider prices not checked. Amounts below preserve the recorded currency and minor units; pricing models and included quantities may affect the final charge.</p><PagedRecords<BillingPackageChoice> app="CareBase" title="Native subscription plans" searchLabel="Search native plan names" columns={["Plan", "Recorded amounts", "Cadence", "Mapping", "Choice"]} read={readPackages} render={row => <><td><strong>{row.name}</strong><p>{row.description}</p><small>{row.pricingModel.replaceAll("_", " ")} · {row.billingMetric.replaceAll("_", " ")}</small></td><td><div>Base: {formatBillingMoney(row.baseAmountMinor, row.currency)}</div><div>Unit: {row.unitAmountMinor === null ? "Not recorded" : formatBillingMoney(row.unitAmountMinor, row.currency)}</div><small>Included {row.includedQuantity}; minimum {row.minimumQuantity}{row.maximumQuantity === null ? "" : `; maximum ${row.maximumQuantity}`}</small></td><td>{checkoutCadence(row.billingInterval, row.intervalCount)}<div>{row.trialDays} trial days</div></td><td>{row.availability === "mapped" ? row.providerPriceId : "Provider price not mapped"}</td><td><button type="button" className="button button-secondary button-small" disabled={busy || row.availability !== "mapped"} aria-pressed={choice?.id === row.id} onClick={() => setChoice(row)}>Choose {row.name} · {checkoutCadence(row.billingInterval, row.intervalCount)}</button></td></>} /></>}
        <form onSubmit={event => void prepare(event)}>{request ? <p>Saved selection: {request.parameters.packageId} · {request.parameters.billingInterval}. The original request identity is preserved.</p> : choice && <p>Selected: {choice.name} · {checkoutCadence(choice.billingInterval, choice.intervalCount)} · {choice.currency.toUpperCase()}.</p>}<label>Administrative reason<input required minLength={10} maxLength={500} value={reason} disabled={busy || request !== null} onChange={event => setReason(event.target.value)} /></label><button type="submit" className="button button-secondary" disabled={busy || reason.trim().length < 10 || !request && !choice}>{busy ? "Preparing checkout preview…" : request ? "Retry same checkout preview" : "Preview subscription checkout"}</button></form>
      </>}
    {ready && intent && intent.previewDispatchedAt === null && intent.dispatchedAt === null && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void discard()}>Discard undispatched checkout review</button>}
    {ready && canStartNew && <button type="button" className="button button-secondary" disabled={busy} onClick={newReview}>Review another checkout</button>}
    {error && <p role="alert">{error}</p>}{ready && error && <button type="button" className="button button-secondary" disabled={busy} onClick={() => { setReady(false); setReload(value => value + 1); }}>Recover saved checkout review</button>}
    {ready && <p className="admin-explanation">Closing preserves this checkout review for the current SMS session. CareBase remains the owner of subscriptions, payment events and access.</p>}
  </section>;
}
