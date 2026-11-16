import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { prepareMutationRequest } from "../security/mutationRequestKey";
import type { PendingMutationRequest } from "../security/mutationRequestKey";
import { tenantLifecycleClient } from "./tenantLifecycleClient";
import type { TenantLifecycleClient } from "./tenantLifecycleClient";
import type { TenantLifecycleContext, TenantLifecyclePreview } from "./tenantLifecycleProtocol";
import { timeLabel } from "./readState";

const statusLabel = { active: "Active", suspended: "Suspended", archived: "Archived" } as const;
function message(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "conflict") return "The organization changed in Breathe since it was loaded, or this review expired. Load it again and review a new change.";
  if (code === "invalid_request") return "Breathe does not allow this change for this organization. Load it again to see its current state.";
  if (code === "notfound") return "Breathe no longer has this organization or review.";
  if (code === "401" || code === "403") return "Your Hub sign-in or Breathe administrator access could not be verified. Sign in again, then retry.";
  if (code === "unconfigured") return "Breathe organization changes are not switched on yet.";
  return "Breathe did not confirm the outcome. Check the saved review below before making another change.";
}

/**
 * Suspend or restore one Breathe organization. Breathe keeps every review and its receipt; a review lasts five minutes, belongs to
 * this sign-in, and is applied only after an explicit confirmation. A lost answer is recovered from the saved review, never by
 * sending another change.
 */
export function TenantLifecyclePanel({ organizationId, label, client = tenantLifecycleClient, onClose, onApplied, onBusyChange }: {
  organizationId: string; label: string; client?: TenantLifecycleClient; onClose: () => void; onApplied: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const [context, setContext] = useState<TenantLifecycleContext | null>(null);
  const [preview, setPreview] = useState<TenantLifecyclePreview | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [clock, setClock] = useState(Date.now);
  const pending = useRef<PendingMutationRequest | null>(null);
  const controller = useRef(new AbortController());
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { const current = new AbortController(); controller.current = current; return () => current.abort(); }, []);
  useEffect(() => { onBusyChange?.(busy || uncertain); }, [busy, uncertain, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => { heading.current?.focus(); }, [preview, done]);

  const run = useCallback(async <T,>(work: (signal: AbortSignal) => Promise<T>, onError?: () => void): Promise<T | null> => {
    setBusy(true); setError("");
    try { return await work(controller.current.signal); }
    catch (caught) { if (!controller.current.signal.aborted) { setError(message(caught)); onError?.(); } return null; }
    finally { if (!controller.current.signal.aborted) setBusy(false); }
  }, []);
  const load = useCallback(async () => {
    setPreview(null); setConfirmed(false); setDone("");
    const result = await run(signal => client.request({ operation: "context", targetId: organizationId }, signal));
    if (result) setContext(result);
  }, [client, organizationId, run]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => { if (!preview) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [preview]);

  const target = context?.target ?? null;
  const suspend = target?.status === "active";
  const unavailable = !target ? null : target.status === "archived" ? "Archived organizations can only be changed in Breathe itself."
    : suspend && target.seedProtected ? "Breathe's own home organization cannot be suspended." : null;

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || unavailable) return;
    const why = reason.trim();
    // The same review is asked for again with the same request id, so Breathe returns it instead of saving a second one.
    pending.current = prepareMutationRequest(pending.current, [target.id, suspend, why, target.revision]);
    const result = await run(signal => client.request({ operation: "preview", requestId: pending.current!.requestKey, targetId: target.id, action: "organizations.setSuspension",
      parameters: { suspended: suspend }, expectedRevision: target.revision, reason: why }, signal));
    if (result) { setClock(Date.now()); setPreview(result); setConfirmed(false); pending.current = null; }
  }
  async function apply() {
    if (!preview || !confirmed) return;
    const result = await run(signal => client.request({ operation: "apply", commandId: preview.commandId, expectedDigest: preview.previewDigest }, signal), () => setUncertain(true));
    if (result) settle(result);
  }
  async function check(requestId: string) {
    const result = await run(signal => client.request({ operation: "resume", requestId }, signal));
    if (result) settle(result);
  }
  function settle(result: TenantLifecyclePreview) {
    setClock(Date.now()); setPreview(result); setConfirmed(false); setUncertain(false);
    if (result.result) { setDone(`${result.result.afterStatus === "suspended" ? "Suspended" : "Restored"} ${timeLabel(result.result.appliedAt)}. Breathe kept the receipt.`); onApplied(); }
    else if (!result.canApplyThisSession) setError("This review can no longer be applied: it expired, the organization changed, or it belongs to an earlier sign-in. Load the organization again for a new review.");
  }

  const expired = preview ? clock >= Date.parse(preview.expiresAt) : false;
  return <section className="panel access-command" aria-label="Review Breathe organization change">
    <div className="panel-heading"><h2 ref={heading} tabIndex={-1}>Organization access · {label}</h2>
      <button type="button" className="button button-secondary button-small" onClick={onClose} disabled={busy || uncertain}>Close</button></div>
    <p>Suspending stops the organization in Breathe: its storefront and its scheduled work. Staff stay signed in until they are signed out in Breathe. Breathe records the administrator, reason and before-and-after status.</p>
    {busy && !context && <p role="status">Loading the organization from Breathe…</p>}
    {target && <p>Current status: <strong>{statusLabel[target.status]}</strong>{target.updatedAt ? ` · changed ${timeLabel(target.updatedAt)}` : ""}</p>}
    {done ? <p role="status">{done}</p> : preview && !preview.result ? <>
      <table><thead><tr><th>Setting</th><th>Current</th><th>Proposed</th></tr></thead><tbody><tr><td>Status</td><td>{statusLabel[preview.before.status]}</td><td>{statusLabel[preview.after.status]}</td></tr></tbody></table>
      <p>Reason: {preview.reason}. Review expires {timeLabel(preview.expiresAt)}.</p>
      <label><input type="checkbox" checked={confirmed} disabled={busy || !preview.canApplyThisSession || expired} onChange={event => setConfirmed(event.target.checked)} />I reviewed this exact change.</label>
      <button type="button" className="button button-primary" disabled={busy || !confirmed || !preview.canApplyThisSession || expired} onClick={() => void apply()}>{busy ? "Waiting for Breathe…" : "Apply reviewed change"}</button>
      {expired && <p>This review expired. <button type="button" className="button button-secondary button-small" onClick={() => void load()}>Load the organization again</button></p>}
      {uncertain && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void check(preview.requestId)}>Check saved result</button>}
    </> : target && (unavailable ? <p>{unavailable}</p> : <form onSubmit={event => void review(event)}>
      <p>Proposed change: <strong>{suspend ? "Suspend this organization" : "Restore this organization"}</strong></p>
      <label>Reason<input required minLength={10} maxLength={500} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} placeholder="Describe the administrative reason" /></label>
      <button type="submit" className="button button-secondary" disabled={busy || reason.trim().length < 10}>{busy ? "Preparing review…" : "Review change"}</button>
    </form>)}
    {context && context.requests.length > 0 && <details><summary>Your saved reviews for this organization ({context.requests.length})</summary><ul>
      {context.requests.map(item => <li key={item.requestId}>{item.parameters.suspended ? "Suspend" : "Restore"} · {timeLabel(item.createdAt)} · {item.result ? `applied ${timeLabel(item.result.appliedAt)}` : item.canApplyThisSession ? "not applied yet" : "not applied, closed"}
        {!item.result && <> <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void check(item.requestId)}>Check</button></>}</li>)}
    </ul></details>}
    {error && <p role="alert">{error}</p>}
    {!done && !busy && error && !uncertain && <button type="button" className="button button-secondary button-small" onClick={() => void load()}>Load the organization again</button>}
  </section>;
}
