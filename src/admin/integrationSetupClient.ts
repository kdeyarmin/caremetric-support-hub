import { z } from "zod";
import { requestAdmin } from "./transport";
export { AdminApiError } from "./transport";

/**
 * The integration setup report from the Hub service. A secret is represented by
 * `set` alone: the schema refuses any value sent for one, so a secret can never
 * reach the browser through this client even if the server were to send it.
 */
const variable = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/), secret: z.boolean(), required: z.boolean(), purpose: z.string().max(300), set: z.boolean(),
  /** A flag variable is satisfied only when it is exactly "true"; every other variable is satisfied when set. */
  satisfied: z.boolean(),
  value: z.string().max(200).nullable().optional(),
}).strict().refine(item => !item.secret || item.value === undefined, "Secret values never cross this protocol");
const integration = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/), name: z.string().max(120), purpose: z.string().max(400), docs: z.string().regex(/^docs\/[A-Z0-9_]+\.md$/),
  variables: z.array(variable).min(1).max(20), ready: z.boolean(), complete: z.boolean(),
}).strict();
export const integrationSetupSchema = z.object({ checkedAt: z.string(), integrations: z.array(integration).max(50) }).strict();
export type IntegrationSetupReport = z.infer<typeof integrationSetupSchema>;
export type IntegrationStatus = z.infer<typeof integration>;
export type IntegrationVariable = z.infer<typeof variable>;

export interface IntegrationSetupClient { report(options: { signal: AbortSignal }): Promise<IntegrationSetupReport> }
export const integrationSetupClient: IntegrationSetupClient = {
  report: async ({ signal }) => integrationSetupSchema.parse(await requestAdmin("integration-setup", {}, signal)),
};

/** Repository documentation for an integration, opened on GitHub. */
export const docsUrl = (path: string) => `https://github.com/kdeyarmin/caremetric-support-hub/blob/main/${path}`;
