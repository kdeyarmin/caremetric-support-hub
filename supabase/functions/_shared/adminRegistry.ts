import type { PortfolioProduct } from "./portfolioProtocol.ts";

/** Reviewed destinations only. Null entries cannot receive any administrator token. */
export const adminRegistry: Record<PortfolioProduct, { name: string; endpoint: string | null; userScope: string; authorizationHeader?: "Authorization" | "X-CareMetric-Hub-Authorization" }> = {
  carebase: { name: "CareBase", endpoint: "https://cmcarebase.com/api/platform-admin/read", userScope: "Application profiles" },
  breathe: { name: "Breathe", endpoint: "https://cmbreathe.com/resupply-api/central-admin/read", userScope: "Staff accounts only" },
  "caremetric-emr": { name: "CareMetric EMR", endpoint: null, userScope: "Registered staff profiles · application entitlements" },
  pennsync: { name: "PennSync", endpoint: null, authorizationHeader: "X-CareMetric-Hub-Authorization", userScope: "Registered administrators and agency members · individual subscriptions" },
  intel: { name: "CareMetric Intel", endpoint: "https://www.caremetricintel.com/functions/centralAdminRead", authorizationHeader: "X-CareMetric-Hub-Authorization", userScope: "Registered application users · organization and billing sources not configured" },
  "caremetric-go": { name: "CareMetric Go", endpoint: null, userScope: "Organizations, staff and application entitlements shared with CareMetric EMR" },
  advisors: { name: "CareMetric Healthcare Advisors", endpoint: null, authorizationHeader: "X-CareMetric-Hub-Authorization", userScope: "Consultation requests from caremetricadvisors.com · no software accounts or subscriptions" },
};

/** Source repository names the owner uses for each application, shown beside the product name. */
export const sourceRepositoryNames: Partial<Record<PortfolioProduct, string>> = {
  carebase: "PennTrain", breathe: "PennFit", pennsync: "CareMetric-Pennsync", "caremetric-emr": "CMbackup", "caremetric-go": "CM-Go",
};
