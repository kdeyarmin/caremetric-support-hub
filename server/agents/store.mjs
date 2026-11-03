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
export function sqlAgentStore(pool, { fenced = false, growth = false } = {}) {
  const call = (operation, args = []) => transaction(pool, async client =>
    (await client.query(`select ${operation}(${args.map((_, index) => `$${index + 1}`).join(', ')}) as result`, args)).rows[0].result);
  return {
    fenced,
    ...(growth ? { deferExecution:(actionId,execution)=>call('private.growth_defer_action',[actionId,execution]) } : {}),
    ...(growth ? { reserveBudget:(taskId,cents)=>call('private.growth_budget_reserve',[taskId,cents]),releaseBudget:id=>call('private.growth_budget_release',[id]),accountsPage: ({limit=200,offset=0}={})=>call('private.agent_accounts_page',[limit,offset]), notificationStatus: key=>call('private.growth_notification_status',[key]) } : {}),
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
    briefFacts: async () => { const facts=await call('private.agent_brief_facts');return growth ? {...facts,growth:await call('private.growth_brief_counts')} : facts; },
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
    /** One health check for one product. The database decides when that opens or closes an incident. */
    probeRecord: ({ targetKey, ok, statusCode, latencyMs, failure = null, threshold = 2, agentKey = 'platform_engineer' }) =>
      call('private.agent_probe_record', [targetKey, ok, statusCode, latencyMs, failure, threshold, agentKey]),
  };
}
