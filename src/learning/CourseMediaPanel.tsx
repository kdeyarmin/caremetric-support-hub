import { useEffect, useRef, useState } from "react";
import { portfolioClient } from "../admin/portfolioClient";
import { runMedia, uploadMedia, courseMediaPath } from "./mediaClient";
import { parseHubMediaOperation, projectMediaContextView, projectMediaIntent, projectMediaReceipt, verifyMediaReceipt,
  mediaUuid, type HubMediaOperation, type MediaContextView, type MediaIntent, type MediaReceipt } from "./mediaProtocol";

type Props = { courseId: string; versionId: string; blockId: string; draft: boolean; disabled?: boolean; onApplied?: () => void; onBusy?: (busy: boolean) => void };
export function CourseMediaPanel(props: Props) { return <MediaPanel key={`${props.courseId}/${props.versionId}/${props.blockId}`} {...props} />; }
function MediaPanel({ courseId, versionId, blockId, draft, disabled = false, onApplied, onBusy }: Props) {
  const [context, setContext] = useState<MediaContextView | null>(null);
  const [file, setFile] = useState<File | null>(null); const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(false); const [confirmed, setConfirmed] = useState(false);
  const [operationId, setOperationId] = useState("");
  const [intent, setIntent] = useState<MediaIntent | null>(null); const [receipt, setReceipt] = useState<MediaReceipt | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [clock, setClock] = useState(() => Date.now());
  const active = useRef<AbortController | null>(null); const retry = useRef<{ key: string; operation: HubMediaOperation } | null>(null);
  const base = { courseId, versionId, blockId };
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => { clearInterval(timer); active.current?.abort(); }; }, []);
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return; const controller = new AbortController(); active.current = controller;
    setBusy(true); onBusy?.(true); setError("");
    try { await work(controller.signal); }
    catch (caught) { if (!controller.signal.aborted) {
      const code = caught && typeof caught === "object" && "code" in caught ? caught.code : "upstream";
      setError(code === "unconfigured" ? "CareBase media management is not enabled for this deployment." : code === "conflict" ? "The source or session changed. Reload media and review the current course material before another attachment." :
        code === "invalid_request" || code === "payload_too_large" ? "Choose a PDF up to 25 MiB or MP4/WebM up to 100 MiB, and enter a reason of 8–500 characters." :
        "The request did not finish. Reload media or check the saved upload before retrying. A confirmed attachment is recorded only once.");
    } } finally { active.current = null; setBusy(false); onBusy?.(false); }
  }
  async function load(signal: AbortSignal) {
    const capabilities = await portfolioClient.capabilities({ product: "carebase", signal });
    if (!capabilities.operations.includes("learning.media.v1")) throw { code: "unconfigured" };
    const op: HubMediaOperation = { ...base, operation: "media.context" };
    setContext(projectMediaContextView(await runMedia(op, signal), op));
  }
  async function status(operationId: string, signal: AbortSignal) {
    const value = await runMedia({ ...base, operation: "media.status", operationId }, signal);
    const next = value === null ? null : projectMediaIntent(value); setIntent(next); setReceipt(next?.result ?? null); setConfirmed(false);
    if (next?.result) onApplied?.();
    if (!next) setError("This upload is unavailable to the current administrator.");
  }
  const canUpload = draft && context?.sourcePreserved && context.block.generationState !== "pending" && !busy && !disabled;
  const canFinish = draft && !busy && !disabled && intent?.state === "staged" && intent.canFinishThisSession && !intent.result
    && Date.parse(intent.expiresAt) > clock && context?.sourcePreserved && context.sourceRevision === intent.sourceRevision;
  const player = context?.block.mediaAsset;
  return <section className="learning-notice" aria-label="Lesson media">
    <h4>Lesson media</h4>
    <button type="button" disabled={busy || disabled} onClick={() => void action(load)}>Load lesson media</button>
    {error && <p role="alert">{error}</p>}
    {context && <>
      <p>{context.block.title ?? "Untitled lesson"} · {context.block.type}</p>
      {player && <><p>{player.fileName} · {player.byteSize.toLocaleString()} bytes</p>
        {player.mimeType === "application/pdf" ? <a href={courseMediaPath(courseId, versionId, blockId, player.id)} target="_blank" rel="noreferrer">Preview current PDF</a>
          : <video controls preload="metadata" src={courseMediaPath(courseId, versionId, blockId, player.id)} aria-label="Current lesson video" />}</>}
      {!player && <p>{context.block.legacyDocumentId || context.block.legacyVideoSha256 ? "This lesson uses a native legacy attachment. A confirmed new upload replaces that reference." : "No media is attached."}</p>}
      {!context.sourcePreserved && <p>Load and explicitly preserve the current course material before attaching media.</p>}
      {context.block.generationState === "pending" && <p>Wait for native video generation to settle before replacing media.</p>}
      {draft && <fieldset disabled={!canUpload}><legend>Upload replacement media</legend>
        <label>Media file<input type="file" accept={context.block.type === "pdf" ? "application/pdf" : "video/mp4,video/webm"}
          onChange={event => { setFile(event.target.files?.[0] ?? null); setReviewed(false); setConfirmed(false); }} /></label>
        <label>Reason<textarea value={reason} maxLength={500} onChange={event => { setReason(event.target.value); setReviewed(false); setConfirmed(false); }} /></label>
        <label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed this file and intend to replace this lesson’s attachment.</label>
        <p>Upload checks format and integrity. Attaching it clears the draft’s previous content approval.</p>
        <button type="button" disabled={!file || !reviewed || reason.trim().length < 8} onClick={() => void action(async signal => {
          if (!file) return;
          // Size is checked before allocating a bounded browser digest buffer.
          const candidate = { ...base, operation: "media.upload" as const, requestId: crypto.randomUUID(), sourceRevision: context.sourceRevision,
            reason: reason.trim(), fileName: file.name.normalize("NFC"), mimeType: file.type, sourceSha256: "0".repeat(64), sourceBytes: file.size };
          parseHubMediaOperation(candidate);
          const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); signal.throwIfAborted();
          const sourceSha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
          const key = JSON.stringify({ ...candidate, requestId: null, sourceSha256 });
          const op = retry.current?.key === key ? retry.current.operation : parseHubMediaOperation({ ...candidate, sourceSha256 });
          retry.current = { key, operation: op };
          const staged = await uploadMedia(op, file, signal);
          if (staged.state === "committed") { setReceipt(staged.result); setIntent(null); onApplied?.(); }
          else await status(staged.operationId, signal);
        })}>Upload for verification</button>
      </fieldset>}
      <label>Saved media operation ID<input value={operationId} onChange={event => setOperationId(event.target.value)} /></label>
      <button type="button" disabled={busy || disabled || !mediaUuid(operationId)} onClick={() => void action(signal => status(operationId, signal))}>Find attachment receipt</button>
      {context.intents.items.length > 0 && <><h5>Saved uploads</h5><ul>{context.intents.items.map(item => <li key={item.operationId}>
        {item.fileName} · {item.state} · {new Date(item.createdAt).toLocaleString()} <button type="button" disabled={busy || disabled}
          onClick={() => void action(signal => status(item.operationId, signal))}>Inspect saved upload</button>
      </li>)}</ul>{context.intents.hasMore && <p>Showing the 20 latest uploads. Keep the operation identifier for older receipt recovery.</p>}</>}
    </>}
    {intent && <div><p>Upload {intent.operationId}: {intent.fileName} · {intent.state}. Expires {new Date(intent.expiresAt).toLocaleString()}.</p>
      <p>{intent.mimeType} / {intent.byteSize.toLocaleString()} bytes. Reason: {intent.reason}</p>
      <details><summary>Verified file checksum</summary><code>{intent.contentSha256}</code></details>
      <button type="button" disabled={busy || disabled} onClick={() => void action(signal => status(intent.operationId, signal))}>Check attachment receipt</button>
      {!receipt && !canFinish && <p>This upload cannot be attached in the current session or source state. You can still inspect its receipt.</p>}
      {canFinish && <><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Confirm attaching this verified file to this lesson.</label>
        <button type="button" disabled={!confirmed} onClick={() => void action(async signal => {
          const result = projectMediaReceipt(await runMedia({ ...base, operation: "media.finish", operationId: intent.operationId }, signal));
          verifyMediaReceipt(result, intent); setReceipt(result); setConfirmed(false); onApplied?.();
        })}>Confirm attachment</button></>}
    </div>}
    {receipt && <p role="status">CareBase confirmed attachment {receipt.assetId}. Reload and preserve the resulting course material before another edit.</p>}
  </section>;
}
