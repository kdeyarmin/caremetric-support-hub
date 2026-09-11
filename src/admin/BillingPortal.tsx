import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { billingPortalUrlSchema, billingResultMetadata } from "../../supabase/functions/_shared/billingCommandProtocol";
import type { BillingIntent, BillingPreviewRequest } from "../../supabase/functions/_shared/billingCommandProtocol";
import { billingCommandClient } from "./billingCommandClient";
import type { BillingCommandClient } from "./billingCommandClient";
import { timeLabel } from "./readState";

export interface BillingPortalTarget { id: string; label: string; }
const navigateToPortal = (url: string) => window.location.assign(url);
function failure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["401", "403", "unauthenticated", "forbidden"].includes(code)) return "Current administrator access could not be verified. Sign in with an SMS code before continuing.";
  if (code === "conflict") return "The native account, configuration or review changed. Recover the saved review and inspect its state before starting another.";
  if (code === "invalid_request") return "Check the organization and administrative reason.";
  if (code === "unconfigured") return "CareBase has not enabled or configured billing portal commands.";
  return "The result is unconfirmed. Resume this same request; do not create a replacement while it is pending. Provider configuration or connectivity may be unavailable.";
}

export function BillingPortal({ target, client = billingCommandClient, onClose, navigate = navigateToPortal }: {
  target: BillingPortalTarget; client?: BillingCommandClient; onClose: () => void; navigate?: (url: string) => void;
}) {
  const [intent, setIntent] = useState<BillingIntent | null>(null);
  const [request, setRequest] = useState<BillingPreviewRequest | null>(null);
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
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    let active = true;
    client.resume(target.id, current.signal).then(saved => {
      if (!active) return;
      setIntent(saved); setRequest(saved?.request ?? null); setReason(saved?.request.reason ?? "");
      setStarted(saved?.dispatchedAt !== null && saved?.dispatchedAt !== undefined);
      setRetryAt(saved?.retryAt ? Date.parse(saved.retryAt) : 0); setReady(true); setError("");
    }).catch(caught => { if (active) { setReady(false); setError(failure(caught)); } });
    return () => { active = false; current.abort(); };
  }, [client, target.id, reload]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { heading.current?.focus(); }, [intent?.preview?.commandId, intent?.result?.outcome]);
  const preview = intent?.preview ?? null;
  const result = intent?.result ?? null;
  const expired = preview ? now >= Date.parse(preview.expiresAt) : !!intent && now >= Date.parse(intent.createdAt) + 360000;
  const canStartNew = result?.outcome === "created" || result?.outcome === "failed" || expired && !started;
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));

  async function prepare(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    const signal = controller.current.signal;
    setBusy(true); setError("");
    const original = request ?? { operation: "preview" as const, requestId: crypto.randomUUID(), action: "billing.portal.create" as const,
      targetId: target.id, parameters: {}, reason: reason.trim() };
    setRequest(original);
    try {
      const saved = await client.preview(original, signal);
      if (!signal.aborted) { setIntent(saved); setConfirmed(false); }
    } catch (caught) { if (!signal.aborted) setError(failure(caught)); }
    finally { inFlight.current = false; if (!signal.aborted) setBusy(false); }
  }
  async function apply(open = false) {
    if (!preview || inFlight.current) return;
    inFlight.current = true;
    const signal = controller.current.signal;
    setBusy(true); setError(""); setStarted(true);
    try {
      const response = await client.apply({ operation: "apply", commandId: preview.commandId, expectedDigest: preview.previewDigest }, preview, signal);
      if (signal.aborted) return;
      const nextRetry = response.outcome === "pending" ? Date.now() + response.retryAfterSeconds * 1000 : 0;
      setRetryAt(nextRetry); setNow(Date.now());
      setIntent(value => value ? { ...value, result: billingResultMetadata(response), dispatchedAt: value.dispatchedAt ?? new Date().toISOString(), retryAt: nextRetry ? new Date(nextRetry).toISOString() : null } : value);
      // Same-tab navigation follows a fresh, bound native replay. No URL is
      // cached in component state, local/session storage, or a reusable href.
      if (open && response.outcome === "created") navigate(billingPortalUrlSchema.parse(response.session.url));
    } catch (caught) {
      if (!signal.aborted) { setError(failure(caught)); setRetryAt(Date.now() + 30000); }
    } finally { inFlight.current = false; if (!signal.aborted) setBusy(false); }
  }
  async function discard() {
    if (!intent || intent.previewDispatchedAt !== null || intent.dispatchedAt !== null || inFlight.current) return;
    inFlight.current = true;
    const signal = controller.current.signal;
    setBusy(true); setError("");
    try {
      await client.discard(intent.request.requestId, signal);
      if (!signal.aborted) { setIntent(null); setRequest(null); setReason(""); }
    } catch (caught) { if (!signal.aborted) setError(failure(caught)); }
    finally { inFlight.current = false; if (!signal.aborted) setBusy(false); }
  }
  function newReview() { setIntent(null); setRequest(null); setReason(""); setStarted(false); setConfirmed(false); setRetryAt(0); setError(""); }
  return <section className="panel access-command" aria-label="Review Stripe billing portal">
    <div className="panel-heading"><h2 ref={heading} tabIndex={-1}>Billing portal · {target.label}</h2><button type="button" className="button button-secondary button-small" onClick={onClose} disabled={busy}>Close</button></div>
    <p>This creates access to the organization’s Stripe billing portal. The options available there come from CareBase’s provider configuration and may allow billing changes. This preview does not enumerate those options.</p>
    {!ready ? <><p role="status">{error ? "Saved review could not be loaded." : "Checking for a saved review…"}</p>{error && <button type="button" className="button button-secondary" onClick={() => setReload(value => value + 1)}>Recover saved review</button>}</> : preview ? <>
      <dl><dt>Organization</dt><dd>{preview.summary.organizationName}</dd><dt>Stripe customer</dt><dd>{preview.summary.providerCustomerId}</dd><dt>Stripe configuration</dt><dd>{preview.summary.providerConfigurationId}</dd><dt>Return destination</dt><dd>CareBase administration ({preview.summary.returnPath})</dd><dt>Reason</dt><dd>{preview.reason}</dd></dl>
      {!started && <p>Review expires {timeLabel(preview.expiresAt)}.</p>}
      {result?.outcome === "created" ? <><p role="status">Portal session created {timeLabel(result.completedAt)}{result.replayed ? " · previously completed request" : ""}. {result.session.livemode ? "Live Stripe session." : "Test Stripe session."}</p><p>Link expiry is not reported. Opening rechecks current access and retrieves the same recorded session; Stripe may reject an expired link.</p><button type="button" className="button button-primary" disabled={busy} onClick={() => void apply(true)}>{busy ? "Checking current access…" : "Open Stripe portal"}</button></>
        : result?.outcome === "failed" ? <p role="status">The provider request failed. No portal link is available for this command.</p>
          : started ? <><p role="status">{result?.outcome === "pending" ? "Portal creation is pending." : "The command result is unconfirmed."} Retry the same command to recover its outcome.</p><button type="button" className="button button-primary" disabled={busy || remaining > 0} onClick={() => void apply()}>{busy ? "Checking recorded result…" : remaining > 0 ? `Retry available in ${remaining}s` : "Retry same command"}</button></>
            : <><label><input type="checkbox" checked={confirmed} disabled={busy || expired} onChange={event => setConfirmed(event.target.checked)} />I reviewed this organization and provider configuration and authorize creation of its billing portal session.</label><button type="button" className="button button-primary" disabled={busy || !confirmed || expired} onClick={() => void apply()}>{busy ? "Creating portal session…" : "Create reviewed portal session"}</button>{expired && <p role="status">This preview expired before a command was dispatched.</p>}</>}
    </> : <form onSubmit={event => void prepare(event)}><label>Administrative reason<input required minLength={10} maxLength={500} value={reason} disabled={busy || request !== null} onChange={event => setReason(event.target.value)} /></label>{request && <p>The original request identity is preserved. Retrying requests the same native preview.</p>}<button type="submit" className="button button-secondary" disabled={busy || reason.trim().length < 10}>{busy ? "Preparing preview…" : request ? "Retry same preview" : "Preview billing portal"}</button></form>}
    {intent && intent.previewDispatchedAt === null && intent.dispatchedAt === null && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void discard()}>Discard undispatched review</button>}
    {canStartNew && <button type="button" className="button button-secondary" disabled={busy} onClick={newReview}>Review a new portal session</button>}
    {error && <p role="alert">{error}</p>}
    {ready && <p className="admin-explanation">Closing preserves a dispatched review for this SMS session. A pending command never creates a replacement automatically.</p>}
  </section>;
}
