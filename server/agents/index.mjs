import { sqlAgentStore } from './store.mjs';
import { agentScheduler } from './scheduler.mjs';
import { actionExecutor, recordOnlyExecutors } from './actions.mjs';
import { ownerNotifier } from './notify.mjs';
import { agentAdmin } from './admin.mjs';
import { builtInHandlers } from './tasks/index.mjs';

const emailAddress = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * Assembles the AI team inside the Hub server. `handlers` and `executors` may be objects or
 * functions of the shared services ({ store, notifier, actions }) that return them, so each
 * agent's code can raise owner alerts and propose actions without a circular wiring.
 * The handlers every server ships with (see tasks/) are always registered; `handlers` adds to
 * or replaces them. Nothing runs unless `enabled` is exactly true (HUB_AGENTS_ENABLED); every
 * agent also starts paused in the database until the owner resumes it.
 */
export function agentTeam({
  pool, store = sqlAgentStore(pool), handlers = {}, executors = {}, sms, email, ownerEmail, publicOrigin,
  fetchImpl = fetch, enabled = false, log = line => console.warn(line), now = () => new Date(),
}) {
  const notifier = ownerNotifier({ store, sms, email, ownerEmail, publicOrigin, log });
  const shared = { store, notifier };
  const actions = actionExecutor({ store, executors: { ...recordOnlyExecutors, ...(typeof executors === 'function' ? executors(shared) : executors) }, log });
  // The handlers every server ships with, then any the caller adds (a caller's handler for the same kind wins).
  const registry = { ...builtInHandlers(shared, { publicOrigin, fetchImpl, log, services: { sms: Boolean(sms?.configured), email: Boolean(email?.configured) } }), ...(typeof handlers === 'function' ? handlers({ ...shared, actions }) : handlers) };
  const scheduler = agentScheduler({ store, handlers: registry, actions, enabled, log, now });
  const admin = agentAdmin({
    pool, actions, kick: () => scheduler.tick(),
    services: () => ({
      enabled: scheduler.active(), handlers: scheduler.kinds(),
      sms: Boolean(sms?.configured), email: Boolean(email?.configured), ownerEmail: emailAddress.test(ownerEmail ?? ''),
    }),
  });
  return { store, notifier, actions, scheduler, admin, tick: scheduler.tick, active: scheduler.active };
}
