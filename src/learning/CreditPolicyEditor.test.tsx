// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../imports/fixtures/governedCourse.json";
import { validateGovernedCourse } from "../imports/governedLearningImport";
import { CreditPolicyEditor } from "./CreditPolicyEditor";
import { CreditPolicyReview } from "./CreditPolicyReview";
import { loadCreditTrainingTypes } from "./creditPolicyClient";
vi.mock("./creditPolicyClient", () => ({ loadCreditTrainingTypes: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const material = validateGovernedCourse(fixture);
function setup(busy = false) {
  const preview = vi.fn();
  render(<CreditPolicyEditor material={material} busy={busy} reasonReady onChange={vi.fn()} onPreview={preview} />);
  return preview;
}
it("retains inactive rules and legacy values while explicitly reviewing changed credits and removals", async () => {
  vi.mocked(loadCreditTrainingTypes).mockResolvedValue({ trainingTypes: [{ id: material.credits[0]!.trainingTypeId, label: "Native active training" }], nextOffset: null });
  const preview = setup();
  expect((screen.getByRole("button", { name: "Edit credit rule 1" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Load active training types" })); await screen.findByText("1 active training types loaded.");
  expect((screen.getByRole("button", { name: "Edit credit rule 2" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Edit credit rule 1" }));
  expect((screen.getByLabelText("Training type") as HTMLInputElement).readOnly).toBe(true);
  fireEvent.change(screen.getByLabelText("Credit hours"), { target: { value: "0.1" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview credit policy changes" }));
  expect(preview.mock.calls[0]![0]).toMatchObject({ credits: [{ creditHours: "0.10" }, { creditId: material.credits[1]!.id, preserve: true }], removedCreditIds: [] });
  fireEvent.click(screen.getByRole("button", { name: "Remove credit rule 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview credit policy changes" }));
  const changes = preview.mock.calls[1]![0]; expect(changes.removedCreditIds).toEqual([material.credits[1]!.id]);
  render(<CreditPolicyReview material={material} changes={changes} />);
  expect(screen.getByText("Remove these rules")).toBeDefined(); expect(screen.getByText("Edit SYNTHETIC")).toBeDefined();
});
it("keeps source rules unchanged during option failures and supports explicit retry", async () => {
  vi.mocked(loadCreditTrainingTypes).mockRejectedValueOnce({ code: "403" }).mockResolvedValueOnce({ trainingTypes: [], nextOffset: null });
  const preview = setup(); fireEvent.click(screen.getByRole("button", { name: "Load active training types" })); await screen.findByRole("alert");
  expect(preview).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Version label"), { target: { value: "Reviewed edition" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview credit policy changes" }));
  expect(preview.mock.calls[0]![0].credits).toEqual(material.credits.map(row => ({ creditId: row.id, preserve: true })));
  fireEvent.click(screen.getByRole("button", { name: "Load active training types" })); await screen.findByText("0 active training types loaded.");
  expect((screen.getByRole("button", { name: "Add credit rule" }) as HTMLButtonElement).disabled).toBe(true);
});
it("does not silently round invalid hours or submit a short rationale", async () => {
  vi.mocked(loadCreditTrainingTypes).mockResolvedValue({ trainingTypes: [{ id: material.credits[0]!.trainingTypeId, label: "Native training" }], nextOffset: null });
  const preview = setup(); fireEvent.click(screen.getByRole("button", { name: "Load active training types" })); await screen.findByText("1 active training types loaded.");
  fireEvent.click(screen.getByRole("button", { name: "Edit credit rule 1" })); fireEvent.change(screen.getByLabelText("Credit hours"), { target: { value: "1.001" } });
  expect((screen.getByRole("button", { name: "Preview credit policy changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Credit hours"), { target: { value: "1.00" } });
  fireEvent.change(screen.getByLabelText("Credited duration rationale"), { target: { value: "Too short" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview credit policy changes" })); expect(preview).not.toHaveBeenCalled();
});
it("locks duplicate option loads and aborts the pending read when unmounted", async () => {
  let complete!: (value: { trainingTypes: []; nextOffset: null }) => void;
  vi.mocked(loadCreditTrainingTypes).mockReturnValue(new Promise(resolve => { complete = resolve; }));
  setup(); const load = screen.getByRole("button", { name: "Load active training types" }); fireEvent.click(load); fireEvent.click(load);
  expect(loadCreditTrainingTypes).toHaveBeenCalledTimes(1); const signal = vi.mocked(loadCreditTrainingTypes).mock.calls[0]![1];
  cleanup(); expect(signal.aborted).toBe(true); complete({ trainingTypes: [], nextOffset: null });
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
});
