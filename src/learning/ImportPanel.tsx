import { useState } from "react";
import type { Product } from "../domain";
import { prepareLearningImport, type LearningImport } from "../imports/learningImport";
import { learningApi } from "./api";
import { prepareGovernedImport, governedImportSummary, type GovernedImport } from "../imports/governedLearningImport";

export function ImportPanel({ products, onImported }: { products: Product[]; onImported: () => Promise<void> }) {
  const [preview, setPreview] = useState<LearningImport[]>([]);
  const [governed, setGoverned] = useState<Array<GovernedImport & { expectedRevision: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  async function read(file: File | undefined) {
    setPreview([]); setGoverned([]); setError(""); setStatus("");
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > 25000000) throw new Error("The source export exceeds 25 MB.");
      const parsed: unknown = JSON.parse(await file.text());
      if (Array.isArray(parsed)) {
        setPreview(prepareLearningImport(parsed, products.filter(p => p.status !== "retired").map(p => p.id)));
      } else {
        const imports = await prepareGovernedImport(parsed);
        const heads = await learningApi.sourceHeads();
        setGoverned(imports.map(entry => ({ ...entry, expectedRevision: heads.find(head => head.sourceCourseId.toLowerCase() === entry.course.sourceCourseId.toLowerCase())?.sourceRevision ?? null })));
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The export is invalid."); }
    finally { setBusy(false); }
  }
  async function stage() {
    setBusy(true); setError("");
    try {
      for (const [index, entry] of governed.entries()) {
        setStatus(`Preserving source snapshot ${index + 1} of ${governed.length}…`);
        await learningApi.stageSource(entry.payload, entry.sourceRevision, entry.expectedRevision);
      }
      setStatus(`${governed.length} source snapshots preserved for review, including quiz and credit policy. Existing course drafts, learner records, and CareBase launches are unchanged.`);
      setGoverned([]);
    } catch (caught) {
      setError(`${caught instanceof Error ? caught.message : "Source snapshots could not be preserved."} Completed snapshots are retained. Reload the export to review current revisions before retrying.`);
    } finally { setBusy(false); }
  }
  const counts = governedImportSummary(governed);
  async function apply() {
    setBusy(true); setError("");
    try {
      for (const [index, course] of preview.entries()) {
        setStatus(`Importing draft ${index + 1} of ${preview.length}…`);
        await learningApi.importDraft(course.sourceCourseId, course.sourceVersionId, course.document);
      }
      await onImported(); setStatus(`${preview.length} drafts imported. CareBase continues to deliver these courses; publication in the Hub is blocked until quiz, credit, and completion reporting are connected.`); setPreview([]);
    } catch (caught) { setError(`${caught instanceof Error ? caught.message : "Import did not complete."} Completed imports are retained; retrying the same export will not overwrite edits.`); }
    finally { setBusy(false); }
  }
  return <section className="panel lesson-panel"><h2>Prepare CareBase course drafts</h2><p>Use the field-limited course export for drafts, or the governed export to preserve complete source course content and policy for migration review. Imported courses keep their existing catalog IDs and continue to open in CareBase. Publication stays blocked until quiz behavior, credits, and completion reporting are connected.</p><label>Course export (JSON)<input type="file" accept=".json" disabled={busy} onChange={event => void read(event.target.files?.[0])} /></label>{governed.length > 0 && <><p>{counts.courses} source snapshots · {counts.blocks} lessons · {counts.quizzes} quizzes · {counts.creditRules} credit rules · {counts.providers} provider profiles · {counts.archived} archived courses. Each snapshot preserves its source policy and revision; media remain in CareBase. This action preserves review copies and does not publish or retire courses.</p><button className="button button-secondary" disabled={busy} onClick={() => void stage()}>Preserve source snapshots</button></>}{preview.length > 0 && <><p>{preview.length} course drafts · {preview.reduce((n,c) => n+c.pendingVideoIds.length,0)} videos require central uploads with captions. Proposed placements cover {products.filter(p => p.status !== "retired").length} registered products; importing does not change the live courses.</p><button className="button button-secondary" disabled={busy} onClick={() => void apply()}>Import course drafts</button></>}{status && <p role="status">{status}</p>}{error && <p role="alert" className="learning-error">{error}</p>}</section>;
}
