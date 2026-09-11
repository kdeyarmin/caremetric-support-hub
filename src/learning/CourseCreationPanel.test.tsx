// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CourseCreationPanel } from "./CourseCreationPanel";
import { creationRequestSchema, type CreationIntent, type CreationRequest } from "./creationProtocol";
const requestAdmin = vi.hoisted(() => vi.fn());
vi.mock("../admin/transport", () => ({ requestAdmin }));
afterEach(() => { cleanup();vi.clearAllMocks(); });
const preview = (request: CreationRequest): CreationIntent => ({ request, createdAt: new Date().toISOString(), dispatchedAt: null, result: null, registration: null,
  preview: { commandId: crypto.randomUUID(), courseId: request.courseId, action: "learning.createCourse", reason: request.reason, previewDigest: "a".repeat(64),
    expiresAt: new Date(Date.now() + 240000).toISOString(), before: { courseId: request.courseId, versionId: request.parameters.versionId, exists: false },
    after: { courseId: request.courseId, versionId: request.parameters.versionId, courseStatus: "draft", status: "draft", versionNumber: 1,
      title: request.parameters.version.title, currentVersionId: null, aiReviewRequired: false, contentStandard: "comprehensive" } } });
const complete = (intent: CreationIntent): CreationIntent => ({ ...intent, dispatchedAt: new Date().toISOString(), registration: { itemId: crypto.randomUUID(), snapshotId: null, sourceRevision: null },
  result: { commandId: intent.preview!.commandId, courseId: intent.request.courseId, versionId: intent.request.parameters.versionId, action: "learning.createCourse", versionNumber: 1,
    status: "draft", courseStatus: "draft", currentVersionId: null, contentStandard: "comprehensive", sourceRevision: "b".repeat(64), appliedAt: new Date().toISOString(), replayed: false } });
async function open() { fireEvent.click(screen.getByRole("button", { name: "Create governed course" }));await screen.findByRole("button", { name: "Preview new course" }); }
function fill() {
  fireEvent.change(screen.getByLabelText("New course title"), { target: { value: "Reviewed safety course" } });
  fireEvent.change(screen.getByLabelText("Reason for creating this course"), { target: { value: "Create the reviewed shared training" } });
}
it("reviews before creating and retains one request after an uncertain native response", async () => {
  let intent: CreationIntent;let applies = 0;
  requestAdmin.mockImplementation(async (_name, op) => {
    if (op.operation === "creationOptions") return { trainingTypes: [], nextOffset: null };
    if (op.operation === "resume") return {rows:[],nextOffset:null};
    if (op.operation === "preview") { intent = preview(creationRequestSchema.parse(op));return intent; }
    if (op.operation === "apply") { applies++;if (applies === 1) throw new Error("lost response");return complete(intent); }
    throw new Error("Unexpected operation");
  });
  const onOpen = vi.fn();render(<CourseCreationPanel onOpen={onOpen} />);await open();fill();
  fireEvent.click(screen.getByRole("button", { name: "Preview new course" }));await screen.findByRole("heading", { name: "Review new draft" });
  expect((screen.getByRole("button", { name: "Create reviewed draft" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(screen.getByRole("button", { name: "Create reviewed draft" }));await screen.findByRole("alert");
  expect(screen.getByLabelText("New course title").matches(":disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Discard undispatched review" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry original creation" }));await screen.findByRole("button", { name: "Open created course" });
  const calls = requestAdmin.mock.calls.filter(([, op]) => op.operation === "apply");expect(calls[0][1]).toEqual(calls[1][1]);
  expect(requestAdmin.mock.calls.filter(([, op]) => op.operation === "preview")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Open created course" }));expect(onOpen).toHaveBeenCalledWith(intent!.request.courseId);
});
it("recovers a saved request with a read action before opening its created course", async () => {
  const request = creationRequestSchema.parse({ operation: "preview", requestId: crypto.randomUUID(), action: "learning.createCourse", courseId: crypto.randomUUID(), reason: "Create reviewed material", parameters: {
    versionId: crypto.randomUUID(), course: { title: "Saved course", description: null, category: null, estimatedDurationMinutes: null, trainingTypeId: null }, version: { title: "Saved first draft", description: null } } });
  const intent = { ...preview(request), dispatchedAt: new Date().toISOString() };
  requestAdmin.mockImplementation(async (_name, op) => op.operation === "creationOptions" ? { trainingTypes: [], nextOffset: null } :
    op.operation === "resume" ? {rows:[intent],nextOffset:null} : op.operation === "recover" ? { status: "applied", intent: complete(intent) } : Promise.reject(new Error("No creation dispatch allowed")));
  render(<CourseCreationPanel onOpen={() => {}} />);await open();fireEvent.click(screen.getByRole("button", { name: "Saved course · Review or recovery required" }));
  fireEvent.click(screen.getByRole("button", { name: "Recover saved course request" }));await screen.findByRole("button", { name: "Open created course" });
  expect(requestAdmin.mock.calls.some(([, op]) => op.operation === "apply" || op.operation === "preview")).toBe(false);
  expect(screen.getByText(/Review the current material before preserving its source/)).toBeTruthy();
});
it("blocks creation while saved requests and current options are unavailable", async () => {
  requestAdmin.mockImplementation(async (_name, op) => { if (op.operation === "resume") throw new Error("unavailable");return { trainingTypes: [], nextOffset: null }; });
  render(<CourseCreationPanel onOpen={() => {}} />);fireEvent.click(screen.getByRole("button", { name: "Create governed course" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());expect(screen.queryByRole("button", { name: "Preview new course" })).toBeNull();
});
