// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrainingCommandReview, type TrainingIntent } from "./TrainingCommandReview";
import { clearTrainingIntent, loadTrainingIntent, saveTrainingIntent } from "./trainingRecovery";
import { trainingIds, trainingIntent } from "./fixtures/training";
import { AdminApiError } from "./transport";
import type { TrainingCommandResult, TrainingResponse } from "../../supabase/functions/_shared/trainingProtocol";
const result: TrainingCommandResult = { requestId: trainingIds.request, action: "facilities.provision", organizationId: trainingIds.organization, replayed: false, result: { organizationId: trainingIds.organization, facilityId: trainingIds.facility } };
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });
function review(request = vi.fn<(...args: Parameters<import("./trainingClient").TrainingClient["request"]>) => Promise<TrainingResponse>>().mockResolvedValue(result), intent = trainingIntent, recovered = false) {
  const onApplied = vi.fn(), onClose = vi.fn();
  const view = render(<TrainingCommandReview actorId="owner-a" intent={intent} client={{ request }} recovered={recovered} onApplied={onApplied} onClose={onClose} />);
  return { ...view, request, onApplied, onClose };
}
function apply() { fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Apply reviewed change" })); }
describe("reviewed training changes", () => {
  it("requires explicit review and saves the exact actor-bound intent before dispatch", async () => {
    const request = vi.fn(async () => { expect(loadTrainingIntent("owner-a")).toEqual(trainingIntent); expect(loadTrainingIntent("owner-b")).toBeNull(); return result; });
    const test = review(request);
    expect((screen.getByRole("button", { name: "Apply reviewed change" }) as HTMLButtonElement).disabled).toBe(true);
    apply(); await waitFor(() => expect(test.onApplied).toHaveBeenCalledOnce());
    expect(request.mock.calls).toHaveLength(1); expect(loadTrainingIntent("owner-a")).toBeNull();
  });
  it("retains a timed-out request across remount and retries its original UUID without allowing edits", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("network timeout")).mockResolvedValue({ ...result, replayed: true });
    const first = review(request); apply();
    await screen.findByRole("button", { name: "Retry same training change" });
    expect((screen.getByRole("button", { name: "Back to edit" }) as HTMLButtonElement).disabled).toBe(true);
    const saved = loadTrainingIntent("owner-a")!; first.unmount();
    const second = review(request, saved, true);
    fireEvent.click(screen.getByRole("button", { name: "Retry same training change" }));
    await waitFor(() => expect(second.onApplied).toHaveBeenCalledOnce());
    expect(request.mock.calls[0][0]).toEqual(request.mock.calls[1][0]);
  });
  it.each(["401", "403"])("keeps %s after possible native I/O unresolved", async code => {
    review(vi.fn().mockRejectedValue(new AdminApiError(code))); apply();
    await screen.findByRole("button", { name: "Retry same training change" });
    expect(loadTrainingIntent("owner-a")?.command.requestId).toBe(trainingIds.request);
    expect((screen.getByRole("button", { name: "Back to edit" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("allows correction after a definitive initial rejection but not after an earlier uncertain attempt", async () => {
    review(vi.fn().mockRejectedValue(new AdminApiError("invalid_request"))); apply();
    await screen.findByText(/CareBase declined/);
    expect(loadTrainingIntent("owner-a")).toBeNull();
    expect((screen.getByRole("button", { name: "Back to edit" }) as HTMLButtonElement).disabled).toBe(false);
    cleanup(); saveTrainingIntent("owner-a", trainingIntent);
    review(vi.fn().mockRejectedValue(new AdminApiError("invalid_request")), trainingIntent, true);
    fireEvent.click(screen.getByRole("button", { name: "Retry same training change" }));
    await screen.findByText(/result has not been confirmed/);
    expect(loadTrainingIntent("owner-a")).toEqual(trainingIntent);
  });
  it("does not dispatch when safe recovery storage is unavailable", async () => {
    const test = review(); vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked storage"); }); apply();
    await screen.findByText(/No change was sent/);
    expect(test.request).not.toHaveBeenCalled();
  });
  it("retains an invitation with unknown delivery instead of claiming a completed send", async () => {
    const intent: TrainingIntent = { ...trainingIntent, command: { ...trainingIntent.command, action: "invitations.create", organizationId: trainingIds.organization, parameters: { firstName: "Ava", lastName: "Admin", email: "ava@example.test", role: "org_admin", facilityId: null, employeeId: null } } };
    const test = review(vi.fn().mockResolvedValue({ ...result, action: "invitations.create", result: { invitationId: null, deliveryStatus: "unknown" } }), intent); apply();
    await screen.findByText(/invitation delivery result is unconfirmed/);
    expect(test.onApplied).not.toHaveBeenCalled(); expect(loadTrainingIntent("owner-a")).toEqual(intent);
  });
  it("aborts callbacks on navigation while preserving the dispatched request for recovery", async () => {
    let finish!: (response: TrainingResponse) => void;
    const request = vi.fn(() => new Promise<TrainingResponse>(resolve => { finish = resolve; }));
    const test = review(request); apply(); fireEvent.click(screen.getByRole("button", { name: "Confirming result…" }));
    expect(request).toHaveBeenCalledOnce(); test.unmount(); finish(result);
    await Promise.resolve(); expect(test.onApplied).not.toHaveBeenCalled(); expect(loadTrainingIntent("owner-a")).toEqual(trainingIntent);
    clearTrainingIntent("owner-a");
  });
});
