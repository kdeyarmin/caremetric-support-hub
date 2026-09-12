import { useRef, useState } from "react";
import { z } from "zod";
import { requestAdmin } from "../admin/transport";
import { authoringOperationSchema, authoringInspectSchema, authoringPreviewSchema, authoringSourceViewSchema,
  projectAuthoringResult, verifyAuthoringOutcome, governedStageResultSchema, type AuthoringOperation, type AuthoringPreview,
  type AuthoringResult, type AuthoringSourceView, type DraftPatch } from "./authoringProtocol";
import { validateGovernedCourse } from "../imports/governedLearningImport";
import { DraftEditor } from "./DraftEditor";
import { StructureEditor } from "./StructureEditor";
import { CourseMediaPanel } from "./CourseMediaPanel";
import { ProviderPolicyPanel } from "./ProviderPolicyPanel";
import { StructureReview } from "./StructureReview";
import type { StructureChange } from "./structureProtocol";
import { CreditPolicyEditor } from "./CreditPolicyEditor";
import { CreditPolicyReview } from "./CreditPolicyReview";
import type { CreditPolicyChanges } from "./creditPolicyProtocol";
import { PackagePanel } from "./PackagePanel";
import { DistributionPanel } from "./DistributionPanel";

async function run(operation: AuthoringOperation) {
  const op = authoringOperationSchema.parse(operation);
  const result = await requestAdmin("learning-authoring", op, new AbortController().signal);
  if (op.operation === "preserve_source") return governedStageResultSchema.parse(result);
  const projected = await projectAuthoringResult(result, op);
  return op.operation === "source" ? authoringSourceViewSchema.parse({ ...authoringSourceViewSchema.parse(result), ...projected }) : projected;
}
export function AuthoringPanel({ courseId }: { courseId: string }) {
  const [catalog, setCatalog] = useState<z.infer<typeof authoringInspectSchema> | null>(null);
  const [versionId, setVersionId] = useState("");
  const [source, setSource] = useState<AuthoringSourceView | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [title, setTitle] = useState(""); const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<AuthoringPreview | null>(null);
  const [result, setResult] = useState<AuthoringResult | null>(null);
  const [previewPatch, setPreviewPatch] = useState<DraftPatch | null>(null);
  const [previewStructure, setPreviewStructure] = useState<StructureChange[] | null>(null);
  const [previewPolicy, setPreviewPolicy] = useState<CreditPolicyChanges | null>(null);
  const [editing, setEditing] = useState<"fields" | "structure" | "credit-policy" | "packages" | null>(null);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [working, setBusy] = useState(false); const [packageBusy, setPackageBusy] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false); const busy = working || packageBusy || mediaBusy;
  const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const intents = useRef(new Map<string, string>());
  const actionPending = useRef(false);
  const version = catalog?.versions.find(v => v.versionId === versionId);
  const material = source ? validateGovernedCourse(JSON.parse(source.payload)) : null;
  const clearPreview = () => { setPreview(null); setResult(null); setPreviewPatch(null); setPreviewStructure(null); setPreviewPolicy(null); };
  const clearSource = () => { setSource(null); setReviewed(false); setEditing(null); clearPreview(); };
  async function action(work: () => Promise<void>) {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true); setError(""); setMessage("");
    try { await work(); }
    catch (caught) {
      const code = caught && typeof caught === "object" && "code" in caught ? caught.code : "upstream";
      if (code === "conflict" || code === "expired") { intents.current.clear(); setPreview(null); }
      setError(code === "conflict" ? "The reviewed source or preview changed. Load the current material and review it again." :
        code === "invalid_request" ? "Check the form. Source preservation also requires this CareBase course to be registered in the Hub catalog." :
        code === "401" || code === "403" ? "A current administrator session in the Hub and CareBase is required." :
        "The request did not finish. Check the connection, then retry the same action. A completed native command will return its original result.");
    } finally { actionPending.current = false; setBusy(false); }
  }
  async function load() {
    const value = authoringInspectSchema.parse(await run({ operation: "inspect", courseId }));
    setCatalog(value); setVersionId(value.currentVersionId ?? value.versions[0]?.versionId ?? ""); clearSource(); intents.current.clear();
  }
  async function prepare(action: AuthoringPreview["action"], patch?: DraftPatch, changes?: StructureChange[], creditPolicy?: CreditPolicyChanges) {
    if (!source || !source.snapshotId || source.headRevision !== source.sourceRevision) throw new Error("Source review required");
    const parameters = { versionId, sourceRevision: source.sourceRevision };
    const common = { operation: "preview" as const, courseId, reason: reason.trim() };
    const intent = action === "learning.cloneVersion" ? { ...common, action, parameters: { ...parameters, title: title.trim() } }
      : action === "learning.patchDraft" ? { ...common, action, parameters: { ...parameters, patch: patch! } }
      : action === "learning.reviewDraft" ? { ...common, action, parameters: { ...parameters, reviewed: true as const } }
      : action === "learning.editStructure" ? { ...common, action, parameters: { ...parameters, changes: changes! } }
      : action === "learning.editCreditPolicy" ? { ...common, action, parameters: { ...parameters, ...creditPolicy! } }
      : { ...common, action, parameters };
    const key = JSON.stringify(intent); let requestId = intents.current.get(key);
    if (!requestId) { requestId = crypto.randomUUID(); intents.current.set(key, requestId); }
    const nextPreview = authoringPreviewSchema.parse(await run({ ...intent, requestId }));
    if ((action === "learning.patchDraft" || action === "learning.editStructure" || action === "learning.editCreditPolicy") && nextPreview.after.aiReviewRequired !== material?.version.aiGenerated) throw new Error("Draft approval state mismatch");
    setPreview(nextPreview); setPreviewPatch(action === "learning.patchDraft" ? patch! : null);
    setPreviewStructure(action === "learning.editStructure" ? changes! : null);
    setPreviewPolicy(action === "learning.editCreditPolicy" ? creditPolicy! : null); setResult(null);
  }
  return <section className="admin-authoring" aria-label="CareBase course material and version controls">
    <h3>Course material and version controls</h3>
    <p>Review course content, assessments, credit rules and provider evidence here. CareBase applies its existing publishing rules to every new version.</p>
    <button type="button" className="button button-secondary" disabled={busy} onClick={() => void action(load)}>Load course versions</button>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {catalog && <>
      <p>Showing up to 20 latest versions.</p>
      <label>Course version<select disabled={busy} value={versionId} onChange={event => { setVersionId(event.target.value); clearSource(); }}>
        {catalog.versions.map(v => <option key={v.versionId} value={v.versionId}>Version {v.versionNumber} · {v.status} · {v.title}</option>)}
      </select></label>
      {version && <><p>{version.aiReviewRequired ? "AI content requires a new review. " : ""}{version.unresolvedPackages ? `${version.unresolvedPackages} package dependencies require accepted replacement artifacts. ` : ""}</p>
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => void action(async () => {
          clearSource(); setSource(authoringSourceViewSchema.parse(await run({ operation: "source", courseId, versionId })));
        })}>Load exact course material</button></>}
    </>}
    {source && material && <>
      <div className="learning-notice"><strong>{material.version.title}</strong>
        <p>{material.blocks.length} lesson blocks · {material.blocks.reduce((n,b) => n+(b.quiz?.questions.length ?? 0),0)} assessment questions · {material.credits.length} credit rules · {material.packages.length} packages</p>
        <p>Private media locations stay in CareBase. This review includes material and policy evidence; it does not copy learner records.</p>
        <details><summary>Review course and version policy</summary><pre>{JSON.stringify({ course: material.course, version: material.version }, null, 2)}</pre></details>
        {material.blocks.map(block => <details key={block.id}><summary>{block.title || "Untitled lesson"} / {block.type}</summary><pre>{JSON.stringify(block, null, 2)}</pre>
          {["pdf", "video"].includes(block.type) && <CourseMediaPanel courseId={courseId} versionId={versionId} blockId={block.id} draft={version?.status === "draft"}
            disabled={busy || editing !== null || Boolean(preview && !result)} onBusy={setMediaBusy} onApplied={() => { clearSource(); setMessage("Media attached. Load the resulting course material and preserve it before editing."); }} />}
        </details>)}
        <details><summary>Review credits, provider evidence and packages</summary><pre>{JSON.stringify({ credits: material.credits, provider: material.provider, packages: material.packages }, null, 2)}</pre></details>
      </div>
      <label className="learning-checkbox"><input type="checkbox" disabled={busy} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed this exact version and its policy evidence for preservation in the Hub.</label>
      <button type="button" className="button button-primary" disabled={busy || !reviewed} onClick={() => void action(async () => {
        const staged = governedStageResultSchema.parse(await run({ operation: "preserve_source", courseId, versionId, sourceRevision: source.sourceRevision, expectedHeadRevision: source.headRevision, reviewed: true }));
        setSource({ ...source, snapshotId: staged.snapshotId, headRevision: staged.headRevision }); clearPreview();
        setMessage(staged.headRevision === source.sourceRevision ? "The reviewed source is preserved. You can preview a version change." : "This historical source is preserved. Load the current source before changing a version.");
      })}>Preserve reviewed source</button>
      {source.snapshotId && source.headRevision === source.sourceRevision && <div className="admin-authoring-actions">
        <label>Reason for change<textarea disabled={busy} value={reason} minLength={10} maxLength={500} onChange={event => { setReason(event.target.value); clearPreview(); }} /></label>
        {material.sourceVersionState === "published" && <><label>New draft title<input disabled={busy} value={title} maxLength={300} onChange={event => { setTitle(event.target.value); clearPreview(); }} /></label>
          <button type="button" className="button button-secondary" disabled={busy || reason.trim().length < 10 || !title.trim()} onClick={() => void action(() => prepare("learning.cloneVersion"))}>Preview new draft from this version</button></>}
        {material.sourceVersionState === "draft" && <>
          {version?.governed && <><DraftEditor key={source.sourceRevision + editorGeneration} material={material} busy={busy || Boolean(result) || (editing !== null && editing !== "fields")} reasonReady={reason.trim().length >= 10}
            onChange={() => { clearPreview(); setEditing("fields"); }} onPreview={patch => void action(() => prepare("learning.patchDraft", patch))}
            onReview={() => void action(() => prepare("learning.reviewDraft"))} publishReady={!version.aiReviewRequired && !version.unresolvedPackages}
            onPublish={() => void action(() => prepare("learning.publishVersion"))} />
            <StructureEditor key={"structure" + source.sourceRevision + editorGeneration} material={material} busy={busy || Boolean(result) || (editing !== null && editing !== "structure")}
              reasonReady={reason.trim().length >= 10} onChange={() => { clearPreview(); setEditing("structure"); }}
              onPreview={changes => void action(() => prepare("learning.editStructure", undefined, changes))} />
            <CreditPolicyEditor key={"policy" + source.sourceRevision + editorGeneration} material={material} busy={busy || Boolean(result) || (editing !== null && editing !== "credit-policy")}
              reasonReady={reason.trim().length >= 10} onChange={() => { clearPreview(); setEditing("credit-policy"); }}
              onPreview={policy => void action(() => prepare("learning.editCreditPolicy", undefined, undefined, policy))} />
            <PackagePanel key={"packages" + source.sourceRevision + editorGeneration} material={material} sourceRevision={source.sourceRevision} reason={reason}
              disabled={working || mediaBusy || Boolean(result) || (editing !== null && editing !== "packages")}
              onEditing={() => { clearPreview(); setEditing("packages"); }} onBusy={setPackageBusy}
              onChanged={receipt => { clearSource(); setMessage(`CareBase confirmed package ${receipt.packageId} as ${receipt.status}. Load course versions and preserve the new exact material before another change.`); }} />
            {editing && !result && <><p>Finish this group of edits before starting another group or approving the draft.</p>
              <button type="button" disabled={busy} onClick={() => { clearPreview(); setEditing(null); setEditorGeneration(value => value + 1); }}>Discard unsaved edits</button></>}
          </>}
          {!version?.governed && <p>Create a governed draft from the published version to edit and review its material here.</p>}
        </>}
      </div>}
    </>}
    {preview && <div className="learning-notice"><h4>Review the native change</h4>
      <p>{{ "learning.cloneVersion": "Create a new draft", "learning.publishVersion": "Publish this version", "learning.patchDraft": "Save draft edits", "learning.reviewDraft": "Approve reviewed material", "learning.editStructure": "Save lesson and assessment changes", "learning.editCreditPolicy": "Save training credit policy" }[preview.action]}: {preview.after.title}, version {preview.after.versionNumber}.</p>
      {previewPatch && <details open><summary>Review the exact field changes</summary><pre>{JSON.stringify(previewPatch, null, 2)}</pre></details>}
      {previewStructure && material && <StructureReview material={material} changes={previewStructure} />}
      {previewPolicy && material && <CreditPolicyReview material={material} changes={previewPolicy} />}
      <p>{preview.reason}</p><p>Preview expires {new Date(preview.expiresAt).toLocaleString()}.</p>
      <p>{preview.action === "learning.cloneVersion" ? "The published source stays intact. AI review and package acceptance must be completed for the new draft." :
        preview.action === "learning.publishVersion" ? "Publishing changes the version CareBase offers for new course activity." :
        preview.action === "learning.patchDraft" || preview.action === "learning.editStructure" || preview.action === "learning.editCreditPolicy" ? "These edits apply to the reviewed draft and clear its prior content approval." :
        "This records your approval of the exact saved material. Later material changes invalidate this approval."}</p>
      <button type="button" className="button button-primary" disabled={busy || Boolean(result)} onClick={() => void action(async () => {
        setResult(verifyAuthoringOutcome(await run({ operation: "apply", commandId: preview.commandId, expectedDigest: preview.previewDigest }), preview));
        setMessage("CareBase confirmed the change. Load course versions to review the result.");
      })}>Confirm and apply this change</button>
    </div>}
    {result && <p role="status">CareBase confirmed version {result.versionNumber} as {result.status}{result.replayed ? " (previously completed)" : ""}.</p>}
    <details><summary>Provider details for all course versions</summary><ProviderPolicyPanel key={courseId} courseId={courseId} onApplied={()=>{clearSource();setCatalog(null);intents.current.clear();}}/></details>
    <DistributionPanel courseId={courseId} disabled={busy} />
  </section>;
}
