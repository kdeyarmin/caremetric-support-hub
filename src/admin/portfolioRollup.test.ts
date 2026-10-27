import { describe, expect, it, vi } from "vitest";
import type { PortfolioCapabilities, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import type { PortfolioClient } from "./portfolioClient";
import { buildPortfolioRollup, groupMoneyByCurrency, loadHubBilling, loadPortfolioRollup, loadRollupApp } from "./portfolioRollup";
import type { HubAppBilling, RollupAppSnapshot, RollupRead } from "./portfolioRollup";
import type { Subscription } from "../billing/billingModel";

const capabilities: PortfolioCapabilities = { apiVersion: 1, operations: ["overview"], sourceRevision: "abc1234" };
function billing(subscriptionCount: number, statusCounts: Array<{ status: string; count: number }>, mrrCents = 0): RollupRead<HubAppBilling> {
  return { state: "ready", data: { source: "hub", subscriptionCount, statusCounts, mrrCents } };
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
      snapshot("breathe", { capabilities: null, overview: { state: "unavailable" }, billing: { state: "unavailable" }, money: [{ currency: "usd", amountMinor: "100" }] }),
    ]);
    expect(rollup.moneyByCurrency).toEqual([{ currency: "usd", amountMinor: "100" }]);
  });
});

describe("portfolio rollup totals", () => {
  it("counts CareMetric Go beside CareMetric EMR because the Hub bills each separately", () => {
    const rollup = buildPortfolioRollup([
      snapshot("caremetric-emr", { billing: billing(10, [{ status: "active", count: 8 }, { status: "past_due", count: 2 }]) }),
      snapshot("caremetric-go", { billing: billing(1, [{ status: "active", count: 1 }]) }),
    ]);
    expect(rollup.subscriptionTotal).toBe(11);
    expect(rollup.billingReportingApps).toEqual(["caremetric-emr", "caremetric-go"]);
    expect(rollup.billingExcludedSharedApps).toEqual([]);
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
    return { capabilities: unexpected, overview: vi.fn(unexpected), organizations: unexpected, users: unexpected, ...overrides };
  }
  const subscription = (app: Subscription["app"], status: Subscription["status"], unit_amount: number, interval: "month" | "year" = "month"): Subscription => ({
    id: `sub_${app}${status}${unit_amount}`, tenant_id: "00000000-0000-4000-8000-0000000000aa", customer: "cus_1", app, status, collection_method: "send_invoice",
    cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null, current_period_start: null, current_period_end: null, trial_start: null, trial_end: null,
    pause_behavior: null, pause_resumes_at: null, discounts: [], created: "2026-10-27T00:00:00Z", version: 1,
    items: [{ id: "si_1", price: "price_1", product: "prod_1", quantity: 2, unit_amount, currency: "usd", interval, interval_count: 1, product_name: "Core", kind: "plan", unit_label: "facility", pricing_model: "per_unit", custom: false }],
  });

  it("requests the overview only when the capabilities advertise it and never asks the application for billing", async () => {
    const portfolio = client({
      capabilities: vi.fn<PortfolioClient["capabilities"]>(async () => ({ apiVersion: 1, sourceRevision: null, operations: [] })),
    });
    const result = await loadRollupApp(portfolio, "pennsync", new AbortController().signal, billing(2, [{ status: "active", count: 2 }]));
    expect(result.overview.state).toBe("not-advertised");
    expect(portfolio.overview).not.toHaveBeenCalled();
    expect(result.billing).toEqual(billing(2, [{ status: "active", count: 2 }]));
  });

  it("keeps Hub billing when an application's connection is unavailable", async () => {
    const portfolio = client({ capabilities: vi.fn<PortfolioClient["capabilities"]>(async () => { throw { code: "unconfigured" }; }) });
    const result = await loadRollupApp(portfolio, "intel", new AbortController().signal, billing(1, [{ status: "active", count: 1 }], 34900));
    expect(result.capabilities).toBeNull();
    expect(result.overview.state).toBe("unavailable");
    expect(result.billing.state).toBe("ready");
    expect(result.money).toEqual([{ currency: "usd", amountMinor: "34900" }]);
  });

  it("summarizes the Hub billing workspace per application and leaves Advisors out", async () => {
    const read = vi.fn(async () => ({ coupons: [], subscriptions: [
      subscription("carebase", "active", 19900), subscription("carebase", "trialing", 19900), subscription("caremetric-intel", "active", 348000, "year"),
      subscription("breathe", "canceled", 79900),
    ] }));
    const result = await loadHubBilling(read, new AbortController().signal);
    expect(result.carebase).toEqual({ state: "ready", data: { source: "hub", subscriptionCount: 2, statusCounts: [{ status: "trialing", count: 1 }, { status: "active", count: 1 }], mrrCents: 39800 } });
    expect(result.intel).toEqual({ state: "ready", data: { source: "hub", subscriptionCount: 1, statusCounts: [{ status: "active", count: 1 }], mrrCents: 58000 } });
    expect(result.breathe.state === "ready" && result.breathe.data.mrrCents).toBe(0);
    expect(result.advisors).toEqual({ state: "not-advertised" });
  });

  it("marks billing unavailable everywhere when the Hub billing read fails, never zero", async () => {
    const portfolio = client({ capabilities: vi.fn<PortfolioClient["capabilities"]>(async () => ({ apiVersion: 1, sourceRevision: null, operations: [] })) });
    const apps = await loadPortfolioRollup(portfolio, new AbortController().signal, async () => { throw new Error("offline"); });
    expect(apps.filter(app => app.product !== "advisors").every(app => app.billing.state === "unavailable")).toBe(true);
    expect(buildPortfolioRollup(apps).subscriptionTotal).toBeNull();
  });
});
