import { AlertCircle, Bot, Check, LoaderCircle, PenLine, Sparkles, Tags } from "lucide-react";
import { useState } from "react";
import { repository } from "../data";
import { AiNotConfiguredError } from "../data/supabaseRepository";
import type { CaseCategory, CasePriority, HubRepository } from "../domain";
import { categoryLabels, priorityLabels } from "../domain";

interface AiCaseToolsProps {
  caseId: string;
  disabled?: boolean;
  onDraft: (draft: string) => void;
  onApplyPriority: (priority: CasePriority) => void;
  repo?: HubRepository;
}

type AiAction = "summary" | "draft" | "triage";

/**
 * Staff AI assistance for one case. Every action is advisory: the summary is shown,
 * the draft is handed to the case reply box for the staffer to edit and send
 * themselves, and the triage suggestion is applied only through the normal case
 * update path. Nothing here sends or changes the case on its own.
 */
export function AiCaseTools({ caseId, disabled = false, onDraft, onApplyPriority, repo = repository }: AiCaseToolsProps) {
  const [busy, setBusy] = useState<AiAction | "">("");
  const [summary, setSummary] = useState("");
  const [triage, setTriage] = useState<{ category: CaseCategory; priority: CasePriority } | null>(null);
  const [qualityTier, setQualityTier] = useState<"draft" | "quality">("draft");
  const [error, setError] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);

  const run = async (action: AiAction, work: () => Promise<void>) => {
    setBusy(action);
    setError("");
    try {
      await work();
    } catch (caught) {
      if (caught instanceof AiNotConfiguredError) setNotConfigured(true);
      else setError(caught instanceof Error ? caught.message : "The AI request could not be completed.");
    } finally {
      setBusy("");
    }
  };

  const summarize = () => run("summary", async () => setSummary(await repo.summarizeCase(caseId)));
  const draft = () => run("draft", async () => onDraft(await repo.draftCaseReply(caseId, qualityTier)));
  const suggest = () => run("triage", async () => setTriage(await repo.suggestCaseTriage(caseId)));

  return (
    <section className="ai-tools" aria-label="AI case assistance">
      <div className="ai-tools-heading">
        <Sparkles size={15} />
        <strong>AI assistance</strong>
        <span>Suggestions only — nothing is sent or changed until you do it.</span>
      </div>
      {notConfigured ? (
        <p className="ai-tools-note">AI assistance isn&rsquo;t set up yet. An administrator needs to add the Anthropic API key to the Support Hub server.</p>
      ) : (
        <>
          <div className="ai-tools-actions">
            <button type="button" className="button button-small button-secondary" disabled={disabled || busy !== ""} onClick={() => void summarize()}>
              {busy === "summary" ? <LoaderCircle className="spin" size={14} /> : <Bot size={14} />} Summarize
            </button>
            <button type="button" className="button button-small button-secondary" disabled={disabled || busy !== ""} onClick={() => void draft()}>
              {busy === "draft" ? <LoaderCircle className="spin" size={14} /> : <PenLine size={14} />} Draft reply
            </button>
            <button type="button" className="button button-small button-secondary" disabled={disabled || busy !== ""} onClick={() => void suggest()}>
              {busy === "triage" ? <LoaderCircle className="spin" size={14} /> : <Tags size={14} />} Suggest triage
            </button>
            <label className="ai-tier-toggle">
              <input type="checkbox" checked={qualityTier === "quality"} onChange={(event) => setQualityTier(event.target.checked ? "quality" : "draft")} />
              <span>Highest-quality draft</span>
            </label>
          </div>
          {summary && (
            <div className="ai-summary">
              <span>Case summary</span>
              <p>{summary}</p>
            </div>
          )}
          {triage && (
            <div className="ai-triage">
              <span>
                Suggested category: <strong>{categoryLabels[triage.category]}</strong> · Suggested priority: <strong>{priorityLabels[triage.priority]}</strong>
              </span>
              <button type="button" className="button button-small" disabled={disabled || busy !== ""} onClick={() => onApplyPriority(triage.priority)}>
                <Check size={13} /> Apply priority
              </button>
              <small>Applying writes through the normal case controls. The category is advisory — review it against the case.</small>
            </div>
          )}
          {error && <p className="form-message form-error"><AlertCircle size={15} /> {error}</p>}
        </>
      )}
    </section>
  );
}
