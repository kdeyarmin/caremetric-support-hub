import { describe, expect, it } from "vitest";
import type { PortfolioOperationName, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import { coverageMatrix, coverageSummary } from "./coverageMatrix";
import type { RollupAppSnapshot } from "./portfolioRollup";

const app = (product: PortfolioProduct, operations: PortfolioOperationName[] | null): RollupAppSnapshot => ({
  product, capabilities: operations ? { apiVersion: 1, operations, sourceRevision: null } : null,
  overview: { state: "not-advertised" }, money: [],
  billing: product === "advisors" ? { state: "not-advertised" } : { state: "ready", data: { source: "hub", subscriptionCount: 0, statusCounts: [], mrrCents: 0 } },
});

describe("super-admin coverage matrix", () => {
  it("reports directory reads from each connection and billing from the Hub", () => {
    const [carebase, intel, breathe, emr] = coverageMatrix([
      app("carebase", ["organizations.list", "users.list"]),
      app("intel", ["overview", "users.list"]),
      app("breathe", ["organizations.list", "users.list", "phone.messages.list"]),
      app("caremetric-emr", null),
    ]);
    expect(carebase.cells.subscribers).toEqual({ state: "available", label: "Billed by the Hub · subscriptions and MRR" });
    expect(carebase.cells.financial).toEqual({ state: "available", label: "Hub invoices, payment links and the customer portal" });
    expect(carebase.nextSteps).toEqual([]);
    expect(intel.cells.directory).toEqual({ state: "partial", label: "Users only" });
    expect(intel.cells.subscribers.state).toBe("available");
    expect(intel.nextSteps).toHaveLength(1);
    expect(breathe.cells.requests.state).toBe("not-applicable");
    // Billing is the Hub's own, so it holds even when the application cannot be reached.
    expect(emr.cells.subscribers.state).toBe("available");
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
  it("never reports subscriptions as held when the Hub's billing read failed", () => {
    const [breathe] = coverageMatrix([{ ...app("breathe", ["organizations.list", "users.list"]), billing: { state: "unavailable" } }]);
    expect(breathe.cells.subscribers).toEqual({ state: "unavailable", label: "Hub billing unavailable" });
    expect(breathe.cells.financial.state).toBe("unavailable");
    expect(breathe.cells.directory.state).toBe("available");
    expect(breathe.nextSteps).toContain("Check the Hub's Stripe configuration; billing figures are unavailable until it answers.");
    expect(coverageSummary([breathe]).available).toBe(2);
  });
});
