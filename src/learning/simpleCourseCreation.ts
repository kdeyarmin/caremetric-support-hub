import { authoringInspectSchema, authoringPreviewSchema, authoringSourceViewSchema, governedStageResultSchema, verifyAuthoringOutcome,
  type AuthoringOperation, type AuthoringResult } from "./authoringProtocol";
import { validateGovernedCourse, type GovernedCourse } from "../imports/governedLearningImport";
import type { Avatar, GenerationOperation, GenerationResult, Voice } from "./generationProtocol";
import { generationFailure } from "./generationClient";

/**
 * One-step course creation: a title and a description become a CareBase course with a HeyGen video for every video
 * lesson, ready for the owner to look over and publish with one click. Every step uses the existing governed CareBase
 * commands: AI drafting, avatar video, source preservation, AI review and publication.
 */
export interface CreationDeps {
  author: (operation: AuthoringOperation) => Promise<unknown>;
  generate: <O extends GenerationOperation>(operation: O) => Promise<GenerationResult<O["operation"]>>;
  newId: () => string;
}
/** A stop the owner can act on; its message is written for them and shown as is. */
export class CreationStopped extends Error {}
export type VideoStatus = "pending" | "processing" | "completed" | "failed";
/** `renderFailed` means HeyGen rendered and failed, so the next try needs a new request; any other failure reuses the request. */
export interface VideoJob { requestId: string; status: VideoStatus; error?: string; renderFailed?: boolean }
/** Saved after every step, so leaving the page never loses a draft or pays twice for a video. */
export interface CourseJob {
  title: string; description: string; avatarId: string; voiceId: string;
  courseId?: string; versionId?: string;
  videos: Record<string, VideoJob>;
  stage: "drafting" | "videos" | "ready" | "published";
  /** When the AI draft was requested; the AI call cannot be repeated safely while it may still be running. */
  draftingSince?: number;
}
export interface VideoLesson { blockId: string; title: string; script: string; attached: boolean }
type Block = GovernedCourse["blocks"][number];

const publishReason = "The owner looked over this AI-written course and its videos, then published it from the one-step course creator.";
const bodyText = (block: Block, key: string) => block.body && typeof block.body === "object" && !Array.isArray(block.body)
  && typeof (block.body as Record<string, unknown>)[key] === "string" ? (block.body as Record<string, string>)[key] : "";

export function newCourseJob(title: string, description: string, avatarId: string, voiceId: string): CourseJob {
  return { title: title.trim(), description: description.trim(), avatarId, voiceId, videos: {}, stage: "drafting" };
}

/** The presenter to preselect: the one used last time, otherwise the owner's AI twin, otherwise a private avatar, otherwise the first. */
export function defaultPresenter(avatars: Avatar[], voices: Voice[], remembered?: string | null): { avatarId: string; voiceId: string } | null {
  const avatar = avatars.find(item => item.id === remembered) ?? avatars.find(item => item.aiTwin) ?? avatars.find(item => item.private) ?? avatars[0];
  if (!avatar) return null;
  const voiceId = voices.some(voice => voice.id === avatar.defaultVoiceId) ? avatar.defaultVoiceId! : voices[0]?.id;
  return voiceId ? { avatarId: avatar.id, voiceId } : null;
}

/** Step 1: CareBase's AI writes one new global draft course from the title and description. */
export async function draftCourse(deps: CreationDeps, job: CourseJob): Promise<CourseJob> {
  if (job.courseId && job.versionId) return { ...job, stage: "videos" };
  const created = await deps.generate({ operation: "ai.generateCourse", request: { generation_mode: "course", title_hint: job.title, notes: job.description } });
  return { ...job, courseId: created.courseId, versionId: created.versionId, stage: "videos" };
}

export async function loadCourse(deps: CreationDeps, job: CourseJob) {
  const source = authoringSourceViewSchema.parse(await deps.author({ operation: "source", courseId: job.courseId!, versionId: job.versionId! }));
  return { source, course: validateGovernedCourse(JSON.parse(source.payload)) };
}

/** Video lessons in lesson order, with the script the AI wrote for each. */
export function videoLessons(course: GovernedCourse): VideoLesson[] {
  return [...course.blocks].filter(block => block.type === "video").sort((a, b) => a.sortOrder - b.sortOrder)
    .map(block => ({ blockId: block.id, title: block.title || "Video lesson", script: bodyText(block, "script").trim(),
      attached: Boolean(block.mediaAsset) || block.videoLocatorSha256 !== null }))
    .filter(lesson => lesson.attached || lesson.script);
}

/**
 * Step 2: submits each video lesson that has no video yet. A render that failed gets a new request; any other retry
 * reuses its request ID, so CareBase returns the same paid HeyGen attempt instead of paying again.
 */
export async function submitVideos(deps: CreationDeps, job: CourseJob, lessons: VideoLesson[], save: (job: CourseJob) => void): Promise<CourseJob> {
  let current = job;
  for (const lesson of lessons) {
    const previous = current.videos[lesson.blockId];
    if (lesson.attached) { current = { ...current, videos: { ...current.videos, [lesson.blockId]: { requestId: previous?.requestId ?? deps.newId(), status: "completed" } } }; continue; }
    if (previous && (previous.status === "processing" || previous.status === "completed")) continue;
    const requestId = !previous || previous.renderFailed ? deps.newId() : previous.requestId;
    current = { ...current, videos: { ...current.videos, [lesson.blockId]: { requestId, status: "pending" } } };
    save(current);
    try {
      const result = await deps.generate({ operation: "video.generate", request: { course_block_id: lesson.blockId, request_id: requestId, avatar_id: current.avatarId,
        voice_id: current.voiceId, script: lesson.script, title: lesson.title, expected_video_url: null, expected_media_asset_id: null } });
      current = { ...current, videos: { ...current.videos, [lesson.blockId]: { requestId, status: result.status } } };
    } catch (caught) {
      current = { ...current, videos: { ...current.videos, [lesson.blockId]: { requestId, status: "failed",
        error: generationFailure(caught, "HeyGen did not confirm this video. Try again: the retry reuses the same paid attempt.") } } };
    }
    save(current);
  }
  return current;
}

/** Step 3: one round of status checks for the videos HeyGen is still rendering. */
export async function checkVideos(deps: CreationDeps, job: CourseJob): Promise<CourseJob> {
  const videos = { ...job.videos };
  for (const [blockId, video] of Object.entries(videos)) {
    if (video.status !== "processing") continue;
    try {
      const status = await deps.generate({ operation: "video.status", request: { course_block_id: blockId } });
      if (status.status === "completed") videos[blockId] = { ...video, status: "completed" };
      else if (status.status === "failed") videos[blockId] = { ...video, status: "failed", renderFailed: true, error: status.error ?? "HeyGen could not make this video." };
    } catch { /* CareBase also finishes renders on its own schedule; check again next round. */ }
  }
  return { ...job, videos };
}

export const videosSettled = (job: CourseJob) => Object.values(job.videos).every(video => video.status === "completed" || video.status === "failed");

/** Inspects the draft and preserves its exact current material, as every CareBase command requires. */
async function preserveCurrent(deps: CreationDeps, job: CourseJob) {
  const catalog = authoringInspectSchema.parse(await deps.author({ operation: "inspect", courseId: job.courseId! }));
  const version = catalog.versions.find(item => item.versionId.toLowerCase() === job.versionId!.toLowerCase());
  if (!version || version.status !== "draft") throw new CreationStopped("This course is no longer a draft. Open it in the full course editor.");
  if (!version.governed) throw new CreationStopped("CareBase did not create this draft for review. Open it in the full course editor.");
  if (version.unresolvedPackages > 0) throw new CreationStopped("This course needs its packages replaced in the full course editor before it can be published.");
  const source = authoringSourceViewSchema.parse(await deps.author({ operation: "source", courseId: job.courseId!, versionId: job.versionId! }));
  const staged = governedStageResultSchema.parse(await deps.author({ operation: "preserve_source", courseId: job.courseId!, versionId: job.versionId!,
    sourceRevision: source.sourceRevision, expectedHeadRevision: source.headRevision, reviewed: true }));
  if (staged.headRevision !== source.sourceRevision) throw new CreationStopped("The course changed while it was being saved. Look it over again, then publish.");
  return { version, sourceRevision: source.sourceRevision };
}

async function command(deps: CreationDeps, job: CourseJob, action: "learning.reviewDraft" | "learning.publishVersion", sourceRevision: string): Promise<AuthoringResult> {
  const parameters = action === "learning.reviewDraft" ? { versionId: job.versionId!, sourceRevision, reviewed: true as const } : { versionId: job.versionId!, sourceRevision };
  const preview = authoringPreviewSchema.parse(await deps.author({ operation: "preview", requestId: deps.newId(), courseId: job.courseId!, action, parameters, reason: publishReason } as AuthoringOperation));
  return verifyAuthoringOutcome(await deps.author({ operation: "apply", commandId: preview.commandId, expectedDigest: preview.previewDigest }), preview);
}

/**
 * Step 4, after the owner looks the course over and clicks Publish: approves the AI content, then publishes. It refuses
 * if the material changed since the owner looked at it.
 */
export async function approveAndPublish(deps: CreationDeps, job: CourseJob, reviewedRevision: string): Promise<AuthoringResult> {
  let state = await preserveCurrent(deps, job);
  if (state.sourceRevision !== reviewedRevision) throw new CreationStopped("The course changed since you looked at it. Look it over again, then publish.");
  if (state.version.aiReviewRequired) {
    await command(deps, job, "learning.reviewDraft", state.sourceRevision);
    state = await preserveCurrent(deps, job);
  }
  const published = await command(deps, job, "learning.publishVersion", state.sourceRevision);
  if (published.status !== "published") throw new CreationStopped("CareBase did not publish the course.");
  return published;
}
