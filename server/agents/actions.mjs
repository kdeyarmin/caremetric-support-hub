/**
 * Carries out actions the owner approved (or that an agent is trusted to take on its own).
 * The database hands each action to exactly one caller (agent_action_execution), so an
 * approval is executed once; the executor for an action's kind does the actual work through
 * the existing reviewed path and the database records how it went.
 *
 * An executor is `async ({ id, kind, targetKind, targetId, input, requestKey, autoApproved }, { sessionToken }) => result`.
 * It throws to report failure, and a thrown `code` (lowercase letters and underscores) is what the
 * owner's screen shows. The action's request key is the idempotency key for whatever it calls, so
 * running it twice can never send or record twice.
 *
 * Some executors act through a staff path that authorizes the owner's live session (a reply is sent
 * as the owner). Those are marked with `sessionExecutor`. They run only when a session is at hand:
 * straight after the owner approves, or when the owner presses "Run what's waiting". The background
 * drain leaves them alone, and a session action that cannot run is skipped BEFORE it is started, so
 * it stays approved instead of being stranded half way. One whose session lapsed after it was started, before
 * anything was done, is handed back to its approved state (on a database that can: see store.releaseExecution)
 * rather than recorded as failed, so signing in again and pressing the button sends it. The owner's session
 * reaches only the executors marked with `sessionExecutor`.
 */
const databaseCode = /^[a-z][a-z_]{0,59}$/;
const codeOf = error => (databaseCode.test(error?.code ?? '') ? error.code : 'executor_error');

/** Incident records have no effect beyond the record itself: the on-call agent tells the owner separately. */
export const recordOnlyExecutors = Object.freeze({
  'incident.open': async () => ({ recorded: true }),
  'incident.resolve': async () => ({ recorded: true }),
});

/** Marks an executor that needs the owner's live session. */
export const sessionExecutor = executor => Object.assign(executor, { requiresSession: true });

export function actionExecutor({ store, executors = {}, log = line => console.warn(line) }) {
  const needsSession = kind => executors[kind]?.requiresSession === true;
  const sessionKinds = () => Object.keys(executors).filter(needsSession);

  /**
   * Carries out one approved action. Pass its `kind` (the callers always know it) so a session action
   * with no session is skipped without being started; with a `sessionToken` it runs as the owner.
   * Returns { executed, failed, skipped, needsSession?, error? }; `error` is the failure's code.
   */
  async function executeOne(actionId, { kind = null, sessionToken = null } = {}) {
    if (kind !== null && needsSession(kind) && !sessionToken) return { executed: false, failed: false, skipped: true, needsSession: true };
    const execution = await store.beginExecution(actionId);
    if (!execution) return { executed: false, failed: false, skipped: true };
    const executor = executors[execution.kind];
    let ok = false;
    let result = null;
    if (typeof executor !== 'function') {
      result = { error: 'no_executor' };
    } else {
      try {
        // The owner's session goes only to an executor that acts as the owner; every other executor runs without one.
        result = (await executor(execution, { sessionToken: executor.requiresSession === true ? sessionToken : null })) ?? {};
        ok = true;
      } catch (error) {
        const code = codeOf(error);
        // Growth deferrals get a durable retry time; immediately releasing them would starve later ready actions.
        if (code === 'action_deferred'
          && await Promise.resolve(store.deferExecution?.(execution.id, execution.execution ?? null)).catch(() => false) === true) {
          return { executed: false, failed: false, skipped: true, needsSession: false };
        }
        // A session that lapsed before anything was sent waits for the owner's next press.
        if (code === 'session_required' && executor.requiresSession === true
          && await Promise.resolve(store.releaseExecution?.(execution.id, execution.execution ?? null)).catch(() => false) === true) {
          return { executed: false, failed: false, skipped: true, needsSession: true };
        }
        result = { error: code };
        log(JSON.stringify({ event: 'hub_agent_action_error', action_id: execution.id, agent: execution.agentKey, kind: execution.kind, code: result.error }));
      }
    }
    await store.completeExecution(execution.id, ok, result, execution.execution ?? null);
    return ok ? { executed: true, failed: false, skipped: false } : { executed: false, failed: true, skipped: false, error: result.error };
  }

  /** The tick's drain: everything approved that needs no session. Session actions are counted as waiting and left alone. */
  async function executeReady(limit = 50) {
    let executed = 0;
    let failed = 0;
    let waiting = 0;
    // The database leaves the session kinds out before it limits the list, so enough waiting replies cannot hide the rest behind them.
    for (const { id, kind } of await store.readyActions(limit, { excludeKinds: sessionKinds() })) {
      if (needsSession(kind)) { waiting += 1; continue; }
      try {
        const outcome = await executeOne(id, { kind });
        if (outcome.executed) executed += 1;
        if (outcome.failed) failed += 1;
      } catch (error) {
        log(JSON.stringify({ event: 'hub_agent_action_step_error', action_id: id, code: codeOf(error) }));
      }
    }
    return { executed, failed, waiting };
  }

  /** Approved actions that are waiting for the owner's session: { id, kind } for each. */
  async function sessionActions(limit = 50) {
    const kinds = sessionKinds();
    if (kinds.length === 0) return [];
    return (await store.readyActions(limit, { kinds })).filter(item => needsSession(item.kind)).map(({ id, kind }) => ({ id, kind }));
  }

  /** Carries those out one at a time with the owner's session. Never rejects. */
  async function executeSessionActions(list, { sessionToken }) {
    let executed = 0;
    let failed = 0;
    for (const { id, kind } of list) {
      try {
        const outcome = await executeOne(id, { kind, sessionToken });
        if (outcome.executed) executed += 1;
        if (outcome.failed) failed += 1;
      } catch (error) {
        log(JSON.stringify({ event: 'hub_agent_action_step_error', action_id: id, code: codeOf(error) }));
      }
    }
    return { executed, failed };
  }

  return { executeOne, executeReady, sessionActions, executeSessionActions };
}
