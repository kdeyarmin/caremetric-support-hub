import { describe, expect, it } from "vitest";
import type { PortfolioOperationName, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import { coverageMatrix, coverageSummary } from "./coverageMatrix";
import type { RollupAppSnapshot } from "./portfolioRollup";

const app = (product: PortfolioProduct, operations: PortfolioOperationName[] | null): RollupAppSnapshot => ({
  product, capabilities: operations ? { apiVersion: 1, operations, sourceRevision: null } : null,
  overview: { state: "not-advertised" }, billing: { state: "not-advertised" }, money: [],
});

describe("super-admin coverage matrix", () => {
  it("reports only what each live connection advertises", () => {
    const [carebase, intel, breathe, emr] = coverageMatrix([
      app("carebase", ["organizations.list", "users.list", "billing.overview", "billing.subscriptions.list", "billing.invoices.list", "billing.subscriptions.verify"]),
      app("intel", ["overview", "users.list"]),
      app("breathe", ["organizations.list", "users.list", "billing.overview", "billing.subscriptions.list", "phone.messages.list"]),
      app("caremetric-emr", null),
    ]);
    expect(carebase.cells.financial).toEqual({ state: "available", label: "Invoices, payments and Stripe verification" });
    expect(carebase.nextSteps).toEqual([]);
    expect(intel.cells.directory).toEqual({ state: "partial", label: "Users only" });
    expect(intel.cells.subscribers.state).toBe("missing");
    expect(intel.nextSteps).toHaveLength(3);
    expect(breathe.cells.subscribers.state).toBe("available");
    expect(breathe.cells.financial.state).toBe("missing");
    expect(breathe.cells.requests.state).toBe("not-applicable");
    expect(Object.values(emr.cells).filter(cell => cell.state === "available").map(cell => cell.label)).toEqual(["Hub inbox · channel status in Communications"]);
    expect(emr.cells.directory.state).toBe("unavailable");
    expect(emr.nextSteps).toEqual(["Restore the application's administration connection; its figures are unavailable until it answers."]);
  });
  it("treats Advisors as a consulting practice and points to its bridge when it is not connected", () => {
    const [connected] = coverageMatrix([app("advisors", ["overview", "inquiries.list"])]);
    expect(connected.cells.requests.state).toBe("available");
    expect([connected.cells.directory, connected.cells.subscribers, connected.cells.financial].map(cell => cell.state)).toEqual(["not-applicable", "not-applicable", "not-applicable"]);
    expect(coverageSummary([connected])).toEqual({ applicable: 2, available: 2, needsWork: 0 });
    const [offline] = coverageMatrix([app("advisors", null)]);
    expect(offline.cells.requests.state).toBe("unavailable");
    expect(offline.nextSteps).toEqual(["Deploy the Advisors bridge and list Hub administrators in HUB_ADMIN_USER_IDS."]);
  });
  it("labels Go's subscriptions as shared with EMR", () => {
    const [go] = coverageMatrix([app("caremetric-go", ["billing.overview", "billing.subscriptions.list"])]);
    expect(go.cells.subscribers.label).toBe("Shared with CareMetric EMR · not double-counted");
  });
});
