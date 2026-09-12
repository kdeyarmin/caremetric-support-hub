// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../imports/fixtures/governedCourse.json";
import { DistributionPanel } from "./DistributionPanel";
import { runDistribution } from "./distributionClient";
import type { DistributionContext, DistributionPlan, DistributionPreview } from "./distributionProtocol";

vi.mock("./distributionClient", () => ({ runDistribution: vi.fn() }));
const courseId = fixture.sourceCourseId, versionId = fixture.sourceVersionId, sha = "a".repeat(64), digest = "b".repeat(64);
const app1 = "90100000-0000-0000-0000-000000000001", app2 = "90100000-0000-0000-0000-000000000002", app3 = "90100000-0000-0000-0000-000000000003";
function context(): DistributionContext {
  return { native: { courseId, publicationState: "published", currentVersionId: versionId, currentVersionState: "published", source: { payload: JSON.stringify(fixture), sourceRevision: sha } },
    catalog: { itemId: "90200000-0000-0000-0000-000000000001", status: "draft", accessLevel: "staff", catalogDigest: digest,
      metadata: { title: "Shared course", summary: "A catalog description", category: "Clinical", durationMinutes: 240 }, productIds: [], legacy: false,
      availability: { managed: true, state: "unverified", observedAt: null, validUntil: null } },
    products: [{ id: app1, slug: "carebase", name: "CareBase", eligible: true }, { id: app2, slug: "breathe", name: "Breathe", eligible: true }, { id: app3, slug: "closed", name: "Closed app", eligible: false }],
    observerConfigured: true, legacyOptInAllowed: false, requests: [] };
}
function plan(): DistributionPlan {
  return { courseId, versionId, sourceRevision: sha, expectedCatalogDigest: digest, metadata: context().catalog.metadata!, productIds: [app1], removedProductIds: [], accessLevel: "staff",
    reason: "Review this exact shared course", reviewed: true, confirmReplacement: false, confirmRetirements: false };
}
function preview(input: { requestId: string; plan: DistributionPlan }, completed = false): DistributionPreview {
  return { requestId: input.requestId, plan: input.plan, canCommitThisSession: !completed, previewDigest: "c".repeat(64), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), replacesPublished: input.plan.confirmReplacement,
    result: completed ? { requestId: input.requestId, itemId: context().catalog.itemId, revisionId: "90300000-0000-0000-0000-000000000001", revisionNumber: 1,
      courseId, versionId, sourceRevision: sha, productIds: input.plan.productIds, accessLevel: input.plan.accessLevel, publishedAt: new Date().toISOString() } : null };
}
beforeEach(() => { vi.mocked(runDistribution).mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(value = context()) {
  vi.mocked(runDistribution).mockImplementation(async operation => {
    if (operation.operation === "context") return value;
    if (operation.operation === "preview") return preview(operation);
    throw Error("Unexpected fixture operation");
  });
  return render(<DistributionPanel courseId={courseId} />);
}
async function review() {
  await screen.findByText("Published version 2 · Original version title");
  if (!(screen.getByLabelText("CareBase") as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText("CareBase"));
  fireEvent.change(screen.getByLabelText("Reason for distribution"), { target: { value: "Review this exact shared course" } });
  fireEvent.click(screen.getByLabelText(/I reviewed this exact published material/));
}
it("reviews the current published material and freezes the selected eligible app IDs", async () => {
  setup(); await screen.findByRole("button", { name: "Preview distribution" });
  expect(runDistribution).toHaveBeenCalledWith({ operation: "context", courseId }, expect.any(AbortSignal));
  expect(screen.getByRole("button", { name: "Preview distribution" }).matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Select all currently eligible apps" }));
  await review(); fireEvent.click(screen.getByRole("button", { name: "Preview distribution" }));
  await screen.findByRole("button", { name: "Publish reviewed distribution" });
  const operation = vi.mocked(runDistribution).mock.calls[1]![0];
  expect(operation).toMatchObject({ operation: "preview", plan: { versionId, sourceRevision: sha, productIds: [app1, app2], reviewed: true } });
  expect(screen.getByRole("button", { name: "Publish reviewed distribution" }).matches(":disabled")).toBe(true);
  expect(vi.mocked(runDistribution).mock.calls.some(([op]) => op.operation === "commit")).toBe(false);
});
it("requires named replacement and app removal acknowledgements", async () => {
  const value = context(); value.catalog.status = "published"; value.catalog.productIds = [app1, app2]; setup(value);
  await screen.findByLabelText("Breathe"); fireEvent.click(screen.getByLabelText("Breathe")); await review();
  expect(screen.getByText("Listings to remove: Breathe.")).toBeTruthy();
  const button = screen.getByRole("button", { name: "Preview distribution" }); expect(button.matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByLabelText(/I confirm replacing/)); expect(button.matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByLabelText(/I confirm removing/)); fireEvent.click(button);
  await screen.findByRole("button", { name: "Publish reviewed distribution" });
  expect(vi.mocked(runDistribution).mock.calls[1]![0]).toMatchObject({ plan: { productIds: [app1], removedProductIds: [app2], confirmReplacement: true, confirmRetirements: true } });
});
it("requires explicit replacement for scheduled placements before the catalog is published", async () => {
  const value = context(); value.catalog.status = "draft"; value.catalog.productIds = [app1]; setup(value);
  await review();
  const button = screen.getByRole("button", { name: "Preview distribution" });
  expect(button.matches(":disabled")).toBe(true);
  expect(runDistribution).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByLabelText("I confirm replacing the current or scheduled app listings."));
  fireEvent.click(button);
  await screen.findByRole("button", { name: "Publish reviewed distribution" });
  expect(vi.mocked(runDistribution).mock.calls[1]![0]).toMatchObject({ plan: { productIds: [app1], confirmReplacement: true } });
});
it.each(["observer", "legacy", "unpublished"])("does not offer a write when %s is unavailable", async mode => {
  const value = context();
  if (mode === "observer") value.observerConfigured = false;
  if (mode === "legacy") { value.catalog.legacy = true; value.catalog.availability = { managed: false, state: "legacy", observedAt: null, validUntil: null }; }
  if (mode === "unpublished") value.native = { courseId, publicationState: "draft", currentVersionId: null, currentVersionState: null, source: null };
  setup(value); await screen.findByRole("button", { name: "Preview distribution" });
  expect(screen.getByRole("button", { name: "Preview distribution" }).matches(":disabled")).toBe(true);
  expect(runDistribution).toHaveBeenCalledTimes(1);
});
it("keeps an already managed legacy listing editable after initial opt-in is disabled", async () => {
  const value = context(); value.catalog.legacy = true; value.legacyOptInAllowed = false; setup(value);
  await review(); expect(screen.getByRole("button", { name: "Preview distribution" }).matches(":disabled")).toBe(false);
  expect(screen.queryByText("Managed distribution for existing listings is disabled on this connection.")).toBeNull();
});
it("retains an ambiguous preview identity and recovers a lost committed response without applying again", async () => {
  setup(); await review();
  vi.mocked(runDistribution).mockRejectedValueOnce({ code: "upstream" });
  fireEvent.click(screen.getByRole("button", { name: "Preview distribution" })); await screen.findByRole("alert");
  const original = vi.mocked(runDistribution).mock.calls[1]![0]; if (original.operation !== "preview") throw Error("fixture preview missing");
  fireEvent.click(screen.getByRole("button", { name: "Retry saved preview" }));
  await screen.findByRole("button", { name: "Publish reviewed distribution" }); expect(vi.mocked(runDistribution).mock.calls[2]![0]).toEqual(original);
  vi.mocked(runDistribution).mockRejectedValueOnce({ code: "upstream" });
  fireEvent.click(screen.getByLabelText(/I confirm these exact saved changes/)); fireEvent.click(screen.getByRole("button", { name: "Publish reviewed distribution" }));
  await screen.findByRole("alert");
  vi.mocked(runDistribution).mockResolvedValueOnce(preview(original, true)); fireEvent.click(screen.getByRole("button", { name: "Check saved request" }));
  await screen.findByText("Completed distribution receipt");
  expect(vi.mocked(runDistribution).mock.calls.filter(([op]) => op.operation === "commit")).toHaveLength(1);
  expect(vi.mocked(runDistribution).mock.lastCall![0]).toEqual({ operation: "resume", requestId: original.requestId });
  expect(screen.queryByRole("button", { name: "Publish reviewed distribution" })).toBeNull();
});
it("requires a fresh review after the local metadata changes and preserves legacy multiline text for correction", async () => {
  const value = context(); value.catalog.metadata!.summary = "Legacy first line\nSecond line"; setup(value); await review();
  expect(screen.getByRole("button", { name: "Preview distribution" }).matches(":disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Catalog summary"), { target: { value: "Reviewed single line" } });
  expect((screen.getByLabelText(/I reviewed this exact published material/) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText(/I reviewed this exact published material/)); fireEvent.click(screen.getByRole("button", { name: "Preview distribution" }));
  await screen.findByRole("button", { name: "Publish reviewed distribution" });
  expect(vi.mocked(runDistribution).mock.calls[1]![0]).toMatchObject({ plan: { metadata: { summary: "Reviewed single line" } } });
});
it.each(["expired", "changed-source", "new-session"])("checks saved %s requests without granting a new publication", async mode => {
  const value = context(), saved = preview({ requestId: "90400000-0000-0000-0000-000000000001", plan: plan() });
  if (mode === "expired") { const expiredAt = Date.now() - 1000; saved.createdAt = new Date(expiredAt - 300_000).toISOString(); saved.expiresAt = new Date(expiredAt).toISOString(); saved.canCommitThisSession = false; }
  else if (mode === "changed-source") value.native!.source!.sourceRevision = "d".repeat(64);
  else saved.canCommitThisSession = false;
  value.requests = [saved]; setup(value);
  await screen.findByRole("button", { name: `Review saved request ${saved.requestId}` });
  vi.mocked(runDistribution).mockResolvedValueOnce(saved); fireEvent.click(screen.getByRole("button", { name: `Review saved request ${saved.requestId}` }));
  await screen.findByRole("button", { name: "Publish reviewed distribution" });
  expect(screen.getByRole("button", { name: "Publish reviewed distribution" }).matches(":disabled")).toBe(true);
  expect(vi.mocked(runDistribution).mock.calls[1]![0]).toEqual({ operation: "resume", requestId: saved.requestId });
});
it("aborts an obsolete course request and ignores its late response", async () => {
  let resolve!: (value: DistributionContext) => void;
  vi.mocked(runDistribution).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const { rerender } = render(<DistributionPanel courseId={courseId} />), signal = vi.mocked(runDistribution).mock.calls[0]![1];
  const other = context(), nextCourse = "99100000-0000-0000-0000-000000000099"; other.native = null; other.catalog.metadata!.title = "Other course";
  vi.mocked(runDistribution).mockResolvedValueOnce(other); rerender(<DistributionPanel courseId={nextCourse} />);
  await screen.findByDisplayValue("Other course"); expect(signal.aborted).toBe(true); resolve(context());
  await waitFor(() => expect(screen.queryByDisplayValue("Shared course")).toBeNull());
});
