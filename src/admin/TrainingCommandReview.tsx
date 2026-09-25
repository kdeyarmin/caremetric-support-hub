import { useEffect, useRef, useState } from "react";
import type { TrainingClient } from "./trainingClient";
import { clearTrainingIntent, saveTrainingIntent } from "./trainingRecovery";

export type TrainingCommand = Extract<Parameters<TrainingClient["request"]>[0], { operation: "apply" }>;
export interface TrainingIntent { command: TrainingCommand; title: string; details: Array<[string, string]>; }

/** This is a review of the exact request, not a claim that native state is reserved. */
export function TrainingCommandReview({ intent, client, actorId, recovered = false, onClose, onApplied }: {
  intent: TrainingIntent; client: TrainingClient; onClose: () => void;
  actorId: string; recovered?: boolean;
  onApplied: (result: Awaited<ReturnType<TrainingClient["request"]>>) => void;
}) {
  const [confirmed, setConfirmed] = useState(recovered), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(recovered), [error, setError] = useState("");
  const pending = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function apply() {
    if (pending.current || !confirmed) return;
    pending.current = true; setBusy(true); setError("");
    const current = new AbortController(); controller.current = current;
    try { saveTrainingIntent(actorId, intent); } catch {
      setError("This browser could not retain the request for safe retry. Allow session storage, then retry. No change was sent.");
      pending.current = false; setBusy(false); return;
    }
    try {
      const result = await client.request(intent.command, current.signal);
      if (!current.signal.aborted) {
        if ("action" in result && result.action === "invitations.create" && result.result.deliveryStatus === "unknown") {
          setUncertain(true); setError("The invitation delivery result is unconfirmed. Retry this same request to retrieve its delivery status without sending another invitation.");
        } else { clearTrainingIntent(actorId); setUncertain(false); onApplied(result); }
      }
    } catch (caught) {
      if (!current.signal.aborted) {
        const code = caught && typeof caught === "object" && "code" in caught ? String(caught.code) : "";
        if (!uncertain && ["invalid_request", "notfound", "conflict", "unconfigured"].includes(code)) {
          clearTrainingIntent(actorId); setConfirmed(false);
          setError("CareBase declined this change. Check the selected records, required fields and current administrator access. You can return to edit this request.");
        } else {
          setUncertain(true);
          setError("This result has not been confirmed. Retry this same request to retrieve or complete its recorded result. It is retained for this administrator in this browser tab if you leave or refresh.");
        }
      }
    } finally { pending.current = false; if (!current.signal.aborted) setBusy(false); }
  }
  return <section className="panel training-review" aria-label="Review training change">
    <h3>{intent.title}</h3><p>Review the exact facility, person and change before submitting. CareBase verifies current access and records your reason when it applies the request.</p>
    {recovered && <p role="status">An unfinished request was recovered. Its original scope and request identity are preserved. Confirm its result before starting another training change.</p>}
    <dl>{intent.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}<div><dt>Reason</dt><dd>{intent.command.reason}</dd></div></dl>
    <label className="training-checkbox"><input type="checkbox" checked={confirmed} disabled={busy || uncertain} onChange={event => setConfirmed(event.target.checked)} />I reviewed this change.</label>
    <div className="training-actions"><button type="button" className="button button-primary" disabled={!confirmed || busy} onClick={() => void apply()}>{busy ? "Confirming result…" : uncertain ? "Retry same training change" : "Apply reviewed change"}</button><button type="button" className="button button-secondary" disabled={busy || uncertain} onClick={onClose}>Back to edit</button></div>
    {error && <p role="alert">{error}</p>}
    <small>Request reference: {intent.command.requestId}</small>
  </section>;
}
