import { describe, expect, it, vi } from "vitest";
import type { AdminBillingOverview, PortfolioCapabilities, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import type { PortfolioClient } from "./portfolioClient";
import { buildPortfolioRollup, groupMoneyByCurrency, loadRollupApp } from "./portfolioRollup";
import type { RollupAppSnapshot, RollupRead } from "./portfolioRollup";

const capabilities: PortfolioCapabilities = { apiVersion: 1, operations: ["overview", "billing.overview"], sourceRevision: "abc1234" };
function billing(subscriptionCount: number, statusCounts: Array<{ status: string; count: number }>): RollupRead<AdminBillingOverview> {
  return { state: "ready", data: { source: "application_database", subscriptionCount, statusCounts } };
}
function snapshot(product: PortfolioProduct, overrides: Partial<RollupAppSnapshot> = {}): RollupAppSnapshot {
  return {
    product,
    capabilities,
    overview: { state: "ready", data: { organizationCount: 1, activeUserCount: 1 } },
    billing: billing(0, []),
    money: [],
    ...overrides,
  };
}

describe("portfolio rollup money grouping", () => {
  it("sums amounts within each currency only and never produces a combined figure", () => {
    const grouped = groupMoneyByCurrency([
      { currency: "usd", amountMinor: "100" },
      { currency: "eur", amountMinor: "50" },
      { currency: "usd", amountMinor: "250" },
      { currency: "jpy", amountMinor: "7" },
    ]);
    expect(grouped).toEqual([
      { currency: "eur", amountMinor: "50" },
      { currency: "jpy", amountMinor: "7" },
      { currency: "usd", amountMinor: "350" },
    ]);
    // The grouped result is the whole money picture: no cross-currency total exists anywhere in it.
    expect(JSON.stringify(grouped)).not.toContain("407");
  });

  it("keeps exact minor-unit arithmetic beyond JavaScript number precision", () => {
    const grouped = groupMoneyByCurrency([
      { currency: "usd", amountMinor: "9007199254740993" },
      { currency: "usd", amountMinor: "9007199254740993" },
    ]);
    expect(grouped).toEqual([{ currency: "usd", amountMinor: "18014398509481986" }]);
  });

  it("rejects amounts and currencies outside the billing contract", () => {
    expect(() => groupMoneyByCurrency([{ currency: "USD", amountMinor: "1" }])).toThrow();
    expect(() => groupMoneyByCurrency([{ currency: "usd", amountMinor: "1.5" }])).toThrow();
    expect(() => groupMoneyByCurrency([{ currency: "usd", amountMinor: "-1" }])).toThrow();
  });

  it("groups only money from applications included in the totals", () => {
    const rollup = buildPortfolioRollup([
      snapshot("carebase", { billing: billing(1, [{ status: "active", count: 1 }]), money: [{ currency: "usd", amountMinor: "100" }] }),
      snapshot("caremetric-go", { billing: billing(1, [{ status: "active", count: 1 }]), money: [{ currency: "usd", amountMinor: "100" }] }),
      snapshot("breathe", { capabilities: null, overview: { state: "unavailable" }, billing: { state: "unavailable" }, money: [{ currency: "usd", amountMinor: "100" }] }),
    ]);
    expect(rollup.moneyByCurrency).toEqual([{ currency: "usd", amountMinor: "100" }]);
  });
});

describe("portfolio rollup totals", () => {
  it("never counts CareMetric Go records beside CareMetric EMR records", () => {
    const rollup = buildPortfolioRollup([
      snapshot("caremetric-emr", { billing: billing(10, [{ status: "active", count: 8 }, { status: "past_due", count: 2 }]) }),
      snapshot("caremetric-go", { billing: billing(10, [{ status: "active", count: 8 }, { status: "past_due", count: 2 }]) }),
    ]);
    expect(rollup.subscriptionTotal).toBe(10);
    expect(rollup.billingReportingApps).toEqual(["caremetric-emr"]);
    expect(rollup.billingExcludedSharedApps).toEqual(["caremetric-go"]);
    expect(rollup.statusTotals).toEqual([
      { status: "active", count: 8 },
      { status: "past_due", count: 2 },
    ]);
  });

  it("shows no total when the only reporting application shares its records", () => {
    const rollup = buildPortfolioRollup([
      snapshot("caremetric-go", { billing: billing(10, [{ status: "active", count: 10 }]) }),
    ]);
    expect(rollup.subscriptionTotal).toBeNull();
    expect(rollup.billingReportingApps).toEqual([]);
    expect(rollup.billingExcludedSharedApps).toEqual(["caremetric-go"]);
    expect(rollup.statusTotals).toEqual([]);
  });

  it("groups subscription statuses across the reporting applications", () => {
    const rollup = buildPortfolioRollup([
      snapshot("carebase", { billing: billing(3, [{ status: "active", count: 2 }, { status: "past_due", count: 1 }]) }),
      snapshot("breathe", { billing: billing(4, [{ status: "active", count: 3 }, { status: "canceled", count: 1 }]) }),
      snapshot("pennsync", { billing: billing(1, [{ status: "active", count: 1 }]) }),
    ]);
    expect(rollup.subscriptionTotal).toBe(8);
    expect(rollup.billingReportingApps).toEqual(["carebase", "breathe", "pennsync"]);
    expect(rollup.statusTotals).toEqual([
      { status: "active", count: 6 },
      { status: "canceled", count: 1 },
      { status: "past_due", count: 1 },
    ]);
  });

  it("keeps unavailable and unadvertised applications out of every total", () => {
    const rollup = buildPortfolioRollup([
      snapshot("carebase", { billing: billing(2, [{ status: "active", count: 2 }]) }),
      snapshot("intel", { capabilities: null, overview: { state: "unavailable" }, billing: { state: "unavailable" } }),
      snapshot("pennsync", { billing: { state: "not-advertised" } }),
    ]);
    expect(rollup.connectionsVerified).toBe(2);
    expect(rollup.connectionsTotal).toBe(3);
    expect(rollup.subscriptionTotal).toBe(2);
    expect(rollup.billingReportingApps).toEqual(["carebase"]);
  });

  it("reports no subscription total when no application reported billing", () => {
    const rollup = buildPortfolioRollup([
      snapshot("carebase", { billing: { state: "not-advertised" } }),
      snapshot("breathe", { capabilities: null, overview: { state: "unavailable" }, billing: { state: "unavailable" } }),
    ]);
    expect(rollup.subscriptionTotal).toBeNull();
    expect(rollup.statusTotals).toEqual([]);
    expect(rollup.moneyByCurrency).toEqual([]);
  });
});

describe("portfolio rollup loading", () => {
  const unexpected = () => Promise.reject(new Error("Unexpected fixture read"));
  function client(overrides: Partial<PortfolioClient>): PortfolioClient {
    return {
      capabilities: unexpected, overview: vi.fn(unexpected), organizations: unexpected, users: unexpected,
      subscriptions: unexpected, billing: vi.fn(unexpected), invoices: unexpected, invoice: unexpected,
      verifySubscription: unexpected, ...overrides,
    };
  }

  it("requests the overview and billing reads only when the capabilities advertise them", async () => {
    const portfolio = client({
      capabilities: vi.fn<PortfolioClient["capabilities"]>(async () => ({ apiVersion: 1, sourceRevision: null, operations: ["overview"] })),
      overview: vi.fn<PortfolioClient["overview"]>(async () => ({ organizationCount: 1, activeUserCount: 1 })),
      billing: vi.fn<PortfolioClient["billing"]>(async () => ({ source: "application_database", subscriptionCount: 0, statusCounts: [] })),
    });
    const result = await loadRollupApp(portfolio, "pennsync", new AbortController().signal);
    expect(result.overview.state).toBe("ready");
    expect(result.billing.state).toBe("not-advertised");
    expect(portfolio.billing).not.toHaveBeenCalled();
  });

  it("marks the whole application unavailable when the capabilities read fails", async () => {
    const portfolio = client({ capabilities: vi.fn<PortfolioClient["capabilities"]>(async () => { throw { code: "unconfigured" }; }) });
    const result = await loadRollupApp(portfolio, "intel", new AbortController().signal);
    expect(result.capabilities).toBeNull();
    expect(result.overview.state).toBe("unavailable");
    expect(result.billing.state).toBe("unavailable");
    expect(portfolio.overview).not.toHaveBeenCalled();
    expect(portfolio.billing).not.toHaveBeenCalled();
  });

  it("keeps a failed billing read unavailable without discarding the overview", async () => {
    const portfolio = client({
      capabilities: vi.fn<PortfolioClient["capabilities"]>(async () => ({ apiVersion: 1, sourceRevision: "abc1234", operations: ["overview", "billing.overview"] })),
      overview: vi.fn<PortfolioClient["overview"]>(async () => ({ organizationCount: 2, activeUserCount: 3 })),
      billing: vi.fn<PortfolioClient["billing"]>(async () => { throw { code: "upstream" }; }),
    });
    const result = await loadRollupApp(portfolio, "carebase", new AbortController().signal);
    expect(result.overview.state).toBe("ready");
    expect(result.billing.state).toBe("unavailable");
  });
});
