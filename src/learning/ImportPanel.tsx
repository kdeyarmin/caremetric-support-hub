import { useState } from "react";
import type { Product } from "../domain";
import { prepareLearningImport, type LearningImport } from "../imports/learningImport";
import { learningApi } from "./api";

export function ImportPanel({ products, onImported }: { products: Product[]; onImported: () => Promise<void> }) {
  const [preview, setPreview] = useState<LearningImport[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  async function read(file: File | undefined) {
    setPreview([]); setError(""); setStatus("");
    if (!file) return;
    try {
      if (file.size > 10000000) throw new Error("The source export exceeds 10 MB.");
      setPreview(prepareLearningImport(JSON.parse(await file.text()), products.filter(p => p.status !== "retired").map(p => p.id)));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The export is invalid."); }
  }
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
  return <section className="panel lesson-panel"><h2>Prepare CareBase course drafts</h2><p>Use the field-limited course export. Imported courses keep their existing catalog IDs and continue to open in CareBase. You can edit drafts here; publication stays blocked until quiz behavior, credits, and completion reporting are connected.</p><label>Course export (JSON)<input type="file" accept=".json" disabled={busy} onChange={event => void read(event.target.files?.[0])} /></label>{preview.length > 0 && <><p>{preview.length} course drafts · {preview.reduce((n,c) => n+c.pendingVideoIds.length,0)} videos require central uploads with captions. Proposed placements cover {products.filter(p => p.status !== "retired").length} registered products; importing does not change the live courses.</p><button className="button button-secondary" disabled={busy} onClick={() => void apply()}>Import course drafts</button></>}{status && <p role="status">{status}</p>}{error && <p role="alert" className="learning-error">{error}</p>}</section>;
}
