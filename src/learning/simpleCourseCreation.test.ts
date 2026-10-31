import { describe, expect, it, vi } from "vitest";
import { validateGovernedCourse } from "../imports/governedLearningImport";
import { GenerationError } from "./generationClient";
import type { GenerationOperation } from "./generationProtocol";
import { courseId, draftPayload, fakeCareBase, firstVideo, newId, revision, secondVideoId, versionId } from "./testFixtures/courseCreator";
import { approveAndPublish, checkVideos, defaultPresenter, draftCourse, loadCourse, newCourseJob, submitVideos, videoInstruction, videoLessons, videosSettled,
  type CreationDeps } from "./simpleCourseCreation";

function deps(generate: (op: GenerationOperation) => unknown, author: CreationDeps["author"] = vi.fn()): CreationDeps {
  return { author, generate: vi.fn(async (op: GenerationOperation) => generate(op)) as unknown as CreationDeps["generate"], newId };
}

describe("one-step course creation", () => {
  it("asks CareBase's AI for the whole course from the title and the owner's specific asks, always with video lessons", async () => {
    const generate = vi.fn(() => ({ courseId, versionId, generationId: newId() }));
    const job = await draftCourse(deps(generate), newCourseJob("  Fall prevention  ", "  Keep residents safe  ", "avatar", "voice"));
    expect(generate).toHaveBeenCalledWith({ operation: "ai.generateCourse", request: { generation_mode: "course", title_hint: "Fall prevention", notes: `Keep residents safe\n\n${videoInstruction}` } });
    expect(job).toMatchObject({ courseId, versionId, stage: "videos" });
    // Resuming a saved job never drafts a second course.
    expect((await draftCourse(deps(generate), job)).courseId).toBe(courseId);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("drafts from the title alone when there are no specific asks, still asking for video lessons", async () => {
    const generate = vi.fn(() => ({ courseId, versionId, generationId: newId() }));
    await draftCourse(deps(generate), newCourseJob("Fall prevention", "   ", "avatar", "voice"));
    expect(generate).toHaveBeenCalledWith({ operation: "ai.generateCourse", request: { generation_mode: "course", title_hint: "Fall prevention", notes: videoInstruction } });
  });

  it("grounds the course in the owner's own policy text when they paste some", async () => {
    const generate = vi.fn(() => ({ courseId, versionId, generationId: newId() }));
    const policy = "Policy 4.2: Report every fall to the nurse supervisor within one hour.";
    await draftCourse(deps(generate), newCourseJob("Fall prevention", "", "avatar", "voice", policy));
    expect(generate).toHaveBeenCalledWith({ operation: "ai.generateCourse", request: { generation_mode: "course", title_hint: "Fall prevention", notes: videoInstruction, source_material: policy } });
  });

  it("finds every video lesson and the script the AI wrote for it", async () => {
    const { course } = await loadCourse(deps(vi.fn(), fakeCareBase().author), { ...newCourseJob("T", "D", "a", "v"), courseId, versionId });
    expect(videoLessons(course)).toEqual([
      { blockId: firstVideo.id, title: "Video", script: "Synthetic transcript", attached: false },
      { blockId: secondVideoId, title: "Second video", script: "Second script", attached: false },
    ]);
    expect(videoLessons(validateGovernedCourse(draftPayload([firstVideo.id])))[0].attached).toBe(true);
  });

  it("makes one HeyGen video per video lesson and waits for each to finish", async () => {
    const statuses: Record<string, string[]> = { [firstVideo.id]: ["processing", "completed"], [secondVideoId]: ["completed"] };
    const generate = vi.fn((op: GenerationOperation) => op.operation === "video.generate" ? { attemptId: newId(), status: "processing", reused: false }
      : { status: statuses[(op.request as { course_block_id: string }).course_block_id].shift(), error: null });
    const lessons = videoLessons(validateGovernedCourse(draftPayload()));
    const save = vi.fn();
    let job = await submitVideos(deps(generate), { ...newCourseJob("T", "D", "avatar-1", "voice-1"), courseId, versionId, stage: "videos" }, lessons, save);
    const submitted = generate.mock.calls.filter(([op]) => op.operation === "video.generate").map(([op]) => op.request);
    expect(submitted).toMatchObject([
      { course_block_id: firstVideo.id, avatar_id: "avatar-1", voice_id: "voice-1", script: "Synthetic transcript", title: "Video", expected_video_url: null },
      { course_block_id: secondVideoId, script: "Second script", title: "Second video" },
    ]);
    expect(save).toHaveBeenCalled();
    expect(videosSettled(job)).toBe(false);
    job = await checkVideos(deps(generate), job);
    expect(Object.values(job.videos).map(video => video.status)).toEqual(["processing", "completed"]);
    job = await checkVideos(deps(generate), job);
    expect(videosSettled(job)).toBe(true);
  });

  it("retries a video without paying twice, and starts a new render only after HeyGen reports a failed one", async () => {
    const lessons = videoLessons(validateGovernedCourse(draftPayload())).slice(0, 1);
    const base = { ...newCourseJob("T", "D", "a", "v"), courseId, versionId, stage: "videos" as const };
    let job = await submitVideos(deps(() => { throw new GenerationError("timeout", null); }), base, lessons, vi.fn());
    const first = job.videos[firstVideo.id];
    expect(first).toMatchObject({ status: "failed" });
    expect(first.error).toMatch(/time limit/);
    const retry = vi.fn<(op: GenerationOperation) => unknown>(() => ({ attemptId: newId(), status: "processing", reused: true }));
    job = await submitVideos(deps(retry), job, lessons, vi.fn());
    expect(retry.mock.calls[0][0]).toMatchObject({ request: { request_id: first.requestId } });

    job = await checkVideos(deps(() => ({ status: "failed", error: "Avatar unavailable" })), job);
    expect(job.videos[firstVideo.id]).toMatchObject({ status: "failed", renderFailed: true, error: "Avatar unavailable" });
    const rerender = vi.fn<(op: GenerationOperation) => unknown>(() => ({ attemptId: newId(), status: "processing", reused: false }));
    await submitVideos(deps(rerender), job, lessons, vi.fn());
    expect(rerender.mock.calls[0][0]).not.toMatchObject({ request: { request_id: first.requestId } });
  });

  it("approves the AI content and publishes only after the owner clicks Publish, against the exact material they saw", async () => {
    const carebase = fakeCareBase();
    const job = { ...newCourseJob("T", "D", "a", "v"), courseId, versionId, stage: "ready" as const };
    const published = await approveAndPublish(deps(vi.fn(), carebase.author), job, revision(1));
    expect(published).toMatchObject({ status: "published", action: "learning.publishVersion" });
    expect(carebase.calls).toEqual(["inspect", "source", "preserve_source", "preview learning.reviewDraft", "apply",
      "inspect", "source", "preserve_source", "preview learning.publishVersion", "apply"]);
  });

  it("refuses to publish material that changed after the owner looked at it", async () => {
    const carebase = fakeCareBase();
    carebase.setHead(2);
    await expect(approveAndPublish(deps(vi.fn(), carebase.author), { ...newCourseJob("T", "D", "a", "v"), courseId, versionId, stage: "ready" }, revision(1)))
      .rejects.toThrow(/changed since you looked/);
    expect(carebase.calls).not.toContain("apply");
  });

  it("preselects the presenter used last time, otherwise the owner's AI twin", () => {
    const avatars = [
      { id: "stock", name: "Stock", gender: null, aiTwin: false, private: false, defaultVoiceId: "v1" },
      { id: "twin", name: "Me", gender: null, aiTwin: true, private: true, defaultVoiceId: "v2" },
    ];
    const voices = [{ id: "v1", name: null, language: null, gender: null }, { id: "v2", name: null, language: null, gender: null }];
    expect(defaultPresenter(avatars, voices)).toEqual({ avatarId: "twin", voiceId: "v2" });
    expect(defaultPresenter(avatars, voices, "stock")).toEqual({ avatarId: "stock", voiceId: "v1" });
    expect(defaultPresenter([], voices)).toBeNull();
  });
});

