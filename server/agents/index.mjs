import { growthHandlers, growthExecutors } from '../growth/worker.mjs';
import { sqlAgentStore } from './store.mjs';
import { agentScheduler } from './scheduler.mjs';
import { actionExecutor, recordOnlyExecutors } from './actions.mjs';
import { ownerNotifier } from './notify.mjs';
import { agentAdmin } from './admin.mjs';
import { builtInHandlers } from './tasks/index.mjs';
import { conciergeExecutors, draftingFor } from './concierge/index.mjs';
import { lifecycleExecutors } from './accounts/executor.mjs';
import { contentExecutors } from './content/executor.mjs';
import { directEmailExecutors } from './direct-email.mjs';
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
 * usage ledger. The Concierge's triage calls the model only when
 * `customerTextToAi` (the owner's switch) is true, a key is set and `guides` (the guide library) is given.
 * `bookingUrl` (HUB_BOOKING_URL) is the owner's booking page, which the Concierge's sales acknowledgment may offer, and `leadSecrets`
 * are the products' lead secrets (HUB_LEAD_SECRET_*), which the Platform Engineer's lead form checks sign with.
 * `lifecycle` is how the Account Manager sends customer emails: `{ mail, postalAddress, bookingUrl }` (a SendGrid sender with
 * one-click unsubscribe headers, the footer's postal address and the owner's optional booking link); the unsubscribe link uses
 * `publicOrigin`. Without them nothing is proposed or sent, and the daily run says what is missing.
 * Growth assessment and drafting use structured business evidence, with exact-message review for model drafts.
 */
export function agentTeam({
  pool, growth: givenGrowth = null, growthMail = null, postalAddress = '', store: givenStore = null, handlers = {}, executors = {}, sms, email, ownerEmail, publicOrigin,
  fetchImpl = fetch, enabled = false, log = line => console.warn(line), now = () => new Date(), communications = null, features = null,
  anthropicApiKey = null, record = null, model = null, guides = null, customerTextToAi = false, bookingUrl = null, leadSecrets = {}, lifecycle = null,
}) {
  // Fenced operations (the attempt a task was claimed under, the execution an action started) exist once the database declares the hardening feature.
  const store = givenStore ?? sqlAgentStore(pool, { fenced: features?.has?.('platform.agents.hardening.v1') === true, growth: features?.has?.('platform.agents.customer-growth.v1') === true });
  const notifier = ownerNotifier({ store, sms, email, ownerEmail, publicOrigin, log });
  const runtime = model ?? modelRuntime({ apiKey: anthropicApiKey, store, record, notifier, log, now });
  const growth = features?.has?.('platform.agents.customer-growth.v1') ? givenGrowth : null;
  const shared = { store, notifier, model: runtime };
  const customerEmail = { ...(lifecycle ?? {}), publicOrigin };
  const actions = actionExecutor({ store, executors: {
    ...recordOnlyExecutors, ...growthExecutors({growth,mail:growthMail,publicOrigin,postalAddress}), ...conciergeExecutors({ communications, store, notifier, features, log }), ...lifecycleExecutors({ store, features, lifecycle: customerEmail, log }),
    ...contentExecutors({ store, features, log }), ...directEmailExecutors({ store, email, features }), ...(typeof executors === 'function' ? executors(shared) : executors),
  }, log });
  // The handlers every server ships with, then any the caller adds (a caller's handler for the same kind wins).
  const registry = { ...growthHandlers({growth,model:runtime,notifier}), ...builtInHandlers(shared, { publicOrigin, fetchImpl, log, communications, features, guides, customerTextToAi, bookingUrl, leadSecrets, lifecycle: customerEmail, services: { sms: Boolean(sms?.configured), email: Boolean(email?.configured) } }), ...(typeof handlers === 'function' ? handlers({ ...shared, actions }) : handlers) };
  const scheduler = agentScheduler({ store, handlers: registry, actions, enabled, log, now });
  const admin = agentAdmin({
    pool, actions, kick: () => scheduler.tick(), waiting: scheduler.runWaiting,
    services: () => ({
      enabled: scheduler.active(), handlers: scheduler.kinds(),
      sms: Boolean(sms?.configured), email: Boolean(email?.configured), ownerEmail: emailAddress.test(ownerEmail ?? ''), ai: Boolean(runtime.configured),
      customerTextToAi: draftingFor({ model: runtime, guides, customerTextToAi }) !== null,
      directEmail: features?.has?.('platform.agents.direct-email.v1') === true,
    }),
  });
  return { store, notifier, model: runtime, actions, scheduler, admin, tick: scheduler.tick, active: scheduler.active, runWaiting: scheduler.runWaiting };
}
