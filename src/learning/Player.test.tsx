// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { courseSteps, type Course } from "./model";

const api = vi.hoisted(() => ({ course: vi.fn(), media: vi.fn(), submit: vi.fn(), certificate: vi.fn(), enroll: vi.fn(), mine: vi.fn() }));
vi.mock("./api", () => ({ learningApi: api }));
const { CoursePlayer, LearningCertificate, MyLearning } = await import("./Player");

function GoTo({ path }: { path: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(path)}>Another enrollment</button>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

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
  // Small repeated seeks cannot creep forward either: each one returns to the furthest point played.
  video.currentTime = 4.5; fireEvent.seeking(video); fireEvent.timeUpdate(video);
  expect(video.currentTime).toBe(4);
  video.currentTime = 2; fireEvent.seeking(video);
  expect(video.currentTime).toBe(2);
  fireEvent.ended(video);
  expect(checkbox.disabled).toBe(false);
  expect(screen.queryByText("Watch the full video to continue.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "✓ Why falls happen" }));
  await screen.findByRole("heading", { name: "Why falls happen" });
  fireEvent.click(screen.getByRole("button", { name: "Room safety" }));
  await screen.findByRole("heading", { name: "Room safety" });
  expect(screen.queryByText("Watch the full video to continue.")).toBeNull();
  expect((screen.getByRole("checkbox", { name: "I have completed this lesson." }) as HTMLInputElement).disabled).toBe(false);
  const returned = await waitFor(() => { const element = document.querySelector("video"); if (!element) throw new Error("video pending"); return element; });
  Object.defineProperty(returned, "currentTime", { value: 0, writable: true });
  returned.currentTime = 90;
  fireEvent.seeking(returned);
  expect(returned.currentTime).toBe(4);
});

it("answers a select-all question with every chosen option", async () => {
  const base = course([ids.text, ids.video]);
  const quiz = base.document.units[2];
  if (quiz.type !== "quiz") throw new Error("Fixture type");
  const third = "77777777-7777-4777-8777-777777777778";
  const selectAll = { ...quiz.questions[0], prompt: "Which apply?", multiple: true, options: [...quiz.questions[0].options, { id: third, text: "This too" }] };
  api.course.mockResolvedValue({ ...base, document: { ...base.document, units: [base.document.units[0], base.document.units[1], { ...quiz, questions: [selectAll] }] } });
  api.submit.mockResolvedValue({ passed: true, score: 100, attemptCount: 1, completedAt: null, certificateId: null });
  renderPlayer();
  await screen.findByText("Select all that apply.");
  const submit = screen.getByRole("button", { name: "Submit answers" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "This one" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Not this" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "This too" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Not this" }));
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  await waitFor(() => expect(api.submit).toHaveBeenCalledWith(ids.enrollment, ids.quiz, { [ids.question]: [ids.option, third] }, false, expect.any(String)));
});

it("lets a learner retake a quiz as often as needed, in a new question order each time", async () => {
  const base = course([ids.text, ids.video]);
  const quiz = base.document.units[2];
  if (quiz.type !== "quiz") throw new Error("Fixture type");
  const questionIds = Array.from({ length: 6 }, (_, index) => `66666666-6666-4666-8666-66666666666${index}`);
  const many = { ...quiz, maxAttempts: 3, questions: questionIds.map((id, index) => ({ ...quiz.questions[0], id, prompt: `Question ${String.fromCharCode(65 + index)}` })) };
  // Three attempts already used: the course's old limit no longer locks the quiz.
  const withAttempts = (attemptCount: number): Course => ({ ...base, document: { ...base.document, units: [base.document.units[0], base.document.units[1], many] },
    progress: [...base.progress, { unitId: ids.quiz, completedAt: null, attemptCount, bestScore: 50 }] });
  api.course.mockResolvedValueOnce(withAttempts(3)).mockResolvedValue(withAttempts(4));
  api.submit.mockResolvedValue({ passed: false, score: 50, attemptCount: 4, completedAt: null, certificateId: null });
  renderPlayer();
  await screen.findByText(/You can retake this quiz as many times as you need/);
  expect(screen.queryByText(/Attempt limit reached/)).toBeNull();
  const order = () => screen.getAllByRole("group").map(group => group.querySelector("legend")?.textContent?.replace(/^\d+\. /, ""));
  const first = order();
  expect([...first].sort()).toEqual(questionIds.map((_, index) => `Question ${String.fromCharCode(65 + index)}`));
  for (const group of screen.getAllByRole("group")) fireEvent.click(group.querySelector("input")!);
  fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
  await screen.findByText(/not passed\. Try again: the questions are in a new order/);
  await screen.findByText(/Attempts so far: 4/);
  expect(order()).not.toEqual(first);
  expect(screen.getAllByRole("group").every(group => !(group.querySelector("input") as HTMLInputElement).checked)).toBe(true);
  expect((screen.getByRole("button", { name: "Submit answers" }) as HTMLButtonElement).disabled).toBe(true);
});

it("shows the post-test score on the certificate", async () => {
  api.certificate.mockResolvedValue({ certificateId: ids.option, learnerName: "Learner One", courseTitle: "Falls prevention", completedAt: "2026-10-09T12:00:00Z", durationMinutes: 30, versionId: ids.version, finalScore: 90, passingScore: 80 });
  render(<MemoryRouter initialEntries={[`/learn/certificates/${ids.enrollment}`]}><Routes><Route path="/learn/certificates/:enrollmentId" element={<LearningCertificate />} /></Routes></MemoryRouter>);
  expect(await screen.findByText("Post-test score: 90% (passing score 80%)")).toBeTruthy();
});

it("retries a failed course load without leaving a permanent loading message", async () => {
  api.course.mockRejectedValueOnce(new Error("Connection interrupted")).mockResolvedValue(course());
  renderPlayer();
  await screen.findByText("Connection interrupted");
  expect(screen.queryByText("Loading course…")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry course" }));
  await screen.findByRole("heading", { name: "Why falls happen" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("clears the previous enrollment and its video progress when another enrollment opens", async () => {
  const nextId = "33333333-3333-4333-8333-333333333334";
  const next = deferred<Course>();
  api.course.mockResolvedValueOnce(course([ids.text])).mockReturnValueOnce(next.promise);
  render(<MemoryRouter initialEntries={[`/learn/courses/${ids.item}?enrollment=${ids.enrollment}`]}>
    <GoTo path={`/learn/courses/${ids.item}?enrollment=${nextId}`} />
    <Routes><Route path="/learn/courses/:itemId" element={<CoursePlayer />} /></Routes>
  </MemoryRouter>);
  await screen.findByRole("heading", { name: "Room safety" });
  const video = await waitFor(() => { const element = document.querySelector("video"); if (!element) throw new Error("video pending"); return element; });
  fireEvent.ended(video);
  expect((screen.getByRole("checkbox", { name: "I have completed this lesson." }) as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Another enrollment" }));
  expect(screen.queryByRole("heading", { name: "Room safety" })).toBeNull();
  await act(async () => next.resolve({ ...course([ids.text]), enrollmentId: nextId }));
  await screen.findByRole("heading", { name: "Room safety" });
  expect((screen.getByRole("checkbox", { name: "I have completed this lesson." }) as HTMLInputElement).disabled).toBe(true);
});

it("does not restore an old enrollment when its saved-progress refresh arrives late", async () => {
  const oldRefresh = deferred<Course>();
  const nextId = "33333333-3333-4333-8333-333333333334";
  const next = { ...course(), enrollmentId: nextId, document: { ...course().document, title: "Current enrollment" } };
  api.course.mockResolvedValueOnce(course()).mockReturnValueOnce(oldRefresh.promise).mockResolvedValueOnce(next);
  api.submit.mockResolvedValue({ passed: true, score: null, attemptCount: 1, completedAt: null, certificateId: null });
  render(<MemoryRouter initialEntries={[`/learn/courses/${ids.item}?enrollment=${ids.enrollment}`]}>
    <GoTo path={`/learn/courses/${ids.item}?enrollment=${nextId}`} />
    <Routes><Route path="/learn/courses/:itemId" element={<CoursePlayer />} /></Routes>
  </MemoryRouter>);
  fireEvent.click(await screen.findByRole("checkbox", { name: "I have completed this lesson." }));
  fireEvent.click(screen.getByRole("button", { name: "Complete lesson" }));
  await waitFor(() => expect(api.course).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Another enrollment" }));
  await screen.findByRole("heading", { name: "Current enrollment" });
  await act(async () => oldRefresh.resolve(course([ids.text])));
  expect(screen.getByRole("heading", { name: "Current enrollment" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Falls prevention" })).toBeNull();
});

it("retries the progress read after a saved quiz without submitting another attempt", async () => {
  api.course.mockResolvedValueOnce(course([ids.text, ids.video])).mockRejectedValueOnce(new Error("Progress unavailable")).mockResolvedValue(course([ids.text, ids.video, ids.quiz]));
  api.submit.mockResolvedValue({ passed: true, score: 100, attemptCount: 1, completedAt: null, certificateId: null });
  renderPlayer();
  fireEvent.click(await screen.findByRole("radio", { name: "This one" }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
  await screen.findByText(/Progress unavailable/);
  expect((screen.getByRole("button", { name: "Submit answers" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry progress update" }));
  await screen.findByRole("button", { name: "Continue" });
  expect(api.submit).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("hides the previous certificate while another certificate loads or fails", async () => {
  const next = deferred<never>();
  const certificate = { certificateId: ids.option, learnerName: "Learner One", courseTitle: "Falls prevention", completedAt: "2026-10-09T12:00:00Z", durationMinutes: 30, versionId: ids.version, finalScore: 90, passingScore: 80 };
  api.certificate.mockResolvedValueOnce(certificate).mockReturnValueOnce(next.promise).mockResolvedValueOnce({ ...certificate, courseTitle: "Current certificate" });
  render(<MemoryRouter initialEntries={[`/learn/certificates/${ids.enrollment}`]}>
    <GoTo path="/learn/certificates/33333333-3333-4333-8333-333333333334" />
    <Routes><Route path="/learn/certificates/:enrollmentId" element={<LearningCertificate />} /></Routes>
  </MemoryRouter>);
  await screen.findByText("Falls prevention");
  fireEvent.click(screen.getByRole("button", { name: "Another enrollment" }));
  expect(screen.queryByText("Falls prevention")).toBeNull();
  expect((screen.getByRole("button", { name: "Print certificate" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => next.reject(new Error("Certificate unavailable")));
  await screen.findByText("Certificate unavailable");
  expect(screen.queryByText("Falls prevention")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry certificate" }));
  await screen.findByText("Current certificate");
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByRole("button", { name: "Print certificate" }) as HTMLButtonElement).disabled).toBe(false);
});

it("can retry loading personal learning records after a transient failure", async () => {
  api.mine.mockRejectedValueOnce(new Error("Records unavailable")).mockResolvedValueOnce([]);
  render(<MemoryRouter><MyLearning /></MemoryRouter>);
  await screen.findByText("Records unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry my learning" }));
  await screen.findByText("You have not started a course in the Hub yet.");
  expect(screen.queryByRole("alert")).toBeNull();
});
