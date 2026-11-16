import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { prepareMutationRequest } from "../security/mutationRequestKey";
import type { PendingMutationRequest } from "../security/mutationRequestKey";
import { staffAccessClient } from "./staffAccessClient";
import type { StaffAccessClient } from "./staffAccessClient";
import type { StaffAccessContext, StaffAccessPreview, StaffAccessUnavailable } from "./staffAccessProtocol";
import { timeLabel } from "./readState";

const statusLabel = { active: "Active", invited: "Invited", locked: "Locked", revoked: "Revoked" } as const;
/** Breathe's reason a change is not offered, in the owner's words. */
const staffUnavailableText: Record<StaffAccessUnavailable, string> = {
  own_account: "This is your own Breathe sign-in. Ask another administrator.",
  protected_administrator: "Platform operator sign-ins can't be changed from the Hub.",
  unsupported_account: "This sign-in can only be changed in Breathe itself.",
  shared_identity: "This sign-in is also a shop, patient-portal or provider-portal login, so turning it off would end that login too. Change it in Breathe itself.",
  invited_account: "This invitation hasn't been accepted yet. Cancel it in Breathe instead.",
  no_change: "The sign-in is already in that state.",
  last_administrator: "This is the organization's last active admin. Make someone else an admin in Breathe first.",
  not_hub_deactivated: "Only a sign-in the Hub turned off, and not changed in Breathe since, can be turned back on here. Re-invite the person in Breathe instead.",
  unverified_email: "This sign-in's email was never verified, so it can't be turned back on. Re-invite the person in Breathe instead.",
};
function message(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "conflict") return "The sign-in changed in Breathe since it was loaded, or this review expired. Load it again and review a new change.";
  if (code === "invalid_request") return "Breathe does not allow this change for this sign-in now. Load it again to see why.";
  if (code === "notfound") return "Breathe no longer has this sign-in or review.";
  if (code === "401" || code === "403") return "Your Hub sign-in or Breathe administrator access could not be verified. Sign in again, then retry.";
  if (code === "unconfigured") return "Breathe staff changes are not switched on yet.";
  return "Breathe did not confirm the outcome. Check the saved review below before making another change.";
}

/**
 * Turn one Breathe staff sign-in off, as Breathe's own Team → Revoke does, or back on when the Hub turned it off. Breathe decides
 * what is offered and keeps every review and receipt; a review lasts five minutes, belongs to this sign-in, and is applied only
 * after an explicit confirmation. A lost answer is recovered from the saved review, never by sending another change.
 */
export function StaffAccessPanel({ userId, label, client = staffAccessClient, onClose, onApplied, onBusyChange }: {
  userId: string; label: string; client?: StaffAccessClient; onClose: () => void; onApplied: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const [context, setContext] = useState<StaffAccessContext | null>(null);
  const [preview, setPreview] = useState<StaffAccessPreview | null>(null);
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
    const result = await run(signal => client.request({ operation: "context", targetId: userId }, signal));
    if (result) setContext(result);
  }, [client, userId, run]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => { if (!preview) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [preview]);

  const target = context?.target ?? null;
  // A sign-in Breathe says is already off is offered turning back on; any other is offered turning off. Either way Breathe's reason
  // for not allowing it is shown instead of a form.
  const activate = target?.unavailable.deactivate === "no_change";
  const unavailable = target ? target.unavailable[activate ? "reactivate" : "deactivate"] : null;

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || unavailable) return;
    const why = reason.trim();
    // The same review is asked for again with the same request id, so Breathe returns it instead of saving a second one.
    pending.current = prepareMutationRequest(pending.current, [target.id, activate, why, target.revision]);
    const result = await run(signal => client.request({ operation: "preview", requestId: pending.current!.requestKey, targetId: target.id, action: "staff.setAccess",
      parameters: { active: activate }, expectedRevision: target.revision, reason: why }, signal));
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
  function settle(result: StaffAccessPreview) {
    setClock(Date.now()); setPreview(result); setConfirmed(false); setUncertain(false);
    if (result.result) { setDone(`${result.result.afterStatus === "revoked" ? "Turned off" : "Turned back on"} ${timeLabel(result.result.appliedAt)}. Breathe kept the receipt.`); onApplied(); }
    else if (!result.canApplyThisSession) setError("This review can no longer be applied: it expired, the sign-in changed, or it belongs to an earlier sign-in. Load it again for a new review.");
  }

  const expired = preview ? clock >= Date.parse(preview.expiresAt) : false;
  return <section className="panel access-command" aria-label="Review Breathe staff access change">
    <div className="panel-heading"><h2 ref={heading} tabIndex={-1}>Staff access · {label}</h2>
      <button type="button" className="button button-secondary button-small" onClick={onClose} disabled={busy || uncertain}>Close</button></div>
    <p>Turning a sign-in off is the same as Revoke on Breathe's Team page: the person is signed out everywhere and their staff seat is revoked. Only a sign-in the Hub turned off can be turned back on here, with the same password and without its old sessions. Breathe records the administrator, reason and before-and-after status.</p>
    {busy && !context && <p role="status">Loading the sign-in from Breathe…</p>}
    {target && <p>Current status: <strong>{statusLabel[target.status]}</strong>{target.seatStatus ? ` · staff seat ${target.seatStatus}` : ""}</p>}
    {done ? <p role="status">{done}</p> : preview && !preview.result ? <>
      <table><thead><tr><th>Setting</th><th>Current</th><th>Proposed</th></tr></thead><tbody><tr><td>Sign-in</td><td>{statusLabel[preview.before.status]}</td><td>{statusLabel[preview.after.status]}</td></tr></tbody></table>
      <p>Reason: {preview.reason}. Review expires {timeLabel(preview.expiresAt)}.</p>
      <label><input type="checkbox" checked={confirmed} disabled={busy || !preview.canApplyThisSession || expired} onChange={event => setConfirmed(event.target.checked)} />I reviewed this exact change.</label>
      <button type="button" className="button button-primary" disabled={busy || !confirmed || !preview.canApplyThisSession || expired} onClick={() => void apply()}>{busy ? "Waiting for Breathe…" : "Apply reviewed change"}</button>
      {expired && <p>This review expired. <button type="button" className="button button-secondary button-small" onClick={() => void load()}>Load the sign-in again</button></p>}
      {uncertain && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void check(preview.requestId)}>Check saved result</button>}
    </> : target && (unavailable ? <p>{staffUnavailableText[unavailable]}</p> : <form onSubmit={event => void review(event)}>
      <p>Proposed change: <strong>{activate ? "Turn this sign-in back on" : "Turn this sign-in off and sign the person out"}</strong></p>
      <label>Reason<input required minLength={10} maxLength={500} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} placeholder="Describe the administrative reason" /></label>
      <button type="submit" className="button button-secondary" disabled={busy || reason.trim().length < 10}>{busy ? "Preparing review…" : "Review change"}</button>
    </form>)}
    {context && context.requests.length > 0 && <details><summary>Your saved reviews for this sign-in ({context.requests.length})</summary><ul>
      {context.requests.map(item => <li key={item.requestId}>{item.parameters.active ? "Turn on" : "Turn off"} · {timeLabel(item.createdAt)} · {item.result ? `applied ${timeLabel(item.result.appliedAt)}` : item.canApplyThisSession ? "not applied yet" : "not applied, closed"}
        {!item.result && <> <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void check(item.requestId)}>Check</button></>}</li>)}
    </ul></details>}
    {error && <p role="alert">{error}</p>}
    {!done && !busy && error && !uncertain && <button type="button" className="button button-secondary button-small" onClick={() => void load()}>Load the sign-in again</button>}
  </section>;
}
