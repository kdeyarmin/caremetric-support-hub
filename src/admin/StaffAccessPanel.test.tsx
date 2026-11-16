// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffAccessPanel } from "./StaffAccessPanel";
import type { StaffAccessClient } from "./staffAccessClient";
import type { StaffAccessOperation } from "./staffAccessProtocol";
import { AdminApiError } from "./transport";
import { staffApplied, staffContext, staffPreview, staffTarget, staffUserId } from "./testFixtures/staffAccess";

vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(cleanup);
type Operation = StaffAccessOperation extends infer T ? T extends unknown ? Omit<T, "domain"> : never : never;
const future = { ...staffPreview, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() };
function fixture(answers: Partial<Record<Operation["operation"], (operation: Operation) => unknown>> = {}) {
  const request = vi.fn(async (operation: Operation) => {
    const answer = answers[operation.operation];
    if (answer) return answer(operation);
    return operation.operation === "context" ? staffContext : operation.operation === "preview" ? future : { ...staffApplied, createdAt: future.createdAt, expiresAt: future.expiresAt };
  }) as unknown as StaffAccessClient["request"];
  const onApplied = vi.fn();
  render(<StaffAccessPanel userId={staffUserId} label="Robin Reyes" client={{ request }} onClose={vi.fn()} onApplied={onApplied} />);
  return { request: request as unknown as ReturnType<typeof vi.fn>, onApplied };
}
const withTarget = (target: Partial<typeof staffTarget>) => () => ({ target: { ...staffTarget, ...target }, requests: [] });

describe("Breathe staff sign-in access", () => {
  it("reviews turning a sign-in off, applies it only after confirmation, and shows Breathe's receipt", async () => {
    const f = fixture();
    expect(await screen.findByText(/Turn this sign-in off and sign the person out/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: staffPreview.reason } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    const apply = await screen.findByRole("button", { name: "Apply reviewed change" });
    expect(f.request.mock.calls[1][0]).toMatchObject({ operation: "preview", targetId: staffUserId, parameters: { active: false }, expectedRevision: staffTarget.revision });
    expect(apply).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed this exact change." }));
    fireEvent.click(apply);
    expect(await screen.findByText(/Turned off .*Breathe kept the receipt/)).toBeTruthy();
    expect(f.onApplied).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.at(-1)![0]).toEqual({ operation: "apply", commandId: staffPreview.commandId, expectedDigest: staffPreview.previewDigest });
  });

  it("offers turning a sign-in back on only when Breathe allows it", async () => {
    fixture({ context: withTarget({ status: "revoked", seatStatus: "revoked", unavailable: { deactivate: "no_change", reactivate: null } }) });
    expect(await screen.findByText("Turn this sign-in back on")).toBeTruthy();
    cleanup();
    fixture({ context: withTarget({ status: "revoked", unavailable: { deactivate: "no_change", reactivate: "not_hub_deactivated" } }) });
    expect(await screen.findByText(/Only a sign-in the Hub turned off/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review change" })).toBeNull();
  });

  it.each([
    ["last_administrator", /last active admin/], ["shared_identity", /also a shop, patient-portal or provider-portal login/],
    ["protected_administrator", /Platform operator sign-ins/], ["invited_account", /hasn't been accepted yet/],
  ] as const)("explains %s instead of offering a change", async (reason, text) => {
    fixture({ context: withTarget({ unavailable: { deactivate: reason, reactivate: reason === "invited_account" ? "not_hub_deactivated" : "no_change" } }) });
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review change" })).toBeNull();
  });

  it("recovers a lost apply from the saved review instead of sending another change", async () => {
    const f = fixture({ apply: () => { throw new AdminApiError("upstream"); } });
    await screen.findByText(/Turn this sign-in off/);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: staffPreview.reason } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    const apply = await screen.findByRole("button", { name: "Apply reviewed change" });
    fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed this exact change." }));
    fireEvent.click(apply);
    expect(await screen.findByText(/did not confirm the outcome/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check saved result" }));
    await waitFor(() => expect(screen.getByText(/Breathe kept the receipt/)).toBeTruthy());
    const operations = f.request.mock.calls.map(([operation]) => (operation as Operation).operation);
    expect(operations.filter(name => name === "apply")).toHaveLength(1);
    expect(operations.at(-1)).toBe("resume");
  });
});
