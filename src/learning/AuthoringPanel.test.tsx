// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { requestAdmin } from "../admin/transport";
import { AuthoringPanel } from "./AuthoringPanel";
import fixture from "../imports/fixtures/governedCourse.json";
import { sourceDigest } from "../imports/governedLearningImport";
vi.mock("../admin/transport", () => ({ requestAdmin: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const id = "cccccccc-0000-0000-0000-000000000001";
async function setup() {
  Object.defineProperty(globalThis.crypto, "subtle", { value: webcrypto.subtle, configurable: true });
  const payload = JSON.stringify(fixture), revision = await sourceDigest(payload);
  const version = { versionId: fixture.sourceVersionId, sourceRevision: revision, governed: true, aiReviewRequired: false,
    unresolvedPackages: 0, status: "published", title: fixture.version.title, versionNumber: fixture.sourceVersionNumber };
  let failPreview = false, failApply = false;
  vi.mocked(requestAdmin).mockImplementation(async (_name, value) => {
    const op = value as { operation: string; reason: string; parameters: { title: string } };
    if (op.operation === "inspect") return { courseId: fixture.sourceCourseId, currentVersionId: version.versionId, title: fixture.course.title, versions: [version] };
    if (op.operation === "source") return { courseId: fixture.sourceCourseId, versionId: version.versionId, payload, sourceRevision: revision, headRevision: null, snapshotId: null };
    if (op.operation === "preserve_source") return { snapshotId: id, sourceRevision: revision, headRevision: revision, sequence: 1, replayed: false };
    if (op.operation === "preview") {
      if (failPreview) throw { code: "upstream" };
      return { commandId: id, courseId: fixture.sourceCourseId, action: "learning.cloneVersion", reason: op.reason, previewDigest: "a".repeat(64), expiresAt: new Date(Date.now() + 240000).toISOString(),
        before: { status: "published", courseId: fixture.sourceCourseId, versionId: version.versionId, currentVersionId: version.versionId, sourceRevision: revision, title: version.title, versionNumber: version.versionNumber },
        after: { status: "draft", sourceVersionId: version.versionId, title: op.parameters.title, versionNumber: version.versionNumber + 1 } };
    }
    if (failApply) throw { code: "upstream" };
    return { commandId: id, courseId: fixture.sourceCourseId, action: "learning.cloneVersion", versionId: id, versionNumber: version.versionNumber + 1, status: "draft", appliedAt: new Date().toISOString(), replayed: true };
  });
  render(<AuthoringPanel courseId={fixture.sourceCourseId} />);
  async function loadAndPreserve() {
    fireEvent.click(screen.getByRole("button", { name: "Load course versions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load exact course material" }));
    const review = await screen.findByRole("checkbox");
    const preserve = screen.getByRole("button", { name: "Preserve reviewed source" });
    expect((preserve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(review); fireEvent.click(preserve);
    await screen.findByRole("button", { name: "Preview new draft from this version" });
    fireEvent.change(screen.getByLabelText("Reason for change"), { target: { value: "Reviewed material for a new draft" } });
    fireEvent.change(screen.getByLabelText("New draft title"), { target: { value: "The reviewed draft" } });
  }
  return { loadAndPreserve, failPreview: (value: boolean) => { failPreview = value; }, failApply: (value: boolean) => { failApply = value; } };
}
it("requires exact source review, explicit native preview and confirmation, with identical apply retry", async () => {
  const f = await setup(); await f.loadAndPreserve();
  fireEvent.click(screen.getByRole("button", { name: "Preview new draft from this version" }));
  const apply = await screen.findByRole("button", { name: "Confirm and apply this change" });
  expect(vi.mocked(requestAdmin).mock.calls.some(c => (c[1] as { operation: string }).operation === "apply")).toBe(false);
  f.failApply(true); fireEvent.click(apply); await screen.findByRole("alert");
  f.failApply(false); fireEvent.click(apply); await screen.findByText(/CareBase confirmed version.*previously completed/);
  const calls = vi.mocked(requestAdmin).mock.calls.filter(c => (c[1] as { operation: string }).operation === "apply");
  expect(calls).toHaveLength(2); expect(calls[0][1]).toEqual(calls[1][1]);
});
it("retains uncertain preview identity but explicit refresh obtains a new preview", async () => {
  const f = await setup(); await f.loadAndPreserve();
  f.failPreview(true); fireEvent.click(screen.getByRole("button", { name: "Preview new draft from this version" })); await screen.findByRole("alert");
  f.failPreview(false); fireEvent.click(screen.getByRole("button", { name: "Preview new draft from this version" })); await screen.findByRole("button", { name: "Confirm and apply this change" });
  let calls = vi.mocked(requestAdmin).mock.calls.filter(c => (c[1] as { operation: string }).operation === "preview");
  expect(calls.at(-2)![1]).toEqual(calls.at(-1)![1]);
  const old = (calls.at(-1)![1] as { requestId: string }).requestId;
  await f.loadAndPreserve(); fireEvent.click(screen.getByRole("button", { name: "Preview new draft from this version" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm and apply this change" })).not.toBeNull());
  calls = vi.mocked(requestAdmin).mock.calls.filter(c => (c[1] as { operation: string }).operation === "preview");
  expect((calls.at(-1)![1] as { requestId: string }).requestId).not.toBe(old);
});
