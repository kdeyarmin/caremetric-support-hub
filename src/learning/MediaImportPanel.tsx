import { useCallback, useEffect, useRef, useState } from "react";
import { mediaImportClient } from "./mediaImportClient";
import { MEDIA_IMPORT_FAILURES, MEDIA_IMPORT_TARGETS, matchSidecar, parseMediaManifest, validateSidecars,
  type MediaImportItem, type MediaImportManifestRow } from "./mediaImportProtocol";

type Prepared = { row: MediaImportManifestRow; captions: string; transcript: string; problem: string | null };
type Plan = { manifestSha256: string; name: string; rows: Prepared[]; errors: { line: number; message: string }[] };
type Outcome = { line: number; title: string; ok: boolean; message: string };

const message = (error: unknown) => error instanceof Error ? error.message : "The request did not complete.";
async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
const megabytes = (bytes: number | null) => bytes === null ? "" : `${(bytes / 1048576).toFixed(1)} MB`;
const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

/** Read the chosen manifest and the caption/transcript files beside it, and check every row before any transfer. */
async function prepare(files: File[]): Promise<Plan> {
  const manifests = files.filter(file => file.name.toLowerCase().endsWith(".csv"));
  if (manifests.length !== 1) throw new Error("Choose exactly one manifest CSV with its caption and transcript files.");
  const text = await manifests[0].text();
  const parsed = parseMediaManifest(text);
  const rows: Prepared[] = [];
  for (const row of parsed.rows) {
    const captionsFile = matchSidecar(row.captionsFile, files), transcriptFile = matchSidecar(row.transcriptFile, files);
    if (!captionsFile || !transcriptFile) {
      rows.push({ row, captions: "", transcript: "", problem: `Choose exactly one ${!captionsFile ? row.captionsFile : row.transcriptFile} with the manifest.` });
      continue;
    }
    const [captions, transcript] = await Promise.all([captionsFile.text(), transcriptFile.text()]);
    rows.push({ row, captions, transcript, problem: validateSidecars(row, captions, transcript) });
  }
  return { manifestSha256: await sha256(text), name: manifests[0].name, rows, errors: parsed.errors };
}

export function MediaImportPanel() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [items, setItems] = useState<MediaImportItem[]>([]);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const stop = useRef(false);
  const folder = useRef<HTMLInputElement>(null);
  useEffect(() => { folder.current?.setAttribute("webkitdirectory", ""); }, []);
  const refresh = useCallback(async () => {
    try { setItems(await mediaImportClient.list()); } catch (caught) { setError(message(caught)); }
  }, []);
  useEffect(() => { let active = true; void (async () => {
    try { const listed = await mediaImportClient.list(); if (active) setItems(listed); }
    catch (caught) { if (active) setError(message(caught)); }
  })(); return () => { active = false; }; }, []);

  async function choose(list: FileList | null) {
    setPlan(null); setOutcomes([]); setError(""); setStatus("");
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setBusy(true);
    try { setPlan(await prepare(files)); } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  async function transfer(rows: Prepared[]) {
    if (!plan || !rows.length) return;
    stop.current = false; setBusy(true); setError("");
    const results: Outcome[] = [];
    for (const [index, entry] of rows.entries()) {
      if (stop.current) break;
      setStatus(`Transferring ${index + 1} of ${rows.length}: ${entry.row.lessonTitle}…`);
      const title = `${entry.row.courseTitle} · ${entry.row.lessonTitle}`;
      try {
        const result = await mediaImportClient.stage({ manifestSha256: plan.manifestSha256, row: stripLine(entry.row), captions: entry.captions, transcript: entry.transcript });
        const item = result.item;
        results.push(item.state === "failed"
          ? { line: entry.row.line, title, ok: false, message: item.failureCode ? MEDIA_IMPORT_FAILURES[item.failureCode] : "Transfer failed." }
          : { line: entry.row.line, title, ok: true, message: result.replayed ? "Already transferred; nothing was fetched again." : "Stored privately and staged for review." });
      } catch (caught) { results.push({ line: entry.row.line, title, ok: false, message: message(caught) }); }
      // Keep earlier rows' outcomes when retrying only the failed ones.
      setOutcomes(previous => [...previous.filter(o => !results.some(r => r.line === o.line)), ...results].sort((a, b) => a.line - b.line));
    }
    const failed = results.filter(r => !r.ok).length;
    setStatus(`${results.length - failed} of ${results.length} videos staged${failed ? `; ${failed} need attention` : ""}${stop.current ? ". Stopped before the remaining rows" : ""}. Review staged videos below before approving them.`);
    setBusy(false); await refresh();
  }
  const ready = plan?.rows.filter(entry => !entry.problem) ?? [];
  const failedLines = new Set(outcomes.filter(o => !o.ok).map(o => o.line));
  const retry = ready.filter(entry => failedLines.has(entry.row.line));
  const staged = items.filter(item => item.state === "staged"), approved = items.filter(item => item.state === "registered");
  const attention = items.filter(item => item.state === "failed" || item.state === "fetching");

  return <section className="panel lesson-panel" aria-label="Bulk lesson video import">
    <h2>Import lesson videos from a manifest</h2>
    <p>Choose the manifest CSV with the caption (.vtt) and transcript (.txt) files beside it. The Hub downloads each MP4 itself from an approved HeyGen host, checks its type and size, and stages it privately only after the stored copy has the same SHA-256 as the download. Nothing is approved, attached to a lesson, or published until you review it here.</p>
    <label>Manifest, captions and transcripts<input type="file" multiple accept=".csv,.vtt,.txt" disabled={busy} onChange={event => void choose(event.target.files)} /></label>
    <label>Or choose the manifest folder<input ref={folder} type="file" multiple disabled={busy} onChange={event => void choose(event.target.files)} /></label>
    {plan && <>
      <p>{plan.name}: {ready.length} of {plan.rows.length + plan.errors.length} videos ready ({ready.filter(e => e.row.product === "pennsync").length} PennSync · {ready.filter(e => e.row.product === "carebase").length} CareBase).</p>
      {(plan.errors.length > 0 || plan.rows.some(e => e.problem)) && <ul aria-label="Manifest problems">
        {plan.errors.map(problem => <li key={`m${problem.line}`}>{problem.line ? `Line ${problem.line}: ` : ""}{problem.message}</li>)}
        {plan.rows.filter(e => e.problem).map(e => <li key={`r${e.row.line}`}>Line {e.row.line} ({e.row.lessonTitle}): {e.problem}</li>)}
      </ul>}
      {plan.errors.length > 0 ? <p>Correct the manifest and choose it again. No video is transferred from a manifest with errors.</p>
        : <div className="learning-links">
          <button className="button button-secondary" disabled={busy || !ready.length} onClick={() => void transfer(ready)}>Transfer {ready.length} videos</button>
          {retry.length > 0 && <button className="button button-secondary" disabled={busy} onClick={() => void transfer(retry)}>Retry {retry.length} failed</button>}
          {busy && <button type="button" onClick={() => { stop.current = true; }}>Stop after this video</button>}
        </div>}
    </>}
    {status && <p role="status">{status}</p>}
    {error && <p role="alert" className="learning-error">{error}</p>}
    {outcomes.length > 0 && <ul aria-label="Transfer results">{outcomes.map(o => <li key={o.line}>{o.ok ? "✓" : "✗"} Line {o.line} · {o.title}: {o.message}</li>)}</ul>}

    <h3>Staged for review ({staged.length})</h3>
    {!staged.length && <p>No videos are waiting for review.</p>}
    {staged.map(item => <StagedVideo key={item.itemKey} item={item} onChanged={refresh} />)}
    {attention.length > 0 && <><h3>Needs attention ({attention.length})</h3><ul>{attention.map(item => <li key={item.itemKey}>
      {item.courseTitle} · {item.lessonTitle}: {item.state === "fetching" ? "Transfer in progress or interrupted. Retry the row after a few minutes." : item.failureCode ? MEDIA_IMPORT_FAILURES[item.failureCode] : "Transfer failed."} Attempts: {item.attempts}.
    </li>)}</ul></>}
    {approved.length > 0 && <><h3>Approved ({approved.length})</h3><ul>{approved.map(item => <ApprovedVideo key={item.itemKey} item={item} onChanged={refresh} />)}</ul></>}
  </section>;
}

function stripLine(row: MediaImportManifestRow) {
  const copy: Partial<MediaImportManifestRow> = { ...row };
  delete copy.line;
  return copy as Omit<MediaImportManifestRow, "line">;
}

function Target({ item }: { item: MediaImportItem }) {
  const target = item.target;
  return <p>{target.draftTitle ? `${target.draftTitle}${target.unitTitle ? ` · ${target.unitTitle}` : ""}: ` : ""}{MEDIA_IMPORT_TARGETS[target.state]}</p>;
}

function StagedVideo({ item, onChanged }: { item: MediaImportItem; onChanged: () => Promise<void> }) {
  const [media, setMedia] = useState<{ video: string; captions: string; transcript: string } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function open() {
    setBusy(true); setError("");
    try { setMedia(await mediaImportClient.review(item.mediaId!)); } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  async function approve() {
    setBusy(true); setError("");
    try { await mediaImportClient.register(item.mediaId!); await onChanged(); } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  return <article className="learning-notice" aria-label={`${item.courseTitle} · ${item.lessonTitle}`}>
    <div><h4>{item.courseTitle} · {item.lessonTitle}</h4>
      <p>{item.product === "pennsync" ? "PennSync" : "CareBase"} · {minutes(item.durationSeconds)} · {megabytes(item.byteSize)} · SHA-256 {item.sourceSha256?.slice(0, 12)}…</p>
      <Target item={item} />
      {!media && <button className="button button-secondary" disabled={busy} onClick={() => void open()}>Review video, captions and transcript</button>}
      {media && <>
        <video controls preload="metadata" crossOrigin="anonymous" src={media.video}><track kind="captions" src={media.captions} srcLang="en" label="English" default /></video>
        <details open><summary>Transcript</summary><pre className="learning-transcript">{media.transcript}</pre></details>
        <label className="learning-check"><input type="checkbox" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)} />I watched this video and reviewed its captions and transcript for accuracy, and confirm they contain no private data.</label>
        <button className="button button-primary" disabled={busy || !reviewed} onClick={() => void approve()}>{item.target.state === "ready" ? "Approve and attach to lesson" : "Approve video"}</button>
      </>}
      {error && <p role="alert" className="learning-error">{error}</p>}
    </div>
  </article>;
}

function ApprovedVideo({ item, onChanged }: { item: MediaImportItem; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function attach() {
    setBusy(true); setError("");
    try { await mediaImportClient.attach(item.mediaId!); await onChanged(); } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  return <li>{item.courseTitle} · {item.lessonTitle} <Target item={item} />
    {item.target.state === "ready" && <button className="button button-secondary" disabled={busy} onClick={() => void attach()}>Attach to lesson</button>}
    {error && <span role="alert" className="learning-error"> {error}</span>}
  </li>;
}
