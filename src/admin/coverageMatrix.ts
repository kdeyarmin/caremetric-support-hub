import type { PortfolioOperationName, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import type { RollupAppSnapshot } from "./portfolioRollup";

/** Whether the Hub holds one area of an application's super-admin information right now. */
export type CoverageState = "available" | "partial" | "missing" | "not-applicable" | "unavailable";
export interface CoverageCell { state: CoverageState; label: string }
export interface CoverageArea { id: "directory" | "controls" | "subscribers" | "financial" | "requests" | "support"; label: string }
export interface CoverageRow { product: PortfolioProduct; cells: Record<CoverageArea["id"], CoverageCell>; nextSteps: string[] }

export const coverageAreas: readonly CoverageArea[] = [
  { id: "directory", label: "Organizations & users" },
  { id: "controls", label: "Access controls" },
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

    // Platform billing belongs to the Hub (Stripe mirror) for every application, independent of its connection.
    const subscribers: CoverageCell = advisors ? notApplicable("Consulting practice · no subscriptions")
      : app.billing.state === "ready" ? { state: "available", label: "Billed by the Hub · subscriptions and MRR" }
      : (nextSteps.push("Check the Hub's Stripe configuration; billing figures are unavailable until it answers."), { state: "unavailable", label: "Hub billing unavailable" });

    const financial: CoverageCell = advisors ? notApplicable("Fees are set by written proposal")
      : app.billing.state === "ready" ? { state: "available", label: "Hub invoices, payment links and the customer portal" }
      : { state: "unavailable", label: "Hub billing unavailable" };

    const requests: CoverageCell = !advisors ? notApplicable("Software support uses the Hub inbox")
      : !connected ? unavailable
      : has(app, "inquiries.list") ? { state: "available", label: "Consultation requests" }
      : missing("Not provided yet", "Deploy the Advisors bridge and list Hub administrators in HUB_ADMIN_USER_IDS.");

    const controls = accessControls(app);
    const control: CoverageCell = advisors ? notApplicable("No software accounts")
      : !connected ? unavailable
      : controls.state === "available" ? { state: "available", label: controls.label }
      : missing("View only", controls.nextStep);

    if (advisors && !connected) nextSteps.push("Deploy the Advisors bridge and list Hub administrators in HUB_ADMIN_USER_IDS.");
    else if (!connected) nextSteps.push("Restore the application's administration connection; its figures are unavailable until it answers.");

    // Every channel lands in the Hub inbox by design; this does not depend on the application connection.
    const support: CoverageCell = { state: "available", label: advisors ? "Hub inbox, including the imported web form · channel status in Communications" : "Hub inbox · channel status in Communications" };
    return { product: app.product, cells: { directory, controls: control, subscribers, financial, requests, support }, nextSteps: [...new Set(nextSteps)] };
  });
}

/**
 * What the Hub can change in an application now, from what its live connection advertises. CareBase and Intel take access changes
 * through their command endpoints; Breathe through its own organization suspend/restore review.
 */
export function accessControls(app: RollupAppSnapshot): { state: "available" | "view-only"; label: string; nextStep: string } {
  const commands = has(app, "commands.preview") && has(app, "commands.apply");
  if (app.product === "carebase") return commands ? { state: "available", label: "Organization suspension and profile access", nextStep: "" }
    : { state: "view-only", label: "View only", nextStep: "Switch on CareBase's access commands (CAREMETRIC_ADMIN_COMMANDS_ENABLED on CareBase)." };
  // Intel lists its organizations from the release that can suspend them, so the list is what tells the two releases apart.
  if (app.product === "intel") return commands ? { state: "available", label: has(app, "organizations.list") ? "Organization suspension and account access" : "Turn accounts on and off", nextStep: "" }
    : { state: "view-only", label: "View only", nextStep: "Deploy Intel's account command and switch it on (CAREMETRIC_ADMIN_COMMANDS_ENABLED on Intel)." };
  if (app.product === "breathe") {
    const lifecycle = (["organizations.lifecycle.context", "organizations.lifecycle.preview", "organizations.lifecycle.apply", "organizations.lifecycle.resume"] as const).every(name => has(app, name));
    const staff = (["staff.access.context", "staff.access.preview", "staff.access.apply", "staff.access.resume"] as const).every(name => has(app, name));
    if (lifecycle && staff) return { state: "available", label: "Organization suspend and restore; staff sign-ins on and off", nextStep: "" };
    if (lifecycle) return { state: "available", label: "Organization suspend and restore", nextStep: "To change staff sign-ins too, switch on Breathe's staff changes (CAREMETRIC_ADMIN_STAFF_COMMANDS_ENABLED on Breathe)." };
    if (staff) return { state: "available", label: "Staff sign-ins on and off", nextStep: "To suspend organizations too, switch on Breathe's organization changes (CAREMETRIC_ADMIN_TENANT_COMMANDS_ENABLED on Breathe)." };
    return { state: "view-only", label: "View only", nextStep: "Switch on Breathe's organization changes (CAREMETRIC_ADMIN_TENANT_COMMANDS_ENABLED) or staff changes (CAREMETRIC_ADMIN_STAFF_COMMANDS_ENABLED) on Breathe." };
  }
  return { state: "view-only", label: "View only", nextStep: "This application has no access commands." };
}

/** Areas that apply to the application, and how many of those the Hub holds completely. */
export function coverageSummary(rows: CoverageRow[]): { applicable: number; available: number; needsWork: number } {
  const cells = rows.flatMap(row => Object.values(row.cells)).filter(cell => cell.state !== "not-applicable");
  return { applicable: cells.length, available: cells.filter(cell => cell.state === "available").length, needsWork: cells.filter(cell => cell.state !== "available").length };
}
