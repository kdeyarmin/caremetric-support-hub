import { transaction } from '../sms-auth.mjs';

/**
 * The Hub server's only path to the AI team tables. hub_app_server holds no table
 * privilege (supabase/migrations/20261102120000_agent_control_plane.sql), so every
 * method is one call to a private.agent_* security definer operation that refuses any
 * other role. Nothing here decides anything: the database keeps the rules (leases,
 * autonomy, idempotency, budgets) and this module only carries values to and from it.
 */
export function sqlAgentStore(pool) {
  const call = (operation, args = []) => transaction(pool, async client =>
    (await client.query(`select ${operation}(${args.map((_, index) => `$${index + 1}`).join(', ')}) as result`, args)).rows[0].result);
  return {
    /** Turns due schedules of the given task kinds (the ones this server can handle) into tasks. */
    fireSchedules: (kinds, limit = 10) => call('private.agent_schedule_fire', [limit, kinds]),
    maintenance: () => call('private.agent_maintenance'),
    claim: (limit, leaseSeconds) => call('private.agent_task_claim', [limit, leaseSeconds]),
    heartbeat: (taskId, leaseSeconds) => call('private.agent_task_heartbeat', [taskId, leaseSeconds]),
    finish: (taskId, status, { result = null, errorCode = null, retryAt = null } = {}) =>
      call('private.agent_task_finish', [taskId, status, result, errorCode, retryAt]),
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
    readyActions: (limit = 10) => call('private.agent_actions_ready', [limit]),
    beginExecution: actionId => call('private.agent_action_execution', [actionId]),
    completeExecution: (actionId, ok, result = null) => call('private.agent_action_executed', [actionId, ok, result]),
    notifyBegin: ({ channel, severity, subject, body, dedupeKey, agentKey = null, taskId = null }) =>
      call('private.agent_notify_begin', [channel, severity, subject, body, dedupeKey, agentKey, taskId]),
    notifyFinish: (id, delivery, providerMessageId = null) => call('private.agent_notify_finish', [id, delivery, providerMessageId]),
    ownerContact: () => call('private.owner_contact'),
  };
}
