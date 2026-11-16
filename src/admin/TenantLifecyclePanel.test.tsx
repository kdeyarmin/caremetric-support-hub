// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantLifecyclePanel } from "./TenantLifecyclePanel";
import type { TenantLifecycleClient } from "./tenantLifecycleClient";
import type { TenantLifecycleOperation } from "./tenantLifecycleProtocol";
import { AdminApiError } from "./transport";
import { lifecycleApplied, lifecycleContext, lifecyclePreview, organizationId, target } from "./testFixtures/tenantLifecycle";

vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(cleanup);
type Operation = TenantLifecycleOperation extends infer T ? T extends unknown ? Omit<T, "domain"> : never : never;
const future = { ...lifecyclePreview, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() };
function fixture(answers: Partial<Record<Operation["operation"], (operation: Operation) => unknown>> = {}) {
  const request = vi.fn(async (operation: Operation) => {
    const answer = answers[operation.operation];
    if (answer) return answer(operation);
    return operation.operation === "context" ? lifecycleContext : operation.operation === "preview" ? future : { ...lifecycleApplied, createdAt: future.createdAt, expiresAt: future.expiresAt };
  }) as unknown as TenantLifecycleClient["request"];
  const onApplied = vi.fn();
  render(<TenantLifecyclePanel organizationId={organizationId} label="Lakeside Medical Supply" client={{ request }} onClose={vi.fn()} onApplied={onApplied} />);
  return { request: request as unknown as ReturnType<typeof vi.fn>, onApplied };
}
async function reviewSuspension() {
  expect(await screen.findByText(/Suspend this organization/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: lifecyclePreview.reason } });
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  return screen.findByRole("button", { name: "Apply reviewed change" });
}

describe("Breathe organization suspend and restore", () => {
  it("reviews the exact change, applies it only after confirmation, and shows Breathe's receipt", async () => {
    const f = fixture();
    const apply = await reviewSuspension();
    const sent = f.request.mock.calls.map(([operation]) => operation as Operation);
    expect(sent[1]).toMatchObject({ operation: "preview", targetId: organizationId, parameters: { suspended: true }, expectedRevision: target.revision, reason: lifecyclePreview.reason });
    expect(apply).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed this exact change." }));
    fireEvent.click(apply);
    expect(await screen.findByText(/Suspended .*Breathe kept the receipt/)).toBeTruthy();
    expect(f.onApplied).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.at(-1)![0]).toEqual({ operation: "apply", commandId: lifecyclePreview.commandId, expectedDigest: lifecyclePreview.previewDigest });
  });

  it("recovers a lost apply from the saved review instead of sending another change", async () => {
    const f = fixture({ apply: () => { throw new AdminApiError("upstream"); } });
    fireEvent.click(await reviewSuspension().then(button => { fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed this exact change." })); return button; }));
    expect(await screen.findByText(/did not confirm the outcome/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Check saved result" }));
    expect(await screen.findByText(/Breathe kept the receipt/)).toBeTruthy();
    const operations = f.request.mock.calls.map(([operation]) => (operation as Operation).operation);
    expect(operations.filter(name => name === "apply")).toHaveLength(1);
    expect(operations.at(-1)).toBe("resume");
  });

  it("offers restore for a suspended organization and never offers to suspend Breathe's own", async () => {
    fixture({ context: () => ({ target: { ...target, status: "suspended" }, requests: [] }) });
    expect(await screen.findByText(/Restore this organization/)).toBeTruthy();
    cleanup();
    fixture({ context: () => ({ target: { ...target, seedProtected: true }, requests: [] }) });
    expect(await screen.findByText("Breathe's own home organization cannot be suspended.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review change" })).toBeNull();
  });

  it("explains a change made in Breathe meanwhile", async () => {
    fixture({ preview: () => { throw new AdminApiError("conflict"); } });
    await expect(reviewSuspension()).rejects.toThrow();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/changed in Breathe since it was loaded/));
  });
});
