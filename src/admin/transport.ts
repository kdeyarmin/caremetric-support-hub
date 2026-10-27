import { config } from "../lib/config";

export class AdminApiError extends Error {
  readonly code: string;
  constructor(code: string) { super("Administrator request could not be completed."); this.code = code; }
}
export async function requestAdmin(functionName: "training" | "platform-admin" | "platform-command" | "learning-receipts" | "learning-authoring" | "learning-catalog" | "course-creation" | "course-distribution" | "learning-provider" | "operational-configuration" | "go-live-readiness" | "integration-setup", body: unknown, signal: AbortSignal): Promise<unknown> {
  if (config.demoMode) throw new AdminApiError("unconfigured");
  const route = functionName === "training" ? "training" : functionName === "operational-configuration" ? "configuration" : functionName === "learning-provider" ? "provider" : functionName === "course-distribution" ? "course-distribution" : functionName === "course-creation" ? "course-creation" : functionName === "learning-authoring" ? "authoring" : functionName === "learning-catalog" ? "learning-catalog" : functionName === "learning-receipts" ? "learning" : functionName === "go-live-readiness" ? "go-live-readiness" : functionName === "integration-setup" ? "integration-setup" : functionName === "platform-command" ? "command" : "read";
  const response = await fetch(`/api/admin/${route}`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(functionName === "course-distribution" ? 30000 : 15000)]), redirect: "error", cache: "no-store",
  });
  if (!response.ok) {
    let code = response.status === 401 ? "401" : response.status === 403 ? "403" : "upstream";
    try {
      const body = await response.json() as { error?: { code?: string } };
      if (body.error?.code && ["unconfigured", "notfound", "upstream", "invalid_request", "conflict", "expired", "report_too_large"].includes(body.error.code)) code = body.error.code;
    } catch { /* Error details are intentionally not displayed. */ }
    throw new AdminApiError(code);
  }
  return response.json();
}
