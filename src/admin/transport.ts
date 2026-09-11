import { config } from "../lib/config";

export class AdminApiError extends Error {
  readonly code: string;
  constructor(code: string) { super("Administrator request could not be completed."); this.code = code; }
}
export async function requestAdmin(functionName: "platform-admin" | "platform-command" | "learning-receipts" | "learning-authoring" | "course-creation" | "billing-command", body: unknown, signal: AbortSignal): Promise<unknown> {
  if (config.demoMode) throw new AdminApiError("unconfigured");
  const route = functionName === "course-creation" ? "course-creation" : functionName === "billing-command" ? "billing-command" : functionName === "learning-authoring" ? "authoring" : functionName === "learning-receipts" ? "learning" : functionName === "platform-command" ? "command" : "read";
  const response = await fetch(`/api/admin/${route}`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
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
