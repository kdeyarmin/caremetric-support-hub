import { sqlAgentStore } from './store.mjs';
import { agentScheduler } from './scheduler.mjs';
import { actionExecutor, recordOnlyExecutors } from './actions.mjs';
import { ownerNotifier } from './notify.mjs';
import { agentAdmin } from './admin.mjs';
import { builtInHandlers } from './tasks/index.mjs';
import { conciergeExecutors, draftingFor } from './concierge/index.mjs';
import { contentExecutors } from './content/executor.mjs';
import { modelRuntime } from './runtime/index.mjs';

const emailAddress = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * Assembles the AI team inside the Hub server. `handlers` and `executors` may be objects or
 * functions of the shared services ({ store, notifier, actions }) that return them, so each
 * agent's code can raise owner alerts and propose actions without a circular wiring.
 * The handlers every server ships with (see tasks/) are always registered; `handlers` adds to
 * or replaces them. Nothing runs unless `enabled` is exactly true (HUB_AGENTS_ENABLED); every
 * agent also starts paused in the database until the owner resumes it.
 * `model` is the shared model runtime (runtime/): built from `anthropicApiKey` unless one is given,
 * and handed to function-style `handlers` beside the store and the notifier. `record` writes the
 * usage ledger. The Concierge's triage calls the model only when `customerTextToAi` (the owner's switch) is true, a key is set
 * and `guides` (the guide library) is given; the Content Marketer's tasks (no customer text at all) only when a key is set and
 * the database declares platform.agents.content.v1.
 */
export function agentTeam({
  pool, store: givenStore = null, handlers = {}, executors = {}, sms, email, ownerEmail, publicOrigin,
  fetchImpl = fetch, enabled = false, log = line => console.warn(line), now = () => new Date(), communications = null, features = null,
  anthropicApiKey = null, record = null, model = null, guides = null, customerTextToAi = false,
}) {
  // Fenced operations (the attempt a task was claimed under, the execution an action started) exist once the database declares the hardening feature.
  const store = givenStore ?? sqlAgentStore(pool, { fenced: features?.has?.('platform.agents.hardening.v1') === true });
  const notifier = ownerNotifier({ store, sms, email, ownerEmail, publicOrigin, log });
  const runtime = model ?? modelRuntime({ apiKey: anthropicApiKey, store, record, notifier, log, now });
  const shared = { store, notifier, model: runtime };
  const actions = actionExecutor({ store, executors: { ...recordOnlyExecutors, ...conciergeExecutors({ communications, store, notifier, features, log }), ...contentExecutors({ store, features, log }), ...(typeof executors === 'function' ? executors(shared) : executors) }, log });
  // The handlers every server ships with, then any the caller adds (a caller's handler for the same kind wins).
  const registry = { ...builtInHandlers(shared, { publicOrigin, fetchImpl, log, communications, features, guides, customerTextToAi, services: { sms: Boolean(sms?.configured), email: Boolean(email?.configured) } }), ...(typeof handlers === 'function' ? handlers({ ...shared, actions }) : handlers) };
  const scheduler = agentScheduler({ store, handlers: registry, actions, enabled, log, now });
  const admin = agentAdmin({
    pool, actions, kick: () => scheduler.tick(), waiting: scheduler.runWaiting,
    services: () => ({
      enabled: scheduler.active(), handlers: scheduler.kinds(),
      sms: Boolean(sms?.configured), email: Boolean(email?.configured), ownerEmail: emailAddress.test(ownerEmail ?? ''), ai: Boolean(runtime.configured),
      customerTextToAi: draftingFor({ model: runtime, guides, customerTextToAi }) !== null,
    }),
  });
  return { store, notifier, model: runtime, actions, scheduler, admin, tick: scheduler.tick, active: scheduler.active, runWaiting: scheduler.runWaiting };
}
