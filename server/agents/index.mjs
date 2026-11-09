import { growthHandlers, growthExecutors } from '../growth/worker.mjs';
import { defaultMarketed, marketingFeature } from './marketing.mjs';
import { sqlAgentStore } from './store.mjs';
import { agentScheduler } from './scheduler.mjs';
import { actionExecutor, recordOnlyExecutors } from './actions.mjs';
import { ownerNotifier } from './notify.mjs';
import { agentAdmin } from './admin.mjs';
import { builtInHandlers } from './tasks/index.mjs';
import { conciergeExecutors, draftingFor } from './concierge/index.mjs';
import { lifecycleExecutors } from './accounts/executor.mjs';
import { externalEmailAvailable, externalEmailExecutors, externalEmailRecovery } from './external-email.mjs';
import { offerExecutors } from './accounts/offers.mjs';
import { contentExecutors } from './content/executor.mjs';
import { modelRuntime } from './runtime/index.mjs';
import { salesHandlers } from './sales/index.mjs';
import { socialDeclared, socialTeam } from './social/index.mjs';

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
 * `leadSecrets` are the products' lead secrets (HUB_LEAD_SECRET_*), which the Platform Engineer's lead form checks sign with.
 * `lifecycle` is how the Account Manager sends customer emails: `{ mail, postalAddress }` (a SendGrid sender with
 * one-click unsubscribe headers and the footer's postal address); the unsubscribe link uses
 * `publicOrigin`. Without them nothing is proposed or sent, and the daily run says what is missing.
 * Growth assessment and drafting use structured business evidence, with exact-message review for model drafts.
 * `offerBilling` makes the Account Manager's offers from the owner's menu (`{ agentOffer }`, platform billing's session-less method); without
 * it an approved offer is refused before Stripe is asked and its place under the cap is given back.
 */
export function agentTeam({
  pool, growth: givenGrowth = null, growthMail = null, postalAddress = '', store: givenStore = null, handlers = {}, executors = {}, sms, email, ownerEmail, publicOrigin,
  fetchImpl = fetch, enabled = false, log = line => console.warn(line), now = () => new Date(), communications = null, features = null,
  anthropicApiKey = null, record = null, model = null, guides = null, customerTextToAi = false, leadSecrets = {}, lifecycle = null, offerBilling = null,
  social = null, meta = null, marketed = null,
}) {
  // Fenced operations (the attempt a task was claimed under, the execution an action started) exist once the database declares the hardening feature.
  const marketing = features?.has?.(marketingFeature) === true;
  const store = givenStore ?? sqlAgentStore(pool, { fenced: features?.has?.('platform.agents.hardening.v1') === true, growth: features?.has?.('platform.agents.customer-growth.v1') === true,
    social: socialDeclared(features), marketing });
  // What the team markets: the owner's switches on the AI team page, read when each marketing task starts (marketing.mjs). Until the
  // database declares them, CareMetric Intel only. A caller (a test) may pass its own list or reader.
  const marketedSource = marketed ?? (marketing && typeof store.marketedProducts === 'function' ? () => store.marketedProducts() : [...defaultMarketed]);
  const notifier = ownerNotifier({ store, sms, email, ownerEmail, publicOrigin, log });
  const runtime = model ?? modelRuntime({ apiKey: anthropicApiKey, store, record, notifier, log, now });
  const growth = features?.has?.('platform.agents.customer-growth.v1') ? givenGrowth : null;
  const shared = { store, notifier, model: runtime };
  // The Social Media Manager (platform.agents.social.v1): its Meta client is built once, from `social` (socialConfig in social/index.mjs).
  const socialWork = socialTeam({ social, features, fetchImpl, meta });
  const customerEmail = { ...(lifecycle ?? {}), publicOrigin };
  const actions = actionExecutor({ store, executors: {
    ...recordOnlyExecutors, ...growthExecutors({growth,mail:growthMail,publicOrigin,postalAddress}), ...conciergeExecutors({ communications, store, notifier, features, log }), ...lifecycleExecutors({ store, features, lifecycle: customerEmail, log }),
    ...offerExecutors({ store, features, billing: offerBilling, notifier, log }),
    ...contentExecutors({ store, features, log }), ...externalEmailExecutors({ store, features, email, log }), ...socialWork.executors({ notifier, log }),
    ...(typeof executors === 'function' ? executors(shared) : executors),
  }, log });
  // The handlers every server ships with, then any the caller adds (a caller's handler for the same kind wins).
  const registry = { ...growthHandlers({growth,model:runtime,notifier,features,marketed:marketedSource}),
    ...salesHandlers({ store, notifier, model: runtime, growth, features, customerTextToAi, publicOrigin, guides, marketed: marketedSource, log }),
    ...socialWork.handlers({ store, notifier, model: runtime, customerTextToAi, publicOrigin, marketed: marketedSource, log }), ...builtInHandlers(shared, { publicOrigin, fetchImpl, log, communications, features, guides, customerTextToAi, leadSecrets, lifecycle: customerEmail, marketed: marketedSource, services: { sms: Boolean(sms?.configured), email: Boolean(email?.configured) } }), ...(typeof handlers === 'function' ? handlers({ ...shared, actions }) : handlers) };
  const scheduler = agentScheduler({ store, handlers: registry, actions, enabled, log, now });
  const admin = agentAdmin({
    pool, actions, kick: () => scheduler.tick(), waiting: scheduler.runWaiting,
    externalEmailReady: externalEmailRecovery({ store, features }),
    services: () => ({
      enabled: scheduler.active(), handlers: scheduler.kinds(),
      sms: Boolean(sms?.configured), email: Boolean(email?.configured), ownerEmail: emailAddress.test(ownerEmail ?? ''), ai: Boolean(runtime.configured),
      customerTextToAi: draftingFor({ model: runtime, guides, customerTextToAi }) !== null,
      externalEmail: externalEmailAvailable({ features, email }),
    }),
  });
  return { store, notifier, model: runtime, actions, scheduler, admin, tick: scheduler.tick, active: scheduler.active, runWaiting: scheduler.runWaiting };
}
