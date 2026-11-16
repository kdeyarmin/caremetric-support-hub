import { z } from "zod";
import { config } from "../lib/config";
import { sessionEvent, responseErrorMessage } from "../lib/appSession";

/**
 * The Hub's settings (server/hub-settings.mjs): switches and values the owner changes on the Settings page instead of in Railway
 * variables. Secrets are never settings, so no value here is secret.
 */
const settingValue = z.union([z.boolean(), z.string().max(1000), z.number(), z.array(z.string().max(1000)).max(20), z.null()]);
const setting = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,30}\.[a-z][a-z0-9_]{1,60}$/),
  label: z.string().max(120),
  help: z.string().max(600),
  input: z.enum(["toggle", "choice", "email", "url", "text", "number", "cents", "lines"]),
  default: settingValue,
  choices: z.array(z.object({ value: z.string(), label: z.string() }).strict()).max(10).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().max(20).optional(),
  value: settingValue,
  effective: settingValue,
  /** Where the value comes from: saved here, copied in once from a Railway variable, the default, or (before the migration) Railway. */
  source: z.enum(["hub", "copied", "default", "railway"]),
  /** The Railway variable this setting replaces (none for a setting that never was one), and whether it is still set there (it is no longer read once copied). */
  variable: z.string().regex(/^[A-Z][A-Z0-9_]{2,80}$/).nullable(),
  variableSet: z.boolean(),
  changedAt: z.string().nullable(),
}).strict();
const group = z.object({ id: z.string().regex(/^[a-z]+$/), label: z.string().max(80), description: z.string().max(400), settings: z.array(setting).max(40) }).strict();
export const settingsViewSchema = z.object({ editable: z.boolean(), groups: z.array(group).max(20) }).strict();
export type SettingsView = z.infer<typeof settingsViewSchema>;
export type HubSetting = z.infer<typeof setting>;
export type SettingValue = z.infer<typeof settingValue>;

/** A failed settings request. The message is the server's reviewed text (for example "This setting changed. Refresh and review again."). */
export class SettingsApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.code = status === 401 ? "401" : status === 403 ? "403" : status === 503 ? "unconfigured" : "upstream";
  }
}

async function post(body: unknown, signal?: AbortSignal): Promise<SettingsView> {
  if (config.demoMode) throw new SettingsApiError(503, "Settings are not available in the preview.");
  const response = await fetch("/api/admin/settings", {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(sessionEvent));
    const message = responseErrorMessage(data) ?? "The request could not be completed.";
    throw new SettingsApiError(response.status, message);
  }
  return settingsViewSchema.parse(data);
}

export interface SettingsClient {
  view(options: { signal: AbortSignal }): Promise<SettingsView>;
  /** Saves one setting, or clears it (null) so its default applies. Returns every setting as saved. */
  save(input: { key: string; value: SettingValue; expectedChangedAt: string }): Promise<SettingsView>;
}

export const settingsClient: SettingsClient = {
  view: ({ signal }) => post({ action: "list" }, signal),
  save: input => post({ action: "save", ...input }),
};
