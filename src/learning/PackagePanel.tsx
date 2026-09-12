import { useEffect, useRef, useState } from "react";
import { packageClient, hashPackage, type PackageClient } from "./packageClient";
import { packageOperationSchema, verifyPackageReceipt, type PackageContextView, type PackageIntent, type PackageOperation, type PackageResult } from "./packageProtocol";
import { packageError } from "./packagePresentation";
import type { GovernedCourse } from "../imports/governedLearningImport";
import "./package.css";

type StageOperation = Extract<PackageOperation, { operation: "upload" | "accept" }>;
export function PackagePanel({ material, sourceRevision, reason, disabled, onEditing, onBusy, onChanged, client = packageClient }: {
  material: GovernedCourse; sourceRevision: string; reason: string; disabled: boolean;
  onEditing: () => void; onBusy: (value: boolean) => void; onChanged: (result: PackageResult) => void; client?: PackageClient;
}) {
  const courseId = material.sourceCourseId, versionId = material.sourceVersionId;
  const [available, setAvailable] = useState<boolean | null>(null);
  const [context, setContext] = useState<PackageContextView | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [standard, setStandard] = useState<"scorm_1_2" | "scorm_2004_4th" | "xapi">("scorm_1_2");
  const [selectedPackage, setSelectedPackage] = useState("");
  const [entryPoint, setEntryPoint] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [reviewedIntents, setReviewedIntents] = useState<string[]>([]);
  const [intent, setIntent] = useState<StageOperation | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const life = useRef<AbortController | null>(null), inFlight = useRef(false), busyCallback = useRef(onBusy);
  useEffect(() => { busyCallback.current = onBusy; }, [onBusy]);
  useEffect(() => {
    const controller = new AbortController(); life.current = controller;
    void client.available(controller.signal).then(async enabled => {
      if (controller.signal.aborted) return;
      setAvailable(enabled);
      if (enabled) {
        const next = await client.context({ operation: "context", courseId, versionId, packageId: null }, controller.signal);
        if (!controller.signal.aborted) setContext(next);
      }
    }).catch(caught => { if (!controller.signal.aborted) setError(packageError(caught)); });
    return () => { controller.abort(); busyCallback.current(false); };
  }, [client, courseId, versionId, sourceRevision]);
  const locked = disabled || busy;
  const sourceReady = context?.sourcePreserved && context.sourceRevision === sourceRevision;
  const eligible = material.packages.filter(pkg => pkg.standard !== "lti_1_3" && ["pending", "validating", "rejected"].includes(pkg.validationStatus));
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    if (inFlight.current || life.current?.signal.aborted || !life.current) return;
    inFlight.current = true; setBusy(true); onBusy(true); setError(""); setMessage("");
    try { await work(life.current.signal); }
    catch (caught) { if (!life.current.signal.aborted) setError(packageError(caught)); }
    finally { inFlight.current = false; if (!life.current.signal.aborted) { setBusy(false); onBusy(false); } }
  }
  async function refresh(signal: AbortSignal) {
    const enabled = await client.available(signal);
    if (signal.aborted) return;
    setAvailable(enabled);
    if (!enabled) { setContext(null); return; }
    const value = await client.context({ operation: "context", courseId, versionId, packageId: null }, signal);
    if (!signal.aborted) { setContext(value); setReviewedIntents([]); }
  }
  function edit() { onEditing(); setIntent(null); setReviewed(false); }
  async function finish(saved: PackageIntent, signal: AbortSignal) {
    const value = verifyPackageReceipt(await client.finish({ operation: "finish", courseId, versionId, requestId: saved.requestId, operationId: saved.operationId }, signal), saved);
    if (!signal.aborted) onChanged(value);
  }
  return <section className="package-panel" aria-label="Course packages">
    <h4>Course packages</h4>
    <p>Retain an original SCORM or xAPI ZIP, then review it before accepting a separate runtime artifact. Package changes clear prior content approval. They do not publish the course or issue completion credit.</p>
    <button type="button" className="button button-secondary" disabled={locked} onClick={() => void action(refresh)}>Refresh package operations</button>
    {available === null && !error && <p role="status">Checking package connection…</p>}
    {available === false && <p>CareBase has not enabled package ingestion on this connection.</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {available && <>
      {!sourceReady && <p>Load and preserve the current exact course material before staging or finishing a package change. Saved operation status remains available.</p>}
      <fieldset disabled={locked || !sourceReady || Boolean(intent)}><legend>Original ZIP</legend>
        <label>Package standard<select value={standard} onChange={event => { edit(); setStandard(event.target.value as typeof standard); }}>
          <option value="scorm_1_2">SCORM 1.2</option><option value="scorm_2004_4th">SCORM 2004 4th edition</option><option value="xapi">xAPI</option>
        </select></label>
        <label>Original course package<input type="file" accept=".zip,application/zip" onChange={event => { edit(); setFile(event.target.files?.[0] ?? null); }} /></label>
        <p>Maximum 50 MiB compressed; CareBase also limits expanded content to 100 MiB and validates archive paths. The Hub does not execute authored ZIP content in this administrator session.</p>
        <button type="button" disabled={!file || reason.trim().length < 8} onClick={() => void action(async signal => {
          if (!file) return;
          const sourceSha256 = await hashPackage(file); if (signal.aborted) return;
          const operation = packageOperationSchema.parse({ operation: "upload", requestId: crypto.randomUUID(), courseId, versionId, sourceRevision, reason: reason.trim(), standard, sourceSha256, sourceBytes: file.size });
          if (operation.operation !== "upload") return;
          onEditing(); setIntent(operation);
        })}>Review original upload</button>
      </fieldset>
      <fieldset disabled={locked || !sourceReady || Boolean(intent)}><legend>Accept a reviewed package</legend>
        <label>Pending package<select value={selectedPackage} onChange={event => { edit(); setSelectedPackage(event.target.value); setEntryPoint(""); }}>
          <option value="">Choose a package</option>{eligible.map(pkg => <option key={pkg.id} value={pkg.id}>{pkg.standard} · {pkg.validationStatus} · {pkg.id}</option>)}
        </select></label>
        {!eligible.length && <p>No pending, validating, or rejected SCORM/xAPI packages in this preserved source.</p>}
        <label>HTML entry point (optional)<input value={entryPoint} maxLength={1024} placeholder="Leave blank to use an existing HTML entry point" onChange={event => { edit(); setEntryPoint(event.target.value); }} /></label>
        <label className="learning-checkbox"><input type="checkbox" checked={reviewed} onChange={event => { onEditing(); setReviewed(event.target.checked); }} />I reviewed the authored package content and its selected entry point before acceptance.</label>
        <button type="button" disabled={!selectedPackage || !reviewed || reason.trim().length < 8} onClick={() => void action(async () => {
          const operation = packageOperationSchema.parse({ operation: "accept", requestId: crypto.randomUUID(), courseId, versionId, packageId: selectedPackage, sourceRevision, reason: reason.trim(), entryPoint: entryPoint || null });
          if (operation.operation === "accept") { onEditing(); setIntent(operation); }
        })}>Review package acceptance</button>
      </fieldset>
      {intent && <div className="package-card" aria-label="Reviewed package request">
        <h5>{intent.operation === "upload" ? "Review original archive retention" : "Review runtime artifact acceptance"}</h5>
        <p>{intent.reason}</p><p>Preserved source SHA: {intent.sourceRevision}</p>
        {intent.operation === "upload" ? <><p>{file?.name} · {intent.sourceBytes} bytes · {intent.standard}</p><p>Original SHA-256: {intent.sourceSha256}</p></>
          : <><p>Package: {intent.packageId}</p><p>HTML entry: {intent.entryPoint ?? "An existing HTML entry selected by CareBase"}</p></>}
        <p>Staging verifies private bytes. You must separately confirm the saved operation to register the original or accept the runtime artifact.</p>
        <button type="button" className="button button-primary" disabled={locked || !sourceReady} onClick={() => void action(async signal => {
          const staged = await client.stage(intent, intent.operation === "upload" ? file : null, signal);
          if (signal.aborted) return;
          if (staged.state === "committed") { onChanged(staged.result); return; }
          setMessage("Artifact staged. Review its saved hashes below, then explicitly finish this operation.");
          await refresh(signal);
        })}>{intent.operation === "upload" ? "Stage this original ZIP" : "Stage this runtime artifact"}</button>
        <button type="button" disabled={locked} onClick={() => void action(async signal => {
          const status = await client.status({ operation: "status", courseId, versionId, requestId: intent.requestId }, signal);
          if (signal.aborted) return;
          if (status && (status.sourceRevision !== intent.sourceRevision || status.operation !== intent.operation)) throw new Error("Saved request differs");
          if (status?.result) { onChanged(status.result); return; }
          setMessage(status ? `The saved request is ${status.status}. Refresh saved operations to inspect whether its bytes are staged.` : "CareBase did not report this request. You can retry the same reviewed request.");
          await refresh(signal);
        })}>Check this request</button>
        <button type="button" disabled={locked} onClick={() => { setIntent(null); setReviewed(false); }}>Clear local review</button>
        <p>Retry uses this same request. Clearing the local review does not cancel a saved native operation.</p>
      </div>}
      {context && <div className="package-saved"><h5>Saved package operations</h5>
        {context.intents.items.length === 0 && <p>No saved package operations for this administrator and version.</p>}
        {context.intents.items.map(saved => <div className="package-card" key={saved.operationId}>
          <p><strong>{saved.operation === "upload" ? "Original upload" : "Runtime acceptance"} · {saved.state}</strong></p>
          <p>Request {saved.requestId}</p><p>Original SHA-256: {saved.sourceSha256}</p>
          {saved.runtimeSha256 && <p>Runtime SHA-256: {saved.runtimeSha256}</p>}
          {saved.entryPoint && <p>Entry point: {saved.entryPoint}</p>}
          <p>Expires {new Date(saved.expiresAt).toLocaleString()}</p>
          {saved.result ? <details><summary>Original committed receipt</summary><p>Package {saved.result.packageId} is {saved.result.status}. Result source SHA: {saved.result.sourceRevision}</p><p>This receipt does not adopt later course changes. Load and preserve current material before another edit.</p></details>
            : saved.canFinishThisSession && sourceReady ? <>
              <label className="learning-checkbox"><input type="checkbox" disabled={locked} checked={reviewedIntents.includes(saved.operationId)} onChange={event => { onEditing(); setReviewedIntents(values => event.target.checked ? [...values, saved.operationId] : values.filter(value => value !== saved.operationId)); }} />I reviewed this saved artifact and the exact hashes for this {saved.operation === "upload" ? "original registration" : "package acceptance"}.</label>
              <button type="button" className="button button-primary" disabled={locked || !reviewedIntents.includes(saved.operationId)} onClick={() => void action(signal => finish(saved, signal))}>{saved.operation === "upload" ? "Confirm original registration" : "Confirm package acceptance"}</button>
            </> : <p>This operation cannot finish with the current session or source. A prepared transfer may be incomplete; refresh status before explicitly starting another upload. Saved intents expire after 15 minutes.</p>}
        </div>)}
        {context.intents.hasMore && <p>Showing the 20 most recent package operations. Earlier requests remain subject to native retention and session rules.</p>}
      </div>}
    </>}
  </section>;
}
