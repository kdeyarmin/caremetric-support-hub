import type { PortfolioProduct } from "./portfolioProtocol.ts";

/** Reviewed destinations only. Null entries cannot receive any administrator token. */
export const adminRegistry: Record<PortfolioProduct, { name: string; endpoint: string | null; userScope: string }> = {
  carebase: { name: "CareBase", endpoint: "https://cmcarebase.com/api/platform-admin/read", userScope: "Application profiles" },
  breathe: { name: "Breathe", endpoint: "https://cmbreathe.com/resupply-api/central-admin/read", userScope: "Staff accounts only" },
  "caremetric-emr": { name: "CareMetric EMR", endpoint: null, userScope: "Connection pending" },
  pennsync: { name: "PennSync", endpoint: null, userScope: "Connection pending" },
  intel: { name: "CareMetric Intel", endpoint: null, userScope: "Connection pending" },
  "caremetric-go": { name: "CareMetric Go", endpoint: null, userScope: "Connection pending" },
};
