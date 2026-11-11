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
/** Configuration checks only: provider access and successful execution are established by task results. */
export const marketingToolSchema = z.object({
  key: z.string().min(1).max(80), label: z.string().min(1).max(120), agents: z.array(agentKey), configured: z.boolean(), supported: z.boolean().optional(),
  missing: z.array(z.string().min(1).max(1000)), detail: z.string().max(2000),
  settingsPath: z.enum(["/admin", "/admin/settings", "/admin/growth", "/admin/creative"]).optional(),
});
export const servicesSchema = z.object({ enabled: z.boolean(), handlers: z.array(taskKind), sms: z.boolean(), email: z.boolean(), ownerEmail: z.boolean(), ai: z.boolean(), customerTextToAi: z.boolean(), externalEmail: z.boolean().optional(),
  marketingTools: z.array(marketingToolSchema).optional(),
  creative: z.object({ declared: z.boolean(), enabled: z.boolean(), videoProvider: z.enum(["internal", "heygen"]).nullable(), dailyRenderCap: z.number().int().min(0) }).optional() });
/**
 * One kind of work the owner hands over: off, a supervised week (they approve each item until `automaticAt`), automatic (the agent
 * does it on its own) or held (they keep approving). `ready` says whether its code is on the Hub; a supervised step whose code is
 * missing switches only when the code arrives. `changedAt` is handed back with a change so a stale screen is refused.
 */
export const autonomyStepSchema = z.object({
  category: z.string().regex(/^[a-z][a-z_]{2,39}$/), label: z.string().max(80), status: z.enum(["off", "supervised", "automatic", "held"]),
  supervisedSince: instant.nullable(), automaticAt: instant.nullable(), changedAt: instant, ready: z.boolean(), agents: z.array(agentKey),
});
/**
 * One offer on the owner's menu: a trial extension of `trialDays`, or one of the owner's Stripe coupons (`couponId`), for trials of `apps`
 * that end within `windowDays`, at most `monthlyCap` a month and once per account. `usedThisMonth` counts offers made (or still being made)
 * this calendar month, Eastern; `appliedTotal` every offer Stripe confirmed. `changedAt` is handed back with a change.
 */
export const offerSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{2,39}$/), label: z.string().max(80), kind: z.enum(["trial_extension", "coupon"]),
  trialDays: z.number().int().min(1).max(30).nullable(), couponId: z.string().max(255).nullable(), apps: z.array(z.string().max(80)),
  eligibility: z.string().max(40), windowDays: z.number().int().min(1).max(30), monthlyCap: z.number().int().min(1).max(50), enabled: z.boolean(),
  changedAt: instant, usedThisMonth: z.number().int().min(0), appliedTotal: z.number().int().min(0),
});
/** One of the owner's Stripe coupons a menu offer may use (valid, live mode). */
export const offerCouponSchema = z.object({
  id: z.string().max(255), name: z.string().nullable(), percentOff: z.number().nullable(), amountOff: z.number().nullable(), currency: z.string().nullable(),
  duration: z.string().nullable(), durationInMonths: z.number().int().nullable(),
});
export const offersSchema = z.object({ offers: z.array(offerSchema), coupons: z.array(offerCouponSchema) });
/**
 * One product the team could market, switched on or off by the owner. The agents read the switches when each task starts: a product
 * switched off gets no prospecting, cold email, posts, ads, articles or outreach drafts, and the Sales Executive leaves its prospects to
 * the owner. Customers' onboarding and support do not depend on it. `changedAt` is handed back with a change.
 */
export const marketingProductSchema = z.object({
  product: z.enum(["caremetric-intel", "carebase", "advisors"]), label: z.string().max(80), description: z.string().max(300), marketed: z.boolean(), changedAt: instant,
});
/**
 * The Monday scorecard's setting. While `individualReports` is false, the five weekly reports (accounts, growth, SEO, pipeline and
 * social) stop emailing on their schedule and the Chief of Staff's scorecard carries their figures; Run now on each still emails it.
 */
export const scorecardSettingsSchema = z.object({ individualReports: z.boolean(), changedAt: instant });
/**
 * `waitingActions` counts approved messages needing checking or completion, including external email recovery candidates; it is not
 * an unsent count. `autonomy`, `offers`, `marketing` and `reports` are null (or absent) when the Hub's database does not have autonomy steps,
 * the offer menu, the marketing switches or the Monday scorecard yet.
 */
export const overviewSchema = z.object({
  team: teamSchema, services: servicesSchema, waitingActions: z.number().int().min(0), autonomy: z.array(autonomyStepSchema).nullable().optional(),
  offers: offersSchema.nullable().optional(), marketing: z.array(marketingProductSchema).nullable().optional(),
  reports: scorecardSettingsSchema.nullable().optional(),
});
/**
 * `error` is the code of why an approved action could not be carried out (see `errorLabel`). `needsSession` is the server saying it
 * confirmed that nothing was started for want of the owner's session; an approval without it, still `approved`, is not confirmed either way.
 */
export const decisionSchema = z.object({ id: z.uuid(), kind: z.string(), status: z.string(), decided: z.boolean(), error: z.string().optional(), needsSession: z.boolean().optional() });
export const taskResultSchema = z.object({ id: z.uuid(), status: z.string() });
/** Preparing an owner-written email creates a proposal; it never approves or sends it. A replay returns the same action. */
export const externalEmailProposalSchema = z.object({
  id: z.uuid(), kind: z.literal("email.external"), requestKey: z.uuid(), created: z.boolean(),
  status: z.enum(["proposed", "approved", "executing", "executed", "failed", "rejected", "expired"]),
});
export type ExternalEmailProposal = z.infer<typeof externalEmailProposalSchema>;
export interface ExternalEmailDraft { to: string; subject: string; body: string }
/** How many waiting tasks were started and how many approved messages were launched or recovered. This does not confirm a new send. */
export const waitingSchema = z.object({ started: z.number().int().min(0), actions: z.number().int().min(0) });

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
export type AutonomyStep = z.infer<typeof autonomyStepSchema>;
export type MenuOffer = z.infer<typeof offerSchema>;
export type MarketingProduct = z.infer<typeof marketingProductSchema>;
export type ScorecardSettings = z.infer<typeof scorecardSettingsSchema>;
export type OfferCoupon = z.infer<typeof offerCouponSchema>;
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

/** What handing each kind of work over means, in the owner's words. */
const stepHelp: Record<string, string> = {
  account_emails: "Welcome, setup help, trial check-in and testimonial request emails to customers, up to 20 a day, each with an unsubscribe link.",
  support_answers: "Answers to questions your published guides cover. Billing, cancellations, outages, legal questions and anything with personal details always come to you.",
  articles: "Articles that pass the content checks, published to your public help pages.",
  offers: "Offers from the menu you set (a trial extension or one of your coupons), to accounts that qualify, within the menu's caps.",
  sales_followups: "The Marketing Manager's follow-ups and replies to people who contacted CareMetric or that you added, within each product's daily limit and touch cap, each with an unsubscribe link.",
  cold_email: "First emails to businesses found online, sent only to the public role address on the business's own website (such as info@), at most 10 a day, each business once, never a text, each with an unsubscribe link and your postal address.",
  sales_answers: "The Sales Executive's answers to prospects by email or chat, drafted from your fact sheet, the sales playbook and your published guides and passing every check. Negotiations, contracts, security questions, cancellations and anything with personal details always come to you.",
  social_posts: "Facebook and Instagram posts from the weekly plan that pass the fact-sheet checks, each published at its time slot.",
  social_replies: "Replies to comments and private messages on Facebook and Instagram that pass the checks, and hiding spam. Complaints, account questions and anything with personal details always come to you.",
  ad_tuning: "Pausing ads that are losing and starting new ad copy inside each ad set's existing budget. Budget increases always come to you.",
  creative_assets: "Finished ad creative that passed every compliance check with no warning, handed to the Social Media Manager. Anything with a warning always comes to you, and anything that fails a check is blocked.",
  creative_retire: "Retiring creative whose results show it is tired (falling click-through rate, seen more than three times per person, rising cost per thousand impressions).",
};
export const stepHelpText = (category: string) => stepHelp[category] ?? "";

const taskLabels: Record<string, string> = {
  "content.weekly": "Weekly help article", "content.outreach": "Monthly outreach drafts",
  "probe.sweep": "Health check", "probe.incident": "Handle an incident", "probe.recovery": "Write a recovery note", "probe.forms": "Lead form check",
  "brief.daily": "Morning brief", "scorecard.weekly": "Monday scorecard", "seo.weekly": "Weekly SEO check", "concierge.sweep": "Look for new messages", "concierge.communication": "Triage a message",
  "import.advisors": "Import Advisors requests", "import.breathe": "Import phone messages", "accounts.weekly": "Weekly account report",
  "growth.leads": "Look for new leads", "growth.followup": "Chase unanswered leads", "growth.weekly": "Weekly growth report",
  "accounts.lifecycle": "Customer emails", "autonomy.graduate": "Hand over work after its supervised week", "accounts.offers": "Offers from your menu",
  "growth.pipeline": "Review sales pipeline", "growth.success": "Review customer success", "growth.discovery": "Discover prospective organizations", "growth.content": "Propose product content",
  "growth.evaluate": "Check the outreach guardrails",
  "sales.reply": "Answer a prospect", "sales.review": "Weekly pipeline review",
  "social.plan": "Weekly social plan", "social.inbox": "Look for new comments and messages", "social.interaction": "Answer a comment or message",
  "social.ads": "Daily ad review", "social.report": "Weekly social report",
  "creative.plan": "Turn marketing plans into briefs", "creative.request": "Draft a creative brief", "creative.render": "Render and check creative",
  "creative.refresh": "Weekly creative refresh", "creative.report": "Weekly creative report",
};
export const taskLabel = (kind: string) => taskLabels[kind] ?? kind;

/** What the Platform Engineer checks: each product's health address, and each product's lead form (checked every six hours). */
const probeTargetLabels: Record<string, string> = {
  hub: "Support Hub", carebase: "CareBase", intel: "CareMetric Intel", advisors: "Healthcare Advisors",
  carebase_forms: "CareBase lead form", intel_forms: "Intel lead form", advisors_forms: "Advisors consultation form",
};
/**
 * What an action is for, in plain words: a probe target's incident ("carebase_forms:2") reads "CareBase lead form, incident 2". A
 * conversation reference (CM-1042), an unknown target and anything else are shown as they are.
 */
export function targetLabel(targetKind: string | null, targetId: string): string {
  if (targetKind !== "probe_target") return targetId;
  const [key, incident] = targetId.split(":");
  const label = probeTargetLabels[key];
  if (!label) return targetId;
  return /^\d+$/.test(incident ?? "") ? `${label}, incident ${incident}` : label;
}

const actionLabels: Record<string, string> = {
  "content.publish": "Publish a help article",
  "communication.reply": "Reply to a customer", "communication.answer": "Answer a customer from your guides", "communication.note": "Add an internal note", "communication.update": "Update a conversation",
  "growth.message": "Send a reviewed growth message", "growth.content": "Approve a product content brief",
  "incident.open": "Open an incident", "incident.resolve": "Resolve an incident", "import.run": "Import messages",
  "email.send": "Email a customer", "offer.apply": "Make an offer from your menu",
  "email.external": "Send an email",
  "social.post": "Publish a social post", "social.reply": "Reply on social media", "social.moderate": "Hide a social comment",
  "social.ad_pause": "Pause an ad", "social.ad_create": "Start a new ad", "social.ad_budget": "Change an ad budget",
  "creative.asset": "Approve ad creative", "creative.asset_review": "Approve ad creative with warnings", "creative.retire": "Retire tired creative",
};
export const actionLabel = (kind: string) => actionLabels[kind] ?? kind;

/** The subject in an email preview's header, after an optional To line. Text in the body is never treated as a header. */
export function emailSubject(preview: string): string | null {
  const match = /^(?:To: [^\n]{1,320}\n)?Subject: ([^\n]{1,200})(\n|$)/u.exec(preview);
  return match ? match[1].trim() || null : null;
}
/** External actions use a request UUID as their target. The private, exact preview carries the recipient. */
export function externalEmailRecipient(preview: string): string | null {
  return /^To: ([^\n]{1,320})\nSubject: /.exec(preview)?.[1] ?? null;
}
/**
 * What an approval card says is proposed: "Email to maple-grove: Welcome to CareMetric CareBase" for a customer email (the account,
 * then the email's own subject), and the action and its target for everything else ("Reply to a customer for CM-1042").
 */
export function approvalTitle(approval: Pick<TeamApproval, "kind" | "targetId" | "preview">): string {
  if (approval.kind === "email.external") {
    const subject = emailSubject(approval.preview);
    return `Email to ${externalEmailRecipient(approval.preview) || "a recipient"}${subject ? `: ${subject}` : ""}`;
  }
  if (approval.kind === "email.send") {
    const subject = emailSubject(approval.preview);
    return `Email to ${approval.targetId || "a customer"}${subject ? `: ${subject}` : ""}`;
  }
  return `${actionLabel(approval.kind)}${approval.targetId ? ` for ${approval.targetId}` : ""}`;
}

const errorLabels: Record<string, string> = {
  invalid_article: "The article no longer passes the content checks (a rule changed since it was written), so it was not published.",
  approval_required: "This article was approved automatically, but article publishing is not handed over to the Content Marketer right now (you chose Keep approving, paused it or changed its level), so it was not published.",
  slug_taken: "Another article already uses this address, so nothing was published.",
  product_unavailable: "The article's product is retired or closed to support, so it was not published.",
  publish_failed: "The article could not be published.",
  thread_changed: "The customer wrote again after this reply was written, so nothing was sent. Open the conversation and answer their latest message.",
  conversation_closed: "The conversation was closed, so nothing was sent.",
  conversation_missing: "The conversation no longer exists, so nothing was sent.",
  target_mismatch: "The answer named a different conversation from the one it would have gone to, so nothing was sent.",
  session_required: "Your sign-in lapsed. Sign in again, then press Run what's waiting.",
  not_permitted: "Your account cannot do this, so nothing was sent.",
  reply_refused: "The Hub could not route this reply (no email address or number on file, or that channel is not set up). Nothing was sent.",
  invalid_reply: "The Hub refused the reply as invalid. Nothing was sent.",
  delivery_failed: "The provider refused the message, so it did not reach the customer.",
  delivery_unknown: "The provider did not confirm delivery. Open the conversation and check the thread before sending again.",
  delivery_unconfirmed: "The reply was recorded but its delivery was never confirmed. Open the conversation and check the thread before sending again.",
  auto_approved_refused: "Replies are never sent without your approval, so nothing was sent.",
  answers_off: "Support answers are no longer handed over to the Concierge (you chose Keep approving, paused it or changed its level after this answer was approved automatically), so nothing was sent.",
  no_executor: "This server cannot carry out that kind of action yet.",
  executor_error: "The action could not be carried out.",
  bridge_unavailable: "The other application did not answer. It is tried again when you press Run what's waiting.",
  rate_limited: "The other application asked to slow down. It is tried again when you press Run what's waiting.",
  request_rejected: "The other application refused the request.",
  invalid_payload: "The task carried something the server could not use.",
  no_longer_applies: "The account changed since this email was written (the trial ended, converted or is being cancelled, or the plan stopped paying), so nothing was sent.",
  suppressed: "The billing contact unsubscribed from CareMetric emails, so nothing was sent.",
  no_address: "There is no usable billing email address for this account, so nothing was sent.",
  not_configured: "Customer email is not set up on the Hub (the SendGrid key, the postal address for the footer or the public address), so nothing was sent.",
  daily_limit: "20 customer emails already went out today, the most the Hub sends in a day, so this one was not sent.",
  frequency_limited: "Another customer-growth or lifecycle email was recently attempted for this contact, so this one was not sent.",
  email_unconfirmed: "SendGrid did not confirm this email. It is never sent again on its own, so the customer may or may not have it.",
  wording_changed: "The Hub's wording for this email changed after you approved it, so nothing was sent rather than different words.",
  auto_send_off: "This email was approved on its own, but its template is no longer one you let the agent send, so nothing was sent.",
  invalid_email: "The Hub refused this email as invalid. Nothing was sent.",
  invalid_external_email: "The recipient, subject or message is invalid. Nothing was sent.",
  external_email_not_configured: "Owner-written email is not available on this Hub yet. Nothing was sent.",
  external_email_refused: "The email provider refused this message. Nothing was sent.",
  external_email_unconfirmed: "The email's outcome could not be confirmed. It may have been sent. Do not resend it; check the provider's activity first. The Hub will not retry it automatically.",
  offers_off: "Offers are no longer handed over to the Account Manager (you chose Keep approving, paused it or changed its level after this offer was approved automatically), so nothing was offered.",
  offer_disabled: "That offer is switched off on your menu, so nothing was offered.",
  not_eligible: "The account no longer qualifies (the trial ended, converted or is not live, or the coupon is no longer valid), so nothing was offered.",
  already_offered: "This account already had this offer, so nothing was offered again.",
  cap_reached: "This offer reached its monthly cap, so nothing was offered.",
  offer_refused: "Stripe refused the change, so nothing was offered. The place under the cap was given back.",
  offer_unconfirmed: "Stripe did not answer, so the offer may or may not have been applied. It is never tried again on its own: check the subscription in Stripe.",
  billing_unavailable: "Stripe is not set up or could not be verified on the Hub, so nothing was offered.",
  invalid_offer: "The Hub refused this offer as invalid. Nothing was offered.",
  outreach_off: "This email was approved on its own, but that kind of outreach is no longer handed over to the Marketing Manager (you chose Keep approving, paused it or changed its level), so nothing was sent.",
  business_contacted: "This business was already emailed once from a public address found on its website, so nothing more was sent to it.",
  not_executing: "The hand-over was not started by this approval, so nothing changed. Refresh and check the asset on the Creative screen.",
  asset_missing: "The creative asset no longer exists, so nothing changed.",
  asset_changed: "The creative asset changed since it was proposed (it was rejected, expired or retired), so nothing changed.",
  invalid_creative_action: "The creative action did not name its asset correctly, so nothing changed.",
  creative_refused: "The database refused the creative hand-over, so nothing changed.",
};
/** What a stored error code means for the owner; an unknown code is shown as it is. */
export const errorLabel = (code: string | null | undefined) => (code ? errorLabels[code] ?? code : "");
/**
 * Why an action that ended `failed` did not go out. A failed action is final, and the "Run what's waiting" button picks up only approved
 * ones, so a lapsed sign-in here is not something that button can put right (a task waiting for the sign-in is: see `errorLabel`).
 */
export const failedActionLabel = (code: string | null | undefined) =>
  code === "session_required" ? "Your sign-in lapsed before the reply was sent, so nothing was sent. Sign in again and answer from the conversation." : errorLabel(code);

/** A generic lookup/executor error is not evidence that an external email was never sent. */
export function externalEmailFailure(code: unknown): { unconfirmed: boolean; message: string } {
  const definite = typeof code === "string" && ["invalid_external_email", "external_email_not_configured", "external_email_refused"].includes(code);
  return { unconfirmed: !definite, message: definite ? errorLabel(code) : errorLabel("external_email_unconfirmed") };
}

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
