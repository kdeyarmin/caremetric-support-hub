// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { courseId, fakeCareBase, versionId } from "./testFixtures/courseCreator";
import { videoInstruction } from "./simpleCourseCreation";

// The creator talks to CareBase only outside the preview, so these tests run as the live Hub.
vi.mock("../lib/config", () => ({ config: { demoMode: false } }));
const { SimpleCourseCreator } = await import("./SimpleCourseCreator");
const { interruptedDraft, jobKey, reloadCreatorForTest, resetCreator } = await import("./courseCreatorRunner");

beforeEach(() => { window.localStorage.clear(); reloadCreatorForTest(); });
afterEach(() => { cleanup(); resetCreator(); });
/** The signed-in person; tests switch it to show that a saved course stays with its own person. */
let signedIn: string | null = "owner-1";
const changed = new Set<() => void>();
const identity = { current: async () => signedIn, subscribe: (listener: () => void) => { changed.add(listener); return () => { changed.delete(listener); }; } };
function signInAs(userId: string | null) { signedIn = userId; for (const listener of changed) listener(); }
beforeEach(() => { signedIn = "owner-1"; });
const saved = () => JSON.parse(window.localStorage.getItem(jobKey("owner-1"))!);
const renderCreator = (deps: ReturnType<typeof fakeCareBase>["deps"]) => render(<MemoryRouter><SimpleCourseCreator deps={deps} identity={identity} /></MemoryRouter>);
const savedJob = (job: object) => window.localStorage.setItem(jobKey("owner-1"), JSON.stringify({ title: "Fall prevention", description: "Teach aides to prevent falls.",
  avatarId: "twin", voiceId: "v2", videos: {}, ...job }));

it("turns just a title into a course with HeyGen videos, then publishes it on one click", async () => {
  const carebase = fakeCareBase();
  renderCreator(carebase.deps);
  // The owner's AI twin is the preselected presenter.
  expect(((await screen.findByLabelText("Video presenter")) as HTMLSelectElement).value).toBe("twin");
  const create = screen.getByRole("button", { name: "Create course" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  // A title is all it needs; the description is optional.
  fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Fall prevention" } });
  expect(create.disabled).toBe(false);
  fireEvent.click(create);

  // Nothing goes live until the owner looks it over.
  const publish = await screen.findByRole("button", { name: "Publish course" });
  expect(carebase.generate.mock.calls.find(([op]) => op.operation === "ai.generateCourse")![0])
    .toEqual({ operation: "ai.generateCourse", request: { generation_mode: "course", title_hint: "Fall prevention", notes: videoInstruction } });
  expect(carebase.calls).not.toContain("apply");
  // The draft joins the Hub's catalog before any video is paid for, so publishing it can't fail on that.
  expect(carebase.calls.indexOf("register_generated")).toBeGreaterThan(-1);
  expect(carebase.calls.indexOf("register_generated")).toBeLessThan(carebase.calls.indexOf("video.generate"));
  expect(carebase.generate.mock.calls.filter(([op]) => op.operation === "video.generate").map(([op]) => op.request))
    .toMatchObject([{ avatar_id: "twin", voice_id: "v2", script: "Synthetic transcript" }, { avatar_id: "twin", voice_id: "v2", script: "Second script" }]);
  const preview = document.querySelector<HTMLElement>(".course-creator-preview")!;
  expect(within(preview).getAllByText(/video ready/)).toHaveLength(2);
  // The owner sees each quiz answer and the answer key before approving the AI's assessment.
  expect(within(preview).getByText("Safe action one").textContent).toContain("(correct answer)");
  expect(within(preview).getByText(/Why: Synthetic explanation/)).toBeTruthy();

  fireEvent.click(publish);
  expect(await screen.findByText("Fall prevention is published.")).toBeTruthy();
  expect(carebase.calls.filter(call => call.startsWith("preview"))).toEqual(["preview learning.reviewDraft", "preview learning.publishVersion"]);
  expect(saved()).toMatchObject({ courseId, stage: "published", registered: true });
});

it("sends the owner's specific asks and their own policy text to the AI", async () => {
  const carebase = fakeCareBase();
  renderCreator(carebase.deps);
  await screen.findByLabelText("Video presenter");
  fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Fall prevention" } });
  fireEvent.change(screen.getByLabelText(/Anything specific to cover or add/), { target: { value: "Cover our 5-step hand-hygiene routine." } });
  fireEvent.change(screen.getByLabelText("Your own policy or reference text"), { target: { value: "Policy 4.2: Report every fall within one hour." } });
  fireEvent.click(screen.getByRole("button", { name: "Create course" }));
  await screen.findByRole("button", { name: "Publish course" });
  expect(carebase.generate.mock.calls.find(([op]) => op.operation === "ai.generateCourse")![0]).toEqual({ operation: "ai.generateCourse", request: {
    generation_mode: "course", title_hint: "Fall prevention", notes: `Cover our 5-step hand-hygiene routine.\n\n${videoInstruction}`, source_material: "Policy 4.2: Report every fall within one hour." } });
});

it("says so plainly when the AI wrote no video lesson, instead of publishing without a video unnoticed", async () => {
  const carebase = fakeCareBase({ withVideoLessons: false });
  renderCreator(carebase.deps);
  await screen.findByLabelText("Video presenter");
  fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Fall prevention" } });
  fireEvent.click(screen.getByRole("button", { name: "Create course" }));
  await screen.findByRole("button", { name: "Publish course" });
  expect(screen.getByRole("alert").textContent).toMatch(/did not write a video lesson/);
  expect(carebase.calls).not.toContain("video.generate");
});

it("picks a course back up after the page is reopened, without asking the AI for a second course", async () => {
  savedJob({ courseId, versionId, stage: "videos" });
  reloadCreatorForTest();
  const carebase = fakeCareBase();
  renderCreator(carebase.deps);
  expect(await screen.findByRole("button", { name: "Publish course" })).toBeTruthy();
  expect(carebase.calls).not.toContain("ai.generateCourse");
  expect(carebase.calls.filter(call => call === "video.generate")).toHaveLength(2);
});

it("never writes an interrupted AI draft again on its own, however long ago it started", async () => {
  // Elapsed time cannot prove CareBase didn't write it: only the owner, checking the course editor, can.
  savedJob({ stage: "drafting", draftingSince: Date.now() - 60 * 60_000 });
  reloadCreatorForTest();
  const carebase = fakeCareBase();
  renderCreator(carebase.deps);
  expect((await screen.findByRole("alert")).textContent).toBe(interruptedDraft);
  expect(screen.getByRole("link", { name: "Check the full course editor" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(carebase.calls).not.toContain("ai.generateCourse");
  // Once the owner has checked, writing it again is their explicit choice.
  fireEvent.click(screen.getByRole("button", { name: "It isn't there: write it again" }));
  expect(await screen.findByRole("button", { name: "Publish course" })).toBeTruthy();
  expect(carebase.calls.filter(call => call === "ai.generateCourse")).toHaveLength(1);
});

it("keeps a saved course with the person who made it, and clears the screen when they sign out", async () => {
  savedJob({ courseId, versionId, stage: "videos" });
  reloadCreatorForTest();
  renderCreator(fakeCareBase().deps);
  expect(await screen.findByRole("button", { name: "Publish course" })).toBeTruthy();
  act(() => signInAs("someone-else"));
  expect(await screen.findByLabelText("Course title")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Publish course" })).toBeNull();
  expect(screen.queryByText(/Fall prevention/)).toBeNull();
  act(() => signInAs(null));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Publish course" })).toBeNull());
  // The owner's saved course is still theirs when they come back.
  expect(saved()).toMatchObject({ courseId, stage: "ready" });
});
