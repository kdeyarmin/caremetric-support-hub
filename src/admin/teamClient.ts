import { z } from "zod";
import { config } from "../lib/config";
import { sessionEvent } from "../lib/appSession";
import { activitySchemas, agentSchema, auditSchema, autonomyStepSchema, decisionSchema, externalEmailProposalSchema, marketingProductSchema, offerSchema, overviewSchema, taskResultSchema, waitingSchema } from "./teamProtocol";
import type { ActivityKind, ActivityPage, AuditPage, AutonomyStep, Decision, ExternalEmailDraft, ExternalEmailProposal, MarketingProduct, MenuOffer, TeamAgent, TeamOverview } from "./teamProtocol";

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
  /** Saves the owner's exact email as a proposal, using the same request key for an unchanged draft's retries. Never sends. */
  prepareEmail(input: ExternalEmailDraft & { requestKey: string }): Promise<ExternalEmailProposal>;
  run(input: { agentKey: string; taskKind: string }): Promise<{ id: string; status: string }>;
  cancel(input: { taskId: string }): Promise<{ id: string; status: string }>;
  /** Starts waiting tasks and checks/completes approved messages. Actions may be recovered without sending again; counts do not confirm delivery. */
  waiting(): Promise<{ started: number; actions: number }>;
  /** Starts a supervised week for one kind of work, keeps the owner approving it ("hold"), or hands it over now ("automatic"). */
  setStep(input: { category: string; action: "supervise" | "hold" | "automatic"; expectedChangedAt: string }): Promise<AutonomyStep>;
  /** Switches one offer on the menu on or off, or changes its monthly cap. */
  setOffer(input: { key: string; enabled: boolean; monthlyCap: number; expectedChangedAt: string }): Promise<MenuOffer>;
  /** Adds an offer to the menu (switched off): a trial extension of 1 to 30 days, or one of the owner's Stripe coupons. */
  addOffer(input: { label: string; kind: "trial_extension" | "coupon"; trialDays?: number; couponId?: string; apps: string[]; windowDays: number; monthlyCap: number }): Promise<MenuOffer>;
  /** Switches marketing of one product on or off. The agents follow it from their next run. */
  setMarketing(input: { product: MarketingProduct["product"]; marketed: boolean; expectedChangedAt: string }): Promise<MarketingProduct>;
  activity<K extends ActivityKind>(input: { kind: K; agentKey: string | null; offset: number; limit: number }, options: { signal: AbortSignal }): Promise<ActivityPage<K>>;
  audit(input: { prefix: string | null; offset: number; limit: number }, options: { signal: AbortSignal }): Promise<AuditPage>;
}

export const teamClient: TeamClient = {
  overview: ({ signal }) => post("admin/team/overview", {}, overviewSchema, signal),
  setStatus: input => post("admin/team/status", input, agentSchema),
  setAutonomy: input => post("admin/team/autonomy", input, agentSchema),
  setBudget: input => post("admin/team/budget", input, agentSchema),
  decide: ({ note, ...input }) => post("admin/team/decide", note ? { ...input, note } : input, decisionSchema),
  prepareEmail: async input => {
    const result = await post("admin/team/email", input, externalEmailProposalSchema);
    if (result.requestKey !== input.requestKey) throw new Error("The proposal confirmation did not match this request.");
    return result;
  },
  run: input => post("admin/team/run", input, taskResultSchema),
  cancel: input => post("admin/team/cancel", input, taskResultSchema),
  waiting: () => post("admin/team/waiting", {}, waitingSchema),
  setStep: input => post("admin/team/step", input, autonomyStepSchema),
  setOffer: input => post("admin/team/offer", input, offerSchema),
  addOffer: input => post("admin/team/addOffer", input, offerSchema),
  setMarketing: input => post("admin/team/marketing", input, marketingProductSchema),
  activity: (input, { signal }) => post("rpc/list_agent_activity", { p_kind: input.kind, p_agent_key: input.agentKey, p_offset: input.offset, p_limit: input.limit }, activitySchemas[input.kind], signal) as never,
  audit: (input, { signal }) => post("rpc/list_audit_events", { p_action_prefix: input.prefix, p_offset: input.offset, p_limit: input.limit }, auditSchema, signal),
};
