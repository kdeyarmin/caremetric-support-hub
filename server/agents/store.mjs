import { transaction } from '../sms-auth.mjs';

/**
 * The Hub server's only path to the AI team tables. hub_app_server holds no table
 * privilege (supabase/migrations/20261102120000_agent_control_plane.sql), so every
 * method is one call to a private.agent_* security definer operation that refuses any
 * other role. Nothing here decides anything: the database keeps the rules (leases,
 * autonomy, idempotency, budgets) and this module only carries values to and from it.
 *
 * `fenced` is true when the database declares platform.agents.hardening.v1. Then a task's heartbeat
 * and finish quote the attempt it was claimed under (a worker whose lease ran out and whose task was
 * handed out again can no longer touch it), an action's settlement quotes the execution it started,
 * the ready list can be narrowed by kind before it is limited, and an execution that never began its
 * work can be handed back. Against a database without those operations the calls keep their old shape
 * and the extras are ignored, so a server can be deployed before the migration is applied.
 */
export function sqlAgentStore(pool, { fenced = false } = {}) {
  const call = (operation, args = []) => transaction(pool, async client =>
    (await client.query(`select ${operation}(${args.map((_, index) => `$${index + 1}`).join(', ')}) as result`, args)).rows[0].result);
  return {
    fenced,
    /** Turns due schedules of the given task kinds (the ones this server can handle) into tasks. */
    fireSchedules: (kinds, limit = 10) => call('private.agent_schedule_fire', [limit, kinds]),
    maintenance: () => call('private.agent_maintenance'),
    claim: (limit, leaseSeconds) => call('private.agent_task_claim', [limit, leaseSeconds]),
    heartbeat: (taskId, leaseSeconds, attempt = null) => (fenced && Number.isInteger(attempt)
      ? call('private.agent_task_heartbeat', [taskId, leaseSeconds, attempt])
      : call('private.agent_task_heartbeat', [taskId, leaseSeconds])),
    finish: (taskId, status, { result = null, errorCode = null, retryAt = null, attempt = null } = {}) => (fenced && Number.isInteger(attempt)
      ? call('private.agent_task_finish', [taskId, status, result, errorCode, retryAt, attempt])
      : call('private.agent_task_finish', [taskId, status, result, errorCode, retryAt])),
    enqueue: (agentKey, kind, requestKey, { payload = {}, priority = 5, dueAt = null, sourceKind = null, sourceRef = null, requiresSession = false } = {}) =>
      call('private.agent_task_enqueue', [agentKey, kind, requestKey, payload, priority, dueAt, sourceKind, sourceRef, requiresSession]),
    sessionTasks: (limit = 10) => call('private.agent_session_tasks', [limit]),
    claimSessionTask: (taskId, leaseSeconds) => call('private.agent_session_task_claim', [taskId, leaseSeconds]),
    startRun: (taskId, model, promptVersion) => call('private.agent_run_start', [taskId, model, promptVersion]),
    finishRun: (runId, outcome, usage = {}, summary = null, errorCode = null) =>
      call('private.agent_run_finish', [runId, outcome, usage, summary, errorCode]),
    budget: agentKey => call('private.agent_budget', [agentKey]),
    proposeAction: ({ taskId, runId = null, kind, targetKind = null, targetId = null, preview, input = {} }) =>
      call('private.agent_action_propose', [taskId, runId, kind, targetKind, targetId, preview, input]),
    /** Approved actions ready to carry out, oldest first. `kinds` and `excludeKinds` narrow the list before the limit (hardened databases only). */
    readyActions: (limit = 10, { kinds = null, excludeKinds = null } = {}) => (fenced
      ? call('private.agent_actions_ready', [limit, kinds, excludeKinds])
      : call('private.agent_actions_ready', [limit])),
    beginExecution: actionId => call('private.agent_action_execution', [actionId]),
    /** `execution` is the number beginExecution reported for this start; a report for any other start is refused. */
    completeExecution: (actionId, ok, result = null, execution = null) => (fenced && Number.isInteger(execution)
      ? call('private.agent_action_executed', [actionId, ok, result, execution])
      : call('private.agent_action_executed', [actionId, ok, result])),
    /** Hands an execution that never began its work back to its approved state. False when the database cannot (not hardened) or it is no longer that execution. */
    releaseExecution: async (actionId, execution = null) => (fenced && Number.isInteger(execution)
      ? call('private.agent_action_release', [actionId, execution])
      : false),
    notifyBegin: ({ channel, severity, subject, body, dedupeKey, agentKey = null, taskId = null }) =>
      call('private.agent_notify_begin', [channel, severity, subject, body, dedupeKey, agentKey, taskId]),
    notifyFinish: (id, delivery, providerMessageId = null) => call('private.agent_notify_finish', [id, delivery, providerMessageId]),
    ownerContact: () => call('private.owner_contact'),
    /** Counts and times for the morning brief: what needs the owner, what the team did yesterday. No names, no text. */
    briefFacts: () => call('private.agent_brief_facts'),
    /** Conversations whose newest inbound message has settled and nobody has answered or triaged. Ids and counts only. */
    conciergePending: ({ limit = 10, settleSeconds = 90, windowHours = 72, channels = null } = {}) =>
      call('private.agent_concierge_pending', [limit, settleSeconds, windowHours, channels]),
    /** A minimal view of one conversation (no contact details, no notes) with up to `messages` recent messages clipped to `chars`. */
    communicationSnapshot: ({ id, requestKey = null, messages = 0, chars = 2000 }) =>
      call('private.agent_communication_snapshot', [id, requestKey, messages, chars]),
    /** How many alerts whose dedupe key starts with `prefix` went out on `channel` (any when null) since `since`. */
    notificationCount: ({ prefix, channel = null, since }) => call('private.agent_notification_count', [prefix, channel, since]),
    /** A snapshot of every account's billing facts, usage and case counts for the weekly report: names and numbers, never a contact address. */
    accountsSnapshot: ({ limit = 200 } = {}) => call('private.agent_accounts_snapshot', [limit]),
    /**
     * The facts the customer emails need, per account and product (or one account and product): names, dates and flags, never an
     * address. Newest first, `limit` rows from `offset`; `truncated` says more rows follow this page.
     */
    lifecycleSnapshot: ({ limit = 200, tenant = null, product = null, offset = 0 } = {}) => call('private.agent_lifecycle_snapshot', [limit, tenant, product, offset]),
    /**
     * Records one approved customer email before it is sent and returns the one address it goes to (`{ state: 'ready', to }`), or why
     * it may not go (`no_address`, `suppressed`, `daily_limit`, `auto_send_off`), or what an earlier attempt recorded (`recorded`, `status`).
     * With no `unsubscribeHash` it only says whether a send was recorded (`recorded` or `unrecorded`) and changes nothing.
     */
    lifecycleBeginSend: ({ actionId, execution = null, unsubscribeHash }) => call('private.agent_lifecycle_begin_send', [actionId, execution, unsubscribeHash]),
    lifecycleFinishSend: ({ actionId, delivery, providerMessageId = null }) => call('private.agent_lifecycle_finish_send', [actionId, delivery, providerMessageId]),
    /**
     * What the Content Marketer needs to choose a topic: its latest article action per topic, which of `slugs` another content
     * item already uses, recent inbox conversations counted by product and inquiry type (never text) and the months whose
     * outreach email is recorded.
     */
    contentState: (slugs = []) => call('private.agent_content_state', [slugs]),
    /** Publishes the article an approved content.publish action carries, as the AI assistant with the owner's approval. */
    contentPublish: (actionId, execution = null) => call('private.agent_content_publish', [actionId, execution]),
    /** One health check for one product. The database decides when that opens or closes an incident. */
    probeRecord: ({ targetKey, ok, statusCode, latencyMs, failure = null, threshold = 2, agentKey = 'platform_engineer' }) =>
      call('private.agent_probe_record', [targetKey, ok, statusCode, latencyMs, failure, threshold, agentKey]),
    // The Growth Manager's reads (platform.agents.growth.v1). None returns a contact's name, address, phone number or message.
    /** Website leads the Growth Manager has not looked at yet, oldest first, from the last `windowHours`: ids, kinds and products only. Test leads never appear. */
    growthPending: ({ limit = 50, windowHours = 24 } = {}) => call('private.agent_growth_pending', [limit, windowHours]),
    /** One lead as an alert may name it: kind, product, organization, a few facts, where it came from and its conversation's reference. */
    growthLead: id => call('private.agent_growth_lead', [id]),
    /** Marks leads as looked at, so each is handled once. Returns how many were newly marked. */
    growthMarkSeen: ids => call('private.agent_growth_mark_seen', [ids]),
    /**
     * Lead conversations to remind the owner about: waiting at least the smallest of `steps` (minutes) and less than `maxMinutes`, whose
     * current step has not been reminded yet, the most recent first, each with its step. Reminded steps are left out before the limit.
     */
    growthUnanswered: ({ steps, maxMinutes, limit = 50 }) => call('private.agent_growth_unanswered', [steps, maxMinutes, limit]),
    /** Counts for the reports: leads by kind, product and source, trials, replies and what is still unanswered, between `since` and `until`. */
    growthFacts: ({ since, until }) => call('private.agent_growth_facts', [since, until]),
    /** Whether a test lead from `source` reached the Hub at or after `since`: the end of a lead form check. */
    leadProbeSeen: ({ source, since }) => call('private.agent_lead_probe_seen', [source, since]),
  };
}
