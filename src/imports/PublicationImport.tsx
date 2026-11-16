import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { validatePublicationManifest, type PublicationManifest } from "./publicationImportPreview";
import {
  publicationActionLabel, publicationConfirmationIds, publicationParts, publicationPartRules,
  type PublicationPart, type PublicationReceipt, type PublicationStage,
} from "./publicationProtocol";
import { publicationClient, PublicationError, type PublicationClient } from "./publicationClient";
import "./publication.css";

const partLabels: Record<PublicationPart, string> = { primary: "Primary article or video", captions: "WebVTT captions", transcript: "Plain-text transcript" };
const errorMessage = (error: unknown) => error instanceof PublicationError ? error.message : "This publication could not be verified. Check the manifest, files, and connection.";
function LocalPublicationPreview({ file, kind }: { file: File; kind: "article" | "video" }) {
  const [text, setText] = useState("");
  const videoElement = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    let current = true;
    if (kind === "article") {
      void file.text().then(value => { if (current) setText(value); }).catch(() => { if (current) setText("This file cannot be previewed. Export a UTF-8 article."); });
      return () => { current = false; };
    }
    const localUrl = URL.createObjectURL(file);
    const video = videoElement.current;
    if (video) video.src = localUrl;
    return () => { current = false; video?.removeAttribute("src"); URL.revokeObjectURL(localUrl); };
  }, [file, kind]);
  return <details className="publication-local-preview"><summary>Review selected source content</summary>{kind === "article"
    ? <div className="preview-body">{text}</div>
    : <video ref={videoElement} className="publication-video" controls preload="metadata" aria-label="Selected source video" />}</details>;
}
export function PublicationImport({ client = publicationClient }: { client?: PublicationClient }) {
  const [access, setAccess] = useState<"loading" | "allowed" | "denied">("loading");
  const [maxVideoBytes, setMaxVideoBytes] = useState(0);
  const [manifest, setManifest] = useState<PublicationManifest | null>(null);
  const [files, setFiles] = useState<Partial<Record<PublicationPart, File>>>({});
  const [sourceReviewed, setSourceReviewed] = useState(false);
  const [stage, setStage] = useState<PublicationStage | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [finalReview, setFinalReview] = useState(false);
  const [receipt, setReceipt] = useState<PublicationReceipt | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [commitAttempted, setCommitAttempted] = useState(false);
  const commitKey = useRef<string | null>(null);
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const runSequence = sequence;
    client.access(controller.signal).then(result => { setAccess("allowed"); setMaxVideoBytes(result.maxVideoBytes); }).catch(cause => {
      if (!controller.signal.aborted) { setAccess("denied"); setError(errorMessage(cause)); }
    });
    return () => { controller.abort(); abort.current?.abort(); runSequence.current++; };
  }, [client]);
  function reset() {
    sequence.current++; abort.current?.abort();
    setManifest(null); setFiles({}); setSourceReviewed(false); setStage(null); setConfirmed([]); setFinalReview(false);
    setReceipt(null); setError(""); setBusy(""); setCommitAttempted(false); commitKey.current = null;
  }
  async function readManifest(file: File | undefined) {
    reset(); if (!file) return;
    const run = sequence.current;
    try {
      if (file.size > 64 * 1024) throw new Error("Oversized manifest");
      const parsed = validatePublicationManifest(JSON.parse(await file.text()));
      if (run !== sequence.current) return;
      if (parsed.content.kind === "video" && parsed.artifact.byte_length > maxVideoBytes) {
        setError(`This video exceeds the Hub's configured ${maxVideoBytes / 1024 / 1024} MiB upload limit.`); return;
      }
      setManifest(parsed);
    } catch { if (run === sequence.current) setError("Choose a valid approved DocStudio publication JSON manifest, no larger than 64 KiB."); }
  }
  async function verify() {
    if (!manifest || !sourceReviewed) return;
    const run = ++sequence.current; const controller = new AbortController(); abort.current = controller;
    setError(""); setBusy("Checking publication permissions…");
    try {
      let current = stage ?? await client.stage(manifest, controller.signal);
      if (run !== sequence.current) return; setStage(current);
      for (const part of publicationParts(manifest)) {
        if (current.uploadedParts.includes(part)) continue;
        const file = files[part]; if (!file) throw new Error("Missing file");
        const label = partLabels[part].toLowerCase();
        setBusy(`Uploading and verifying ${label}…`);
        current = await client.upload(current, part, file, controller.signal, (received, total) => {
          if (run === sequence.current) setBusy(`Uploading and verifying ${label}: ${Math.floor(received * 100 / total)}%…`);
        });
        if (run !== sequence.current) return; setStage(current);
      }
      setBusy("Checking the current catalog and placements…");
      current = await client.preview(current.id, controller.signal);
      if (run !== sequence.current) return;
      setStage(current); setConfirmed([]); setFinalReview(false); commitKey.current = crypto.randomUUID();
    } catch (cause) {
      if (run === sequence.current) setError(errorMessage(cause));
    } finally { if (run === sequence.current) setBusy(""); }
  }
  async function commit() {
    if (!stage?.plan || !commitKey.current || !finalReview) return;
    const required = publicationConfirmationIds(stage.plan);
    if (required.some(id => !confirmed.includes(id))) return;
    const run = ++sequence.current; const controller = new AbortController(); abort.current = controller;
    setError(""); setBusy("Publishing the reviewed revision…"); setCommitAttempted(true);
    try {
      const result = await client.commit(stage.id, { planIdentity: stage.plan.planIdentity, idempotencyKey: commitKey.current, confirmedActions: required, reviewConfirmed: true }, controller.signal);
      if (run === sequence.current) setReceipt(result);
    } catch (cause) {
      if (run === sequence.current) setError(cause instanceof PublicationError && cause.status < 500 ? cause.message : "The publication result could not be confirmed. Retry the same publication to retrieve its result.");
    }
    finally { if (run === sequence.current) setBusy(""); }
  }
  const required = stage?.plan ? publicationConfirmationIds(stage.plan) : [];
  const completeFiles = manifest && publicationParts(manifest).every(part => !!files[part]);
  return <div className="publication-workspace">
    <header className="page-heading"><div><p className="eyebrow">Shared knowledge</p><h1>Import from DocStudio</h1><p>Review one article or video, then publish the same revision in the selected CareMetric apps.</p></div><Link to="/knowledge" className="button button-secondary">Knowledge</Link></header>
    {access === "loading" && <p role="status">Checking publication access…</p>}
    {error && <div className="publication-notice" role="alert">{error}</div>}
    {access === "denied" && <section className="panel"><h2>Publication access is unavailable</h2><p>A current SMS session and content editor permission for every affected product are required.</p></section>}
    {access === "allowed" && <>
      {receipt ? <section className="panel publication-success" role="status"><h2>{receipt.outcome === "retired" ? "Content retired" : receipt.outcome === "unchanged" ? "Catalog already up to date" : "Publication complete"}</h2><p>Revision {receipt.revision} is recorded. Previous revisions remain preserved.</p><p>Import reference: <code>{receipt.importId}</code></p><a className="button button-primary" href="/knowledge">Open the updated catalog</a><button className="button button-secondary" onClick={reset}>Review another publication</button></section> : <>
        <section className="panel publication-package"><h2>1. Select the approved export</h2><p>Choose the manifest and its original files. Article limit: 2 MiB. Video limit configured for this Hub: {maxVideoBytes / 1024 / 1024} MiB. Captions and transcript: 10 MiB each. Storage may reject files if its project limit is lower.</p>
          <label className="publication-field">Publication manifest<input aria-label="Publication manifest" type="file" accept="application/json,.json" disabled={!!busy || !!stage} onChange={event => void readManifest(event.target.files?.[0])} /></label>
          {manifest && <>
            <dl className="publication-metadata"><div><dt>Title</dt><dd>{manifest.content.title}</dd></div><div><dt>Source</dt><dd>{manifest.source.content_key} · {manifest.source.version}</dd></div><div><dt>Access</dt><dd>{manifest.content.access_level}</dd></div><div><dt>Language</dt><dd>{manifest.content.locale}</dd></div></dl>
            <p>{manifest.content.summary}</p>
            {publicationParts(manifest).map(part => <label key={part} className="publication-field">{partLabels[part]}<input aria-label={partLabels[part]} type="file" disabled={!!busy || !!stage} accept={part === "primary" ? manifest.content.kind === "article" ? ".md,text/markdown" : ".mp4,video/mp4" : part === "captions" ? ".vtt,text/vtt" : ".txt,text/plain"} onChange={event => {
              const file = event.target.files?.[0]; const rule = publicationPartRules(manifest, part);
              setError("");
              if (file && (!file.size || file.size > rule.maxBytes || (rule.byteLength !== null && file.size !== rule.byteLength))) { setFiles(previous => ({ ...previous, [part]: undefined })); setError("The file size does not match this manifest or upload limit."); }
              else setFiles(previous => ({ ...previous, [part]: file }));
            }} /></label>)}
            {files.primary && <LocalPublicationPreview key={`${files.primary.name}:${files.primary.lastModified}`} file={files.primary} kind={manifest.content.kind} />}
            <label className="publication-check"><input type="checkbox" checked={sourceReviewed} disabled={!!busy || !!stage} onChange={event => setSourceReviewed(event.target.checked)} /><span>I reviewed the source content and its PHI-free approval, and approve this source version for the Hub. The export's approval does not grant access or replace my review.</span></label>
            {!stage?.plan && <button className="button button-primary" disabled={!!busy || !completeFiles || !sourceReviewed} onClick={() => void verify()}>{stage ? "Resume verification" : "Verify package and preview changes"}</button>}
          </>}
        </section>
        {stage?.plan && <section className="panel publication-review"><h2>2. Review the exact catalog changes</h2><p>Preview expires {new Date(stage.expiresAt).toLocaleString()}. Files are private and the catalog is unchanged until this commit succeeds.</p>
          <ol className="publication-actions">{stage.plan.actions.map((action, index) => {
            const id = `${index}:${action.type}`;
            return <li key={id}>{"requiresExplicitApproval" in action ? <label className="publication-check"><input type="checkbox" aria-label={publicationActionLabel(action)} checked={confirmed.includes(id)} disabled={!!busy || commitAttempted} onChange={event => setConfirmed(previous => event.target.checked ? [...previous, id] : previous.filter(value => value !== id))} /><span>{publicationActionLabel(action)}</span></label> : <strong>{publicationActionLabel(action)}</strong>}
              {"audience" in action && <p>Audience: {action.audience.join(", ")} · Route: {action.routePattern ?? "All routes"}</p>}
            </li>;
          })}</ol>
          <label className="publication-check"><input type="checkbox" checked={finalReview} disabled={!!busy || commitAttempted} onChange={event => setFinalReview(event.target.checked)} /><span>I approve this exact revision and every selected placement change.</span></label>
          <button className="button button-primary" disabled={!!busy || !finalReview || required.some(id => !confirmed.includes(id))} onClick={() => void commit()}>{commitAttempted ? "Retry the same publication" : "Commit reviewed publication"}</button>
          {commitAttempted && <p>A retry uses the same request key and confirmations. It cannot create a duplicate revision.</p>}
        </section>}
        {(manifest || stage) && <button className="button button-secondary" disabled={!!busy} onClick={reset}>Start a new review</button>}
        {!!busy && <p className="publication-progress" role="status">{busy}</p>}
      </>}
    </>}
  </div>;
}
