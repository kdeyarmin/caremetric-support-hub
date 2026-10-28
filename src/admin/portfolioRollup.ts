import { centralHubPortfolioApps } from "../hubScope";
import type { PortfolioCapabilities, PortfolioOverview, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import type { PortfolioClient } from "./portfolioClient";
import { parseMinorAmount } from "./billingMoney";
import { summarizeByApp, type BillingWorkspace } from "../billing/billingModel";
import type { BillingApp } from "../billing/billingProtocol";

/**
 * An application's subscriptions as the Hub bills them. Paid applications'
 * platform billing lives in the Hub's Stripe mirror, so these figures come from
 * one source and are never counted twice across applications.
 */
export interface HubAppBilling { source: "hub"; subscriptionCount: number; statusCounts: Array<{ status: string; count: number }>; mrrCents: number }

/** One adapter read as the rollup records it: data, a failed connection, or an operation the adapter never advertised. */
export type RollupRead<T> =
  | { state: "ready"; data: T }
  | { state: "unavailable" }
  | { state: "not-advertised" };

/** A native money figure in Stripe minor units, exactly as invoice records carry amounts. */
export interface RollupMoney { currency: string; amountMinor: string; }

export interface RollupAppSnapshot {
  product: PortfolioProduct;
  /** Null when the capabilities read failed: the connection is unavailable and no totals are inferred from it. */
  capabilities: PortfolioCapabilities | null;
  overview: RollupRead<PortfolioOverview>;
  /** The Hub's own billing; not-advertised for PennSync and Healthcare Advisors. */
  billing: RollupRead<HubAppBilling>;
  /** Monthly recurring revenue from the Hub's billing, grouped by currency (all prices are USD today). */
  money: RollupMoney[];
}

export interface PortfolioRollupTotals {
  connectionsVerified: number;
  connectionsTotal: number;
  /** Applications whose Hub billing is included in the totals below. */
  billingReportingApps: PortfolioProduct[];
  /** Kept for compatibility: Hub billing is per application, so no application is ever excluded as shared. */
  billingExcludedSharedApps: PortfolioProduct[];
  /** Subscriptions across the reporting applications, or null when Hub billing could not be read — never a fabricated zero. */
  subscriptionTotal: number | null;
  /** Subscription counts grouped by the native status, across the reporting applications only. */
  statusTotals: Array<{ status: string; count: number }>;
  /** Monthly recurring revenue grouped by currency. There is deliberately no cross-currency total. */
  moneyByCurrency: Array<{ currency: string; amountMinor: string }>;
}

/**
 * Products whose native records are shared with another product's records.
 * CareMetric Go reads from the CareMetric EMR backend, so counting Go beside
 * EMR would count the same organizations and subscriptions twice; the
 * per-application workspace already warns that Go records "must not be
 * counted as additional organizations or subscriptions."
 */
export const sharedRecordProducts: readonly PortfolioProduct[] = ["caremetric-go"];
const sharedRecordNote: Partial<Record<PortfolioProduct, PortfolioProduct>> = { "caremetric-go": "caremetric-emr" };
export function sharedWithProduct(product: PortfolioProduct): PortfolioProduct | null {
  return sharedRecordNote[product] ?? null;
}

function currencyCode(value: string): string {
  if (!/^[a-z]{3}$/.test(value)) throw new Error("Invalid currency");
  return value;
}

/**
 * Sum minor-unit amounts within each currency only. Amounts keep the exact
 * string arithmetic the billing reads use (never a JavaScript Number), and
 * the result has one entry per currency — no combined figure exists.
 */
export function groupMoneyByCurrency(money: readonly RollupMoney[]): Array<{ currency: string; amountMinor: string }> {
  const totals = new Map<string, bigint>();
  for (const entry of money) {
    const currency = currencyCode(entry.currency);
    const amount = BigInt(parseMinorAmount(entry.amountMinor));
    totals.set(currency, (totals.get(currency) ?? 0n) + amount);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, total]) => ({ currency, amountMinor: total.toString() }));
}

/** Aggregate per-application snapshots into portfolio totals without inventing figures for silent applications. */
export function buildPortfolioRollup(apps: readonly RollupAppSnapshot[]): PortfolioRollupTotals {
  const billingReportingApps: PortfolioProduct[] = [];
  const billingExcludedSharedApps: PortfolioProduct[] = [];
  let subscriptionTotal: number | null = null;
  const statusCounts = new Map<string, number>();
  const money: RollupMoney[] = [];
  for (const app of apps) {
    if (!billingAppFor[app.product]) continue;
    if (app.billing.state !== "ready") continue;
    billingReportingApps.push(app.product);
    subscriptionTotal = (subscriptionTotal ?? 0) + app.billing.data.subscriptionCount;
    for (const item of app.billing.data.statusCounts) {
      statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + item.count);
    }
    money.push(...app.money);
  }
  return {
    connectionsVerified: apps.filter(app => app.capabilities !== null).length,
    connectionsTotal: apps.length,
    billingReportingApps,
    billingExcludedSharedApps,
    subscriptionTotal,
    statusTotals: [...statusCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => ({ status, count })),
    moneyByCurrency: groupMoneyByCurrency(money),
  };
}

async function settle<T>(read: () => Promise<T>): Promise<RollupRead<T>> {
  try {
    return { state: "ready", data: await read() };
  } catch {
    return { state: "unavailable" };
  }
}

/** PennSync and Healthcare Advisors have support connections without payment authority. */
export const billingAppFor: Record<PortfolioProduct, BillingApp | null> = {
  carebase: "carebase", breathe: "breathe", "caremetric-emr": "caremetric-emr", pennsync: null, intel: "caremetric-intel", "caremetric-go": "caremetric-go", advisors: null,
};
export type BillingReader = (signal: AbortSignal) => Promise<Pick<BillingWorkspace, "subscriptions" | "coupons">>;

/**
 * Load one application's rollup snapshot through the same portfolio client the
 * administration workspace uses. The overview is requested only when the
 * capabilities response advertises it; a failed capabilities read marks the
 * connection unavailable instead of guessing. Billing comes from the Hub.
 */
export async function loadRollupApp(portfolio: PortfolioClient, product: PortfolioProduct, signal: AbortSignal, billing: RollupRead<HubAppBilling> = { state: "unavailable" }): Promise<RollupAppSnapshot> {
  if (!billingAppFor[product]) billing = { state: "not-advertised" };
  const money = billing.state === "ready" && billing.data.mrrCents > 0 ? [{ currency: "usd", amountMinor: String(billing.data.mrrCents) }] : [];
  let capabilities: PortfolioCapabilities;
  try {
    capabilities = await portfolio.capabilities({ product, signal });
  } catch {
    return { product, capabilities: null, overview: { state: "unavailable" }, billing, money };
  }
  const overview = capabilities.operations.includes("overview")
    ? await settle(() => portfolio.overview({ product, signal }))
    : { state: "not-advertised" } as const;
  return { product, capabilities, overview, billing, money };
}

/** Hub billing per application, read once for every card. */
export async function loadHubBilling(readBilling: BillingReader, signal: AbortSignal): Promise<Partial<Record<PortfolioProduct, RollupRead<HubAppBilling>>>> {
  const read = await settle(() => readBilling(signal));
  const summary = read.state === "ready" ? summarizeByApp(read.data) : null;
  return Object.fromEntries(centralHubPortfolioApps.map(product => {
    const app = billingAppFor[product];
    if (!app) return [product, { state: "not-advertised" }];
    if (!summary) return [product, { state: "unavailable" }];
    const { subscriptionCount, statusCounts, mrrCents } = summary[app];
    return [product, { state: "ready", data: { source: "hub", subscriptionCount, statusCounts, mrrCents } }];
  })) as Partial<Record<PortfolioProduct, RollupRead<HubAppBilling>>>;
}

/** Load every registered application's snapshot; one silent application never fails the others. */
export async function loadPortfolioRollup(portfolio: PortfolioClient, signal: AbortSignal, readBilling?: BillingReader): Promise<RollupAppSnapshot[]> {
  const billing = readBilling ? await loadHubBilling(readBilling, signal) : null;
  return Promise.all(centralHubPortfolioApps.map(product => loadRollupApp(portfolio, product, signal, billing?.[product])));
}
