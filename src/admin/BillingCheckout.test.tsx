// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkoutResultMetadata } from "../../supabase/functions/_shared/checkoutCommandProtocol";
import type { CheckoutIntent, CheckoutResult } from "../../supabase/functions/_shared/checkoutCommandProtocol";
import { BillingCheckout } from "./BillingCheckout";
import type { CheckoutCommandClient } from "./checkoutCommandClient";
import { checkoutApply, checkoutCatalog, checkoutCheck, checkoutChoice, checkoutClosed, checkoutIntent, checkoutOpen, checkoutOrganization, checkoutPending, checkoutRequest, checkoutUrl } from "./fixtures/checkout";
vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const target = { id: checkoutOrganization, label: "Example organization" };
function client(overrides: Partial<CheckoutCommandClient> = {}): CheckoutCommandClient {
  return { packages: vi.fn(async () => checkoutCatalog()), resume: vi.fn(async () => null),
    preview: vi.fn(async request => ({ ...checkoutIntent(), request, preview: { ...checkoutIntent().preview!, reason: request.reason } })),
    apply: vi.fn(async () => checkoutOpen()), check: vi.fn(async () => checkoutOpen()), discard: vi.fn(async () => {}), ...overrides };
}
const click = async (name: string | RegExp) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
async function mount(api: CheckoutCommandClient, navigate = vi.fn()) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<BillingCheckout target={target} client={api} onClose={vi.fn()} navigate={navigate} />); });
  return view;
}
async function choose() {
  await click("Choose Example plan · Every 3 months");
  fireEvent.change(screen.getByLabelText("Administrative reason"), { target: { value: checkoutRequest.reason } });
}
function applied(result: CheckoutResult): CheckoutIntent {
  return { ...checkoutIntent(), dispatchedAt: new Date().toISOString(), result: checkoutResultMetadata(result) };
}
describe("reviewed subscription checkout", () => {
  it("shows recorded exact amounts and cadence, and never selects an unmapped price", async () => {
    const page = checkoutCatalog(); page.items.push({ ...checkoutChoice, id: checkoutRequest.requestId, name: "Unmapped plan", availability: "unmapped", providerPriceId: null }); page.total++;
    const api = client({ packages: vi.fn(async () => page) }); await mount(api);
    expect(screen.getByText(/92,233,720,368,547,758.07/).textContent).toContain("USD");
    expect(screen.getByText(/provider prices not checked/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Choose Unmapped plan · Every 3 months" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Preview subscription checkout" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("requires an explicit review, creates once, and opens through a fresh GET-only check", async () => {
    const api = client(), navigate = vi.fn(); await mount(api, navigate); await choose(); await click("Preview subscription checkout");
    expect(api.apply).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Create reviewed checkout" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox")); await click("Create reviewed checkout");
    expect(api.apply).toHaveBeenCalledExactlyOnceWith(checkoutApply, expect.objectContaining({ commandId: checkoutApply.commandId }), expect.any(AbortSignal));
    expect(navigate).not.toHaveBeenCalled(); expect(document.body.innerHTML).not.toContain(checkoutUrl);
    expect(document.querySelector('a[href*="stripe.com"]')).toBeNull();
    await click("Open Stripe checkout");
    expect(api.apply).toHaveBeenCalledTimes(1);
    expect(api.check).toHaveBeenCalledExactlyOnceWith(checkoutCheck, expect.objectContaining({ commandId: checkoutApply.commandId }), expect.any(AbortSignal));
    expect(navigate).toHaveBeenCalledWith(checkoutUrl);
  });
  it("keeps one request identity across simultaneous submits and lost preview recovery", async () => {
    let resolve!: (value: CheckoutIntent) => void;
    const deferred = new Promise<CheckoutIntent>(done => { resolve = done; });
    const api = client({ preview: vi.fn(() => deferred) }); await mount(api); await choose();
    const form = screen.getByLabelText("Administrative reason").closest("form")!;
    await act(async () => { fireEvent.submit(form); fireEvent.submit(form); }); expect(api.preview).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(checkoutIntent()); });
    cleanup();
    const saved = { ...checkoutIntent(), preview: null };
    const recovery = client({ resume: vi.fn(async () => saved), preview: vi.fn().mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue(checkoutIntent()) });
    const view = await mount(recovery); expect(screen.queryByText("Discard undispatched checkout review")).toBeNull();
    await click("Retry same checkout preview"); view.unmount(); await mount(recovery); await click("Retry same checkout preview");
    expect(recovery.preview).toHaveBeenCalledTimes(2);
    expect(recovery.preview).toHaveBeenNthCalledWith(1, checkoutRequest, expect.any(AbortSignal));
    expect(recovery.preview).toHaveBeenNthCalledWith(2, checkoutRequest, expect.any(AbortSignal));
  });
  it("never creates while checking uncertainty and does not release an applied checkout by elapsed time", async () => {
    vi.useFakeTimers(); const saved = applied(checkoutPending()); saved.retryAt = new Date(Date.now() + 30000).toISOString();
    const api = client({ resume: vi.fn(async () => saved), check: vi.fn(async () => checkoutPending()) }); await mount(api);
    expect((screen.getByRole("button", { name: "Check available in 30s" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(3600000); });
    expect(api.check).not.toHaveBeenCalled(); expect(api.apply).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Review another checkout" })).toBeNull();
    await click("Check checkout status"); expect(api.check).toHaveBeenCalledWith(checkoutCheck, saved.preview, expect.any(AbortSignal));
    expect(api.apply).not.toHaveBeenCalled(); expect(api.preview).not.toHaveBeenCalled();
  });
  it("permits a new review only when current native evidence releases a completed checkout", async () => {
    const saved = applied(checkoutClosed("complete"));
    const api = client({ resume: vi.fn(async () => saved), check: vi.fn(async () => checkoutClosed("complete", true)) }); await mount(api);
    expect(screen.queryByRole("button", { name: "Review another checkout" })).toBeNull();
    expect(screen.getByText(/CareBase handles payment settlement/)).toBeTruthy();
    await click("Check checkout status"); await click("Review another checkout");
    expect(screen.getByLabelText("Administrative reason")).toBeTruthy(); expect(api.apply).not.toHaveBeenCalled();
  });
  it("does not disclose a cached URL when current access is denied or a check becomes terminal", async () => {
    const saved = applied(checkoutOpen()), navigate = vi.fn();
    const api = client({ resume: vi.fn(async () => saved), check: vi.fn().mockRejectedValue({ code: "403" }) });
    await mount(api, navigate); await click("Open Stripe checkout");
    expect(navigate).not.toHaveBeenCalled(); expect(document.body.innerHTML).not.toContain(checkoutUrl);
    expect(screen.getByRole("alert").textContent).toContain("Current administrator access");
    cleanup(); await mount(client({ resume: vi.fn(async () => saved), check: vi.fn(async () => checkoutClosed("complete")) }), navigate);
    await click("Open Stripe checkout"); expect(navigate).not.toHaveBeenCalled();
  });
  it("cannot navigate after an outstanding provider check is unmounted", async () => {
    let resolve!: (value: CheckoutResult) => void;
    const deferred = new Promise<CheckoutResult>(done => { resolve = done; }), navigate = vi.fn();
    const view = await mount(client({ resume: vi.fn(async () => applied(checkoutOpen())), check: vi.fn(() => deferred) }), navigate);
    await click("Open Stripe checkout"); view.unmount(); await act(async () => { resolve(checkoutOpen()); });
    expect(navigate).not.toHaveBeenCalled();
  });
  it("withholds a new plan selection until durable recovery succeeds", async () => {
    const api = client({ resume: vi.fn().mockRejectedValue(new Error("Unavailable")) }); await mount(api);
    expect(screen.queryByLabelText("Administrative reason")).toBeNull(); expect(api.packages).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Recover checkout review" })).toBeTruthy();
  });
});
