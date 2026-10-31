// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { courseId, fakeCareBase, versionId } from "./testFixtures/courseCreator";

// The creator talks to CareBase only outside the preview, so these tests run as the live Hub.
vi.mock("../lib/config", () => ({ config: { demoMode: false } }));
const { SimpleCourseCreator } = await import("./SimpleCourseCreator");
const { reloadCreatorForTest, resetCreator } = await import("./courseCreatorRunner");

beforeEach(() => { window.localStorage.clear(); reloadCreatorForTest(); });
afterEach(() => { cleanup(); resetCreator(); });
const renderCreator = (deps: ReturnType<typeof fakeCareBase>["deps"]) => render(<MemoryRouter><SimpleCourseCreator deps={deps} /></MemoryRouter>);

it("turns a title and description into a course with HeyGen videos, then publishes it on one click", async () => {
  const carebase = fakeCareBase();
  renderCreator(carebase.deps);
  // The owner's AI twin is the preselected presenter.
  expect(((await screen.findByLabelText("Video presenter")) as HTMLSelectElement).value).toBe("twin");
  const create = screen.getByRole("button", { name: "Create course" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Fall prevention" } });
  fireEvent.change(screen.getByLabelText("What should the course teach?"), { target: { value: "Teach home care aides how to prevent falls at home." } });
  fireEvent.click(create);

  // Nothing goes live until the owner looks it over.
  const publish = await screen.findByRole("button", { name: "Publish course" });
  expect(carebase.calls).not.toContain("apply");
  expect(carebase.generate.mock.calls.filter(([op]) => op.operation === "video.generate").map(([op]) => op.request))
    .toMatchObject([{ avatar_id: "twin", voice_id: "v2", script: "Synthetic transcript" }, { avatar_id: "twin", voice_id: "v2", script: "Second script" }]);
  const preview = document.querySelector<HTMLElement>(".course-creator-preview")!;
  expect(within(preview).getAllByText(/video ready/)).toHaveLength(2);

  fireEvent.click(publish);
  expect(await screen.findByText("Fall prevention is published.")).toBeTruthy();
  expect(carebase.calls.filter(call => call.startsWith("preview"))).toEqual(["preview learning.reviewDraft", "preview learning.publishVersion"]);
  expect(JSON.parse(window.localStorage.getItem("caremetric.courseCreator.job")!)).toMatchObject({ courseId, stage: "published" });
});

it("picks a course back up after the page is reopened, without asking the AI for a second course", async () => {
  window.localStorage.setItem("caremetric.courseCreator.job", JSON.stringify({ title: "Fall prevention", description: "Teach aides to prevent falls.", avatarId: "twin", voiceId: "v2",
    courseId, versionId, videos: {}, stage: "videos" }));
  reloadCreatorForTest();
  const carebase = fakeCareBase();
  renderCreator(carebase.deps);
  expect(await screen.findByRole("button", { name: "Publish course" })).toBeTruthy();
  expect(carebase.calls).not.toContain("ai.generateCourse");
  expect(carebase.calls.filter(call => call === "video.generate")).toHaveLength(2);
});

it("does not repeat an AI draft that may still be running when the page was closed", async () => {
  window.localStorage.setItem("caremetric.courseCreator.job", JSON.stringify({ title: "Fall prevention", description: "Teach aides to prevent falls.", avatarId: "twin", voiceId: "v2",
    videos: {}, stage: "drafting", draftingSince: Date.now() - 30_000 }));
  reloadCreatorForTest();
  const carebase = fakeCareBase();
  renderCreator(carebase.deps);
  expect((await screen.findByRole("alert")).textContent).toMatch(/may still be writing this course/);
  expect(carebase.calls).not.toContain("ai.generateCourse");
});
