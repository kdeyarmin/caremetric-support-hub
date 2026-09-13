// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CourseMediaPanel, CourseMediaReceiptRecovery } from "./CourseMediaPanel";
import { runMedia, uploadMedia } from "./mediaClient";
import { portfolioClient } from "../admin/portfolioClient";
import { mediaBase, mediaFixture } from "./testFixtures/media";
vi.mock("./mediaClient", () => ({ runMedia: vi.fn(), uploadMedia: vi.fn(), courseMediaPath: () => "/api/course-media/fixture" }));
vi.mock("../admin/portfolioClient", () => ({ portfolioClient: { capabilities: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup({ current = true, preserved = true, lost = false, enabled = true } = {}) {
  const f = mediaFixture(); f.intent.canFinishThisSession = current;
  if (!preserved) { f.context.headRevision = null; f.context.sourcePreserved = false; }
  let wrote = false;
  vi.mocked(portfolioClient.capabilities).mockResolvedValue({ apiVersion: 1, operations: enabled ? ["learning.media.v1"] : [], sourceRevision: null });
  vi.mocked(runMedia).mockImplementation(async op => {
    if (op.operation === "media.context") return f.context;
    if (op.operation === "media.status") return wrote ? { ...f.intent, result: f.receipt, state: "committed", canFinishThisSession: false } : f.intent;
    if (op.operation === "media.finish") { wrote = true; if (lost) throw { code: "upstream" }; return f.receipt; }
    throw Error();
  });
  const applied = vi.fn(); render(<CourseMediaPanel {...mediaBase} draft onApplied={applied} />); return { ...f, applied };
}
async function inspect() { fireEvent.click(screen.getByRole("button", { name: "Load lesson media" })); fireEvent.click(await screen.findByRole("button", { name: "Inspect saved upload" })); }
it("requires explicit attachment confirmation after a separate upload/status review", async () => {
  const f = setup(); await inspect(); const button = await screen.findByRole("button", { name: "Confirm attachment" });
  expect((button as HTMLButtonElement).disabled).toBe(true); expect(f.applied).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Confirm attaching/ })); fireEvent.click(button);
  await screen.findByRole("status"); expect(f.applied).toHaveBeenCalledOnce(); expect(uploadMedia).not.toHaveBeenCalled();
  expect(vi.mocked(runMedia).mock.calls.filter(([op]) => op.operation === "media.finish")).toHaveLength(1);
});
it("recovers a lost attachment response by status without repeating the write", async () => {
  setup({ lost: true }); await inspect(); fireEvent.click(await screen.findByRole("checkbox", { name: /Confirm attaching/ }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm attachment" })); await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Check attachment receipt" })); await screen.findByRole("status");
  expect(vi.mocked(runMedia).mock.calls.filter(([op]) => op.operation === "media.finish")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Confirm attachment" })).toBeNull();
});
it.each([{ current: false }, { preserved: false }])("keeps expired session or unpreserved source observation read-only: %j", async options => {
  setup(options); await inspect(); await screen.findByText(/cannot be attached in the current session/);
  expect(screen.queryByRole("button", { name: "Confirm attachment" })).toBeNull();
  expect(screen.getByRole("button", { name: "Check attachment receipt" })).toBeDefined();
});
it("does not request media from a deployment without the native capability", async () => {
  setup({ enabled: false }); fireEvent.click(screen.getByRole("button", { name: "Load lesson media" }));
  await screen.findByText(/media management is not enabled/); expect(runMedia).not.toHaveBeenCalled();
});
it("does not attach on a route change and preserves old operation IDs only in their own lesson", async () => {
  setup(); await inspect(); await screen.findByRole("button", { name: "Confirm attachment" });
  cleanup(); render(<CourseMediaPanel {...mediaBase} blockId={mediaBase.courseId} draft />);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm attachment" })).toBeNull());
  expect(vi.mocked(runMedia).mock.calls.filter(([op]) => op.operation === "media.finish")).toHaveLength(0);
});

it("observes a removed lesson receipt with its exact identifiers without requesting context or another write", async () => {
  const f = mediaFixture();
  vi.mocked(runMedia).mockImplementation(async op => {
    if (op.operation !== "media.status") throw Error("Removed lesson has no context");
    return { ...f.intent, state: "committed", result: f.receipt, canFinishThisSession: false };
  });
  render(<CourseMediaReceiptRecovery courseId={mediaBase.courseId} versionId={mediaBase.versionId} />);
  fireEvent.change(screen.getByLabelText("Previous lesson ID"), { target: { value: mediaBase.blockId } });
  fireEvent.change(screen.getByLabelText("Previous media operation ID"), { target: { value: f.intent.operationId } });
  fireEvent.click(screen.getByRole("button", { name: "Recover recorded media outcome", hidden: true }));
  expect((await screen.findByRole("status", { hidden: true })).textContent).toContain(f.receipt.assetId);
  expect(runMedia).toHaveBeenCalledOnce();
  expect(vi.mocked(runMedia).mock.calls[0][0]).toEqual({ ...mediaBase, operation: "media.status", operationId: f.intent.operationId });
  expect(uploadMedia).not.toHaveBeenCalled(); expect(portfolioClient.capabilities).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Confirm attachment", hidden: true })).toBeNull();
});
