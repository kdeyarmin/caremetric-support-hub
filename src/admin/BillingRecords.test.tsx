// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { InvoiceDetail, InvoiceRecords, SubscriptionVerification } from "./BillingRecords";
import { AdminWorkspace } from "./AdminWorkspace";
import type { PortfolioClient } from "./portfolioClient";
import type { AdminClient } from "./types";
import type { AdminInvoiceDetail } from "../../supabase/functions/_shared/billingProtocol";
import { invoiceDetailFixture, invoiceFixture, subscriptionFixture, subscriptionVerificationFixture } from "./billingFixtures";

// DOM tests inject every data client; initialize the app's ordinary explicit preview configuration.
vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(cleanup);
const unexpected = () => Promise.reject(new Error("Unexpected fixture read"));
function client(overrides: Partial<PortfolioClient> = {}): PortfolioClient {
  return { capabilities: unexpected, overview: unexpected, organizations: unexpected, users: unexpected, subscriptions: unexpected, billing: unexpected,
    invoices: vi.fn(async () => ({ source: "application_database" as const, items: [invoiceFixture], total: 1, limit: 20, offset: 0 })), invoice: vi.fn(async () => invoiceDetailFixture), verifySubscription: vi.fn(async () => subscriptionVerificationFixture), ...overrides };
}
const courseClient: AdminClient = { getOverview: unexpected, listCourses: unexpected, getCourse: unexpected };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("billing read interactions", () => {
  it("loads stored invoices first and performs provider verification only when a record is selected", async () => {
    const pending = deferred<AdminInvoiceDetail>();
    const portfolio = client({ invoice: vi.fn(() => pending.promise) });
    render(<InvoiceRecords portfolio={portfolio} canGet />);
    await screen.findByRole("button", { name: "Compare invoice in_fixture" });
    expect(portfolio.invoice).not.toHaveBeenCalled();
    expect(screen.getAllByText("USD 92,233,720,368,547,758.07").length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Compare invoice in_fixture" }));
    await screen.findByText("Loading invoice and checking Stripe");
    expect(portfolio.invoice).toHaveBeenCalledWith(expect.objectContaining({ id: invoiceFixture.id, signal: expect.any(AbortSignal) }));
    await act(async () => pending.resolve(invoiceDetailFixture));
    const detail = screen.getByRole("region", { name: "Invoice comparison" });
    expect(within(detail).getByText("Compared fields match.")).toBeTruthy();
    expect(within(detail).getByText("Test")).toBeTruthy();
    expect(detail.querySelector('a[href]')).toBeNull();
    fireEvent.click(within(detail).getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("region", { name: "Invoice comparison" })).toBeNull();
  });
  it.each(["unconfigured", "unavailable", "notfound", "identity_mismatch"] as const)("preserves the stored record when Stripe is %s", async availability => {
    const portfolio = client({ invoice: async () => ({ ...invoiceDetailFixture, provider: { ...invoiceDetailFixture.provider, availability, data: null }, comparison: { status: "not_checked", fields: [] } }) });
    render(<InvoiceDetail id={invoiceFixture.id} portfolio={portfolio} onClose={() => undefined} />);
    await screen.findByText("Stripe comparison unavailable");
    expect(screen.getAllByText("USD 92,233,720,368,547,758.07").length).toBe(2);
    expect(screen.queryByText("Compared fields match.")).toBeNull();
    expect(screen.getByText("Provider comparison was not completed.")).toBeTruthy();
    expect(screen.getAllByText("Not checked").length).toBeGreaterThan(0);
  });
  it("shows denied native access without rendering private exception contents or invented data", async () => {
    const portfolio = client({ invoice: async () => { throw { code: "403", message: "PRIVATE_RESPONSE secret customer@example.invalid" }; } });
    render(<InvoiceDetail id={invoiceFixture.id} portfolio={portfolio} onClose={() => undefined} />);
    await screen.findByText("Administrator access required");
    expect(document.body.textContent).not.toContain("PRIVATE_RESPONSE");
    expect(screen.queryByText("USD 0.00")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("cancels stale invoice reads when a different record is selected", async () => {
    const first = deferred<AdminInvoiceDetail>();
    const next = { ...invoiceFixture, id: "91000000-0000-4000-8000-000000000002", providerInvoiceId: "in_second" };
    const portfolio = client({ invoices: async () => ({ source: "application_database", items: [invoiceFixture, next], total: 2, limit: 20, offset: 0 }), invoice: vi.fn(({ id }) => id === invoiceFixture.id ? first.promise : Promise.resolve({ ...invoiceDetailFixture, recorded: next })) });
    render(<InvoiceRecords portfolio={portfolio} canGet />);
    fireEvent.click(await screen.findByRole("button", { name: "Compare invoice in_fixture" }));
    await screen.findByText("Loading invoice and checking Stripe");
    const signal = vi.mocked(portfolio.invoice).mock.calls[0][0].signal;
    fireEvent.click(screen.getByRole("button", { name: "Compare invoice in_second" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Invoice comparison" })).getByText("in_second")).toBeTruthy());
    expect(signal.aborted).toBe(true);
    await act(async () => first.resolve(invoiceDetailFixture));
    const detail = screen.getByRole("region", { name: "Invoice comparison" });
    expect(within(detail).queryByText("in_fixture")).toBeNull();
    expect(within(detail).getByText("in_second")).toBeTruthy();
  });
  it("resets invoice pagination when a new literal search is submitted", async () => {
    const portfolio = client({ invoices: vi.fn<PortfolioClient["invoices"]>(async options => ({ source: "application_database", items: [invoiceFixture], total: 45, limit: options.limit, offset: options.offset })) });
    render(<InvoiceRecords portfolio={portfolio} canGet={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(portfolio.invoices).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 })));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  in_100%  " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(portfolio.invoices).toHaveBeenLastCalledWith(expect.objectContaining({ search: "in_100%", offset: 0 })));
    expect(screen.queryByRole("button", { name: "Compare invoice in_fixture" })).toBeNull();
  });
  it("keeps manual application access separate from a verified Stripe status and can check again", async () => {
    const portfolio = client();
    render(<SubscriptionVerification id={subscriptionFixture.id} portfolio={portfolio} onClose={() => undefined} />);
    await screen.findByText("Compared fields match.");
    expect(screen.getByText("comped")).toBeTruthy();
    expect(screen.getByText("manual_comp")).toBeTruthy();
    expect(screen.getAllByText("active").length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Check Stripe again" }));
    await waitFor(() => expect(portfolio.verifySubscription).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /pay|cancel subscription|refund/i })).toBeNull();
  });
  it.each([false, true])("shows new billing operations only when the native capabilities advertise them: %s", async enabled => {
    const portfolio = client({
      capabilities: async () => ({ apiVersion: 1, sourceRevision: null, operations: ["overview", "billing.overview", "billing.subscriptions.list", ...(enabled ? ["billing.invoices.list", "billing.invoices.get", "billing.subscriptions.verify"] as const : [])] }),
      overview: async () => ({ organizationCount: 1, activeUserCount: 1 }), billing: async () => ({ source: "application_database", subscriptionCount: 1, statusCounts: [{ status: "active", count: 1 }] }),
      subscriptions: async () => ({ source: "application_database", items: [subscriptionFixture], total: 1, limit: 20, offset: 0 }),
    });
    render(<MemoryRouter><AdminWorkspace client={courseClient} portfolio={portfolio} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Billing" }));
    await screen.findByText("Fixture plan");
    expect(Boolean(screen.queryByRole("button", { name: "Verify subscription sub_fixture" }))).toBe(enabled);
    expect(Boolean(screen.queryByText("Stored invoices"))).toBe(enabled);
    if (enabled) {
      fireEvent.click(screen.getByRole("button", { name: "Verify subscription sub_fixture" }));
      await screen.findByText("Compared fields match.");
      expect(portfolio.verifySubscription).toHaveBeenCalledWith(expect.objectContaining({ id: subscriptionFixture.id }));
    } else expect(portfolio.invoices).not.toHaveBeenCalled();
  });
  it.each([false, true])("shows the portal review only when both native billing command capabilities exist: %s", async enabled => {
    const portfolio = client({
      capabilities: async () => ({ apiVersion: 1, sourceRevision: null, operations: ["overview", "billing.overview", "billing.subscriptions.list", "billing.commands.preview", ...(enabled ? ["billing.commands.apply"] as const : [])] }),
      overview: async () => ({ organizationCount: 1, activeUserCount: 1 }), billing: async () => ({ source: "application_database", subscriptionCount: 1, statusCounts: [{ status: "active", count: 1 }] }),
      subscriptions: async () => ({ source: "application_database", items: [subscriptionFixture], total: 1, limit: 20, offset: 0 }),
    });
    render(<MemoryRouter><AdminWorkspace client={courseClient} portfolio={portfolio} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Billing" }));
    await screen.findByText("Fixture plan");
    expect(Boolean(screen.queryByRole("button", { name: "Review billing portal" }))).toBe(enabled);
  });
});
