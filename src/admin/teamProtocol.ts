import { z } from "zod";

/**
 * What the Hub server returns for the AI team (`POST /api/admin/team/*` and the three read RPCs
 * behind them). Everything here is operational metadata: kinds, counts, references, decisions and
 * short previews of text the team drafted. Inbound customer text is never part of it.
 */
const instant = z.string().min(10).max(64);
const agentKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const taskKind = z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/);

export const scheduleSchema = z.object({
  id: z.uuid(), taskKind, cadence: z.enum(["interval", "daily"]), everySeconds: z.number().int().nullable(), atLocal: z.string().nullable(),
  timezone: z.string(), requiresSession: z.boolean(), enabled: z.boolean(), nextRunAt: instant, lastRunAt: instant.nullable(),
});
export const agentSchema = z.object({
  key: agentKey, displayName: z.string().max(80), roleSummary: z.string().max(400), status: z.enum(["active", "paused"]),
  autonomy: z.enum(["observe", "propose", "act"]), modelTier: z.enum(["fast", "draft", "quality"]),
  dailyBudgetCents: z.number().int(), spentTodayCents: z.number(), promptVersion: z.string(), toolAllowlist: z.array(z.string()),
  config: z.record(z.string(), z.unknown()),
  /** Handed back untouched with every change so the database can refuse a stale one. */
  updatedAt: instant,
  lastRun: z.object({ startedAt: instant, outcome: z.string().nullable() }).nullable(),
  counts: z.object({ queued: z.number(), running: z.number(), awaitingApproval: z.number(), awaitingSession: z.number(), failedLast24h: z.number() }),
  schedules: z.array(scheduleSchema),
});
export const approvalSchema = z.object({
  id: z.uuid(), agentKey, agentName: z.string(), taskId: z.uuid().nullable(), kind: z.string(), targetKind: z.string().nullable(),
  targetId: z.string(), preview: z.string(), createdAt: instant, expiresAt: instant,
});
export const teamSchema = z.object({
  loadedAt: instant, dayStart: instant, agents: z.array(agentSchema), approvals: z.array(approvalSchema),
  approvalCount: z.number().int(), awaitingSessionCount: z.number().int(),
});
export const servicesSchema = z.object({ enabled: z.boolean(), handlers: z.array(taskKind), sms: z.boolean(), email: z.boolean(), ownerEmail: z.boolean() });
export const overviewSchema = z.object({ team: teamSchema, services: servicesSchema });
export const decisionSchema = z.object({ id: z.uuid(), kind: z.string(), status: z.string(), decided: z.boolean() });
export const taskResultSchema = z.object({ id: z.uuid(), status: z.string() });

const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number().int(), offset: z.number().int(), limit: z.number().int() });
const runItem = z.object({
  id: z.uuid(), taskId: z.uuid(), agentKey, model: z.string(), promptVersion: z.string(), startedAt: instant, finishedAt: instant.nullable(), outcome: z.string().nullable(),
  rounds: z.number(), toolCalls: z.number(), inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheWriteTokens: z.number(),
  costCents: z.number(), summary: z.string().nullable(), errorCode: z.string().nullable(),
});
const taskItem = z.object({
  id: z.uuid(), agentKey, kind: taskKind, status: z.string(), priority: z.number(), sourceKind: z.string().nullable(), sourceRef: z.string().nullable(),
  requiresSession: z.boolean(), dueAt: instant, attempts: z.number(), lastErrorCode: z.string().nullable(), result: z.record(z.string(), z.unknown()).nullable(),
  createdAt: instant, finishedAt: instant.nullable(),
});
const actionItem = z.object({
  id: z.uuid(), taskId: z.uuid().nullable(), agentKey, kind: z.string(), targetKind: z.string().nullable(), targetId: z.string(), status: z.string(), preview: z.string(),
  decisionNote: z.string().nullable(), createdAt: instant, expiresAt: instant, decidedAt: instant.nullable(), executedAt: instant.nullable(), result: z.record(z.string(), z.unknown()).nullable(),
});
const notificationItem = z.object({
  id: z.uuid(), agentKey: agentKey.nullable(), channel: z.enum(["sms", "email"]), severity: z.enum(["info", "warning", "urgent"]), subject: z.string(), body: z.string(),
  status: z.string(), attempts: z.number(), createdAt: instant, sentAt: instant.nullable(),
});
const auditItem = z.object({
  id: z.number(), action: z.string(), entityType: z.string(), entityId: z.string().nullable(), actorId: z.string().nullable(), actorName: z.string().nullable(),
  tenantId: z.string().nullable(), productId: z.string().nullable(), caseId: z.string().nullable(), changedColumns: z.array(z.string()), reasonCode: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()), createdAt: instant,
});
export const activitySchemas = { runs: page(runItem), tasks: page(taskItem), actions: page(actionItem), notifications: page(notificationItem) } as const;
export const auditSchema = page(auditItem);

export type TeamOverview = z.infer<typeof overviewSchema>;
export type TeamAgent = z.infer<typeof agentSchema>;
export type TeamSchedule = z.infer<typeof scheduleSchema>;
export type TeamApproval = z.infer<typeof approvalSchema>;
export type TeamServices = z.infer<typeof servicesSchema>;
export type ActivityKind = keyof typeof activitySchemas;
export type ActivityPage<K extends ActivityKind> = z.infer<(typeof activitySchemas)[K]>;
export type AuditPage = z.infer<typeof auditSchema>;
export type Decision = z.infer<typeof decisionSchema>;

// ---- Display ---------------------------------------------------------------------------------

/** 52.5 cents is "$0.53": the budget is for people, so it rounds to whole cents. */
export const centsLabel = (cents: number) => `$${(Math.round(cents) / 100).toFixed(2)}`;

export const autonomyLabels = { observe: "Observe", propose: "Propose", act: "Act" } as const;
export const autonomyHelp = {
  observe: "Reads and reports only. It cannot propose anything.",
  propose: "Drafts actions and waits for your approval of each one.",
  act: "Does the kinds of action you trust it with on its own and proposes the rest.",
} as const;
export const tierLabels = { fast: "Fast (Haiku)", draft: "Draft (Sonnet)", quality: "Quality (Opus)" } as const;

const taskLabels: Record<string, string> = {
  "probe.sweep": "Health check", "probe.incident": "Handle an incident", "probe.recovery": "Write a recovery note",
  "brief.daily": "Morning brief", "seo.weekly": "Weekly SEO check", "concierge.sweep": "Look for new messages", "concierge.communication": "Triage a message",
  "import.advisors": "Import Advisors requests", "import.breathe": "Import phone messages",
};
export const taskLabel = (kind: string) => taskLabels[kind] ?? kind;

const actionLabels: Record<string, string> = {
  "communication.reply": "Reply to a customer", "communication.note": "Add an internal note", "communication.update": "Update a conversation",
  "incident.open": "Open an incident", "incident.resolve": "Resolve an incident", "import.run": "Import messages",
};
export const actionLabel = (kind: string) => actionLabels[kind] ?? kind;

const outcomeLabels: Record<string, string> = {
  completed: "Completed", failed: "Failed", budget_exhausted: "Stopped at the daily budget", no_result: "No result", refused: "Declined by the model", cancelled: "Cancelled",
};
export const outcomeLabel = (outcome: string | null) => (outcome ? outcomeLabels[outcome] ?? outcome : "Running");

const statusLabels: Record<string, string> = {
  queued: "Queued", running: "Running", awaiting_approval: "Waiting for approval", awaiting_session: "Waiting for your sign-in", done: "Done", failed: "Failed", cancelled: "Cancelled",
  proposed: "Waiting for approval", approved: "Approved", auto_approved: "Approved automatically", executing: "Carrying out", rejected: "Rejected", executed: "Carried out", expired: "Expired",
  pending: "Sending", sent: "Sent", unknown: "Outcome unknown", suppressed: "Not sent (channel unavailable)",
};
export const statusLabel = (status: string) => statusLabels[status] ?? status;

const zoneNames: Record<string, string> = { "America/New_York": "Eastern", UTC: "UTC" };
export function cadenceLabel(schedule: Pick<TeamSchedule, "cadence" | "everySeconds" | "atLocal" | "timezone">): string {
  if (schedule.cadence === "daily") {
    const [hours = "0", minutes = "0"] = (schedule.atLocal ?? "00:00").split(":");
    const hour = Number(hours);
    return `Daily at ${hour % 12 || 12}:${minutes.padStart(2, "0")} ${hour < 12 ? "AM" : "PM"} ${zoneNames[schedule.timezone] ?? schedule.timezone}`;
  }
  const seconds = schedule.everySeconds ?? 0;
  if (seconds % 3600 === 0) return seconds === 3600 ? "Every hour" : `Every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "Every minute" : `Every ${seconds / 60} minutes`;
  return `Every ${seconds} seconds`;
}
