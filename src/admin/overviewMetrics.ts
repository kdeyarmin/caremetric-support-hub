import { adminRegistry, sourceRepositoryNames } from "../../supabase/functions/_shared/adminRegistry";
import type { PortfolioOverview, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";

export interface OverviewMetric { label: string; value: number | null }

/** The product name the owner recognizes, with its source repository when that name differs. */
export function applicationLabel(product: PortfolioProduct): string {
  const source = sourceRepositoryNames[product];
  return source ? `${adminRegistry[product].name} (${source})` : adminRegistry[product].name;
}

/** One reviewed set of overview labels for the workspace and the portfolio rollup. */
export function overviewMetrics(product: PortfolioProduct, data: PortfolioOverview): OverviewMetric[] {
  if (product === "advisors") return [
    { label: "Consultation requests · retained 365 days", value: data.inquiryCount ?? null },
    { label: "Open consultation requests", value: data.openInquiryCount ?? null },
  ];
  return [
    { label: "Organizations", value: data.organizationCount },
    { label: product === "breathe" || product === "caremetric-emr" || product === "caremetric-go" ? "Active staff accounts" : "Active application profiles", value: data.activeUserCount },
    ...(data.registeredUserCount === undefined ? [] : [{ label: product === "intel" ? "Registered application profiles" : "Registered staff profiles", value: data.registeredUserCount }]),
    ...(data.globalCourseCount === undefined ? [] : [{ label: "Shared courses · all publication states", value: data.globalCourseCount }]),
    ...(data.subscriptionCount === undefined ? [] : [{ label: "Recorded subscriptions", value: data.subscriptionCount }]),
  ];
}
