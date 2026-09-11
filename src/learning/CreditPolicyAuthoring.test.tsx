// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import fixture from "../imports/fixtures/governedCourse.json";
import { sourceDigest } from "../imports/governedLearningImport";
import { requestAdmin } from "../admin/transport";
import { AuthoringPanel } from "./AuthoringPanel";
vi.mock("../admin/transport", () => ({ requestAdmin: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("requires preserved source and explicit policy preview, isolates edit groups and replays the same apply", async () => {
  Object.defineProperty(globalThis.crypto, "subtle", { value: webcrypto.subtle, configurable: true });
  const material = structuredClone(fixture); material.sourceVersionState = "draft"; material.version.aiGenerated = true;
  const payload = JSON.stringify(material), revision = await sourceDigest(payload), commandId = crypto.randomUUID(), snapshotId = crypto.randomUUID();
  const version = { versionId: material.sourceVersionId, sourceRevision: revision, governed: true, aiReviewRequired: true, unresolvedPackages: 0,
    status: "draft", title: material.version.title, versionNumber: material.sourceVersionNumber };
  let fail = true;
  vi.mocked(requestAdmin).mockImplementation(async (_name, value) => {
    const op = value as { operation: string; action: string; reason: string };
    if (op.operation === "inspect") return { courseId: material.sourceCourseId, currentVersionId: null, title: material.course.title, versions: [version] };
    if (op.operation === "source") return { courseId: material.sourceCourseId, versionId: material.sourceVersionId, sourceRevision: revision, payload, snapshotId: null, headRevision: null };
    if (op.operation === "preserve_source") return { snapshotId, sourceRevision: revision, headRevision: revision, sequence: 1, replayed: false };
    if (op.operation === "preview") {
      const before = { courseId: material.sourceCourseId, versionId: material.sourceVersionId, sourceRevision: revision, currentVersionId: null,
        status: "draft", title: version.title, versionNumber: version.versionNumber };
      const { sourceRevision: _revision, ...after } = before; expect(_revision).toBe(revision);
      return { commandId, courseId: material.sourceCourseId, action: op.action, reason: op.reason, previewDigest: "b".repeat(64),
        expiresAt: new Date(Date.now() + 240000).toISOString(), before, after: { ...after, aiReviewRequired: true } };
    }
    if (fail) throw { code: "upstream" };
    return { commandId, courseId: material.sourceCourseId, action: "learning.editCreditPolicy", versionId: material.sourceVersionId,
      versionNumber: version.versionNumber, status: "draft", sourceRevision: "c".repeat(64), appliedAt: new Date().toISOString(), replayed: true };
  });
  render(<AuthoringPanel courseId={material.sourceCourseId} />);
  expect(screen.queryByLabelText("Version label")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load course versions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Load exact course material" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /reviewed this exact version/ }));
  fireEvent.click(screen.getByRole("button", { name: "Preserve reviewed source" }));
  fireEvent.change(await screen.findByLabelText("Reason for change"), { target: { value: "Update the reviewed credit policy label" } });
  fireEvent.change(screen.getByLabelText("Version label"), { target: { value: "Reviewed training edition" } });
  expect((screen.getByRole("button", { name: "Preview credit policy changes" }) as HTMLButtonElement).disabled).toBe(false);
  const editing = screen.getByRole("button", { name: "Discard unsaved edits" }); expect(editing).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Preview credit policy changes" }));
  const apply = await screen.findByRole("button", { name: "Confirm and apply this change" });
  expect(screen.getByRole("region", { name: "Review credit policy changes" })).toBeDefined();
  const preview = vi.mocked(requestAdmin).mock.calls.find(call => (call[1] as { operation: string }).operation === "preview")![1];
  expect(preview).toMatchObject({ action: "learning.editCreditPolicy", parameters: { sourceRevision: revision,
    policy: { versionLabel: "Reviewed training edition" }, credits: material.credits.map(row => ({ creditId: row.id, preserve: true })), removedCreditIds: [] } });
  expect(vi.mocked(requestAdmin).mock.calls.some(call => (call[1] as { operation: string }).operation === "apply")).toBe(false);
  fireEvent.click(apply); await screen.findByRole("alert"); fail = false; fireEvent.click(apply);
  await waitFor(() => expect(screen.getByText(/confirmed version.*previously completed/)).toBeDefined());
  const applies = vi.mocked(requestAdmin).mock.calls.filter(call => (call[1] as { operation: string }).operation === "apply");
  expect(applies).toHaveLength(2); expect(applies[0]![1]).toEqual(applies[1]![1]);
});
