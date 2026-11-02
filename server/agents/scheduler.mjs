/**
 * The AI team's clock. One tick, once a minute: housekeeping, turn due schedules into tasks,
 * claim a few tasks under a lease, run each through its handler, and carry out any approved
 * action. The database owns every rule (which agent is active, leases, retries, idempotency);
 * this module only decides what a handler's outcome means and when to try again.
 *
 * A handler is `async (task, { signal, now }) => outcome`, where an outcome is
 * `{ status?, result?, errorCode?, retryAt? }` and status is one of done (the default),
 * awaiting_approval, awaiting_session, queued (try again at retryAt) or failed. A handler
 * that throws is retried with a doubling backoff, except that an error that is not marked
 * `transient` stops after the third attempt. Only task kinds with a handler are scheduled,
 * so a schedule seeded ahead of its code waits instead of failing every interval.
 */
const outcomes = new Set(['done', 'awaiting_approval', 'awaiting_session', 'queued', 'failed']);
const databaseCode = /^[a-z][a-z_]{0,59}$/;
const codeOf = error => (databaseCode.test(error?.code ?? '') ? error.code : error?.transient === true ? 'provider_outage' : 'handler_error');

export function agentScheduler({
  store, handlers = {}, actions = null, enabled = false, leaseSeconds = 600, claimLimit = 3, heartbeatMs = 60_000,
  taskTimeoutMs = 4 * 60_000, retryDelayMs = 5 * 60_000, maxRetryDelayMs = 30 * 60_000, maxPermanentAttempts = 3,
  now = () => new Date(), log = line => console.warn(line),
}) {
  let running = false;
  const active = () => enabled === true;
  const kinds = () => Object.keys(handlers).filter(kind => typeof handlers[kind] === 'function').sort();
  const backoff = attempts => Math.min(retryDelayMs * 2 ** Math.max(attempts - 1, 0), maxRetryDelayMs);

  // One failing step must not stop the others: a database blip during housekeeping still lets claimed work run.
  async function guarded(step, work) {
    try { return await work(); } catch (error) {
      log(JSON.stringify({ event: 'hub_agent_step_error', step, code: codeOf(error) }));
      return undefined;
    }
  }

  async function execute(task) {
    const handler = handlers[task.kind];
    if (typeof handler !== 'function') {
      log(JSON.stringify({ event: 'hub_agent_task_error', task_id: task.id, agent: task.agentKey, kind: task.kind, code: 'no_handler', transient: false, attempts: task.attempts }));
      await guarded('finish', () => store.finish(task.id, 'failed', { errorCode: 'no_handler' }));
      return { id: task.id, status: 'failed' };
    }
    const beat = setInterval(() => { store.heartbeat(task.id, leaseSeconds).catch(() => {}); }, heartbeatMs);
    beat.unref?.();
    const controller = new AbortController();
    let timer;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => handler(task, { signal: controller.signal, now })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Object.assign(new Error('The agent task timed out.'), { code: 'task_timeout', transient: true }));
          }, taskTimeoutMs);
          timer.unref?.();
        }),
      ]);
      const status = outcome?.status ?? 'done';
      if (!outcomes.has(status)) throw Object.assign(new Error('The handler returned an unsupported outcome.'), { code: 'invalid_outcome' });
      const final = await store.finish(task.id, status, {
        result: outcome?.result ?? null, errorCode: outcome?.errorCode ?? null, retryAt: outcome?.retryAt ?? null,
      });
      return { id: task.id, status: final };
    } catch (error) {
      const transient = error?.transient === true;
      const code = codeOf(error);
      // Provenance only: which task failed and why, never a message that could carry content.
      log(JSON.stringify({ event: 'hub_agent_task_error', task_id: task.id, agent: task.agentKey, kind: task.kind, code, transient, attempts: task.attempts }));
      const giveUp = !transient && task.attempts >= maxPermanentAttempts;
      const final = await guarded('finish', () => store.finish(task.id, giveUp ? 'failed' : 'queued', {
        errorCode: code, retryAt: giveUp ? null : new Date(now().getTime() + backoff(task.attempts)),
      }));
      return { id: task.id, status: final ?? 'unknown' };
    } finally {
      clearInterval(beat);
      clearTimeout(timer);
    }
  }

  async function tick() {
    if (running || !active()) return { skipped: true, fired: 0, claimed: 0, executedActions: 0 };
    running = true;
    try {
      await guarded('maintenance', () => store.maintenance());
      const fired = await guarded('fire', () => store.fireSchedules(kinds()));
      const tasks = (await guarded('claim', () => store.claim(claimLimit, leaseSeconds))) ?? [];
      const results = await Promise.all(tasks.map(execute));
      const drained = actions ? await guarded('actions', () => actions.executeReady()) : undefined;
      return { skipped: false, fired: fired?.length ?? 0, claimed: tasks.length, executedActions: drained?.executed ?? 0, results };
    } finally {
      running = false;
    }
  }

  return { tick, active, kinds };
}
