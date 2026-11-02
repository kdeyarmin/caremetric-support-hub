/**
 * Carries out actions the owner approved (or that an agent is trusted to take on its own).
 * The database hands each action to exactly one caller (agent_action_execution), so an
 * approval is executed once; the executor for an action's kind does the actual work through
 * the existing reviewed path and the database records how it went.
 *
 * An executor is `async ({ id, kind, targetKind, targetId, input, requestKey, autoApproved }) => result`.
 * It throws to report failure. The action's request key is the idempotency key for whatever
 * it calls, so running it twice can never send or record twice.
 */
const databaseCode = /^[a-z][a-z_]{0,59}$/;
const codeOf = error => (databaseCode.test(error?.code ?? '') ? error.code : 'executor_error');

/** Incident records have no effect beyond the record itself: the on-call agent tells the owner separately. */
export const recordOnlyExecutors = Object.freeze({
  'incident.open': async () => ({ recorded: true }),
  'incident.resolve': async () => ({ recorded: true }),
});

export function actionExecutor({ store, executors = {}, log = line => console.warn(line) }) {
  async function executeOne(actionId) {
    const execution = await store.beginExecution(actionId);
    if (!execution) return { executed: false, failed: false, skipped: true };
    const executor = executors[execution.kind];
    let ok = false;
    let result = null;
    if (typeof executor !== 'function') {
      result = { error: 'no_executor' };
    } else {
      try {
        result = (await executor(execution)) ?? {};
        ok = true;
      } catch (error) {
        result = { error: codeOf(error) };
        log(JSON.stringify({ event: 'hub_agent_action_error', action_id: execution.id, agent: execution.agentKey, kind: execution.kind, code: result.error }));
      }
    }
    await store.completeExecution(execution.id, ok, result);
    return { executed: ok, failed: !ok, skipped: false };
  }

  async function executeReady(limit = 10) {
    let executed = 0;
    let failed = 0;
    for (const { id } of await store.readyActions(limit)) {
      try {
        const outcome = await executeOne(id);
        if (outcome.executed) executed += 1;
        if (outcome.failed) failed += 1;
      } catch (error) {
        log(JSON.stringify({ event: 'hub_agent_action_step_error', action_id: id, code: codeOf(error) }));
      }
    }
    return { executed, failed };
  }

  return { executeOne, executeReady };
}
