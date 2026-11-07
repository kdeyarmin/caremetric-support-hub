import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { learningApi } from "./api";
import { courseSteps, type Course, type LearnerUnit } from "./model";
import { questionOrder } from "./quizOrder";

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "The request did not complete. Please retry."; }

export function CoursePlayer() {
  const { itemId = "" } = useParams();
  const [params] = useSearchParams();
  const enrollment = params.get("enrollment");
  return <CourseSession key={`${itemId}:${enrollment ?? ""}`} itemId={itemId} enrollment={enrollment} />;
}

// Enrollment changes also invalidate pending saves, lesson selection and local playback state.
function CourseSession({ itemId, enrollment }: { itemId: string; enrollment: string | null }) {
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  // Watching state lives with the course, not the lesson panel: switching lessons unmounts the panel.
  const playback = useRef(new Map<string, { watched: boolean; furthest: number }>());
  const steps = course ? courseSteps(course) : null;
  const current = steps ? Math.min(selected ?? steps.lastOpen, steps.lastOpen) : 0;
  useEffect(() => {
    let active = true;
    void learningApi.course(itemId, enrollment).then(value => { if (active) { setCourse(value); setError(""); } }, caught => { if (active) setError(errorMessage(caught)); });
    return () => { active = false; };
  }, [itemId, enrollment, attempt]);
  async function start() {
    setBusy(true); setError("");
    try { const id = await learningApi.enroll(itemId); setCourse(await learningApi.course(itemId, id)); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return <div className="learning-workspace">
    <nav className="learning-links"><Link to="/learn">All courses</Link><Link to="/learn/my">My learning</Link></nav>
    {error && <p role="alert" className="learning-error">{error}{!course && <> <button onClick={() => { setError(""); setAttempt(value => value + 1); }}>Retry course</button></>}</p>}
    {!course ? !error && <p role="status">Loading course…</p> : <>
      <header><p className="eyebrow">{course.document.category}</p><h1>{course.document.title}</h1><p>{course.document.summary}</p><p>{course.document.durationMinutes} minutes · {course.progress.filter(p => p.completedAt).length} of {course.document.units.length} lessons completed</p></header>
      {course.document.overview && <div className="lesson-body">{course.document.overview}</div>}
      {course.completedAt && <div className="panel learning-notice"><strong>Course completed</strong><Link to={`/learn/certificates/${course.enrollmentId}`}>View completion certificate</Link></div>}
      {!course.enrollmentId ? <button className="button button-primary" disabled={busy} onClick={() => void start()}>Start course</button> :
        <div className="learning-player"><aside className="panel"><ol>{course.document.units.map((unit, index) => <li key={unit.id}><button aria-current={index === current ? "step" : undefined} disabled={index > steps!.lastOpen} title={index > steps!.lastOpen ? "Complete the earlier lessons first" : undefined} onClick={() => setSelected(index)}>{course.progress.some(p => p.unitId === unit.id && p.completedAt) ? "✓ " : ""}{unit.title}{index === steps!.postTest ? " · Post-test" : ""}</button></li>)}</ol></aside>
          <Lesson key={`${course.enrollmentId}:${course.document.units[current].id}`} course={course} unit={course.document.units[current]} playback={playback} onRefresh={async () => { setSelected(current); setCourse(await learningApi.course(itemId, course.enrollmentId)); }} onNext={() => setSelected(Math.min(current + 1, course.document.units.length - 1))} />
        </div>}
    </>}
  </div>;
}

function Lesson({ course, unit, playback, onRefresh, onNext }: { course: Course; unit: LearnerUnit; playback: { current: Map<string, { watched: boolean; furthest: number }> }; onRefresh: () => Promise<void>; onNext: () => void }) {
  const progress = course.progress.find(p => p.unitId === unit.id);
  const saved = playback.current.get(unit.id);
  // A select-all question is answered with the set of chosen options; the others with one option.
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [attested, setAttested] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [watched, setWatched] = useState(saved?.watched ?? false);
  const pending = useRef<{ serialized: string; key: string } | null>(null);
  // Learners retake a quiz as many times as they need; each attempt shows its questions in a new order.
  const attemptsSoFar = progress?.attemptCount ?? 0;
  const questions = unit.type === "quiz" ? questionOrder(unit.questions, { enrollmentId: course.enrollmentId ?? "", unitId: unit.id, attemptNumber: attemptsSoFar }) : [];
  // A first viewing must reach the end before the lesson can be marked complete.
  const mustWatch = unit.type === "video" && Boolean(unit.mediaAssetId) && !progress?.completedAt && !watched;
  async function refreshProgress() {
    setBusy(true); setError("");
    try {
      await onRefresh();
      pending.current = null;
      setRefreshPending(false);
    } catch (caught) { setError(`Your result was saved, but progress could not be refreshed. ${errorMessage(caught)}`); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (busy || refreshPending) return;
    setBusy(true); setError("");
    const serialized = JSON.stringify({ answers, attested });
    if (pending.current?.serialized !== serialized) pending.current = { serialized, key: crypto.randomUUID() };
    try {
      const result = await learningApi.submit(course.enrollmentId!, unit.id, answers, attested, pending.current.key);
      setMessage(result.score === null ? "Lesson completed." : result.passed ? `${result.score}% — passed.` : `${result.score}% — not passed. Try again: the questions are in a new order.`);
      // A new attempt starts clean.
      if (result.score !== null && !result.passed) setAnswers({});
      setRefreshPending(true);
      await refreshProgress();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return <section className="panel lesson-panel"><h2>{unit.title}</h2>
    {unit.type === "video" && unit.mediaAssetId && <PrivateVideo assetId={unit.mediaAssetId} enrollmentId={course.enrollmentId!} lockSeeking={!progress?.completedAt} initialFurthest={saved?.furthest ?? 0} onFurthest={seconds => { const entry = playback.current.get(unit.id) ?? { watched: false, furthest: 0 }; playback.current.set(unit.id, { ...entry, furthest: seconds }); }} onWatched={() => { const entry = playback.current.get(unit.id) ?? { watched: false, furthest: 0 }; playback.current.set(unit.id, { ...entry, watched: true }); setWatched(true); }} />}
    {unit.type !== "quiz" ? <div className="lesson-body">{unit.body}</div> : <>
      {unit.body && <div className="lesson-body">{unit.body}</div>}
      <p>Passing score: {unit.passingScore}%. {attemptsSoFar ? `Attempts so far: ${attemptsSoFar}. ` : ""}You can retake this quiz as many times as you need.</p>
      {questions.map((question, index) => <fieldset key={question.id} disabled={busy || refreshPending || Boolean(progress?.completedAt)}><legend>{index + 1}. {question.prompt}</legend>{question.multiple && <p><em>Select all that apply.</em></p>}{question.options.map(option => {
        const chosen = answers[question.id], picked = Array.isArray(chosen) ? chosen : [];
        return question.multiple
          ? <label className="learning-check" key={option.id}><input type="checkbox" name={question.id} checked={picked.includes(option.id)} onChange={() => setAnswers({ ...answers, [question.id]: picked.includes(option.id) ? picked.filter(id => id !== option.id) : [...picked, option.id] })} />{option.text}</label>
          : <label className="learning-check" key={option.id}><input type="radio" name={question.id} checked={chosen === option.id} onChange={() => setAnswers({ ...answers, [question.id]: option.id })} />{option.text}</label>;
      })}</fieldset>)}
    </>}
    {error && <p className="learning-error" role="alert">{error}</p>}
    {refreshPending && !busy && <button className="button button-secondary" onClick={() => void refreshProgress()}>Retry progress update</button>}
    {message && <p role="status">{message}</p>}
    {progress?.completedAt ? <button className="button button-primary" onClick={onNext}>Continue</button> : <>
      {mustWatch && <p role="status">Watch the full video to continue.</p>}
      {unit.type !== "quiz" && <label className="learning-check"><input type="checkbox" checked={attested} disabled={busy || refreshPending || mustWatch} onChange={event => setAttested(event.target.checked)} />{unit.type === "attestation" ? "I agree to the attestation above." : "I have completed this lesson."}</label>}
      <button className="button button-primary" disabled={busy || refreshPending || (unit.type === "quiz" ? unit.questions.some(q => { const answer = answers[q.id]; return Array.isArray(answer) ? answer.length === 0 : !answer; }) : !attested || mustWatch)} onClick={() => void submit()}>{busy ? "Saving…" : unit.type === "quiz" ? "Submit answers" : "Complete lesson"}</button>
    </>}
  </section>;
}

function PrivateVideo({ assetId, enrollmentId, lockSeeking, initialFurthest, onFurthest, onWatched }: { assetId: string; enrollmentId: string; lockSeeking: boolean; initialFurthest: number; onFurthest: (seconds: number) => void; onWatched: () => void }) {
  const [media, setMedia] = useState<{ video: string; captions: string } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Furthest point reached by playback; a seek past it returns there until the video has been watched.
  const furthest = useRef(initialFurthest);
  useEffect(() => {
    let active = true;
    void learningApi.media(assetId, enrollmentId).then(value => { if (active) { setMedia(value); setError(""); } }, caught => { if (active) setError(errorMessage(caught)); });
    return () => { active = false; };
  }, [assetId, enrollmentId, attempt]);
  return <div>{media && <video controls preload="metadata" crossOrigin="anonymous" src={media.video} onError={() => setError("Playback could not continue. Refresh access and resume the video.")}
    onTimeUpdate={event => { const time = event.currentTarget.currentTime; if (time > furthest.current && time - furthest.current < 2) { furthest.current = time; onFurthest(time); } }}
    onSeeking={event => { const video = event.currentTarget; if (lockSeeking && video.currentTime > furthest.current) video.currentTime = furthest.current; }}
    onEnded={onWatched}><track kind="captions" src={media.captions} srcLang="en" label="English" default /></video>}{error && <p role="alert">{error} <button onClick={() => setAttempt(attempt + 1)}>Refresh video access</button></p>}</div>;
}

export function MyLearning() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof learningApi.mine>>>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { let active = true; void learningApi.mine().then(value => { if (active) { setRows(value); setLoaded(true); } }, caught => { if (active) setError(errorMessage(caught)); }); return () => { active = false; }; }, [attempt]);
  return <div className="learning-workspace"><nav className="learning-links"><Link to="/learn">All courses</Link></nav><h1>My learning</h1>{error && <p role="alert">{error} <button onClick={() => { setError(""); setAttempt(value => value + 1); }}>Retry my learning</button></p>}{!loaded && !error && <p role="status">Loading your learning…</p>}{loaded && !rows.length && <p>You have not started a course in the Hub yet.</p>}{rows.map(row => <article className="panel learning-notice" key={row.enrollmentId}><div><h2>{row.title}</h2><p>{row.completedUnits} of {row.totalUnits} lessons completed</p></div>{row.completedAt ? <Link className="button button-secondary" to={`/learn/certificates/${row.enrollmentId}`}>Completion certificate</Link> : <Link className="button button-primary" to={`/learn/courses/${row.itemId}?enrollment=${row.enrollmentId}`}>Continue course</Link>}</article>)}</div>;
}

export function LearningCertificate() {
  const { enrollmentId = "" } = useParams();
  return <Certificate key={enrollmentId} enrollmentId={enrollmentId} />;
}

function Certificate({ enrollmentId }: { enrollmentId: string }) {
  const [certificate, setCertificate] = useState<Awaited<ReturnType<typeof learningApi.certificate>> | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { let active = true; void learningApi.certificate(enrollmentId).then(value => { if (active) setCertificate(value); }, caught => { if (active) setError(errorMessage(caught)); }); return () => { active = false; }; }, [enrollmentId, attempt]);
  return <div className="learning-workspace"><nav className="learning-links"><Link to="/learn/my">My learning</Link><button disabled={!certificate} onClick={() => window.print()}>Print certificate</button></nav>{error && <p role="alert">{error} <button onClick={() => { setError(""); setAttempt(value => value + 1); }}>Retry certificate</button></p>}{!certificate && !error && <p role="status">Loading certificate…</p>}{certificate && <section className="panel learning-certificate"><p>CareMetric Learning</p><h1>Certificate of completion</h1><h2>{certificate.learnerName}</h2><p>completed</p><h2>{certificate.courseTitle}</h2><p>{new Date(certificate.completedAt).toLocaleDateString()} · Estimated learning time: {certificate.durationMinutes} minutes</p>{certificate.finalScore != null && <p>Post-test score: {certificate.finalScore}%{certificate.passingScore != null && ` (passing score ${certificate.passingScore}%)`}</p>}<p>This certificate records course completion. It does not confer accredited continuing education credit.</p><small>Certificate {certificate.certificateId}<br />Course revision {certificate.versionId}</small></section>}</div>;
}
