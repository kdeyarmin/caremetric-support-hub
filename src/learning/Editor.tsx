import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Product } from "../domain";
import { ImportPanel } from "./ImportPanel";
import { learningApi } from "./api";
import { draftDocumentSchema, newDocument, newUnit, type Draft, type DraftDocument, type DraftUnit } from "./model";

const message = (error: unknown) => error instanceof Error ? error.message : "The request did not complete.";

export function CourseLibrary({ products }: { products: Product[] }) {
  const [allowed, setAllowed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<Awaited<ReturnType<typeof learningApi.drafts>>>([]);
  useEffect(() => { let active = true; void (async () => {
    try { const access = await learningApi.editorAccess(); const drafts = access ? await learningApi.drafts() : []; if (active) { setAllowed(access); setRows(drafts); setLoaded(true); } }
    catch (caught) { if (active) setError(message(caught)); }
  })(); return () => { active = false; }; }, []);
  return <div className="learning-workspace"><nav className="learning-links"><Link to="/learn">Browse courses</Link><Link to="/learn/my">My learning</Link></nav><header><p className="eyebrow">Shared learning library</p><h1>Create once. Teach across CareMetric.</h1><p>Create courses, upload captioned video lessons, and publish to the products you choose. The Hub handles delivery, quizzes, and completion records.</p></header>{error && <p role="alert" className="learning-error">{error}</p>}{allowed && <Link className="button button-primary" to="/library/courses/new">Create course</Link>}{loaded && !allowed && <p>Course editing requires shared content permission and two-step verification.</p>}{allowed && !rows.length && <p>No course drafts yet.</p>}{rows.map(row => <article className="panel learning-notice" key={row.itemId}><div><h2>{row.title}</h2><p>{row.published ? "Published · working draft" : "Draft"} · revision {row.draftVersion}</p></div><Link className="button button-secondary" to={`/library/courses/${row.itemId}`}>Edit course</Link></article>)}{allowed && <ImportPanel products={products} onImported={async () => setRows(await learningApi.drafts())} />}</div>;
}

export function CourseEditor({ products }: { products: Product[] }) {
  const { itemId = "new" } = useParams();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creationId] = useState(() => crypto.randomUUID());
  const [document, setDocument] = useState<DraftDocument>(() => newDocument(products.filter(p => p.status !== "retired").map(p => p.id)));
  const [allowed, setAllowed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [media, setMedia] = useState<Awaited<ReturnType<typeof learningApi.mediaList>>>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(itemId === "new");
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => { let active = true; void (async () => {
    try {
      const access = await learningApi.editorAccess();
      if (!access) { if (active) { setAllowed(false); setLoaded(true); } return; }
      const [existing, assets] = await Promise.all([itemId === "new" ? Promise.resolve(null) : learningApi.draft(itemId), learningApi.mediaList()]);
      if (active) { setAllowed(true); setLoaded(true); setMedia(assets); if (existing) { setDraft(existing); setDocument(existing.document); setDirty(false); } }
    } catch (caught) { if (active) setError(message(caught)); }
  })(); return () => { active = false; }; }, [itemId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function edit(next: DraftDocument) { setDocument(next); setDirty(true); setReviewed(false); setStatus(""); }
  function editUnit(index: number, next: DraftUnit) { edit({ ...document, units: document.units.map((unit, i) => i === index ? next : unit) }); }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const parsed = draftDocumentSchema.safeParse(document);
      if (!parsed.success) throw new Error(parsed.error.issues.map(issue => `${issue.path.join(" → ")}: ${issue.message}`).join("; "));
      const saved = await learningApi.save(draft?.itemId ?? creationId, parsed.data, draft?.draftVersion ?? 0);
      setDraft(saved); setDocument(saved.document); setDirty(false); setReviewed(false); setStatus("Draft saved.");
      if (itemId === "new") navigate(`/library/courses/${saved.itemId}`, { replace: true });
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (!draft) return;
    setBusy(true); setError("");
    try { await learningApi.publish(draft.itemId, draft.draftVersion, reviewed); setDraft({ ...draft, published: true }); setReviewed(false); setStatus("Course published. New learners will use this revision."); }
    catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  return <div className="learning-workspace"><nav className="learning-links"><Link to="/library">Course library</Link>{draft?.published && <Link to={`/learn/courses/${draft.itemId}`}>View published course</Link>}</nav><h1>{draft ? "Edit course" : "Create course"}</h1>{error && <p role="alert" className="learning-error">{error}</p>}{status && <p role="status">{status}</p>}{loaded && !allowed && <p>Shared course editing requires content permission and two-step verification.</p>}{allowed && <>
    <form onSubmit={event => void save(event)} className="learning-editor"><fieldset disabled={busy}>
      <section className="panel lesson-panel"><label>Course title<input required maxLength={180} value={document.title} onChange={e => edit({ ...document, title: e.target.value })} /></label><label>Course overview<textarea rows={5} value={document.overview} onChange={e => edit({ ...document, overview: e.target.value })} /></label><label>Summary<textarea maxLength={500} value={document.summary} onChange={e => edit({ ...document, summary: e.target.value })} /></label><div className="learning-fields"><label>Category<input maxLength={100} value={document.category} onChange={e => edit({ ...document, category: e.target.value })} /></label><label>Estimated minutes<input type="number" min={1} max={1440} value={document.durationMinutes} onChange={e => edit({ ...document, durationMinutes: Number(e.target.value) })} /></label><label>Who can enroll?<select value={document.accessLevel} onChange={e => edit({ ...document, accessLevel: e.target.value as DraftDocument["accessLevel"] })}><option value="public">Any signed-in learner</option><option value="customer">Product members</option><option value="staff">Authorized staff</option></select></label></div><fieldset><legend>Publish to products</legend>{products.filter(p => p.status !== "retired").map(product => <label className="learning-check" key={product.id}><input type="checkbox" checked={document.productIds.includes(product.id)} onChange={e => edit({ ...document, productIds: e.target.checked ? [...document.productIds, product.id] : document.productIds.filter(id => id !== product.id) })} />{product.name}</label>)}</fieldset></section>
      {document.units.map((unit, index) => <section className="panel lesson-panel" key={unit.id}><div className="learning-links"><strong>Lesson {index + 1} · {unit.type}</strong><button type="button" disabled={index === 0} onClick={() => { const units = [...document.units]; [units[index - 1], units[index]] = [units[index], units[index - 1]]; edit({ ...document, units }); }}>Move up</button><button type="button" disabled={document.units.length === 1} onClick={() => edit({ ...document, units: document.units.filter(u => u.id !== unit.id) })}>Remove lesson</button></div><label>Lesson title<input required maxLength={180} value={unit.title} onChange={e => editUnit(index, { ...unit, title: e.target.value })} /></label>
        {unit.type === "quiz" ? <QuizEditor unit={unit} onChange={value => editUnit(index, value)} /> : <label>{unit.type === "video" ? "Readable transcript" : unit.type === "attestation" ? "Attestation text" : "Lesson content"}<textarea required rows={9} value={unit.body} onChange={e => editUnit(index, { ...unit, body: e.target.value })} /></label>}
        {unit.type === "video" && <label>Approved video<select value={unit.mediaAssetId ?? ""} onChange={e => editUnit(index, { ...unit, mediaAssetId: e.target.value || null })}><option value="">Choose an uploaded video</option>{media.map(asset => <option value={asset.id} key={asset.id}>{asset.title}</option>)}</select></label>}
      </section>)}
      <div className="learning-links">{(["text", "video", "quiz", "attestation"] as const).map(type => <button type="button" key={type} disabled={document.units.length >= 150} onClick={() => edit({ ...document, units: [...document.units, newUnit(type)] })}>Add {type} lesson</button>)}</div><button className="button button-primary" type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save draft"}</button>
    </fieldset></form>
    <section className="panel lesson-panel"><h2>Publish reviewed course</h2><p>Publishing creates a new revision. Existing enrollments and completions keep their original course.</p><label className="learning-check"><input type="checkbox" checked={reviewed} disabled={busy || dirty || !draft} onChange={e => setReviewed(e.target.checked)} />I reviewed the lessons and answers for accuracy and confirm they contain no private data.</label><button className="button button-primary" disabled={busy || dirty || !reviewed || !draft} onClick={() => void publish()}>Publish course</button>{dirty && <p>Save your changes before publishing.</p>}</section>
    <MediaUpload onUploaded={async () => setMedia(await learningApi.mediaList())} />
  </>}</div>;
}

function QuizEditor({ unit, onChange }: { unit: Extract<DraftUnit, { type: "quiz" }>; onChange: (unit: Extract<DraftUnit, { type: "quiz" }>) => void }) {
  return <><label>Quiz instructions<textarea rows={4} maxLength={60000} value={unit.body} onChange={e => onChange({ ...unit, body: e.target.value })} /></label><div className="learning-fields"><label>Passing score (%)<input type="number" min={1} max={100} value={unit.passingScore} onChange={e => onChange({ ...unit, passingScore: Number(e.target.value) })} /></label><label>Attempt limit (blank for unlimited)<input type="number" min={1} max={10} value={unit.maxAttempts ?? ""} onChange={e => onChange({ ...unit, maxAttempts: e.target.value ? Number(e.target.value) : null })} /></label></div>{unit.questions.map((question, index) => <fieldset key={question.id}><legend>Question {index + 1}</legend><label>Question<input required value={question.prompt} onChange={e => onChange({ ...unit, questions: unit.questions.map(q => q.id === question.id ? { ...q, prompt: e.target.value } : q) })} /></label>{question.options.map(option => <div className="learning-option" key={option.id}><input aria-label={`Correct answer: option ${question.options.indexOf(option) + 1}`} type="radio" name={`correct-${question.id}`} checked={question.correctOptionId === option.id} onChange={() => onChange({ ...unit, questions: unit.questions.map(q => q.id === question.id ? { ...q, correctOptionId: option.id } : q) })} /><input aria-label={`Option ${question.options.indexOf(option) + 1}`} required value={option.text} onChange={e => onChange({ ...unit, questions: unit.questions.map(q => q.id === question.id ? { ...q, options: q.options.map(o => o.id === option.id ? { ...o, text: e.target.value } : o) } : q) })} /></div>)}<div className="learning-links"><button type="button" disabled={question.options.length >= 8} onClick={() => onChange({ ...unit, questions: unit.questions.map(q => q.id === question.id ? { ...q, options: [...q.options, { id: crypto.randomUUID(), text: "" }] } : q) })}>Add answer option</button><button type="button" disabled={unit.questions.length === 1} onClick={() => onChange({ ...unit, questions: unit.questions.filter(q => q.id !== question.id) })}>Remove question</button></div></fieldset>)}<button type="button" disabled={unit.questions.length >= 100} onClick={() => { const extra = newUnit("quiz"); if (extra.type === "quiz") onChange({ ...unit, questions: [...unit.questions, ...extra.questions] }); }}>Add question</button></>;
}

function MediaUpload({ onUploaded }: { onUploaded: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  async function upload(event: FormEvent) {
    event.preventDefault(); if (!files.video || !files.captions || !files.transcript) return;
    setBusy(true); setError(""); setStatus("");
    try { await learningApi.uploadMedia(title, files.video, files.captions, files.transcript, reviewed); await onUploaded(); setReviewed(false); setStatus("Video uploaded. Select it in a video lesson above."); }
    catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  return <form className="panel lesson-panel learning-editor" onSubmit={event => void upload(event)}><h2>Upload a video lesson</h2><p>Upload an MP4 with matching WebVTT captions and a text transcript. Videos are stored privately in the Hub.</p><fieldset disabled={busy}><label>Video title<input required minLength={2} maxLength={180} value={title} onChange={e => { setTitle(e.target.value); setReviewed(false); }} /></label>{(["video", "captions", "transcript"] as const).map(kind => <label key={kind}>{kind}<input required type="file" accept={kind === "video" ? ".mp4" : kind === "captions" ? ".vtt" : ".txt"} onChange={e => { setFiles({ ...files, [kind]: e.target.files?.[0] ?? null }); setReviewed(false); }} /></label>)}<label className="learning-check"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I reviewed the video, captions, and transcript and confirm they contain no private data.</label><button className="button button-secondary" disabled={!reviewed || busy} type="submit">{busy ? "Uploading…" : "Upload reviewed media"}</button></fieldset>{error && <p role="alert" className="learning-error">{error}</p>}{status && <p role="status">{status}</p>}</form>;
}
