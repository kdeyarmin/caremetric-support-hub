import { z } from "zod";
import { appRequest } from "../lib/appSession";

/** The AI usage summary served by hub.get_ai_usage_summary for the platform administrator. Counts only; never content. */
const count = z.number().int().nonnegative();
const tenantUsage = z.object({ tenantId: z.uuid(), name: z.string().max(200), calls: count, failedCalls: count, inputTokens: count, outputTokens: count });
const productUsage = z.object({
  productId: z.uuid(), slug: z.string().max(80), name: z.string().max(200),
  calls: count, failedCalls: count, staffCalls: count, automationCalls: count, inputTokens: count, outputTokens: count,
  tenants: z.array(tenantUsage).max(5000),
});
export const aiUsageSummarySchema = z.object({
  days: z.number().int().min(1).max(365), since: z.string(), loadedAt: z.string(),
  totals: z.object({ calls: count, failedCalls: count, staffCalls: count, automationCalls: count, inputTokens: count, outputTokens: count }),
  unattributedCalls: count,
  products: z.array(productUsage).max(100),
  features: z.array(z.object({ feature: z.string().max(60), calls: count, inputTokens: count, outputTokens: count })).max(100),
});
export type AiUsageSummary = z.infer<typeof aiUsageSummarySchema>;
export type AiUsageProduct = z.infer<typeof productUsage>;
export type AiUsageTenant = z.infer<typeof tenantUsage>;

export const aiUsagePeriods = [7, 30, 90] as const;
export type AiUsagePeriod = typeof aiUsagePeriods[number];

/** Owner-facing names for the ledger's feature keys. */
export const aiFeatureLabels: Record<string, string> = {
  case_summary: "Case summary for staff", case_draft_reply: "Reply draft for staff", case_triage: "Triage suggestion",
  automation_attempt: "Automated resolution attempt", automation_escalation_summary: "Escalation summary", automation_resolution_classification: "Customer reply classification",
};

export interface AiUsageClient { summary(days: AiUsagePeriod, signal?: AbortSignal): Promise<AiUsageSummary> }
export const aiUsageClient: AiUsageClient = {
  async summary(days, signal) { return aiUsageSummarySchema.parse(await appRequest("rpc/get_ai_usage_summary", { p_days: days }, signal)); },
};
