import { AlertCircle, CheckCircle2, LoaderCircle, Sparkles, XCircle } from "lucide-react";
import { useRef, useState } from "react";
import { repository } from "../data";
import type { HubRepository } from "../domain";
import { prepareMutationRequest, type PendingMutationRequest } from "../security/mutationRequestKey";

interface AiResolutionPromptProps {
  caseId: string;
  onChanged: () => void;
  repo?: HubRepository;
}

/**
 * The customer's explicit answer to an automated AI fix. "That fixed it" resolves
 * the case through hub.record_ai_resolution_response; "Still not fixed" hands the
 * loop its next step (one more automated attempt, then human escalation).
 */
export function AiResolutionPrompt({ caseId, onChanged, repo = repository }: AiResolutionPromptProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [answered, setAnswered] = useState("");
  const pending = useRef<PendingMutationRequest | null>(null);

  const answer = async (fixed: boolean) => {
    const request = prepareMutationRequest(pending.current, ["ai-resolution-response", caseId, fixed]);
    pending.current = request;
    setSaving(true);
    setError("");
    try {
      const result = await repo.respondToAiResolution(caseId, fixed, request.requestKey);
      pending.current = null;
      setAnswered(result.stage === "resolved" || fixed
        ? "Thanks for confirming — this case is now resolved."
        : "Thanks for letting us know. We'll keep working on it and follow up here.");
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your answer could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  if (answered) {
    return (
      <div className="ai-resolution-prompt ai-resolution-done" role="status">
        <CheckCircle2 size={16} />
        <span>{answered}</span>
      </div>
    );
  }

  return (
    <div className="ai-resolution-prompt">
      <p>
        <Sparkles size={15} /> <strong>CareMetric AI Assistant suggested a fix for this case.</strong> Did it solve the problem?
      </p>
      <div className="ai-resolution-actions">
        <button type="button" className="button button-primary button-small" disabled={saving} onClick={() => void answer(true)}>
          {saving ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} That fixed it
        </button>
        <button type="button" className="button button-secondary button-small" disabled={saving} onClick={() => void answer(false)}>
          <XCircle size={14} /> Still not fixed
        </button>
      </div>
      {error && <p className="form-message form-error"><AlertCircle size={15} /> {error}</p>}
    </div>
  );
}
