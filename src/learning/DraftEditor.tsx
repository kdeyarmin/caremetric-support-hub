import { useState } from "react";
import type { GovernedCourse } from "../imports/governedLearningImport";
import { draftPatchSchema, type DraftPatch } from "./authoringProtocol";

type BlockPatch = NonNullable<DraftPatch["blocks"]>[number];
export function DraftEditor({ material, busy, reasonReady, publishReady, onChange, onPreview, onReview, onPublish }: {
  material: GovernedCourse; busy: boolean; reasonReady: boolean; onChange: () => void;
  publishReady: boolean; onPreview: (patch: DraftPatch) => void; onReview: () => void; onPublish: () => void;
}) {
  const [title, setTitle] = useState(material.version.title);
  const [description, setDescription] = useState(material.version.description ?? "");
  const [blocks, setBlocks] = useState<Record<string, BlockPatch>>({});
  const [humanReviewed, setHumanReviewed] = useState(false);
  const version: NonNullable<DraftPatch["version"]> = {};
  if (title !== material.version.title) version.title = title;
  if (description !== (material.version.description ?? "")) version.description = description || null;
  const changedBlocks = Object.values(blocks).filter(block => Object.keys(block).length > 1);
  const patch = { ...(Object.keys(version).length ? { version } : {}), ...(changedBlocks.length ? { blocks: changedBlocks } : {}) };
  const dirty = Object.keys(patch).length > 0;
  const parsed = draftPatchSchema.safeParse(patch);
  const changed = () => { setHumanReviewed(false); onChange(); };
  function editBlock(blockId: string, key: keyof Omit<BlockPatch, "blockId">, value: string | number | null, original: unknown) {
    changed();
    setBlocks(current => {
      const block = { ...current[blockId], blockId };
      if (value === original) delete block[key];
      else Object.assign(block, { [key]: value });
      return { ...current, [blockId]: block };
    });
  }
  return <div aria-label="Draft editor">
    <h4>Edit this draft</h4>
    <label>Draft title<input value={title} maxLength={300} disabled={busy} onChange={event => { changed(); setTitle(event.target.value); }} /></label>
    <label>Draft description<textarea value={description} maxLength={12_000} disabled={busy} onChange={event => { changed(); setDescription(event.target.value); }} /></label>
    {material.blocks.map(block => {
      const body = block.body == null ? {} : typeof block.body === "object" && !Array.isArray(block.body) ? block.body : null;
      const contentKey = block.type === "text" ? "content" : block.type === "video" ? "transcript" : null;
      const contentEditable = body && contentKey && (body[contentKey] == null || typeof body[contentKey] === "string");
      const content = body && contentKey && typeof body[contentKey] === "string" ? body[contentKey] as string : "";
      const minutesEditable = body && (body.estimated_minutes == null || typeof body.estimated_minutes === "number");
      const minutes = body && typeof body.estimated_minutes === "number" ? body.estimated_minutes : null;
      const edits = blocks[block.id];
      const fieldValue = (key: keyof BlockPatch, original: string | number | null) => edits && Object.hasOwn(edits, key) ? edits[key] : original;
      return <details key={block.id}><summary>Edit {block.title || "untitled lesson"} · {block.type}</summary>
        <label>Lesson title<input value={fieldValue("title", block.title) ?? ""} maxLength={300} disabled={busy}
          onChange={event => editBlock(block.id, "title", event.target.value || null, block.title)} /></label>
        {contentEditable && <>
          <label>{contentKey === "content" ? "Lesson text" : "Video transcript"}<textarea disabled={busy} maxLength={12_000}
            value={String(fieldValue(contentKey, content) ?? "")}
            onChange={event => editBlock(block.id, contentKey, event.target.value, content)} /></label>
        </>}
        {contentKey && !contentEditable && <p>Edit this lesson’s existing content format in the native course editor.</p>}
        {contentKey && minutesEditable && <label>Estimated minutes<input type="number" min={0} max={1440} step={1} disabled={busy}
            value={Number.isNaN(fieldValue("estimatedMinutes", minutes)) ? "" : fieldValue("estimatedMinutes", minutes) ?? ""}
            onChange={event => editBlock(block.id, "estimatedMinutes", event.target.value === "" ? Number.NaN : Number(event.target.value), minutes)} /></label>}
        {contentKey && !minutesEditable && <p>Edit this lesson’s existing duration format in the native course editor.</p>}
      </details>;
    })}
    <p>Changes require a preview and confirmation. Saved edits clear prior content approval; review the saved material before publication.</p>
    {dirty && !parsed.success && <p role="alert">Enter valid field values and keep each save to 20 lessons and 24 KB of changes.</p>}
    <button type="button" className="button button-secondary" disabled={busy || !reasonReady || !parsed.success}
      onClick={() => { if (parsed.success) onPreview(parsed.data); }}>Preview draft edits</button>
    {material.version.aiGenerated && <><label className="learning-checkbox"><input type="checkbox" checked={humanReviewed} disabled={busy || dirty}
      onChange={event => { onChange(); setHumanReviewed(event.target.checked); }} />I reviewed the complete saved draft, its assessments and policy evidence and approve this exact material.</label>
    {dirty && <p>Save or undo these edits, then load and preserve the updated material before approving it.</p>}
    <button type="button" className="button button-secondary" disabled={busy || dirty || !reasonReady || !humanReviewed}
      onClick={onReview}>Preview content approval</button></>}
    <button type="button" className="button button-secondary" disabled={busy || dirty || !reasonReady || !publishReady}
      onClick={onPublish}>Preview publication</button>
  </div>;
}
