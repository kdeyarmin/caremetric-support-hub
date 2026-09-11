// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { billingResultMetadata } from "../../supabase/functions/_shared/billingCommandProtocol";
import type { BillingIntent, BillingResult } from "../../supabase/functions/_shared/billingCommandProtocol";
import { BillingPortal } from "./BillingPortal";
import type { BillingCommandClient } from "./billingCommandClient";
import { billingApply, billingCreated, billingIntent, billingOrganization, billingPending, billingRequest, portalUrl } from "./fixtures/billingPortal";

vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const target = { id: billingOrganization, label: "Example organization" };
function client(overrides: Partial<BillingCommandClient> = {}): BillingCommandClient {
  return { resume: vi.fn(async () => null), preview: vi.fn(async request => ({ ...billingIntent(), request, preview: { ...billingIntent().preview!, reason: request.reason } })),
    apply: vi.fn(async () => billingCreated()), discard: vi.fn(async () => {}), ...overrides };
}
const click = async(name: string | RegExp) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const renderPortal = async(api: BillingCommandClient, navigate = vi.fn()) => {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<BillingPortal target={target} client={api} onClose={vi.fn()} navigate={navigate} />); });
  return view;
};

describe("reviewed billing portal interactions", () => {
  it("keeps one request identity when a form is submitted twice before state updates", async () => {
    let resolve!: (intent: BillingIntent) => void;
    const pending = new Promise<BillingIntent>(done => { resolve = done; });
    const api = client({ preview: vi.fn(() => pending) });
    await renderPortal(api);
    const input = screen.getByLabelText("Administrative reason");
    fireEvent.change(input, { target: { value: billingRequest.reason } });
    const form = input.closest("form")!;
    await act(async () => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(api.preview).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(billingIntent()); });
    expect(screen.getByRole("button", { name: "Create reviewed portal session" })).toBeTruthy();
  });
  it("requires a reason and explicit confirmation; navigation replays the same command", async () => {
    const api = client(), navigate = vi.fn(); await renderPortal(api, navigate);
    expect((screen.getByRole("button", { name: "Preview billing portal" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Administrative reason"), { target: { value: billingRequest.reason } });
    await click("Preview billing portal");
    expect(api.apply).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Create reviewed portal session" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    await click("Create reviewed portal session");
    expect(navigate).not.toHaveBeenCalled();
    expect(document.querySelector('a[href*="stripe.com"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain(portalUrl);
    await click("Open Stripe portal");
    expect(api.apply).toHaveBeenCalledTimes(2);
    expect(api.apply).toHaveBeenNthCalledWith(1, billingApply, expect.objectContaining({ commandId: billingApply.commandId }), expect.any(AbortSignal));
    expect(api.apply).toHaveBeenNthCalledWith(2, billingApply, expect.objectContaining({ commandId: billingApply.commandId }), expect.any(AbortSignal));
    expect(navigate).toHaveBeenCalledWith(portalUrl);
  });
  it("retains the original preview key after a lost response and a page reload", async () => {
    const saved = { ...billingIntent(), preview: null };
    const api = client({ resume: vi.fn(async () => saved), preview: vi.fn().mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue(billingIntent()) });
    const view = await renderPortal(api);
    expect(screen.queryByRole("button", { name: "Discard undispatched review" })).toBeNull();
    expect((screen.getByLabelText("Administrative reason") as HTMLInputElement).disabled).toBe(true);
    await click("Retry same preview");
    expect(api.preview).toHaveBeenLastCalledWith(billingRequest, expect.any(AbortSignal));
    view.unmount(); await renderPortal(api); await click("Retry same preview");
    expect(api.preview).toHaveBeenCalledTimes(2);
    expect(api.preview).toHaveBeenLastCalledWith(billingRequest, expect.any(AbortSignal));
  });
  it("keeps a pending command, waits thirty seconds, and never creates a replacement automatically", async () => {
    vi.useFakeTimers();
    const saved = billingIntent(); saved.dispatchedAt = new Date().toISOString(); saved.result = billingPending;
    saved.retryAt = new Date(Date.now() + 30000).toISOString();
    const api = client({ resume: vi.fn(async () => saved), apply: vi.fn(async () => billingPending) });
    await renderPortal(api);
    expect((screen.getByRole("button", { name: "Retry available in 30s" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Review a new portal session" })).toBeNull();
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(api.apply).not.toHaveBeenCalled(); expect(api.preview).not.toHaveBeenCalled();
    await click("Retry same command");
    expect(api.apply).toHaveBeenCalledWith(billingApply, saved.preview, expect.any(AbortSignal));
    expect(api.preview).not.toHaveBeenCalled();
  });
  it("does not navigate on revoked access when opening a previously created session", async () => {
    const saved = billingIntent(); saved.dispatchedAt = new Date().toISOString(); saved.result = billingResultMetadata(billingCreated());
    const api = client({ resume: vi.fn(async () => saved), apply: vi.fn().mockRejectedValue({ code: "403" }) }), navigate = vi.fn();
    await renderPortal(api, navigate); await click("Open Stripe portal");
    expect(navigate).not.toHaveBeenCalled(); expect(document.body.innerHTML).not.toContain(portalUrl);
    expect(screen.getByRole("alert").textContent).toContain("Current administrator access");
  });
  it("never navigates after an outstanding replay is unmounted", async () => {
    let resolve!: (result: BillingResult) => void;
    const pending = new Promise<BillingResult>(done => { resolve = done; });
    const saved = billingIntent(); saved.dispatchedAt = new Date().toISOString(); saved.result = billingResultMetadata(billingCreated());
    const api = client({ resume: vi.fn(async () => saved), apply: vi.fn(() => pending) }), navigate = vi.fn();
    const view = await renderPortal(api, navigate); await click("Open Stripe portal");
    view.unmount(); await act(async () => { resolve(billingCreated()); });
    expect(navigate).not.toHaveBeenCalled();
  });
  it("does not allow a new review when saved state could not be read", async () => {
    const api = client({ resume: vi.fn().mockRejectedValue(new Error("Unavailable")) });
    await renderPortal(api);
    expect(screen.queryByLabelText("Administrative reason")).toBeNull();
    expect(screen.getByRole("button", { name: "Recover saved review" })).toBeTruthy();
    expect(api.preview).not.toHaveBeenCalled();
  });
});
