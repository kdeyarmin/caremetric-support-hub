import { parseMinorAmount } from "../../supabase/functions/_shared/billingProtocol";
import { portfolioProducts } from "../../supabase/functions/_shared/portfolioProtocol";
import type { AdminBillingOverview, PortfolioCapabilities, PortfolioOverview, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import type { PortfolioClient } from "./portfolioClient";

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
  billing: RollupRead<AdminBillingOverview>;
  /**
   * Money figures reported for this application. No overview-class read in the
   * portfolio protocol reports money today (amounts exist only on individual
   * invoice records, which are never totalled), so the loader always records
   * an empty list; any future money figure must enter through this field so
   * aggregation can group it by currency instead of summing across currencies.
   */
  money: RollupMoney[];
}

export interface PortfolioRollupTotals {
  connectionsVerified: number;
  connectionsTotal: number;
  /** Applications whose billing overview is included in the totals below. */
  billingReportingApps: PortfolioProduct[];
  /** Applications that reported billing but are excluded because their records are shared with another application. */
  billingExcludedSharedApps: PortfolioProduct[];
  /** Recorded subscriptions across the reporting applications, or null when none reported — never a fabricated zero. */
  subscriptionTotal: number | null;
  /** Subscription counts grouped by the native status, across the reporting applications only. */
  statusTotals: Array<{ status: string; count: number }>;
  /** Money grouped by currency. There is deliberately no cross-currency total. */
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
    if (app.billing.state !== "ready") continue;
    if (sharedRecordProducts.includes(app.product)) {
      billingExcludedSharedApps.push(app.product);
      continue;
    }
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

/**
 * Load one application's rollup snapshot through the same portfolio client the
 * administration workspace uses. The overview and billing reads are requested
 * only when the capabilities response advertises them; a failed capabilities
 * read marks the whole application unavailable instead of guessing.
 */
export async function loadRollupApp(portfolio: PortfolioClient, product: PortfolioProduct, signal: AbortSignal): Promise<RollupAppSnapshot> {
  let capabilities: PortfolioCapabilities;
  try {
    capabilities = await portfolio.capabilities({ product, signal });
  } catch {
    return { product, capabilities: null, overview: { state: "unavailable" }, billing: { state: "unavailable" }, money: [] };
  }
  const [overview, billing] = await Promise.all([
    capabilities.operations.includes("overview")
      ? settle(() => portfolio.overview({ product, signal }))
      : Promise.resolve<RollupRead<PortfolioOverview>>({ state: "not-advertised" }),
    capabilities.operations.includes("billing.overview")
      ? settle(() => portfolio.billing({ product, signal }))
      : Promise.resolve<RollupRead<AdminBillingOverview>>({ state: "not-advertised" }),
  ]);
  return { product, capabilities, overview, billing, money: [] };
}

/** Load every registered application's snapshot; one silent application never fails the others. */
export function loadPortfolioRollup(portfolio: PortfolioClient, signal: AbortSignal): Promise<RollupAppSnapshot[]> {
  return Promise.all(portfolioProducts.map(product => loadRollupApp(portfolio, product, signal)));
}
