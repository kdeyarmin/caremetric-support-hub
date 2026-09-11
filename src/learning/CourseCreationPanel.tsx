import { useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { requestAdmin } from "../admin/transport";
import { creationIntentSchema, creationOperationSchema, creationOptionsSchema, creationRequestSchema, creationResumeSchema,
  verifyCreationPreview, verifyCreationResult, type CreationIntent, type CreationOperation, type CreationRequest } from "./creationProtocol";

const recoverySchema = z.strictObject({ status: z.enum(["absent", "applied"]), intent: creationIntentSchema });
const ids = (): { courseId: string; versionId: string } => ({ courseId: crypto.randomUUID(), versionId: crypto.randomUUID() });
const empty = () => ({ title: "", description: "", category: "", minutes: "", trainingTypeId: "", versionTitle: "", versionDescription: "", reason: "" });
const run = (op: CreationOperation) => requestAdmin("course-creation", creationOperationSchema.parse(op), new AbortController().signal);

export function CourseCreationPanel({ onOpen }: { onOpen: (courseId: string) => void }) {
  const [open, setOpen] = useState(false); const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState(empty); const [identity, setIdentity] = useState(ids);
  const [options, setOptions] = useState<z.infer<typeof creationOptionsSchema>>({ trainingTypes: [], nextOffset: null });
  const [saved, setSaved] = useState<CreationIntent[]>([]); const [intent, setIntent] = useState<CreationIntent | null>(null);
  const [nextSaved, setNextSaved] = useState<number | null>(null);
  const [request, setRequest] = useState<CreationRequest | null>(null); const [reviewed, setReviewed] = useState(false);
  const [applyStarted, setApplyStarted] = useState(false);
  const [busy, setBusy] = useState(false); const lock = useRef(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const currentRequest = request ?? intent?.request ?? null;
  async function action(work: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await work(); }
    catch (caught) {
      const code = caught && typeof caught === "object" && "code" in caught ? caught.code : "upstream";
      setError(code === "invalid_request" || caught instanceof z.ZodError ? "Check the course fields and review reason." :
        code === "401" || code === "403" ? "A current Hub and CareBase administrator session is required. Sign in, then recover the saved request." :
        code === "conflict" ? "The review expired or the native record changed. Recover the saved request before starting another review." :
        "The request did not finish. Retry or recover this saved course request; its course identity is retained.");
    } finally { lock.current = false; setBusy(false); }
  }
  function accept(value: unknown, expected?: CreationRequest) {
    const next = creationIntentSchema.parse(value);
    if (expected && JSON.stringify(next.request) !== JSON.stringify(expected)) throw new Error("Creation request changed");
    if (next.preview) verifyCreationPreview(next.preview, next.request);
    if (next.result) { if (!next.preview) throw new Error("Missing preview"); verifyCreationResult(next.result, next.preview); }
    setIntent(next); setRequest(next.request); setSaved(rows => [next, ...rows.filter(row => row.request.requestId !== next.request.requestId)]);
    return next;
  }
  function select(next: CreationIntent) {
    const r = next.request, c = r.parameters.course, v = r.parameters.version;
    setIntent(next); setRequest(r); setIdentity({ courseId: r.courseId, versionId: r.parameters.versionId }); setReviewed(false);setApplyStarted(false);
    setForm({ title: c.title, description: c.description ?? "", category: c.category ?? "", minutes: c.estimatedDurationMinutes?.toString() ?? "",
      trainingTypeId: c.trainingTypeId ?? "", versionTitle: v.title, versionDescription: v.description ?? "", reason: r.reason });
  }
  async function load() {
    setOpen(true);
    const results = await Promise.allSettled([run({ operation: "creationOptions", offset: 0 }), run({ operation: "resume" })]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const values = results.map(result => result.status === "fulfilled" ? result.value : null);
    const resumed=creationResumeSchema.parse(values[1]);setOptions(creationOptionsSchema.parse(values[0]));setSaved(resumed.rows);setNextSaved(resumed.nextOffset);setLoaded(true);
  }
  async function preview(event: FormEvent) {
    event.preventDefault(); await action(async () => {
      const next = currentRequest ?? creationRequestSchema.parse({ operation: "preview", requestId: crypto.randomUUID(), action: "learning.createCourse",
        courseId: identity.courseId, reason: form.reason.trim(), parameters: { versionId: identity.versionId,
          course: { title: form.title.trim(), description: form.description || null, category: form.category.trim() || null,
            estimatedDurationMinutes: form.minutes ? Number(form.minutes) : null, trainingTypeId: form.trainingTypeId || null },
          version: { title: form.versionTitle.trim() || form.title.trim(), description: form.versionDescription || null } } });
      setRequest(next); setReviewed(false); accept(await run(next), next);
    });
  }
  async function recover() {
    if (!currentRequest) return;
    const recovery = recoverySchema.parse(await run({ operation: "recover", requestId: currentRequest.requestId }));
    const next = accept(recovery.intent, currentRequest);
    if (recovery.status === "applied") {
      if (!next.result || !next.registration) throw new Error("Missing recovered course");
      setMessage("The original draft is registered. Open it to continue editing.");
    } else {
      if (next.result) throw new Error("Native course state mismatch");
      setMessage("CareBase confirmed these course identities are unused. You can review the same course fields again with a new request.");
      setRequest(null); setIntent(null); setReviewed(false);setApplyStarted(false);
      // Identity and form are retained. Native absence locks prevent a second
      // course even if the original request completes concurrently.
    }
  }
  const active = Boolean(currentRequest); const fields = intent?.request ?? currentRequest;
  return <section className="admin-authoring" aria-label="Create a governed CareBase course">
    <h3>Create a governed course</h3><p>Start a shared CareBase draft, then add lessons and assessments using the course controls below.</p>
    {!open ? <button type="button" className="button button-primary" disabled={busy} onClick={() => void action(load)}>Create governed course</button> : <>
      {!loaded && <button type="button" disabled={busy} onClick={() => void action(load)}>Load creation options and saved requests</button>}
      {loaded && <>
        {saved.length > 0 && <details><summary>Recent course creation requests ({saved.length})</summary><ul>{saved.map(row => <li key={row.request.requestId}><button type="button" disabled={busy} onClick={() => select(row)}>{row.request.parameters.course.title} · {row.result ? "Created" : "Review or recovery required"}</button></li>)}</ul></details>}
        {nextSaved !== null && <button type="button" disabled={busy} onClick={() => void action(async () => {
          const page=creationResumeSchema.parse(await run({operation:"resume",offset:nextSaved}));setSaved(rows=>[...rows,...page.rows.filter(row=>!rows.some(prior=>prior.request.requestId===row.request.requestId))]);setNextSaved(page.nextOffset);
        })}>Load more saved course requests</button>}
        <form onSubmit={event => void preview(event)}><fieldset disabled={busy || active}>
          <label>New course title<input required maxLength={300} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
          <label>Course description<textarea rows={3} maxLength={12000} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
          <label>Course category<input maxLength={300} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} /></label>
          <label>Estimated minutes (optional)<input type="number" min={1} max={1440} value={form.minutes} onChange={e => setForm({ ...form, minutes: e.target.value })} /></label>
          <label>Training type (optional)<select value={form.trainingTypeId} onChange={e => setForm({ ...form, trainingTypeId: e.target.value })}><option value="">None selected</option>{options.trainingTypes.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
          {options.nextOffset !== null && <button type="button" onClick={() => void action(async () => {
            const page = creationOptionsSchema.parse(await run({ operation: "creationOptions", offset: options.nextOffset! }));
            setOptions({ trainingTypes: [...options.trainingTypes, ...page.trainingTypes.filter(row => !options.trainingTypes.some(prior => prior.id === row.id))], nextOffset: page.nextOffset });
          })}>Load more training types</button>}
          <label>First version title (defaults to course title)<input maxLength={300} value={form.versionTitle} onChange={e => setForm({ ...form, versionTitle: e.target.value })} /></label>
          <label>First version description<textarea rows={3} maxLength={12000} value={form.versionDescription} onChange={e => setForm({ ...form, versionDescription: e.target.value })} /></label>
          <label>Reason for creating this course<textarea required minLength={10} maxLength={500} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></label>
        </fieldset>{!intent?.preview && <button type="submit" className="button button-primary" disabled={busy}>{active ? "Retry original preview" : "Preview new course"}</button>}</form>
        {intent?.preview && !intent.result && <div><h4>Review new draft</h4><dl>
          <dt>Course</dt><dd>{fields?.parameters.course.title}</dd><dt>First version</dt><dd>{intent.preview.after.title}</dd>
          <dt>Publication</dt><dd>Draft · comprehensive content standard</dd><dt>Reason</dt><dd>{intent.preview.reason}</dd>
        </dl><p>Publication remains unavailable until the course passes its content, assessment, and approval checks.</p>
          <label><input type="checkbox" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)} />I reviewed these fields and want to create this draft.</label>
          <button type="button" className="button button-primary" disabled={busy || !reviewed} onClick={() => void action(async () => {
            setApplyStarted(true);
            const next = accept(await run({ operation: "apply", commandId: intent.preview!.commandId, expectedDigest: intent.preview!.previewDigest }), intent.request);
            if (!next.result || !next.registration) throw new Error("Incomplete creation"); setMessage("Draft created and registered. Open it to add course material.");
          })}>{applyStarted || intent.dispatchedAt ? "Retry original creation" : "Create reviewed draft"}</button></div>}
        {active && <div className="learning-links"><button type="button" disabled={busy} onClick={() => void action(recover)}>Recover saved course request</button>
          {!applyStarted && !intent?.dispatchedAt && !intent?.result && <button type="button" disabled={busy} onClick={() => void action(async () => {
            await run({ operation: "discard", requestId: currentRequest!.requestId });setSaved(rows => rows.filter(row => row.request.requestId !== currentRequest!.requestId));setRequest(null);setIntent(null);setIdentity(ids());setReviewed(false);
          })}>Discard undispatched review</button>}</div>}
        {intent?.result && <div><p role="status">Course created. {intent.registration?.snapshotId ? "The exact initial draft was preserved." : "Review the current material before preserving its source."}</p>
          <button type="button" className="button button-primary" disabled={busy} onClick={() => onOpen(intent.result!.courseId)}>Open created course</button>
          <button type="button" disabled={busy} onClick={() => { setIntent(null);setRequest(null);setIdentity(ids());setForm(empty());setReviewed(false);setMessage("");setApplyStarted(false); }}>Start another course</button></div>}
      </>}
    </>}{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
