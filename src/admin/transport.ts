import { supabase } from "../lib/supabase";
import { config } from "../lib/config";

export class AdminApiError extends Error {
  readonly code: string;
  constructor(code: string) { super("Administrator request could not be completed."); this.code = code; }
}
export async function requestAdmin(functionName: "platform-admin" | "platform-command", body: unknown, signal: AbortSignal): Promise<unknown> {
  if (!supabase) throw new AdminApiError("unconfigured");
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new AdminApiError("401");
  const response = await fetch(`${config.supabaseUrl}/functions/v1/${functionName}`, {
    method: "POST", headers: { "Content-Type": "application/json", apikey: config.supabasePublishableKey, Authorization: `Bearer ${data.session.access_token}` },
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: "error", cache: "no-store",
  });
  if (!response.ok) {
    let code = response.status === 401 ? "401" : response.status === 403 ? "403" : "upstream";
    try {
      const body = await response.json() as { error?: { code?: string } };
      if (body.error?.code && ["unconfigured", "notfound", "upstream", "invalid_request", "conflict", "expired"].includes(body.error.code)) code = body.error.code;
    } catch { /* Error details are intentionally not displayed. */ }
    throw new AdminApiError(code);
  }
  return response.json();
}
