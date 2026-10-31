import { AdminApiError } from "../admin/transport";
import type { GovernedCourse } from "../imports/governedLearningImport";
import { GenerationError, generationFailure } from "./generationClient";
import { approveAndPublish, checkVideos, CreationStopped, draftCourse, loadCourse, submitVideos, videoLessons, videosSettled,
  type CourseJob, type CreationDeps, type VideoLesson } from "./simpleCourseCreation";

/**
 * Runs one course creation outside any page, so it keeps going while the owner moves around the Hub and the page picks
 * it up again on return. The job is saved after every step; a reload resumes from the last saved step.
 */
export interface CreatorView {
  job: CourseJob | null; lessons: VideoLesson[]; preview: { course: GovernedCourse; revision: string } | null;
  busy: boolean; status: string; error: string;
}
const jobKey = "caremetric.courseCreator.job";
export const pollMs = 30_000;
// The AI call has no request ID, so a draft that was in flight when the page closed cannot be resumed safely.
const draftingWindowMs = 4 * 60_000;

function readJob(): CourseJob | null {
  try { const value = window.localStorage.getItem(jobKey); return value ? JSON.parse(value) as CourseJob : null; } catch { return null; }
}
function writeJob(job: CourseJob | null) {
  try { if (job) window.localStorage.setItem(jobKey, JSON.stringify(job)); else window.localStorage.removeItem(jobKey); } catch { /* The job still runs while the Hub stays open. */ }
}
const idle = (): CreatorView => ({ job: readJob(), lessons: [], preview: null, busy: false, status: "", error: "" });
let view: CreatorView = idle();
let run = 0;
const listeners = new Set<() => void>();
function update(patch: Partial<CreatorView>) {
  if ("job" in patch) writeJob(patch.job ?? null);
  view = { ...view, ...patch };
  for (const listener of listeners) listener();
}
export const creatorStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => view,
};

export function failureMessage(caught: unknown) {
  if (caught instanceof CreationStopped) return caught.message;
  if (caught instanceof GenerationError) return generationFailure(caught, "CareBase did not finish. Try again: nothing is created twice.");
  if (caught instanceof AdminApiError) return caught.code === "401" || caught.code === "403" ? "Your Hub sign-in has expired. Sign in again, then come back here to continue."
    : caught.code === "conflict" ? "The course changed while it was being saved. Try again." : "CareBase did not answer. Try again: nothing is created twice.";
  return "Something went wrong talking to CareBase. Try again: nothing is created twice.";
}

/** Moves the job forward from its saved step until it is ready to look over, a video fails, or a step fails. */
export async function advance(deps: CreationDeps, start: CourseJob, wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
  if (view.busy) return;
  const mine = ++run;
  const live = () => mine === run;
  update({ job: start, busy: true, error: "", status: "" });
  try {
    let current = start;
    if (current.stage === "drafting") {
      update({ status: "The AI is writing your course. This takes about two and a half minutes.", job: { ...current, draftingSince: Date.now() } });
      current = await draftCourse(deps, current);
      if (!live()) return;
      update({ job: current });
    }
    if (current.stage === "videos") {
      const lessons = videoLessons((await loadCourse(deps, current)).course);
      if (!live()) return;
      update({ lessons, status: lessons.length ? `HeyGen is making ${lessons.length} video${lessons.length === 1 ? "" : "s"}. You can leave this page; it keeps going and picks up where it left off.` : "" });
      current = await submitVideos(deps, current, lessons, job => { if (live()) update({ job }); });
      while (live() && !videosSettled(current)) { await wait(pollMs); if (!live()) return; current = await checkVideos(deps, current); update({ job: current }); }
      if (!live()) return;
      if (Object.values(current.videos).some(video => video.status === "failed")) { update({ status: "" }); return; }
      current = { ...current, stage: "ready" };
      update({ job: current });
    }
    if (current.stage === "ready") {
      update({ status: "Loading the finished course for you to look over." });
      const loaded = await loadCourse(deps, current);
      if (!live()) return;
      update({ lessons: videoLessons(loaded.course), preview: { course: loaded.course, revision: loaded.source.sourceRevision } });
    }
    update({ status: "" });
  } catch (caught) {
    if (live()) update({ status: "", error: failureMessage(caught) });
  } finally {
    if (live()) update({ busy: false });
  }
}

/** Picks up a saved job when the page opens, unless an AI draft was in flight when the page closed. */
export function resume(deps: CreationDeps) {
  const job = view.job;
  if (!job || view.busy || job.stage === "published" || view.error) return;
  if (job.stage === "drafting" && job.draftingSince && Date.now() - job.draftingSince < draftingWindowMs) {
    update({ error: "The AI may still be writing this course from before the page closed. Give it a few minutes and check the full course editor before trying again, so you don't get two copies." });
    return;
  }
  void advance(deps, job);
}

export async function publish(deps: CreationDeps) {
  const { job, preview } = view;
  if (!job || !preview || view.busy) return;
  const mine = ++run;
  update({ busy: true, error: "", status: "Publishing your course in CareBase." });
  try {
    await approveAndPublish(deps, job, preview.revision);
    if (mine === run) update({ job: { ...job, stage: "published" }, status: "" });
  } catch (caught) {
    if (mine === run) update({ status: "", error: failureMessage(caught) });
  } finally {
    if (mine === run) update({ busy: false });
  }
}

/** Forgets the current job. Anything already created stays in CareBase's course list. */
export function resetCreator() {
  run += 1;
  update({ job: null, lessons: [], preview: null, busy: false, status: "", error: "" });
}

/** Test support: rereads saved state as a fresh page load would. */
export function reloadCreatorForTest() { run += 1; view = idle(); }
