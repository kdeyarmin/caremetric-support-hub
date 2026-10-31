// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../imports/fixtures/governedCourse.json";
import { validateGovernedCourse } from "../imports/governedLearningImport";
import { GenerationError, runGeneration } from "./generationClient";
import { runAuthoring } from "./authoringClient";
import { AiCourseDraftPanel, AvatarVideoPanel, BlockRegenerationPanel } from "./GenerationPanels";
vi.mock("./generationClient", async () => ({ ...await vi.importActual<object>("./generationClient"), runGeneration: vi.fn() }));
vi.mock("./authoringClient", () => ({ runAuthoring: vi.fn() }));
const id = "ffffffff-0000-0000-0000-000000000001", other = "ffffffff-0000-0000-0000-000000000002";
const withVideo = (video: object) => validateGovernedCourse({ ...fixture, sourceVersionState: "draft", blocks: fixture.blocks.map(block => block.type === "video" ? { ...block, ...video } : block) });
// The fixture's video lesson links a video; most cases start from a lesson without one.
const material = withVideo({ videoLocatorSha256: null });
const videoBlock = fixture.blocks.find(block => block.type === "video")!;
type Op = { operation: string; request: Record<string, unknown> };
const calls = (name: string) => vi.mocked(runGeneration).mock.calls.map(call => call[0] as Op).filter(op => op.operation === name);
const options = { avatars: [{ id: "twin", name: "Dr. Kim", gender: null, aiTwin: true, private: true, defaultVoiceId: "calm" }, { id: "stock", name: "Alex", gender: "male", aiTwin: false, private: false, defaultVoiceId: null }],
  voices: [{ id: "calm", name: "Calm", language: "English", gender: null }, { id: "bright", name: "Bright", language: "English", gender: null }] };
beforeEach(() => { vi.mocked(runGeneration).mockReset(); vi.mocked(runAuthoring).mockReset().mockResolvedValue({ itemId: id, registered: true } as never); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("drafts one global course with AI and opens it", async () => {
  vi.mocked(runGeneration).mockResolvedValueOnce({ courseId: id, versionId: other, generationId: id } as never);
  const onOpen = vi.fn(); render(<AiCourseDraftPanel onOpen={onOpen} />);
  const submit = screen.getByRole("button", { name: "Draft with AI" }) as HTMLButtonElement;
  fireEvent.change(screen.getByLabelText("Category"), { target: { value: "Safety" } });
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Working title"), { target: { value: "Fire safety for personal care homes" } });
  fireEvent.change(screen.getByLabelText("Number of lessons (1 to 30)"), { target: { value: "6" } });
  fireEvent.click(submit);
  fireEvent.click(await screen.findByRole("button", { name: "Open the draft" }));
  expect(onOpen).toHaveBeenCalledWith(id);
  expect(calls("ai.generateCourse")).toEqual([{ operation: "ai.generateCourse", request: { generation_mode: "course", title_hint: "Fire safety for personal care homes", category: "Safety", desired_module_count: 6 } }]);
  // The draft joins the Hub's catalog, which reviewing and publishing it from the Hub requires.
  expect(runAuthoring).toHaveBeenCalledWith({ operation: "register_generated", courseId: id, versionId: other });
});
it("keeps a drafted course when the catalog step fails, and adds it later without drafting again", async () => {
  vi.mocked(runGeneration).mockResolvedValueOnce({ courseId: id, versionId: other, generationId: id } as never);
  vi.mocked(runAuthoring).mockRejectedValueOnce(new Error("unavailable"));
  render(<AiCourseDraftPanel onOpen={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Working title"), { target: { value: "Fire safety" } });
  fireEvent.click(screen.getByRole("button", { name: "Draft with AI" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/could not add this draft to its course catalog/);
  expect(screen.getByRole("button", { name: "Open the draft" })).not.toBeNull();
  // Not a drafting failure: nothing offers to draft the same course again.
  expect(screen.queryByRole("button", { name: "Retry with the same inputs" })).toBeNull();
  // Another draft would replace this one's catalog retry, so none starts until it is in the catalog.
  const submit = screen.getByRole("button", { name: "Draft with AI" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.submit(screen.getByRole("form", { name: "Draft a course with AI" }));
  fireEvent.click(screen.getByRole("button", { name: "Add it to the catalog" }));
  await vi.waitFor(() => expect(submit.disabled).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(vi.mocked(runAuthoring).mock.calls).toHaveLength(2);
  expect(calls("ai.generateCourse")).toHaveLength(1);
});
it("shows CareBase's message when drafting is refused and offers the same inputs again", async () => {
  vi.mocked(runGeneration).mockRejectedValueOnce(new GenerationError("forbidden", "AI course generation is currently disabled by the platform administrator."));
  render(<AiCourseDraftPanel onOpen={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Notes for the drafter"), { target: { value: "Cover evacuation drills." } });
  fireEvent.click(screen.getByRole("button", { name: "Draft with AI" }));
  expect((await screen.findByRole("alert")).textContent).toBe("AI course generation is currently disabled by the platform administrator.");
  expect(screen.getByRole("button", { name: "Retry with the same inputs" })).not.toBeNull();
});
it("regenerates one draft lesson from the administrator's feedback", async () => {
  vi.mocked(runGeneration).mockResolvedValueOnce({ blockId: videoBlock.id, generationId: id } as never);
  const onRegenerated = vi.fn();
  render(<BlockRegenerationPanel material={material} busy={false} onBusy={vi.fn()} onRegenerated={onRegenerated} />);
  const lessons = [...(screen.getByLabelText("Lesson to regenerate") as HTMLSelectElement).options].map(option => option.textContent);
  expect(lessons).toEqual(["Choose a lesson", "0. Practice · text", "2. Final exam · quiz", "4. Video · video"]);
  fireEvent.change(screen.getByLabelText("Lesson to regenerate"), { target: { value: videoBlock.id } });
  fireEvent.change(screen.getByLabelText("What to change (up to 4,000 characters)"), { target: { value: "Shorter, with one example." } });
  fireEvent.click(screen.getByRole("button", { name: "Regenerate with AI" }));
  await vi.waitFor(() => expect(onRegenerated).toHaveBeenCalled());
  expect(calls("ai.regenerateBlock")).toEqual([{ operation: "ai.regenerateBlock", request: { course_block_id: videoBlock.id, feedback: "Shorter, with one example." } }]);
});
async function openVideo(attempt: () => unknown, course = material) {
  vi.mocked(runGeneration).mockImplementation(async op => {
    if (op.operation === "video.options") return options as never;
    if (op.operation === "video.generate") return attempt() as never;
    return { status: "completed", error: null } as never;
  });
  const onAttached = vi.fn();
  render(<AvatarVideoPanel material={course} busy={false} onBusy={vi.fn()} onAttached={onAttached} />);
  fireEvent.change(screen.getByLabelText("Video lesson"), { target: { value: videoBlock.id } });
  await screen.findByRole("option", { name: "Dr. Kim · AI twin" });
  fireEvent.change(screen.getByLabelText("Avatar"), { target: { value: "twin" } });
  expect((screen.getByLabelText("Voice") as HTMLSelectElement).value).toBe("calm");
  return onAttached;
}
it("renders an avatar video, retries with the same request ID and attaches it when finished", async () => {
  let fail = true;
  const onAttached = await openVideo(() => { if (fail) { fail = false; throw new GenerationError("upstream", null); } return { attemptId: id, status: "processing", reused: false }; });
  expect((screen.getByLabelText("Script (up to 50,000 characters)") as HTMLTextAreaElement).value).toBe(videoBlock.body?.script);
  fireEvent.click(screen.getByRole("button", { name: "Generate video" }));
  // Only the 30-second poll is faked; Testing Library's own waits keep real timers.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  fireEvent.click(await screen.findByRole("button", { name: "Retry the same render" }));
  await screen.findByText(/HeyGen is rendering the video/);
  const [first, second] = calls("video.generate");
  expect(first).toEqual(second);
  expect(first.request).toMatchObject({ course_block_id: videoBlock.id, avatar_id: "twin", voice_id: "calm", expected_video_url: null, expected_media_asset_id: null });
  expect(first.request).not.toHaveProperty("replace_existing");
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(calls("video.status")).toEqual([{ operation: "video.status", request: { course_block_id: videoBlock.id } }]);
  expect(onAttached).toHaveBeenCalled();
});
it("never offers a retry when the provider response is unresolved", async () => {
  await openVideo(() => { throw new GenerationError("conflict", "The provider response is unresolved. Contact support to reconcile this request before starting another paid render."); });
  fireEvent.click(screen.getByRole("button", { name: "Generate video" }));
  await screen.findByText(/provider response is unresolved/);
  expect((screen.getByRole("button", { name: "Generate video" }) as HTMLButtonElement).disabled).toBe(true);
});
it("refuses to replace a linked video it cannot see and asks before replacing an uploaded one", async () => {
  render(<AvatarVideoPanel material={validateGovernedCourse({ ...fixture, sourceVersionState: "draft" })} busy={false} onBusy={vi.fn()} onAttached={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Video lesson"), { target: { value: videoBlock.id } });
  expect(screen.getByText(/already has a linked video/)).not.toBeNull();
  expect(runGeneration).not.toHaveBeenCalled();
  cleanup();
  const asset = { id: other, contentSha256: "b".repeat(64), mimeType: "video/mp4", byteSize: 1024, fileName: "intro.mp4" };
  await openVideo(() => ({ attemptId: id, status: "processing", reused: false }), withVideo({ videoLocatorSha256: null, mediaAsset: asset }));
  const generate = screen.getByRole("button", { name: "Generate video" }) as HTMLButtonElement;
  expect(generate.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("Replace this lesson’s current video"));
  fireEvent.click(generate);
  await screen.findByText(/HeyGen is rendering the video/);
  expect(calls("video.generate")[0].request).toMatchObject({ replace_existing: true, expected_video_url: null, expected_media_asset_id: other });
});
