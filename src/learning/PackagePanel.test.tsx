// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../imports/fixtures/governedCourse.json";
import { validateGovernedCourse } from "../imports/governedLearningImport";
import { PackagePanel } from "./PackagePanel";
import type { PackageClient } from "./packageClient";
import { packageContext, packageCourseId, packageVersionId, packageIntent, packageReceipt, packageSha, packageId, archiveSha, runtimeSha } from "./packageFixtures";
import type { PackageContextView, PackageResult } from "./packageProtocol";
const material = validateGovernedCourse({ ...fixture, sourceCourseId: packageCourseId, sourceVersionId: packageVersionId,
  packages: [{ ...fixture.packages[0], id: packageId, validationStatus: "pending", standard: "scorm_1_2" }] });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(context: PackageContextView = structuredClone(packageContext)) {
  const client: PackageClient = { available: vi.fn().mockResolvedValue(true), context: vi.fn().mockResolvedValue(context),
    status: vi.fn().mockResolvedValue(null), stage: vi.fn(), finish: vi.fn().mockResolvedValue(packageReceipt) };
  const changed = vi.fn(), busy = vi.fn();
  const view = render(<PackagePanel material={material} sourceRevision={packageSha} reason="Review this exact authored package" disabled={false}
    onEditing={vi.fn()} onBusy={busy} onChanged={changed} client={client} />);
  return { client, changed, busy, ...view };
}
it("recovers a staged operation after reload and requires explicit exact-artifact confirmation", async () => {
  const { client, changed } = setup();
  const confirm = await screen.findByRole("button", { name: "Confirm original registration" });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  expect(client.finish).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/I reviewed this saved artifact/)); fireEvent.click(confirm);
  await waitFor(() => expect(changed).toHaveBeenCalledWith(packageReceipt));
  expect(client.finish).toHaveBeenCalledWith({ operation: "finish", courseId: packageCourseId, versionId: packageVersionId,
    requestId: packageIntent.requestId, operationId: packageIntent.operationId }, expect.any(AbortSignal));
});
it.each(["stale", "old-session", "expired"])("does not offer finish for a %s source/session", async mode => {
  const context = structuredClone(packageContext);
  if (mode === "stale") { context.sourceRevision = "e".repeat(64); context.sourcePreserved = false; }
  else { context.intents.items[0]!.canFinishThisSession = false; if (mode === "expired") context.intents.items[0]!.state = "expired"; }
  const { client } = setup(context); await screen.findByText(/This operation cannot finish/);
  expect(screen.queryByRole("button", { name: "Confirm original registration" })).toBeNull(); expect(client.finish).not.toHaveBeenCalled();
});
it("retains an uncertain acceptance request and stages again with the same identity without auto-finishing", async () => {
  const context = structuredClone(packageContext); context.intents.items = [];
  const { client, changed } = setup(context); await screen.findByText(/No saved package operations/);
  fireEvent.change(screen.getByLabelText("Pending package"), { target: { value: packageId } });
  fireEvent.click(screen.getByLabelText(/I reviewed the authored package/));
  fireEvent.click(screen.getByRole("button", { name: "Review package acceptance" }));
  const stage = await screen.findByRole("button", { name: "Stage this runtime artifact" });
  vi.mocked(client.stage).mockRejectedValueOnce({ code: "upstream" }).mockResolvedValueOnce({ state: "staged", operationId: packageIntent.operationId,
    packageId, versionId: packageVersionId, sourceSha256: archiveSha, runtimeSha256: runtimeSha, entryPoint: "index.html" });
  fireEvent.click(stage); await screen.findByRole("alert"); const original = vi.mocked(client.stage).mock.calls[0]![0];
  fireEvent.click(stage); await screen.findByText(/Artifact staged/);
  expect(vi.mocked(client.stage).mock.calls[1]![0]).toEqual(original); expect(client.finish).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});
it("never adopts a changed receipt or a late response after the panel closes", async () => {
  const { client, changed, unmount } = setup();
  const confirm = await screen.findByRole("button", { name: "Confirm original registration" });
  vi.mocked(client.finish).mockResolvedValueOnce({ ...packageReceipt, sourceSha256: "f".repeat(64) });
  fireEvent.click(screen.getByLabelText(/I reviewed this saved artifact/)); fireEvent.click(confirm);
  await screen.findByRole("alert"); expect(changed).not.toHaveBeenCalled();
  let resolve!: (value: PackageResult) => void;
  vi.mocked(client.finish).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  fireEvent.click(confirm); fireEvent.click(confirm); expect(client.finish).toHaveBeenCalledTimes(2);
  const signal = vi.mocked(client.finish).mock.calls[1]![1]; unmount(); expect(signal.aborted).toBe(true);
  resolve(packageReceipt); await Promise.resolve(); expect(changed).not.toHaveBeenCalled();
});
it("shows the native connection as unavailable without inventing upload readiness", async () => {
  const { client } = setup(); await screen.findByRole("button", { name: "Confirm original registration" });
  vi.mocked(client.available).mockResolvedValue(false); fireEvent.click(screen.getByRole("button", { name: "Refresh package operations" }));
  await screen.findByText(/CareBase has not enabled package ingestion/); expect(screen.queryByLabelText("Original course package")).toBeNull();
});
