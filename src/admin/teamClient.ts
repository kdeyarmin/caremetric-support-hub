import { z } from "zod";
import { config } from "../lib/config";
import { sessionEvent } from "../lib/appSession";
import { activitySchemas, agentSchema, auditSchema, autonomyStepSchema, decisionSchema, overviewSchema, taskResultSchema, waitingSchema } from "./teamProtocol";
import type { ActivityKind, ActivityPage, AuditPage, AutonomyStep, Decision, TeamAgent, TeamOverview } from "./teamProtocol";

/**
 * A failed AI team request. The message is the server's reviewed text (for example "This agent
 * changed. Refresh and review again."), safe to show; the code lets the read-failure panel pick
 * the same wording the other administrator screens use.
 */
export class TeamApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.code = status === 401 ? "401" : status === 403 ? "403" : status === 404 || status === 503 ? "unconfigured" : "upstream";
  }
}

async function post<S extends z.ZodType>(path: string, body: unknown, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
  if (config.demoMode) throw new TeamApiError(503, "The AI team is not available in the preview.");
  const response = await fetch(`/api/${path}`, {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(sessionEvent));
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "The request could not be completed.";
    throw new TeamApiError(response.status, message);
  }
  return schema.parse(data);
}

export interface TeamClient {
  overview(options: { signal: AbortSignal }): Promise<TeamOverview>;
  setStatus(input: { key: string; status: "active" | "paused"; expectedUpdatedAt: string }): Promise<TeamAgent>;
  setAutonomy(input: { key: string; autonomy: "observe" | "propose" | "act"; expectedUpdatedAt: string }): Promise<TeamAgent>;
  setBudget(input: { key: string; dailyBudgetCents: number; expectedUpdatedAt: string }): Promise<TeamAgent>;
  decide(input: { actionId: string; decision: "approve" | "reject"; note?: string }): Promise<Decision>;
  run(input: { agentKey: string; taskKind: string }): Promise<{ id: string; status: string }>;
  cancel(input: { taskId: string }): Promise<{ id: string; status: string }>;
  /** Runs the work that was waiting for the owner's sign-in (imports, and approved replies that never went out). Answers at once; the work finishes in the background. */
  waiting(): Promise<{ started: number; actions: number }>;
  /** Starts a supervised week for one kind of work, keeps the owner approving it ("hold"), or hands it over now ("automatic"). */
  setStep(input: { category: string; action: "supervise" | "hold" | "automatic"; expectedChangedAt: string }): Promise<AutonomyStep>;
  activity<K extends ActivityKind>(input: { kind: K; agentKey: string | null; offset: number; limit: number }, options: { signal: AbortSignal }): Promise<ActivityPage<K>>;
  audit(input: { prefix: string | null; offset: number; limit: number }, options: { signal: AbortSignal }): Promise<AuditPage>;
}

export const teamClient: TeamClient = {
  overview: ({ signal }) => post("admin/team/overview", {}, overviewSchema, signal),
  setStatus: input => post("admin/team/status", input, agentSchema),
  setAutonomy: input => post("admin/team/autonomy", input, agentSchema),
  setBudget: input => post("admin/team/budget", input, agentSchema),
  decide: ({ note, ...input }) => post("admin/team/decide", note ? { ...input, note } : input, decisionSchema),
  run: input => post("admin/team/run", input, taskResultSchema),
  cancel: input => post("admin/team/cancel", input, taskResultSchema),
  waiting: () => post("admin/team/waiting", {}, waitingSchema),
  setStep: input => post("admin/team/step", input, autonomyStepSchema),
  activity: (input, { signal }) => post("rpc/list_agent_activity", { p_kind: input.kind, p_agent_key: input.agentKey, p_offset: input.offset, p_limit: input.limit }, activitySchemas[input.kind], signal) as never,
  audit: (input, { signal }) => post("rpc/list_audit_events", { p_action_prefix: input.prefix, p_offset: input.offset, p_limit: input.limit }, auditSchema, signal),
};
