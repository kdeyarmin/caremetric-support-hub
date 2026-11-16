import { config } from "../lib/config";

export class AdminApiError extends Error {
  readonly code: string;
  /** For a refused change: the server's fixed explanation of the application's reason (server/admin-transport.mjs). */
  readonly detail: string | null;
  constructor(code: string, detail: string | null = null) { super("Administrator request could not be completed."); this.code = code; this.detail = detail; }
}
export async function requestAdmin(functionName: "training" | "platform-admin" | "platform-command" | "learning-receipts" | "learning-authoring" | "learning-catalog" | "course-creation" | "course-distribution" | "learning-provider" | "operational-configuration" | "go-live-readiness" | "integration-setup" | "advisors-command" | "tenant-lifecycle", body: unknown, signal: AbortSignal): Promise<unknown> {
  if (config.demoMode) throw new AdminApiError("unconfigured");
  const route = functionName === "advisors-command" ? "advisors-command" : functionName === "tenant-lifecycle" ? "tenant-lifecycle" : functionName === "training" ? "training" : functionName === "operational-configuration" ? "configuration" : functionName === "learning-provider" ? "provider" : functionName === "course-distribution" ? "course-distribution" : functionName === "course-creation" ? "course-creation" : functionName === "learning-authoring" ? "authoring" : functionName === "learning-catalog" ? "learning-catalog" : functionName === "learning-receipts" ? "learning" : functionName === "go-live-readiness" ? "go-live-readiness" : functionName === "integration-setup" ? "integration-setup" : functionName === "platform-command" ? "command" : "read";
  const response = await fetch(`/api/admin/${route}`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(functionName === "course-distribution" ? 30000 : functionName === "tenant-lifecycle" || functionName === "platform-command" ? 20000 : 15000)]), redirect: "error", cache: "no-store",
  });
  if (!response.ok) {
    let code = response.status === 401 ? "401" : response.status === 403 ? "403" : "upstream";
    let detail: string | null = null;
    try {
      const body = await response.json() as { error?: { code?: string; message?: string } };
      if (body.error?.code && ["unconfigured", "notfound", "upstream", "invalid_request", "conflict", "expired", "report_too_large", "refused"].includes(body.error.code)) code = body.error.code;
      // Only a refusal carries words to show, and those are the Hub server's own fixed sentences.
      if (code === "refused" && typeof body.error?.message === "string" && body.error.message.length <= 300) detail = body.error.message;
    } catch { /* Error details are intentionally not displayed. */ }
    throw new AdminApiError(code, detail);
  }
  return response.json();
}
