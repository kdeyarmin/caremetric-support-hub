import { vi } from "vitest";
import fixture from "../../imports/fixtures/governedCourse.json";
import type { AuthoringOperation } from "../authoringProtocol";
import type { GenerationOperation } from "../generationProtocol";
import type { CreationDeps } from "../simpleCourseCreation";

/** A fake CareBase for the one-step course creator: an AI draft with two video lessons, HeyGen renders, review and publication. */
export const courseId = fixture.sourceCourseId, versionId = fixture.sourceVersionId;
export const firstVideo = fixture.blocks.find(block => block.type === "video")!;
export const secondVideoId = "99300000-0000-0000-0000-000000000007";
export const revision = (n: number) => String(n).repeat(64).slice(0, 64);
const linked = firstVideo.videoLocatorSha256;

/** The AI draft: two video lessons with scripts; `attached` lists the lessons whose video is done. */
export const draftPayload = (attached: string[] = []) => ({ ...fixture, sourceVersionState: "draft", blocks: [
  ...fixture.blocks.map(block => block.type === "video" ? { ...block, videoLocatorSha256: attached.includes(block.id) ? linked : null } : block),
  { ...firstVideo, id: secondVideoId, sortOrder: 6, title: "Second video", body: { script: "Second script", estimated_minutes: 3 }, videoLocatorSha256: attached.includes(secondVideoId) ? linked : null },
] });

let ids = 0;
export const newId = () => `aaaaaaaa-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

export function fakeCareBase({ aiReviewRequired = true, renderImmediately = true, withVideoLessons = true } = {}) {
  let head = 1, needsReview = aiReviewRequired, published = false;
  const attached: string[] = [];
  const calls: string[] = [];
  const version = () => ({ versionId, versionNumber: 2, title: fixture.version.title, status: published ? "published" : "draft", sourceRevision: revision(head),
    governed: true, aiReviewRequired: needsReview, unresolvedPackages: 0 });
  const author = vi.fn(async (op: AuthoringOperation): Promise<unknown> => {
    calls.push(op.operation === "preview" ? `preview ${op.action}` : op.operation);
    if (op.operation === "inspect") return { courseId, title: fixture.version.title, currentVersionId: null, versions: [version()] };
    if (op.operation === "source") {
      const payload = draftPayload(attached);
      const course = withVideoLessons ? payload : { ...payload, blocks: payload.blocks.filter(block => block.type !== "video") };
      return { courseId, versionId, sourceRevision: revision(head), payload: JSON.stringify(course), headRevision: null, snapshotId: null };
    }
    if (op.operation === "preserve_source") return { snapshotId: newId(), sourceRevision: op.sourceRevision, headRevision: revision(head), sequence: head, replayed: false };
    if (op.operation === "preview") {
      const before = { courseId, versionId, sourceRevision: op.parameters.sourceRevision, status: "draft", title: fixture.version.title, versionNumber: 2, aiReviewRequired: needsReview, currentVersionId: null };
      const after = op.action === "learning.publishVersion" ? { ...before, status: "published", currentVersionId: versionId }
        : { courseId, versionId, status: "draft", title: fixture.version.title, versionNumber: 2, aiReviewRequired: false, currentVersionId: null };
      return { commandId: newId(), courseId, action: op.action, reason: op.reason, previewDigest: "d".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), before, after };
    }
    if (op.operation === "apply") {
      const action = calls.filter(call => call.startsWith("preview")).at(-1)!.slice("preview ".length);
      if (action === "learning.reviewDraft") { needsReview = false; head += 1; } else published = true;
      return { commandId: op.commandId, courseId, action, versionId, versionNumber: 2, status: published ? "published" : "draft", appliedAt: new Date().toISOString(), replayed: false,
        ...(action === "learning.reviewDraft" ? { sourceRevision: revision(head) } : {}) };
    }
    throw new Error("unexpected authoring operation");
  });
  const generate = vi.fn(async (op: GenerationOperation): Promise<unknown> => {
    calls.push(op.operation);
    if (op.operation === "ai.generateCourse") return { courseId, versionId, generationId: newId() };
    if (op.operation === "video.options") return { avatars: [
      { id: "stock", name: "Stock presenter", gender: null, aiTwin: false, private: false, defaultVoiceId: "v1" },
      { id: "twin", name: "Owner", gender: null, aiTwin: true, private: true, defaultVoiceId: "v2" },
    ], voices: [{ id: "v1", name: null, language: null, gender: null }, { id: "v2", name: null, language: null, gender: null }] };
    if (op.operation === "video.generate") {
      if (renderImmediately) { attached.push(op.request.course_block_id); head += 1; }
      return { attemptId: newId(), status: renderImmediately ? "completed" : "processing", reused: false };
    }
    if (op.operation === "video.status") return { status: "processing", error: null };
    throw new Error("unexpected generation operation");
  });
  const deps: CreationDeps = { author, generate: generate as unknown as CreationDeps["generate"], newId };
  return { author, generate, deps, calls, setHead: (n: number) => { head = n; } };
}
