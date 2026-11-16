import { z } from "zod";
import { config } from "../lib/config";
import { sessionEvent, responseErrorMessage } from "../lib/appSession";
import { SettingsApiError } from "./settingsClient";

export type SocialProvider = "meta" | "linkedin";
export const guidedSocialSettings = new Set([
  "social.meta_page_id", "social.instagram_id", "social.meta_ad_account_id", "social.linkedin_organization_id",
  "social.linkedin_ad_account_id", "social.linkedin_client_id", "social.linkedin_ads_client_id",
]);
const field = z.object({ value: z.string().max(1000), changedAt: z.string().max(40) }).strict();
export const socialConnectionsSchema = z.object({
  editable: z.boolean(), message: z.string().max(500).nullable(),
  connections: z.array(z.object({
    provider: z.enum(["meta", "linkedin"]), revision: z.string().uuid(),
    fields: z.record(z.string(), field), secrets: z.record(z.string(), z.boolean()),
  }).strict()).max(2),
}).strict();
export type SocialConnectionsView = z.infer<typeof socialConnectionsSchema>;
export type SocialConnection = SocialConnectionsView["connections"][number];
export type SocialConnectionSave = Pick<SocialConnection, "provider" | "revision" | "fields"> & { secrets: Record<string, string | null> };
const checkSchema = z.object({ ok: z.boolean(), message: z.string().max(1000) }).strict();
export type ConnectionCheck = z.infer<typeof checkSchema>;

async function post(body: unknown, signal?: AbortSignal): Promise<unknown> {
  if (config.demoMode) throw new SettingsApiError(503, "Social connections are unavailable in the preview.");
  const response = await fetch("/api/admin/social-connections", {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(sessionEvent));
    throw new SettingsApiError(response.status, responseErrorMessage(data) ?? "The connection request could not be completed.");
  }
  return data;
}
export interface SocialConnectionsClient {
  view(signal: AbortSignal): Promise<SocialConnectionsView>;
  save(input: SocialConnectionSave): Promise<{ saved: true }>;
  check(provider: SocialProvider): Promise<ConnectionCheck>;
}
export const socialConnectionsClient: SocialConnectionsClient = {
  view: async signal => socialConnectionsSchema.parse(await post({ action: "list" }, signal)),
  save: async input => z.object({ saved: z.literal(true) }).strict().parse(await post({ action: "save", ...input })),
  check: async provider => checkSchema.parse(await post({ action: "check", provider })),
};
