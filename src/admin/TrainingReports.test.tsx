// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrainingReports } from "./TrainingReports";
import { trainingIds, trainingReport } from "./fixtures/training";
import { downloadTrainingCsv } from "./trainingPresentation";
import type { TrainingOperation, TrainingResponse } from "../../supabase/functions/_shared/trainingProtocol";
import { AdminApiError } from "./transport";
vi.mock("./trainingPresentation", async importOriginal => ({ ...await importOriginal<object>(), downloadTrainingCsv: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(downloadTrainingCsv).mockClear(); });
const answer = async (operation: TrainingOperation): Promise<TrainingResponse> => operation.operation === "certificates.read"
  ? { certificateId: trainingIds.certificate, status: "ready", url: "https://example.test/signed-certificate.pdf", expiresAt: "2026-09-25T03:00:00Z" }
  : { ...trainingReport, ...(operation.operation === "enrollments.report" ? { limit: operation.limit, offset: operation.offset } : {}) };
function setup(request = vi.fn(answer)) {
  const view = render(<TrainingReports client={{ request }} organizationId={trainingIds.organization} facilityId={trainingIds.facility} onCancel={vi.fn()} />);
  return { ...view, request };
}
describe("facility training report exports", () => {
  it("exports one complete snapshot using applied filters, never unsubmitted draft filters", async () => {
    const { request } = setup(); await screen.findByRole("button", { name: "Export complete CSV" });
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Fire" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    await screen.findByRole("button", { name: "Export complete CSV" });
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Unsubmitted" } });
    fireEvent.click(screen.getByRole("button", { name: "Export complete CSV" }));
    await waitFor(() => expect(downloadTrainingCsv).toHaveBeenCalledOnce());
    const exports = request.mock.calls.map(call => call[0]).filter(operation => operation.operation === "enrollments.report" && operation.limit === 10000);
    expect(exports).toEqual([expect.objectContaining({ organizationId: trainingIds.organization, facilityId: trainingIds.facility, courseSearch: "Fire", dateFrom: "2026-09-01", limit: 10000, offset: 0 })]);
    expect(vi.mocked(downloadTrainingCsv).mock.calls[0][0]).toContain("Course: Fire");
  });
  it.each(["truncated", "report_too_large"])("does not download a %s export", async mode => {
    setup(vi.fn(async operation => {
      if (operation.operation === "enrollments.report" && operation.limit === 10000) {
        if (mode === "report_too_large") throw new AdminApiError("report_too_large");
        return { ...trainingReport, total: 2 };
      }
      return answer(operation);
    }));
    fireEvent.click(await screen.findByRole("button", { name: "Export complete CSV" }));
    await screen.findByText(/No partial report was exported/); expect(downloadTrainingCsv).not.toHaveBeenCalled();
  });
  it("prints a complete PA-dated report outside the app shell and removes it after printing", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {}); setup();
    fireEvent.click(await screen.findByRole("button", { name: "Print complete report" }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    const printable = document.getElementById("hub-training-print")!;
    expect(printable.parentElement).toBe(document.body);
    expect(printable.textContent).toContain("Sep 24, 2026, 10:00 PM EDT");
    act(() => { window.dispatchEvent(new Event("afterprint")); });
    expect(document.getElementById("hub-training-print")).toBeNull();
  });
  it("clears a prepared print when the report filters change", async () => {
    vi.spyOn(window, "print").mockImplementation(() => {}); setup();
    fireEvent.click(await screen.findByRole("button", { name: "Print complete report" }));
    await waitFor(() => expect(document.getElementById("hub-training-print")).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "New report" } });
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    expect(document.getElementById("hub-training-print")).toBeNull();
  });
  it("opens only the certificate read result rather than linking to a native app login", async () => {
    const { request } = setup(); fireEvent.click(await screen.findByRole("button", { name: "View / print certificate" }));
    const link = await screen.findByRole("link", { name: "Open certificate PDF to print or save" });
    expect(link.getAttribute("href")).toBe("https://example.test/signed-certificate.pdf");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ operation: "certificates.read", certificateId: trainingIds.certificate, organizationId: trainingIds.organization }), expect.any(AbortSignal));
  });
});
