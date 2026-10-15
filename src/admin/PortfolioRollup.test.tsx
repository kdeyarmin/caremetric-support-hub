// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AdminBillingOverview, PortfolioCapabilities, PortfolioOverview, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import { PortfolioRollup } from "./PortfolioRollup";
import type { PortfolioClient } from "./portfolioClient";

// DOM tests inject every data client; initialize the app's ordinary explicit preview configuration.
vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(cleanup);

interface ProductReads { capabilities?: PortfolioCapabilities; overview?: PortfolioOverview; billing?: AdminBillingOverview; }
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
    organizations: unexpected, users: unexpected, subscriptions: unexpected,
    billing: vi.fn<PortfolioClient["billing"]>(async ({ product }) => {
      const entry = reads[product];
      if (!entry?.billing) throw { code: "upstream" };
      return entry.billing;
    }),
    invoices: unexpected, invoice: unexpected, verifySubscription: unexpected,
  };
}
function renderRollup(portfolio: PortfolioClient) {
  return render(<MemoryRouter><PortfolioRollup portfolio={portfolio} /></MemoryRouter>);
}
function totalsText(root: HTMLElement): string {
  return root.querySelector(".rollup-totals")?.textContent ?? "";
}

describe("portfolio rollup", () => {
  it("shows verified health and figures for answering applications and unavailable without invented figures for silent ones", async () => {
    const portfolio = fakePortfolio({
      carebase: {
        capabilities: { apiVersion: 1, operations: ["overview", "billing.overview"], sourceRevision: "abc1234" },
        overview: { organizationCount: 2, activeUserCount: 3 },
        billing: { source: "application_database", subscriptionCount: 5, statusCounts: [{ status: "active", count: 5 }] },
      },
    });
    renderRollup(portfolio);
    const health = await screen.findByRole("region", { name: "Application health" });
    expect(within(health).getByText(/Connections verified for 1 of 6 applications/)).toBeTruthy();
    const carebase = within(health).getByRole("region", { name: "CareBase health" });
    expect(within(carebase).getByText("Connection verified")).toBeTruthy();
    expect(within(carebase).getByText("Deployed source: abc1234")).toBeTruthy();
    expect(within(carebase).getByText("Organizations")).toBeTruthy();
    expect(within(health).getAllByText("Unavailable")).toHaveLength(5);
    const financials = screen.getByRole("region", { name: "Subscription financials" });
    expect(totalsText(financials)).toContain("5 recorded subscriptions across CareBase");
    expect(document.body.textContent).not.toContain("0 recorded subscriptions");
  });

  it("requests the overview and billing reads only when the capabilities advertise them", async () => {
    const portfolio = fakePortfolio({
      pennsync: {
        capabilities: { apiVersion: 1, operations: ["overview"], sourceRevision: null },
        overview: { organizationCount: 4, activeUserCount: null, registeredUserCount: 9, subscriptionCount: 3 },
      },
      "caremetric-emr": {
        capabilities: { apiVersion: 1, operations: ["billing.overview"], sourceRevision: null },
        billing: { source: "application_database", subscriptionCount: 2, statusCounts: [{ status: "active", count: 2 }] },
      },
    });
    renderRollup(portfolio);
    const health = await screen.findByRole("region", { name: "Application health" });
    expect(portfolio.billing).not.toHaveBeenCalledWith(expect.objectContaining({ product: "pennsync" }));
    expect(portfolio.overview).not.toHaveBeenCalledWith(expect.objectContaining({ product: "caremetric-emr" }));
    const pennsync = within(health).getByRole("region", { name: "PennSync health" });
    expect(within(pennsync).getByText("Not reported")).toBeTruthy();
    const emr = within(health).getByRole("region", { name: "CareMetric EMR health" });
    expect(within(emr).getByText("This connection does not provide an application overview.")).toBeTruthy();
    const financials = screen.getByRole("region", { name: "Subscription financials" });
    expect(within(financials).getByText("This connection does not provide a billing overview.")).toBeTruthy();
    expect(totalsText(financials)).toContain("2 recorded subscriptions across CareMetric EMR");
  });

  it("excludes CareMetric Go from the portfolio totals and explains the shared records", async () => {
    const portfolio = fakePortfolio({
      "caremetric-emr": {
        capabilities: { apiVersion: 1, operations: ["billing.overview"], sourceRevision: null },
        billing: { source: "application_database", subscriptionCount: 4, statusCounts: [{ status: "active", count: 4 }] },
      },
      "caremetric-go": {
        capabilities: { apiVersion: 1, operations: ["billing.overview"], sourceRevision: null },
        billing: { source: "application_database", subscriptionCount: 4, statusCounts: [{ status: "active", count: 4 }] },
      },
    });
    renderRollup(portfolio);
    const financials = await screen.findByRole("region", { name: "Subscription financials" });
    expect(totalsText(financials)).toContain("4 recorded subscriptions across CareMetric EMR");
    expect(within(financials).getByText(/CareMetric Go reported billing records, but they are shared with CareMetric EMR/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("8 recorded subscriptions");
  });

  it("shows no portfolio total when no application reports billing", async () => {
    const silent: ProductReads = { capabilities: { apiVersion: 1, operations: [], sourceRevision: null } };
    const portfolio = fakePortfolio({
      carebase: silent, breathe: silent, "caremetric-emr": silent,
      pennsync: silent, intel: silent, "caremetric-go": silent,
    });
    renderRollup(portfolio);
    const financials = await screen.findByRole("region", { name: "Subscription financials" });
    expect(within(financials).getByText("No application reported billing totals, so no portfolio total is shown.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("0 recorded subscriptions");
    const health = screen.getByRole("region", { name: "Application health" });
    expect(within(health).getByText(/Connections verified for 6 of 6 applications/)).toBeTruthy();
  });
});
