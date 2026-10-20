import type { PortfolioOperationName, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import type { RollupAppSnapshot } from "./portfolioRollup";
import { sharedWithProduct } from "./portfolioRollup";

/** Whether the Hub holds one area of an application's super-admin information right now. */
export type CoverageState = "available" | "partial" | "missing" | "not-applicable" | "unavailable";
export interface CoverageCell { state: CoverageState; label: string }
export interface CoverageArea { id: "directory" | "subscribers" | "financial" | "requests" | "support"; label: string }
export interface CoverageRow { product: PortfolioProduct; cells: Record<CoverageArea["id"], CoverageCell>; nextSteps: string[] }

export const coverageAreas: readonly CoverageArea[] = [
  { id: "directory", label: "Organizations & users" },
  { id: "subscribers", label: "Subscribers & subscriptions" },
  { id: "financial", label: "Invoices & payments" },
  { id: "requests", label: "Consultation requests" },
  { id: "support", label: "Support inquiries" },
];

const has = (app: RollupAppSnapshot, operation: PortfolioOperationName) => app.capabilities?.operations.includes(operation) === true;

/**
 * One row per application, derived only from what each live connection advertises.
 * A failed connection is never reported as available, and a missing read is
 * labelled as app-side work rather than hidden.
 */
export function coverageMatrix(apps: RollupAppSnapshot[]): CoverageRow[] {
  return apps.map(app => {
    const advisors = app.product === "advisors";
    const unavailable: CoverageCell = { state: "unavailable", label: "Connection unavailable" };
    const notApplicable = (label: string): CoverageCell => ({ state: "not-applicable", label });
    const connected = app.capabilities !== null;
    const nextSteps: string[] = [];
    const missing = (label: string, step: string): CoverageCell => { nextSteps.push(step); return { state: "missing", label }; };

    const organizations = has(app, "organizations.list"), users = has(app, "users.list");
    const directory: CoverageCell = advisors ? notApplicable("No software accounts")
      : !connected ? unavailable
      : organizations && users ? { state: "available", label: "Organizations and users" }
      : users ? (nextSteps.push("Add an organization read to the application's administration connection."), { state: "partial", label: "Users only" })
      : organizations ? (nextSteps.push("Add a user read to the application's administration connection."), { state: "partial", label: "Organizations only" })
      : missing("Not provided yet", "Add organization and user reads to the application's administration connection.");

    const sharedWith = sharedWithProduct(app.product);
    const subscribers: CoverageCell = advisors ? notApplicable("Consulting practice · no subscriptions")
      : !connected ? unavailable
      // The connection answered but its billing read failed: never show subscriptions as held.
      : app.billing.state === "unavailable" ? (nextSteps.push("Check the application's billing read; subscription figures are unavailable until it answers."), { state: "unavailable", label: "Billing read failed" })
      : has(app, "billing.overview") && has(app, "billing.subscriptions.list")
        ? { state: "available", label: sharedWith ? "Shared with CareMetric EMR · not double-counted" : "Subscription records and status totals" }
      : missing("Not provided yet", "Add billing overview and subscription reads to the application's administration connection.");

    const financial: CoverageCell = advisors ? notApplicable("Fees are set by written proposal")
      : !connected ? unavailable
      : has(app, "billing.invoices.list") ? { state: "available", label: has(app, "billing.subscriptions.verify") ? "Invoices, payments and Stripe verification" : "Invoices and payments" }
      : missing("Not provided yet", "Add invoice reads (amounts in minor units with currency) to the application's administration connection.");

    const requests: CoverageCell = !advisors ? notApplicable("Software support uses the Hub inbox")
      : !connected ? unavailable
      : has(app, "inquiries.list") ? { state: "available", label: "Consultation requests" }
      : missing("Not provided yet", "Deploy the Advisors bridge and list Hub administrators in HUB_ADMIN_USER_IDS.");

    if (advisors && !connected) nextSteps.push("Deploy the Advisors bridge and list Hub administrators in HUB_ADMIN_USER_IDS.");
    else if (!connected) nextSteps.push("Restore the application's administration connection; its figures are unavailable until it answers.");

    // Every channel lands in the Hub inbox by design; this does not depend on the application connection.
    const support: CoverageCell = { state: "available", label: advisors ? "Hub inbox, including the imported web form · channel status in Communications" : "Hub inbox · channel status in Communications" };
    return { product: app.product, cells: { directory, subscribers, financial, requests, support }, nextSteps: [...new Set(nextSteps)] };
  });
}

/** Areas that apply to the application, and how many of those the Hub holds completely. */
export function coverageSummary(rows: CoverageRow[]): { applicable: number; available: number; needsWork: number } {
  const cells = rows.flatMap(row => Object.values(row.cells)).filter(cell => cell.state !== "not-applicable");
  return { applicable: cells.length, available: cells.filter(cell => cell.state === "available").length, needsWork: cells.filter(cell => cell.state !== "available").length };
}
