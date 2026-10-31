import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { CheckCircle2, Clock3, LoaderCircle, Sparkles, Video } from "lucide-react";
import { Link } from "react-router-dom";
import { config } from "../lib/config";
import type { GovernedCourse } from "../imports/governedLearningImport";
import { runAuthoring } from "./authoringClient";
import { runGeneration } from "./generationClient";
import type { Avatar, Voice } from "./generationProtocol";
import { advance, creatorStore, failureMessage, publish, resetCreator, resume } from "./courseCreatorRunner";
import { defaultPresenter, newCourseJob, type CreationDeps } from "./simpleCourseCreation";
import "./courseCreator.css";

const presenterKey = "caremetric.courseCreator.presenter";
const fullEditor = "/admin/apps?product=carebase&view=courses";
const liveDeps: CreationDeps = {
  author: runAuthoring,
  generate: operation => runGeneration(operation, new AbortController().signal),
  newId: () => crypto.randomUUID(),
};
const lessonKind: Record<GovernedCourse["blocks"][number]["type"], string> = { text: "Reading", video: "Video", pdf: "Document", scorm: "Package", quiz: "Quiz", attestation: "Sign-off" };

/** Title and description in; a finished CareBase course with HeyGen videos out, published when the owner clicks Publish. */
export function SimpleCourseCreator({ deps = liveDeps }: { deps?: CreationDeps }) {
  const { job, lessons, preview, busy, status, error } = useSyncExternalStore(creatorStore.subscribe, creatorStore.snapshot);
  const [title, setTitle] = useState(""); const [description, setDescription] = useState("");
  const [presenters, setPresenters] = useState<{ avatars: Avatar[]; voices: Voice[] } | null>(null);
  const [avatarId, setAvatarId] = useState(""); const [optionsError, setOptionsError] = useState("");

  useEffect(() => {
    if (config.demoMode) return;
    resume(deps);
    let active = true;
    deps.generate({ operation: "video.options", request: {} }).then(options => {
      if (!active) return;
      let remembered: string | null = null; try { remembered = window.localStorage.getItem(presenterKey); } catch { /* No saved presenter. */ }
      setPresenters(options); setAvatarId(defaultPresenter(options.avatars, options.voices, remembered)?.avatarId ?? "");
    }).catch(caught => { if (active) setOptionsError(failureMessage(caught)); });
    return () => { active = false; };
  }, [deps]);

  function start(event: FormEvent) {
    event.preventDefault();
    const presenter = presenters?.avatars.find(avatar => avatar.id === avatarId);
    const choice = presenters && presenter ? defaultPresenter([presenter], presenters.voices) : null;
    if (!choice || !title.trim() || description.trim().length < 20) return;
    try { window.localStorage.setItem(presenterKey, choice.avatarId); } catch { /* Preselection is a convenience. */ }
    void advance(deps, newCourseJob(title, description, choice.avatarId, choice.voiceId));
  }
  const failed = job ? Object.entries(job.videos).filter(([, video]) => video.status === "failed") : [];
  const ready = Boolean(presenters && avatarId && title.trim() && description.trim().length >= 20);
  const madeVideos = job ? Object.values(job.videos).filter(video => video.status === "completed").length : 0;

  return <section className="panel course-creator" aria-labelledby="course-creator-title">
    <div className="panel-heading"><div><h2 id="course-creator-title"><Sparkles size={18} aria-hidden="true" /> Create a course</h2>
      <p>Give it a title and describe what it should teach. The AI writes the lessons and quiz, HeyGen makes the videos, and you publish it with one click.</p></div></div>
    <div className="panel-body">
      {!job && <form className="course-creator-form" onSubmit={start}>
        <label>Course title<input value={title} maxLength={300} onChange={event => setTitle(event.target.value)} placeholder="e.g. Fall prevention for home care aides" disabled={busy} /></label>
        <label>What should the course teach?<textarea value={description} rows={5} maxLength={4000} onChange={event => setDescription(event.target.value)} disabled={busy}
          placeholder="Who it is for, what they need to learn, and anything it must cover. A few sentences is enough." /></label>
        {presenters && <label>Video presenter<select value={avatarId} onChange={event => setAvatarId(event.target.value)} disabled={busy}>
          {presenters.avatars.map(avatar => <option key={avatar.id} value={avatar.id}>{avatar.name ?? avatar.id}{avatar.aiTwin ? " (your AI twin)" : ""}</option>)}</select></label>}
        {config.demoMode && <p className="muted">Sign in to the live Hub to create courses. The preview cannot reach CareBase or HeyGen.</p>}
        {!config.demoMode && !presenters && !optionsError && <p className="muted" role="status"><LoaderCircle className="spin" size={14} /> Loading your HeyGen presenters…</p>}
        {optionsError && <p className="form-message form-error" role="alert">{optionsError}</p>}
        <div className="button-row"><button className="button button-primary" disabled={busy || !ready}><Sparkles size={17} /> Create course</button>
          {title.trim() && description.trim().length < 20 && <span className="muted">Describe the course in at least a sentence.</span>}</div>
      </form>}

      {job && job.stage !== "published" && <div className="course-creator-progress">
        <h3>{job.title}</h3>
        <ol className="course-creator-steps">
          <li className={job.stage === "drafting" ? "active" : "done"}>{job.stage === "drafting" ? <LoaderCircle className={busy ? "spin" : ""} size={16} /> : <CheckCircle2 size={16} />} Write the lessons and quiz</li>
          <li className={job.stage === "videos" ? "active" : job.stage === "drafting" ? "" : "done"}>
            {job.stage === "videos" ? <LoaderCircle className={busy ? "spin" : ""} size={16} /> : job.stage === "drafting" ? <Clock3 size={16} /> : <CheckCircle2 size={16} />}
            Make the videos{lessons.length ? ` (${madeVideos} of ${lessons.length} done)` : ""}</li>
          <li className={job.stage === "ready" ? "active" : ""}>{job.stage === "ready" ? <CheckCircle2 size={16} /> : <Clock3 size={16} />} Look it over and publish</li>
        </ol>
        {status && <p role="status" className="muted">{status}</p>}
        {failed.length > 0 && !busy && <div className="course-creator-alert" role="alert">
          <strong>{failed.length} video{failed.length === 1 ? "" : "s"} could not be made.</strong>
          <ul>{failed.map(([blockId, video]) => <li key={blockId}>{lessons.find(lesson => lesson.blockId === blockId)?.title ?? "Video lesson"}: {video.error}</li>)}</ul>
          <div className="button-row"><button type="button" className="button button-primary" onClick={() => void advance(deps, job)}>Try the videos again</button>
            <button type="button" className="button button-secondary" onClick={() => void advance(deps, { ...job, stage: "ready" })}>Continue without them</button></div>
        </div>}
      </div>}

      {preview && job?.stage === "ready" && <div className="course-creator-preview">
        <p className="muted">Here is the course the AI wrote. Open any lesson to read it. Nothing is live until you publish.</p>
        {preview.course.version.description && <p>{preview.course.version.description}</p>}
        <ol className="course-creator-lessons">{[...preview.course.blocks].sort((a, b) => a.sortOrder - b.sortOrder).map(block => {
          const body = block.body && typeof block.body === "object" && !Array.isArray(block.body) ? block.body as Record<string, unknown> : {};
          const text = [body.content, body.script, body.attestation_text].find(value => typeof value === "string") as string | undefined;
          const lesson = lessons.find(item => item.blockId === block.id);
          return <li key={block.id}><details><summary><strong>{block.title || "Untitled lesson"}</strong> <span className="muted">{lessonKind[block.type]}
            {block.type === "video" && (lesson?.attached ? <> · <Video size={13} aria-hidden="true" /> video ready</> : " · no video")}
            {block.quiz ? ` · ${block.quiz.questions.length} question${block.quiz.questions.length === 1 ? "" : "s"}` : ""}</span></summary>
            {text && <p className="manual-body">{text}</p>}
            {block.quiz && <ol>{block.quiz.questions.map(question => <li key={question.id}>{question.prompt}</li>)}</ol>}
          </details></li>;
        })}</ol>
        <div className="button-row"><button type="button" className="button button-primary" disabled={busy} onClick={() => void publish(deps)}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <CheckCircle2 size={17} />} Publish course</button>
          <Link className="button button-secondary" to={fullEditor}>Edit in the full course editor</Link></div>
      </div>}

      {job?.stage === "published" && <div className="course-creator-done" role="status"><CheckCircle2 size={20} aria-hidden="true" />
        <div><strong>{job.title} is published.</strong><p>Learners can take it in CareBase now.</p></div></div>}

      {error && <p className="form-message form-error" role="alert">{error}</p>}
      {error && job && job.stage !== "published" && !busy && <div className="button-row"><button type="button" className="button button-primary" onClick={() => void advance(deps, job)}>Try again</button></div>}
      {job && !busy && <div className="button-row course-creator-reset"><button type="button" className="text-link" onClick={() => { resetCreator(); setTitle(""); setDescription(""); }}>
        {job.stage === "published" ? "Create another course" : "Start a different course"}</button>
        {job.stage !== "published" && job.courseId && <span className="muted">The draft so far stays in the full course editor.</span>}</div>}
    </div>
  </section>;
}
