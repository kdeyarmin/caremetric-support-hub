// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { courseSteps, type Course } from "./model";

const api = vi.hoisted(() => ({ course: vi.fn(), media: vi.fn(), submit: vi.fn(), certificate: vi.fn() }));
vi.mock("./api", () => ({ learningApi: api }));
const { CoursePlayer, LearningCertificate } = await import("./Player");

const ids = { item: "11111111-1111-4111-8111-111111111111", version: "22222222-2222-4222-8222-222222222222", enrollment: "33333333-3333-4333-8333-333333333333",
  text: "44444444-4444-4444-8444-444444444441", video: "44444444-4444-4444-8444-444444444442", quiz: "44444444-4444-4444-8444-444444444443",
  media: "55555555-5555-4555-8555-555555555555", question: "66666666-6666-4666-8666-666666666666", option: "77777777-7777-4777-8777-777777777777" };
function course(completed: string[] = []): Course {
  return { itemId: ids.item, versionId: ids.version, enrollmentId: ids.enrollment, completedAt: null, certificateId: null,
    document: { title: "Falls prevention", summary: "", overview: "", category: "Safety", durationMinutes: 30, accessLevel: "customer", productIds: [ids.item], units: [
      { id: ids.text, type: "text", title: "Why falls happen", body: "Read this lesson." },
      { id: ids.video, type: "video", title: "Room safety", body: "Transcript", mediaAssetId: ids.media },
      { id: ids.quiz, type: "quiz", title: "Final assessment", body: "", passingScore: 80, maxAttempts: 3, questions: [{ id: ids.question, prompt: "Which is correct?", points: 1, options: [{ id: ids.option, text: "This one" }, { id: ids.media, text: "Not this" }] }] },
    ] },
    progress: completed.map(unitId => ({ unitId, completedAt: "2026-10-09T12:00:00Z", attemptCount: 1, bestScore: null })) };
}
function renderPlayer() {
  render(<MemoryRouter initialEntries={[`/learn/courses/${ids.item}?enrollment=${ids.enrollment}`]}><Routes><Route path="/learn/courses/:itemId" element={<CoursePlayer />} /></Routes></MemoryRouter>);
}
beforeEach(() => { api.media.mockResolvedValue({ video: "https://media.test/video.mp4", captions: "https://media.test/captions.vtt" }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("opens units in order and labels the final quiz as the post-test", () => {
  expect(courseSteps(course())).toEqual({ lastOpen: 0, postTest: 2 });
  expect(courseSteps(course([ids.text]))).toEqual({ lastOpen: 1, postTest: 2 });
  expect(courseSteps(course([ids.text, ids.video, ids.quiz]))).toEqual({ lastOpen: 2, postTest: 2 });
});

it("locks later lessons and the post-test until earlier lessons are complete", async () => {
  api.course.mockResolvedValue(course());
  renderPlayer();
  await screen.findByRole("heading", { name: "Why falls happen" });
  expect((screen.getByRole("button", { name: "Room safety" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Final assessment · Post-test" }) as HTMLButtonElement).disabled).toBe(true);
});

it("requires a first viewing to reach the end before a video lesson can be completed", async () => {
  api.course.mockResolvedValue(course([ids.text]));
  renderPlayer();
  await screen.findByRole("heading", { name: "Room safety" });
  expect(screen.getByText("Watch the full video to continue.")).toBeTruthy();
  const checkbox = screen.getByRole("checkbox", { name: "I have completed this lesson." }) as HTMLInputElement;
  expect(checkbox.disabled).toBe(true);
  const video = await waitFor(() => { const element = document.querySelector("video"); if (!element) throw new Error("video pending"); return element; });
  // jsdom does not implement media playback; give the element a settable clock.
  Object.defineProperty(video, "currentTime", { value: 0, writable: true });
  video.currentTime = 1.5; fireEvent.timeUpdate(video);
  video.currentTime = 3; fireEvent.timeUpdate(video);
  video.currentTime = 4; fireEvent.timeUpdate(video);
  video.currentTime = 90; fireEvent.seeking(video);
  expect(video.currentTime).toBe(4);
  fireEvent.ended(video);
  expect(checkbox.disabled).toBe(false);
  expect(screen.queryByText("Watch the full video to continue.")).toBeNull();
});

it("shows the post-test score on the certificate", async () => {
  api.certificate.mockResolvedValue({ certificateId: ids.option, learnerName: "Learner One", courseTitle: "Falls prevention", completedAt: "2026-10-09T12:00:00Z", durationMinutes: 30, versionId: ids.version, finalScore: 90, passingScore: 80 });
  render(<MemoryRouter initialEntries={[`/learn/certificates/${ids.enrollment}`]}><Routes><Route path="/learn/certificates/:enrollmentId" element={<LearningCertificate />} /></Routes></MemoryRouter>);
  expect(await screen.findByText("Post-test score: 90% (passing score 80%)")).toBeTruthy();
});
