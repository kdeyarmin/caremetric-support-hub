import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AppCommandProduct, CommandAction, CommandParameters, CommandPreview } from "../../supabase/functions/_shared/adminCommandProtocol";
import { prepareMutationRequest } from "../security/mutationRequestKey";
import type { PendingMutationRequest } from "../security/mutationRequestKey";
import { commandClient } from "./commandClient";
import type { CommandClient } from "./commandClient";
import { timeLabel } from "./readState";

export interface AccessTarget { id: string; label: string; action: CommandAction; }
const applicationName: Record<AppCommandProduct, string> = { carebase: "CareBase", intel: "CareMetric Intel" };
/** An Intel organization's status as Intel stores it (billing's, or `disabled` while CareMetric has it suspended), in words. */
const intelOrganizationStatuses: Record<string, string> = {
  payment_required: "Awaiting payment details", trial: "Trial", active: "Active", past_due: "Past due", canceled: "Canceled", disabled: "Suspended",
};
/** How an application's organization status reads in the Hub. Unknown values are shown as sent. */
export function organizationStatusLabel(product: string, status: string | null): string | null {
  return product === "intel" && status !== null ? intelOrganizationStatuses[status] ?? status : status;
}
const fieldLabels = { active: "Profile active", status: "Status", billingState: "Access state", stateSource: "Access source", compedUntil: "Complimentary access ends" };
function message(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "conflict") return "The underlying record changed. Close this review, refresh the records, and preview a new change.";
  if (code === "expired") return "This preview expired. Close it and request a new preview.";
  if (code === "401" || code === "unauthenticated" || code === "403" || code === "forbidden") return "Current administrator access could not be verified. Sign in again and retry.";
  if (code === "invalid_request") return "Check the selected change and reason before retrying.";
  // The application refused the change for a reason it names; the Hub server words it (server/admin-transport.mjs).
  if (code === "refused") return error && typeof error === "object" && "detail" in error && typeof error.detail === "string" && error.detail ? error.detail : "The application refused this change.";
  if (code === "unconfigured") return "Application access controls are not enabled for this connection.";
  return "The result could not be confirmed. Retry this same request to check its recorded outcome; do not create a replacement change.";
}

/** Preview and apply remain distinct user actions; an ambiguous retry retains its key. */
export function AccessCommand({ target, product = "carebase", client = commandClient, onClose, onApplied, onBusyChange }: { target: AccessTarget; product?: AppCommandProduct; client?: CommandClient; onClose: () => void; onApplied: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const intelOrganization = product === "intel" && target.action === "organizations.setSuspension";
  const shown = (field: string, value: string | null) => intelOrganization && field === "status" ? organizationStatusLabel(product, value) : value;
  const pending = useRef<PendingMutationRequest | null>(null);
  const controller = useRef(new AbortController());
  useEffect(() => { const current = new AbortController(); controller.current = current; return () => current.abort(); }, []);
  useEffect(() => { heading.current?.focus(); }, [preview, completed]);
  // The table keeps every other "Change access" button disabled while a change is in flight, so its outcome is never discarded.
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  async function createPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      let parameters: CommandParameters;
      if (target.action === "users.setActive") parameters = { active: value === "active" };
      else parameters = { suspended: value === "suspended" };
      pending.current = prepareMutationRequest(pending.current, [target.action, target.id, JSON.stringify(parameters), reason.trim()]);
      const result = await client.preview({ operation: "preview", requestId: pending.current.requestKey, action: target.action, targetId: target.id, parameters, reason: reason.trim() }, controller.current.signal, product);
      if (!controller.current.signal.aborted) setPreview(result);
    } catch (caught) { if (!controller.current.signal.aborted) setError(message(caught)); }
    finally { if (!controller.current.signal.aborted) setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const result = await client.apply({ operation: "apply", commandId: preview.commandId, expectedDigest: preview.previewDigest }, preview, controller.current.signal, product);
      if (!controller.current.signal.aborted) { setCompleted(`Change recorded ${timeLabel(result.appliedAt)}${result.replayed ? " · previously completed request" : ""}.`); onApplied(); }
    } catch (caught) { if (!controller.current.signal.aborted) setError(message(caught)); }
    finally { if (!controller.current.signal.aborted) setBusy(false); }
  }
  return <section className="panel access-command" aria-label="Review application access change"><div className="panel-heading"><h2 ref={heading} tabIndex={-1}>Change access · {target.label}</h2><button type="button" className="button button-secondary button-small" onClick={onClose} disabled={busy}>Close</button></div><p>{applicationName[product]} records the administrator, reason, and exact before-and-after values. These controls change application access; subscriptions and charges are managed in the Hub's Billing workspace.</p>
    {completed ? <p role="status">{completed}</p> : preview ? <><p>Review expires {timeLabel(preview.expiresAt)}. Reason: {preview.reason}</p>{intelOrganization && <p>A suspended organization's members keep their sign-ins but can open only Billing, and are told to contact CareMetric. Restoring it has Intel check its billing with the Hub again.</p>}<table><thead><tr><th>Setting</th><th>Current</th><th>Proposed</th></tr></thead><tbody>{preview.changes.map(change => <tr key={change.field}><td>{fieldLabels[change.field]}</td><td>{shown(change.field, change.before) ?? "Not set"}</td><td>{shown(change.field, change.after) ?? "Not set"}</td></tr>)}</tbody></table>{preview.changes.length === 0 && <p>The requested values already match the current record.</p>}<button type="button" className="button button-primary" disabled={busy} onClick={() => void apply()}>{busy ? "Checking recorded result…" : "Apply previewed change"}</button></> : <form onSubmit={event => void createPreview(event)}><label>Desired access<select required disabled={busy} value={value} onChange={event => setValue(event.target.value)}><option value="">Select a change</option>{target.action === "users.setActive" ? product === "intel" ? <><option value="active">Turn the account back on</option><option value="inactive">Turn the account off and end its sessions</option></>
              : <><option value="active">Activate profile</option><option value="inactive">Deactivate profile and revoke sessions</option></> : intelOrganization ? <><option value="suspended">Suspend the organization (its members keep only Billing)</option><option value="restored">Restore the organization and check its billing again</option></>
              : <><option value="suspended">Suspend organization access</option><option value="restored">Remove manual suspension</option></>}</select></label><label>Reason<input required minLength={10} maxLength={500} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} placeholder="Describe the administrative reason" /></label><button type="submit" className="button button-secondary" disabled={busy || !value || reason.trim().length < 10}>{busy ? "Preparing preview…" : "Preview change"}</button></form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
