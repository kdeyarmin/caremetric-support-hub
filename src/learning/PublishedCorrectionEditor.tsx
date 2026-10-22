import { useState } from "react";
import type { GovernedCourse } from "../imports/governedLearningImport";
import { correctionLabels, publishedCorrectionSchema, type PublishedCorrection } from "./authoringProtocol";

export type BlockCorrection = { blockId: string; correction: PublishedCorrection };
type LessonField = "content" | "transcript";
const fieldFor = (type: string): LessonField | null => type === "text" ? "content" : type === "video" ? "transcript" : null;
/** null when the lesson keeps its text in a format a correction cannot replace. */
function lessonText(body: unknown, field: LessonField): string | null {
  if (body == null) return "";
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[field];
  return value == null ? "" : typeof value === "string" ? value : null;
}

/** Urgent in-place fixes to one lesson of the current published version. Anything else needs a new draft. */
export function PublishedCorrectionEditor({ material, busy, reasonReady, onChange, onPreview }: {
  material: GovernedCourse; busy: boolean; reasonReady: boolean; onChange: () => void; onPreview: (value: BlockCorrection) => void;
}) {
  const blocks = [...material.blocks].sort((a, b) => a.sortOrder - b.sortOrder);
  const [blockId, setBlockId] = useState("");
  const [title, setTitle] = useState(""); const [text, setText] = useState("");
  const block = blocks.find(value => value.id === blockId);
  const field = block ? fieldFor(block.type) : null;
  const originalText = block && field ? lessonText(block.body, field) : null;
  const correction: Record<string, string> = {};
  if (block && title !== (block.title ?? "")) correction.title = title;
  if (field && originalText !== null && text !== originalText) correction[field] = text;
  const dirty = Object.keys(correction).length > 0;
  const parsed = publishedCorrectionSchema.safeParse(correction);
  function choose(id: string) {
    const next = blocks.find(value => value.id === id); const nextField = next ? fieldFor(next.type) : null;
    onChange(); setBlockId(id); setTitle(next?.title ?? ""); setText(next && nextField ? lessonText(next.body, nextField) ?? "" : "");
  }
  return <div aria-label="Published lesson correction">
    <h4>Correct a published lesson</h4>
    <p>Fix an urgent error, such as a wrong dose or a rescinded rule, in the live version without creating a new one. Only a lesson’s title,
      a text lesson’s text and a video lesson’s transcript can change here. Questions, answers, media and lesson order need a new draft version.</p>
    <label>Lesson to correct<select disabled={busy} value={blockId} onChange={event => choose(event.target.value)}>
      <option value="">Choose a lesson</option>
      {blocks.map(value => <option key={value.id} value={value.id}>{value.sortOrder + 1}. {value.title || "Untitled lesson"} · {value.type}</option>)}
    </select></label>
    {block && <>
      <label>{correctionLabels.title}<input disabled={busy} value={title} maxLength={300} onChange={event => { onChange(); setTitle(event.target.value); }} /></label>
      {field && originalText !== null && <label>{correctionLabels[field]}<textarea disabled={busy} value={text} maxLength={12_000}
        onChange={event => { onChange(); setText(event.target.value); }} /></label>}
      {field && originalText === null && <p>This lesson’s {field === "content" ? "text" : "transcript"} uses a format that only a new draft version can change.</p>}
      {dirty && <details open><summary>Review the exact correction</summary>
        {(Object.keys(correction) as (keyof PublishedCorrection)[]).map(key => <div key={key}><strong>{correctionLabels[key]}</strong>
          <p>Before</p><pre>{key === "title" ? block.title ?? "" : originalText}</pre><p>After</p><pre>{correction[key]}</pre></div>)}
      </details>}
      {dirty && !parsed.success && <p role="alert">Enter a single-line title of up to 300 characters and lesson text of 1 to 12,000 characters.</p>}
      <button type="button" className="button button-secondary" disabled={busy || !reasonReady || !dirty || !parsed.success}
        onClick={() => { if (parsed.success) onPreview({ blockId: block.id, correction: parsed.data }); }}>Preview correction</button>
    </>}
  </div>;
}
