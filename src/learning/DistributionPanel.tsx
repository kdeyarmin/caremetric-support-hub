import { memo, useEffect, useMemo, useRef, useState } from "react";
import { runDistribution } from "./distributionClient";
import { distributionContextSchema, distributionPlanSchema, distributionPreviewSchema, type DistributionContext, type DistributionPlan, type DistributionPreview } from "./distributionProtocol";
import { validateGovernedCourse, type GovernedCourse } from "../imports/governedLearningImport";

type SavedRequest = { requestId: string; plan: DistributionPlan };
function materialOf(context: DistributionContext | null): GovernedCourse | null {
  try { return context?.native?.source ? validateGovernedCourse(JSON.parse(context.native.source.payload)) : null; }
  catch { return null; }
}
function failure(caught: unknown) {
  const code = caught && typeof caught === "object" && "code" in caught ? caught.code : null;
  if (code === "conflict" || code === "expired") return "The source, catalog, or review changed. Check the saved request before loading current information and reviewing a new request.";
  if (["unauthenticated", "forbidden", "401", "403"].includes(String(code))) return "A current authorized administrator session is required. Sign in again, then check the saved request.";
  if (code === "unconfigured") return "Course distribution is not enabled on this connection.";
  return "The request did not finish. Check the saved request or retry the exact same request; a lost response may follow a completed update.";
}
const MaterialReview = memo(function MaterialReview({ material }: { material: GovernedCourse }) {
  return <details><summary>Review published course material and policies</summary>
    <p><strong>{material.version.title}</strong> · Version {material.sourceVersionNumber}</p>
    <p>{material.version.description ?? material.course.description}</p>
    <p>{material.blocks.length} lessons · {material.blocks.filter(block => block.quiz).length} quizzes · {material.packages.length} packages</p>
    {material.blocks.map(block => <details key={block.id}><summary>{block.title ?? "Untitled lesson"} · {block.type}</summary>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify({ body: block.body, quiz: block.quiz, documentId: block.documentId, videoLocatorSha256: block.videoLocatorSha256 }, null, 2)}</pre>
    </details>)}
    <details><summary>Credit, renewal, provider, and package evidence</summary>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify({ course: material.course, version: material.version, credits: material.credits, provider: material.provider, packages: material.packages }, null, 2)}</pre>
    </details>
    <p>Private media remains in CareBase. This review lists retained identifiers and hashes; learners use the CareBase course runtime.</p>
  </details>;
});

export function DistributionPanel(props: { courseId: string; disabled?: boolean }) {
  return <DistributionEditor key={props.courseId.toLowerCase()} {...props} />;
}
function DistributionEditor({ courseId, disabled = false }: { courseId: string; disabled?: boolean }) {
  const [context, setContext] = useState<DistributionContext | null>(null);
  const [title, setTitle] = useState(""), [summary, setSummary] = useState(""), [category, setCategory] = useState(""), [duration, setDuration] = useState("");
  const [products, setProducts] = useState<string[]>([]), [access, setAccess] = useState<DistributionPlan["accessLevel"]>("staff");
  const [reason, setReason] = useState(""), [reviewed, setReviewed] = useState(false), [replacement, setReplacement] = useState(false), [retirements, setRetirements] = useState(false);
  const [pending, setPending] = useState<SavedRequest | null>(null), [preview, setPreview] = useState<DistributionPreview | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [message, setMessage] = useState(""), [now, setNow] = useState(Date.now);
  const life = useRef<AbortController | null>(null), inFlight = useRef(false);
  function adopt(next: DistributionContext) {
    const material = materialOf(next), metadata = next.catalog.metadata;
    setContext(next); setTitle(metadata?.title ?? material?.course.title ?? ""); setSummary(metadata?.summary ?? material?.course.description ?? "");
    setCategory(metadata?.category ?? material?.course.category ?? ""); setDuration(String(metadata?.durationMinutes ?? material?.course.estimatedDurationMinutes ?? ""));
    setProducts(next.catalog.productIds.filter(id => next.products.some(product => product.id === id && product.eligible)));
    setAccess(next.catalog.accessLevel); setReviewed(false); setReplacement(false); setRetirements(false); setConfirmed(false);
  }
  useEffect(() => {
    const controller = new AbortController(); life.current = controller;
    void runDistribution({ operation: "context", courseId }, controller.signal).then(value => {
      if (!controller.signal.aborted) adopt(distributionContextSchema.parse(value));
    }).catch(caught => { if (!controller.signal.aborted) setError(failure(caught)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [courseId]);
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    const controller = life.current;
    if (!controller || controller.signal.aborted || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setMessage("");
    try { await work(controller.signal); }
    catch (caught) { if (!controller.signal.aborted) setError(failure(caught)); }
    finally { inFlight.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  async function refresh(signal: AbortSignal) {
    const value = distributionContextSchema.parse(await runDistribution({ operation: "context", courseId }, signal));
    if (!signal.aborted) { adopt(value); setPending(null); setPreview(null); setMessage("Current published source and catalog loaded. Review them before creating another request."); }
  }
  async function receive(value: unknown, requestId: string, signal: AbortSignal, expectedPlan?: DistributionPlan) {
    const next = distributionPreviewSchema.parse(value);
    if (next.requestId !== requestId || next.plan.courseId !== courseId.toLowerCase() || (expectedPlan && JSON.stringify(next.plan) !== JSON.stringify(expectedPlan))) throw Error("Distribution receipt differs");
    if (!signal.aborted) {
      setPreview(next); setPending({ requestId: next.requestId, plan: next.plan }); setConfirmed(false);
      if (next.result) setMessage("The saved catalog distribution completed. Its original receipt is shown below.");
    }
  }
  async function resume(requestId: string, signal: AbortSignal) {
    await receive(await runDistribution({ operation: "resume", requestId }, signal), requestId, signal);
  }
  const material = useMemo(() => materialOf(context), [context]), source = context?.native?.source;
  const allowed = !!context && !!material && !!source && context.observerConfigured && (!context.catalog.legacy || context.catalog.availability.managed || context.legacyOptInAllowed);
  const locked = busy || disabled;
  const removed = context?.catalog.productIds.filter(id => !products.includes(id)) ?? [];
  const requiresReplacement = !!context && (context.catalog.status === "published" || context.catalog.productIds.length > 0);
  const eligible = context?.products.filter(product => product.eligible) ?? [];
  const productName = (id: string) => context?.products.find(product => product.id === id)?.name ?? id;
  const parsedPlan = distributionPlanSchema.safeParse({ courseId, versionId: context?.native?.currentVersionId, sourceRevision: source?.sourceRevision,
    expectedCatalogDigest: context?.catalog.catalogDigest, metadata: { title: title.trim(), summary: summary.trim(), category: category.trim() || null,
      durationMinutes: duration.trim() === "" ? null : /^\d+$/.test(duration) ? Number(duration) : -1 }, productIds: products, removedProductIds: removed,
    accessLevel: access, reason: reason.trim(), reviewed, confirmReplacement: replacement, confirmRetirements: retirements });
  const currentPreviewSource = !!preview && !!source && preview.plan.sourceRevision === source.sourceRevision && preview.plan.versionId === context?.native?.currentVersionId;
  const expired = !!preview && Date.parse(preview.expiresAt) <= now;
  const availability = context?.catalog.availability;
  const availabilityExpired = availability?.validUntil != null && Date.parse(availability.validUntil) <= now;
  function edit() { setReviewed(false); setConfirmed(false); }
  return <section className="admin-authoring" aria-label="Course distribution">
    <h3>Distribute this course across apps</h3>
    <p>Review the current published CareBase course, then publish its catalog listing to the selected apps. Assignments, completion, credits, and certificates continue through CareBase.</p>
    <button type="button" className="button button-secondary" disabled={locked} onClick={() => void action(refresh)}>Load current distribution</button>
    {busy && !context && <p role="status">Loading current course distribution…</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {context && <>
      <p>Catalog status: {context.catalog.status}. Availability: {availability?.state === "published" && availabilityExpired ? "stale" : availability?.state}.</p>
      {availability?.observedAt && <p>Last verified {new Date(availability.observedAt).toLocaleString()}{availability.validUntil ? `; valid until ${new Date(availability.validUntil).toLocaleString()}.` : "."}</p>}
      {context.catalog.legacy && !context.catalog.availability.managed && <p>This is an existing catalog listing. Managed availability begins only after an explicit reviewed distribution.</p>}
      {!context.observerConfigured && <p>Availability monitoring is not configured. New distribution is unavailable.</p>}
      {context.catalog.legacy && !context.catalog.availability.managed && !context.legacyOptInAllowed && <p>Managed distribution for existing listings is disabled on this connection.</p>}
      {!context.native && <p>CareBase could not provide current course status. Saved request receipts can still be checked.</p>}
      {context.native && !material && <p>There is no current published CareBase version available for distribution.</p>}
      {material && source && <><p>Published version {material.sourceVersionNumber} · {material.version.title}</p>
        <p style={{ overflowWrap: "anywhere" }}>Source SHA-256: {source.sourceRevision}</p><MaterialReview material={material} /></>}
      <fieldset disabled={locked || !allowed || !!pending}><legend>Reviewed catalog listing</legend>
        <label>Catalog title<input value={title} maxLength={180} onChange={event => { edit(); setTitle(event.target.value); }} /></label>
        <label>Catalog summary<textarea value={summary} maxLength={500} onChange={event => { edit(); setSummary(event.target.value); }} /></label>
        <p>Use one line of plain text for the catalog summary. Existing material above retains its original formatting.</p>
        <label>Catalog category<input value={category} maxLength={200} onChange={event => { edit(); setCategory(event.target.value); }} /></label>
        <label>Duration in minutes (optional)<input type="text" inputMode="numeric" value={duration} onChange={event => { edit(); setDuration(event.target.value); }} /></label>
        <fieldset><legend>Apps receiving this listing</legend>
          <button type="button" disabled={!eligible.length} onClick={() => { edit(); setProducts(eligible.map(product => product.id)); }}>Select all currently eligible apps</button>
          <p>Selection includes only the apps shown now. Future apps require another review.</p>
          {context.products.map(product => <label className="learning-checkbox" key={product.id}><input type="checkbox" checked={products.includes(product.id)} disabled={!product.eligible}
            onChange={event => { edit(); setProducts(ids => event.target.checked ? [...ids, product.id] : ids.filter(id => id !== product.id)); }} />{product.name}{!product.eligible ? " (unavailable for distribution)" : ""}</label>)}
        </fieldset>
        <label>Catalog visibility<select value={access} onChange={event => { edit(); setAccess(event.target.value as DistributionPlan["accessLevel"]); }}>
          <option value="staff">Staff only</option><option value="customer">Customers</option><option value="public">Public</option>
        </select></label>
        <p>Catalog visibility does not grant a learner account, course assignment, or credit entitlement.</p>
        <label>Reason for distribution<textarea value={reason} maxLength={500} onChange={event => { edit(); setReason(event.target.value); }} /></label>
        {requiresReplacement && <label className="learning-checkbox"><input type="checkbox" checked={replacement} onChange={event => setReplacement(event.target.checked)} />I confirm replacing the current or scheduled app listings.</label>}
        {!!removed.length && <><p>Listings to remove: {removed.map(productName).join(", ")}.</p>
          <label className="learning-checkbox"><input type="checkbox" checked={retirements} onChange={event => setRetirements(event.target.checked)} />I confirm removing these app listings.</label></>}
        <label className="learning-checkbox"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed this exact published material, its policies, and the catalog choices above.</label>
        <button type="button" className="button button-primary" disabled={!parsedPlan.success || (requiresReplacement && !replacement)} onClick={() => void action(async signal => {
          if (!parsedPlan.success) return;
          const saved = { requestId: crypto.randomUUID(), plan: parsedPlan.data }; setPending(saved);
          await receive(await runDistribution({ operation: "preview", ...saved }, signal), saved.requestId, signal, saved.plan);
        })}>Preview distribution</button>
        {!parsedPlan.success && <p>Review the source, choose at least one eligible app, and enter valid catalog fields and a reason of 10–500 characters.</p>}
      </fieldset>
      {pending && !preview && <div aria-label="Unconfirmed distribution request">
        <p>Request {pending.requestId} is retained with its exact reviewed choices.</p>
        <button type="button" disabled={locked || !allowed} onClick={() => void action(async signal => receive(await runDistribution({ operation: "preview", ...pending }, signal), pending.requestId, signal, pending.plan))}>Retry saved preview</button>
        <button type="button" disabled={locked} onClick={() => void action(signal => resume(pending.requestId, signal))}>Check saved request</button>
      </div>}
      {preview && <div aria-label="Distribution review">
        <h4>{preview.result ? "Completed distribution receipt" : "Confirm the saved distribution"}</h4>
        <p>{preview.plan.metadata.title} · {preview.plan.accessLevel} visibility · Version {preview.plan.versionId}</p>
        <p>{preview.plan.metadata.summary}</p><p>Category: {preview.plan.metadata.category ?? "None"}. Duration: {preview.plan.metadata.durationMinutes ?? "Unspecified"}.</p>
        <p>Apps: {preview.plan.productIds.map(productName).join(", ")}. Removed: {preview.plan.removedProductIds.length ? preview.plan.removedProductIds.map(productName).join(", ") : "None"}.</p>
        <p>{preview.replacesPublished ? "Replaces current or scheduled app listings." : "Creates a published catalog revision."}</p>
        <p>Reason: {preview.plan.reason}</p><p style={{ overflowWrap: "anywhere" }}>Reviewed source SHA-256: {preview.plan.sourceRevision}</p>
        <p>Request {preview.requestId}. Review expires {new Date(preview.expiresAt).toLocaleString()}.</p>
        {preview.result ? <p>Catalog revision {preview.result.revisionNumber} completed {new Date(preview.result.publishedAt).toLocaleString()}. Item {preview.result.itemId}.</p> : <>
          {expired && <p>This preview has expired. Check its saved receipt before reviewing a new request.</p>}
          {!currentPreviewSource && <p>The loaded current source does not match this saved review. Load current information and review a new request before publishing.</p>}
          {!preview.canCommitThisSession && !expired && <p>This saved review cannot publish from the current session. Its receipt remains readable; review a new request to make another change.</p>}
          <label className="learning-checkbox"><input type="checkbox" disabled={locked || !allowed || expired || !currentPreviewSource || !preview.canCommitThisSession} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I confirm these exact saved changes to the app catalog.</label>
          <button type="button" className="button button-primary" disabled={locked || !allowed || expired || !currentPreviewSource || !preview.canCommitThisSession || !confirmed} onClick={() => void action(async signal => receive(await runDistribution({ operation: "commit", requestId: preview.requestId, expectedDigest: preview.previewDigest }, signal), preview.requestId, signal, preview.plan))}>Publish reviewed distribution</button>
        </>}
        <button type="button" disabled={locked} onClick={() => void action(signal => resume(preview.requestId, signal))}>Check saved request</button>
      </div>}
      {pending && <><button type="button" disabled={locked} onClick={() => { setPending(null); setPreview(null); setReviewed(false); setConfirmed(false); }}>Clear local review</button><p>Clearing this local review does not cancel a saved request or undo a completed distribution.</p></>}
      <h4>Saved distribution requests</h4>
      {!context.requests.length && <p>No saved requests were returned for this course and administrator.</p>}
      {context.requests.map(saved => <div key={saved.requestId}><p>{saved.plan.metadata.title} · {saved.result ? "Completed" : Date.parse(saved.expiresAt) <= now ? "Expired review" : "Awaiting confirmation"} · Request {saved.requestId}</p>
        <button type="button" disabled={locked} onClick={() => void action(signal => resume(saved.requestId, signal))}>Review saved request {saved.requestId}</button>
      </div>)}
      {context.requests.length === 20 && <p>Showing up to 20 saved requests returned by the service.</p>}
    </>}
  </section>;
}
