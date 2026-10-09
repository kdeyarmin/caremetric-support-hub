import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { learningApi } from "./api";
import { courseSteps, type Course, type LearnerUnit } from "./model";

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "The request did not complete. Please retry."; }

export function CoursePlayer() {
  const { itemId = "" } = useParams();
  const [params] = useSearchParams();
  const enrollment = params.get("enrollment");
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const steps = course ? courseSteps(course) : null;
  const current = steps ? Math.min(selected ?? steps.lastOpen, steps.lastOpen) : 0;
  useEffect(() => {
    let active = true;
    void learningApi.course(itemId, enrollment).then(value => { if (active) { setCourse(value); setError(""); } }, caught => { if (active) setError(errorMessage(caught)); });
    return () => { active = false; };
  }, [itemId, enrollment]);
  async function start() {
    setBusy(true); setError("");
    try { const id = await learningApi.enroll(itemId); setCourse(await learningApi.course(itemId, id)); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return <div className="learning-workspace">
    <nav className="learning-links"><Link to="/learn">All courses</Link><Link to="/learn/my">My learning</Link></nav>
    {error && <p role="alert" className="learning-error">{error}</p>}
    {!course ? <p>Loading course…</p> : <>
      <header><p className="eyebrow">{course.document.category}</p><h1>{course.document.title}</h1><p>{course.document.summary}</p><p>{course.document.durationMinutes} minutes · {course.progress.filter(p => p.completedAt).length} of {course.document.units.length} lessons completed</p></header>
      {course.document.overview && <div className="lesson-body">{course.document.overview}</div>}
      {course.completedAt && <div className="panel learning-notice"><strong>Course completed</strong><Link to={`/learn/certificates/${course.enrollmentId}`}>View completion certificate</Link></div>}
      {!course.enrollmentId ? <button className="button button-primary" disabled={busy} onClick={() => void start()}>Start course</button> :
        <div className="learning-player"><aside className="panel"><ol>{course.document.units.map((unit, index) => <li key={unit.id}><button aria-current={index === current ? "step" : undefined} disabled={index > steps!.lastOpen} title={index > steps!.lastOpen ? "Complete the earlier lessons first" : undefined} onClick={() => setSelected(index)}>{course.progress.some(p => p.unitId === unit.id && p.completedAt) ? "✓ " : ""}{unit.title}{index === steps!.postTest ? " · Post-test" : ""}</button></li>)}</ol></aside>
          <Lesson key={`${course.enrollmentId}:${course.document.units[current].id}`} course={course} unit={course.document.units[current]} onRefresh={async () => { setSelected(current); setCourse(await learningApi.course(itemId, course.enrollmentId)); }} onNext={() => setSelected(Math.min(current + 1, course.document.units.length - 1))} />
        </div>}
    </>}
  </div>;
}

function Lesson({ course, unit, onRefresh, onNext }: { course: Course; unit: LearnerUnit; onRefresh: () => Promise<void>; onNext: () => void }) {
  const progress = course.progress.find(p => p.unitId === unit.id);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [attested, setAttested] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [watched, setWatched] = useState(false);
  const pending = useRef<{ serialized: string; key: string } | null>(null);
  const exhausted = unit.type === "quiz" && unit.maxAttempts !== null && (progress?.attemptCount ?? 0) >= unit.maxAttempts;
  // A first viewing must reach the end before the lesson can be marked complete.
  const mustWatch = unit.type === "video" && Boolean(unit.mediaAssetId) && !progress?.completedAt && !watched;
  async function submit() {
    setBusy(true); setError("");
    const serialized = JSON.stringify({ answers, attested });
    if (pending.current?.serialized !== serialized) pending.current = { serialized, key: crypto.randomUUID() };
    try {
      const result = await learningApi.submit(course.enrollmentId!, unit.id, answers, attested, pending.current.key);
      setMessage(result.score === null ? "Lesson completed." : `${result.score}% — ${result.passed ? "passed" : "not passed"}.`);
      await onRefresh();
      pending.current = null;
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return <section className="panel lesson-panel"><h2>{unit.title}</h2>
    {unit.type === "video" && unit.mediaAssetId && <PrivateVideo assetId={unit.mediaAssetId} enrollmentId={course.enrollmentId!} lockSeeking={!progress?.completedAt} onWatched={() => setWatched(true)} />}
    {unit.type !== "quiz" ? <div className="lesson-body">{unit.body}</div> : <>
      {unit.body && <div className="lesson-body">{unit.body}</div>}
      <p>Passing score: {unit.passingScore}%. Attempts used: {progress?.attemptCount ?? 0}{unit.maxAttempts === null ? " (unlimited)" : ` of ${unit.maxAttempts}`}.</p>
      {unit.questions.map((question, index) => <fieldset key={question.id} disabled={busy || Boolean(progress?.completedAt) || exhausted}><legend>{index + 1}. {question.prompt}</legend>{question.options.map(option => <label className="learning-check" key={option.id}><input type="radio" name={question.id} checked={answers[question.id] === option.id} onChange={() => setAnswers({ ...answers, [question.id]: option.id })} />{option.text}</label>)}</fieldset>)}
    </>}
    {error && <p className="learning-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {progress?.completedAt ? <button className="button button-primary" onClick={onNext}>Continue</button> : exhausted ? <p role="status">Attempt limit reached. Contact your educator for help.</p> : <>
      {mustWatch && <p role="status">Watch the full video to continue.</p>}
      {unit.type !== "quiz" && <label className="learning-check"><input type="checkbox" checked={attested} disabled={busy || mustWatch} onChange={event => setAttested(event.target.checked)} />{unit.type === "attestation" ? "I agree to the attestation above." : "I have completed this lesson."}</label>}
      <button className="button button-primary" disabled={busy || (unit.type === "quiz" ? unit.questions.some(q => !answers[q.id]) : !attested)} onClick={() => void submit()}>{busy ? "Saving…" : unit.type === "quiz" ? "Submit answers" : "Complete lesson"}</button>
    </>}
  </section>;
}

function PrivateVideo({ assetId, enrollmentId, lockSeeking, onWatched }: { assetId: string; enrollmentId: string; lockSeeking: boolean; onWatched: () => void }) {
  const [media, setMedia] = useState<{ video: string; captions: string } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Furthest point reached by playback; a seek past it returns there until the video has been watched.
  const furthest = useRef(0);
  useEffect(() => {
    let active = true;
    void learningApi.media(assetId, enrollmentId).then(value => { if (active) { setMedia(value); setError(""); } }, caught => { if (active) setError(errorMessage(caught)); });
    return () => { active = false; };
  }, [assetId, enrollmentId, attempt]);
  return <div>{media && <video controls preload="metadata" crossOrigin="anonymous" src={media.video} onError={() => setError("Playback could not continue. Refresh access and resume the video.")}
    onTimeUpdate={event => { const time = event.currentTarget.currentTime; if (time > furthest.current && time - furthest.current < 2) furthest.current = time; }}
    onSeeking={event => { const video = event.currentTarget; if (lockSeeking && video.currentTime > furthest.current + 1) video.currentTime = furthest.current; }}
    onEnded={onWatched}><track kind="captions" src={media.captions} srcLang="en" label="English" default /></video>}{error && <p role="alert">{error} <button onClick={() => setAttempt(attempt + 1)}>Refresh video access</button></p>}</div>;
}

export function MyLearning() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof learningApi.mine>>>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { let active = true; void learningApi.mine().then(value => { if (active) { setRows(value); setLoaded(true); } }, caught => { if (active) setError(errorMessage(caught)); }); return () => { active = false; }; }, []);
  return <div className="learning-workspace"><nav className="learning-links"><Link to="/learn">All courses</Link></nav><h1>My learning</h1>{error && <p role="alert">{error}</p>}{loaded && !rows.length && <p>You have not started a course in the Hub yet.</p>}{rows.map(row => <article className="panel learning-notice" key={row.enrollmentId}><div><h2>{row.title}</h2><p>{row.completedUnits} of {row.totalUnits} lessons completed</p></div>{row.completedAt ? <Link className="button button-secondary" to={`/learn/certificates/${row.enrollmentId}`}>Completion certificate</Link> : <Link className="button button-primary" to={`/learn/courses/${row.itemId}?enrollment=${row.enrollmentId}`}>Continue course</Link>}</article>)}</div>;
}

export function LearningCertificate() {
  const { enrollmentId = "" } = useParams();
  const [certificate, setCertificate] = useState<Awaited<ReturnType<typeof learningApi.certificate>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { let active = true; void learningApi.certificate(enrollmentId).then(value => { if (active) setCertificate(value); }, caught => { if (active) setError(errorMessage(caught)); }); return () => { active = false; }; }, [enrollmentId]);
  return <div className="learning-workspace"><nav className="learning-links"><Link to="/learn/my">My learning</Link><button onClick={() => window.print()}>Print certificate</button></nav>{error && <p role="alert">{error}</p>}{certificate && <section className="panel learning-certificate"><p>CareMetric Learning</p><h1>Certificate of completion</h1><h2>{certificate.learnerName}</h2><p>completed</p><h2>{certificate.courseTitle}</h2><p>{new Date(certificate.completedAt).toLocaleDateString()} · Estimated learning time: {certificate.durationMinutes} minutes</p>{certificate.finalScore != null && <p>Post-test score: {certificate.finalScore}%{certificate.passingScore != null && ` (passing score ${certificate.passingScore}%)`}</p>}<p>This certificate records course completion. It does not confer accredited continuing education credit.</p><small>Certificate {certificate.certificateId}<br />Course revision {certificate.versionId}</small></section>}</div>;
}
