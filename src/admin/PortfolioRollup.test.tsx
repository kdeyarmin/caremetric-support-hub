// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PortfolioCapabilities, PortfolioOverview, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import { PortfolioRollup } from "./PortfolioRollup";
import type { PortfolioClient } from "./portfolioClient";
import type { BillingReader } from "./portfolioRollup";
import type { Subscription } from "../billing/billingModel";

// DOM tests inject every data client; initialize the app's ordinary explicit preview configuration.
vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(cleanup);

interface ProductReads { capabilities?: PortfolioCapabilities; overview?: PortfolioOverview; }
function fakePortfolio(reads: Partial<Record<PortfolioProduct, ProductReads>>): PortfolioClient {
  const unexpected = () => Promise.reject(new Error("Unexpected fixture read"));
  return {
    capabilities: vi.fn<PortfolioClient["capabilities"]>(async ({ product }) => {
      const entry = reads[product];
      if (!entry?.capabilities) throw { code: "unconfigured" };
      return entry.capabilities;
    }),
    overview: vi.fn<PortfolioClient["overview"]>(async ({ product }) => {
      const entry = reads[product];
      if (!entry?.overview) throw { code: "upstream" };
      return entry.overview;
    }),
    organizations: unexpected, users: unexpected,
  };
}
const subscription = (app: Subscription["app"], status: Subscription["status"], unitAmount: number): Subscription => ({
  id: `sub_${app}${status}`, tenant_id: "00000000-0000-4000-8000-0000000000aa", customer: "cus_1", app, status, collection_method: "send_invoice",
  cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null, current_period_start: null, current_period_end: null, trial_start: null, trial_end: null,
  pause_behavior: null, pause_resumes_at: null, discounts: [], created: "2026-10-27T00:00:00Z", version: 1,
  items: [{ id: "si_1", price: "price_1", product: "prod_1", quantity: 1, unit_amount: unitAmount, currency: "usd", interval: "month", interval_count: 1, product_name: "Plan", kind: "plan", unit_label: "", pricing_model: "flat", custom: false }],
});
const hubBilling = (subscriptions: Subscription[]): BillingReader => async () => ({ subscriptions, coupons: [] });
function renderRollup(portfolio: PortfolioClient, billing: BillingReader = hubBilling([])) {
  return render(<MemoryRouter><PortfolioRollup portfolio={portfolio} billing={billing} demo={false} /></MemoryRouter>);
}
function totalsText(root: HTMLElement): string {
  return root.querySelector(".rollup-totals")?.textContent ?? "";
}

describe("portfolio rollup", () => {
  it("shows verified health for answering applications and Hub billing for every application", async () => {
    const portfolio = fakePortfolio({
      carebase: { capabilities: { apiVersion: 1, operations: ["overview"], sourceRevision: "abc1234" }, overview: { organizationCount: 2, activeUserCount: 3 } },
    });
    renderRollup(portfolio, hubBilling([subscription("carebase", "active", 19900), subscription("caremetric-intel", "trialing", 34900)]));
    const health = await screen.findByRole("region", { name: "Application health" });
    expect(within(health).getByText(/Connections verified for 1 of 7 applications/)).toBeTruthy();
    const carebase = within(health).getByRole("region", { name: "CareBase health" });
    expect(within(carebase).getByText("Connection verified")).toBeTruthy();
    expect(within(carebase).getByText("Deployed source: abc1234")).toBeTruthy();
    expect(within(health).getAllByText("Unavailable")).toHaveLength(6);
    const financials = screen.getByRole("region", { name: "Subscription financials" });
    expect(totalsText(financials)).toContain("2 subscriptions across");
    expect(totalsText(financials)).toContain("USD monthly recurring revenue: USD 199.00");
  });

  it("never asks an application connection for billing", async () => {
    const portfolio = fakePortfolio({
      pennsync: { capabilities: { apiVersion: 1, operations: ["overview"], sourceRevision: null }, overview: { organizationCount: 4, activeUserCount: null, registeredUserCount: 9, subscriptionCount: 3 } },
    });
    renderRollup(portfolio);
    const health = await screen.findByRole("region", { name: "Application health" });
    const pennsync = within(health).getByRole("region", { name: "PennSync health" });
    expect(within(pennsync).getByText("Not reported")).toBeTruthy();
    expect(portfolio.overview).toHaveBeenCalledWith(expect.objectContaining({ product: "pennsync" }));
    expect(Object.keys(portfolio)).not.toContain("billing");
  });

  it("shows Healthcare Advisors consultation totals and explains that it has no subscriptions", async () => {
    const portfolio = fakePortfolio({
      advisors: {
        capabilities: { apiVersion: 1, operations: ["overview", "inquiries.list"], sourceRevision: "37afa7a" },
        overview: { organizationCount: null, activeUserCount: null, inquiryCount: 12, openInquiryCount: 3 },
      },
    });
    renderRollup(portfolio);
    const health = await screen.findByRole("region", { name: "CareMetric Healthcare Advisors health" });
    expect(within(health).getByText("Open consultation requests")).toBeTruthy();
    const financials = screen.getByRole("region", { name: "Subscription financials" });
    expect(within(financials).getByText(/consulting practice\. It has no software subscriptions/)).toBeTruthy();
    expect(totalsText(financials)).not.toContain("Healthcare Advisors");
  });

  it("shows super-admin coverage: billing from the Hub even when a connection fails", async () => {
    const portfolio = fakePortfolio({
      carebase: { capabilities: { apiVersion: 1, operations: ["organizations.list", "users.list"], sourceRevision: null } },
      advisors: { capabilities: { apiVersion: 1, operations: ["overview", "inquiries.list"], sourceRevision: null }, overview: { organizationCount: null, activeUserCount: null, inquiryCount: 0, openInquiryCount: 0 } },
    });
    renderRollup(portfolio);
    const coverage = await screen.findByRole("region", { name: "Super-admin coverage" });
    expect(within(coverage).getAllByRole("row")).toHaveLength(8);
    const carebase = within(coverage).getByRole("row", { name: /CareBase \(PennTrain\)/ });
    expect(within(carebase).getAllByText("In the Hub")).toHaveLength(4);
    const breathe = within(coverage).getByRole("row", { name: /Breathe \(PennFit\)/ });
    expect(within(breathe).getAllByText("Unavailable")).toHaveLength(1);
    expect(within(breathe).getAllByText("In the Hub")).toHaveLength(3);
  });

  it("shows no portfolio total when the Hub's billing cannot be read", async () => {
    const silent: ProductReads = { capabilities: { apiVersion: 1, operations: [], sourceRevision: null } };
    const portfolio = fakePortfolio({ carebase: silent, breathe: silent, "caremetric-emr": silent, pennsync: silent, intel: silent, "caremetric-go": silent, advisors: silent });
    renderRollup(portfolio, async () => { throw new Error("offline"); });
    const financials = await screen.findByRole("region", { name: "Subscription financials" });
    expect(within(financials).getByText("The Hub's billing records could not be loaded, so no portfolio total is shown.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("0 subscriptions");
    const health = screen.getByRole("region", { name: "Application health" });
    expect(within(health).getByText(/Connections verified for 7 of 7 applications/)).toBeTruthy();
  });
});
