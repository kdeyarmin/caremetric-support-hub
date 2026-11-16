import { growthHandlers, growthExecutors } from '../growth/worker.mjs';
import { peopleHandlers } from '../growth/people.mjs';
import { matchHandlers } from '../growth/agency-match.mjs';
import { researchHandlers } from '../growth/deep-research.mjs';
import { verifyHandlers } from '../growth/verify.mjs';
import { briefHandlers } from '../growth/brief.mjs';
import { viewsHandlers } from '../growth/views.mjs';
import { learningHandlers } from '../growth/learning.mjs';
import { adsTeam } from './ads/index.mjs';
import { handoverFeature } from './handover.mjs';
import { defaultMarketed, marketingFeature } from './marketing.mjs';
import { sqlAgentStore } from './store.mjs';
import { agentScheduler } from './scheduler.mjs';
import { actionExecutor, recordOnlyExecutors } from './actions.mjs';
import { ownerNotifier } from './notify.mjs';
import { agentAdmin } from './admin.mjs';
import { builtInHandlers } from './tasks/index.mjs';
import { senderServices } from './tasks/brief.mjs';
import { conciergeExecutors, draftingFor } from './concierge/index.mjs';
import { lifecycleExecutors } from './accounts/executor.mjs';
import { externalEmailAvailable, externalEmailExecutors, externalEmailRecovery } from './external-email.mjs';
import { offerExecutors } from './accounts/offers.mjs';
import { contentExecutors } from './content/executor.mjs';
import { modelRuntime } from './runtime/index.mjs';
import { salesHandlers } from './sales/index.mjs';
import { socialDeclared, socialTeam } from './social/index.mjs';
import { creativeDeclared, creativeTeam } from './creative/index.mjs';
import { creativeExecutors } from './creative/executor.mjs';
import { scorecardDeclared, scorecardHandlers } from './scorecard/index.mjs';
import { live } from '../live.mjs';
import { marketingToolkit } from './toolkit.mjs';

const emailAddress = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * Assembles the AI team inside the Hub server. `handlers` and `executors` may be objects or
 * functions of the shared services ({ store, notifier, actions }) that return them, so each
 * agent's code can raise owner alerts and propose actions without a circular wiring.
 * The handlers every server ships with (see tasks/) are always registered; `handlers` adds to
 * or replaces them. Nothing runs unless `enabled` is exactly true (Settings → AI team → "Run the AI team"); every
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
 * `creative` is the Creative Director's configuration, or a function returning it (creativeConfig in creative/index.mjs: Settings → Creative
 * and the HeyGen key). Its work registers when the database declares platform.agents.creative.v1 and runs while "Turn on the Creative
 * Director" is on; its two executors (handing an approved asset over, retiring one) whenever the database declares it, so an approval the
 * owner gives is always carried out. The Social Media Manager uses approved creative whenever the database has it.
 */
export function agentTeam({
  pool, growth: givenGrowth = null, growthMail = null, postalAddress = '', store: givenStore = null, handlers = {}, executors = {}, sms, email, ownerEmail, publicOrigin,
  fetchImpl = fetch, enabled = false, log = line => console.warn(line), now = () => new Date(), communications = null, features = null,
  anthropicApiKey = null, record = null, model = null, guides = null, customerTextToAi = false, leadSecrets = {}, lifecycle = null, offerBilling = null,
  social = null, meta = null, marketed = null, searchConsoleSites = undefined, searchConsoleCredentials = '', creative = null, visitorMetrics = null,
  inboundFollowup = false, concurrentTasks = 3, ads = null, watchdogIdleDays = 3,
}) {
  // Fenced operations (the attempt a task was claimed under, the execution an action started) exist once the database declares the hardening feature.
  const marketing = features?.has?.(marketingFeature) === true;
  const creativeOn = creativeDeclared(features);
  const store = givenStore ?? sqlAgentStore(pool, { fenced: features?.has?.('platform.agents.hardening.v1') === true, growth: features?.has?.('platform.agents.customer-growth.v1') === true,
    social: socialDeclared(features), socialVideo: features?.has?.('platform.agents.social-video.v1') === true,
    marketing, scorecard: scorecardDeclared(features), creative: creativeOn, creativeData: features?.has?.('platform.agents.creative-data.v1') === true,
    creativeReview: features?.has?.('platform.agents.creative-review.v1') === true,
    ads: features?.has?.('platform.agents.ads.v1') === true, watchdog: features?.has?.('platform.agents.watchdog.v1') === true,
    handover: features?.has?.(handoverFeature) === true });
  // What the team markets: the owner's switches on the AI team page, read when each marketing task starts (marketing.mjs). Until the
  // database declares them, CareMetric Intel only. A caller (a test) may pass its own list or reader.
  const marketedSource = marketed ?? (marketing && typeof store.marketedProducts === 'function' ? () => store.marketedProducts() : [...defaultMarketed]);
  const notifier = ownerNotifier({ store, sms, email, ownerEmail, publicOrigin, log });
  const runtime = model ?? modelRuntime({ apiKey: anthropicApiKey, store, record, notifier, log, now });
  const growth = features?.has?.('platform.agents.customer-growth.v1') ? givenGrowth : null;
  const shared = { store, notifier, model: runtime };
  // The Social Media Manager (platform.agents.social.v1): its Meta client is built once, from `social` (socialConfig in social/index.mjs).
  const socialWork = socialTeam({ social, features, fetchImpl, meta });
  // The Creative Director (platform.agents.creative.v1; its work runs while Settings → Creative → "Turn on the Creative Director" is on):
  // it reads the Social Media Manager's ad clients for results.
  const creativeWork = creativeTeam({ creative, features, fetchImpl, record });
  // Paid ads (platform.agents.ads.v1): new campaigns (paused for the owner's approval, or launched live with approved creative once the owner
  // hands ad campaign launch over), and leads from ad clicks reported back.
  const adsWork = adsTeam({ ads, features, fetchImpl });
  // What each marketing tool still needs, read when the morning brief explains a quiet agent (watchdog.mjs).
  const toolkitNow = () => marketingToolkit({ features, growth, growthMail, model: runtime, customerTextToAi, communications, email, leadSecrets,
    lifecycle: customerEmail, social, socialWork, creativeWork, adsWork, searchConsoleCredentials, searchConsoleSites, visitorMetrics, marketed: Array.isArray(marketed) ? marketed : defaultMarketed });
  // Approved creative for the Social Media Manager, and the hook that tells the Creative Director a weekly social plan was written.
  const creativeLink = creativeOn && typeof store.creativeApproved === 'function' ? {
    approved: query => store.creativeApproved(query),
    live: (assetId, ref) => store.creativeMarkLive(assetId, ref),
    planned: week => (creativeWork.enabled() ? store.enqueue('creative_director', 'creative.plan', `creative:plan:social:${week}`, { payload: { week }, priority: 5, sourceKind: 'agent', sourceRef: 'social.plan' }) : null),
  } : null;
  // Kept as getters, not copied: the postal address is a Hub setting the Account Manager reads on each run.
  const customerEmail = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(lifecycle ?? {}), publicOrigin: { value: publicOrigin, enumerable: true } });
  const actions = actionExecutor({ store, executors: {
    ...recordOnlyExecutors, ...growthExecutors({growth,mail:growthMail,publicOrigin,postalAddress,features}), ...conciergeExecutors({ communications, store, notifier, features, log }), ...lifecycleExecutors({ store, features, lifecycle: customerEmail, log }),
    ...offerExecutors({ store, features, billing: offerBilling, notifier, log }),
    ...contentExecutors({ store, features, log }), ...externalEmailExecutors({ store, features, email, log }), ...socialWork.executors({ notifier, log, creative: creativeLink, store, publicOrigin }),
    ...adsWork.executors({ meta: socialWork.meta, linkedin: socialWork.linkedin, social: socialWork.ads?.settings ?? {}, notifier, store, creative: creativeLink, publicOrigin, log }),
    ...(creativeOn && typeof store.creativeHandoff === 'function' ? creativeExecutors({ store }) : {}),
    ...(typeof executors === 'function' ? executors(shared) : executors),
  }, log });
  // The handlers every server ships with, then any the caller adds (a caller's handler for the same kind wins).
  const registry = { ...growthHandlers({growth,model:runtime,notifier,features,marketed:marketedSource}), ...peopleHandlers({growth,features,marketed:marketedSource}), ...matchHandlers({growth,features,marketed:marketedSource}), ...researchHandlers({growth,model:runtime,features,marketed:marketedSource}), ...verifyHandlers({growth,features,notifier}), ...briefHandlers({growth,model:runtime,features,marketed:marketedSource}), ...viewsHandlers({growth,features,notifier}), ...learningHandlers({growth,features,marketed:marketedSource,enabled:growth?.learning?.enabled??false}),
    ...salesHandlers({ store, notifier, model: runtime, growth, features, customerTextToAi, publicOrigin, guides, marketed: marketedSource, log }),
    ...socialWork.handlers({ store, notifier, model: runtime, customerTextToAi, publicOrigin, marketed: marketedSource, log, creative: creativeLink, feed: growth?.roster?.feed ?? null }),
    ...creativeWork.handlers({ store, notifier, model: runtime, meta: socialWork.meta, linkedin: socialWork.linkedin, publicOrigin, marketed: marketedSource, log, feed: growth?.roster?.feed ?? null,
      states: growth?.roster?.states ?? null }),
    ...adsWork.handlers({ store, notifier, model: runtime, meta: socialWork.meta, linkedin: socialWork.linkedin, social: socialWork.ads?.settings ?? {}, marketed: marketedSource, creative: creativeLink, publicOrigin, log }),
    ...scorecardHandlers({ store, notifier, publicOrigin, features, growth, ads: socialWork.ads, fetchImpl, searchConsoleSites, visitors: visitorMetrics ? input => visitorMetrics.read(input) : null, log }), ...builtInHandlers(shared, { publicOrigin, fetchImpl, log, communications, features, guides, customerTextToAi, leadSecrets, lifecycle: customerEmail, marketed: marketedSource, searchConsoleSites, inboundFollowup, toolkit: toolkitNow, watchdogIdleDays, services: senderServices(sms, email) }), ...(typeof handlers === 'function' ? handlers({ ...shared, actions }) : handlers) };
  // Settings → AI team → Tasks at once: how many tasks may run side by side.
  const scheduler = agentScheduler({ store, handlers: registry, actions, enabled, log, now, claimLimit: concurrentTasks });
  const admin = agentAdmin({
    pool, actions, kick: () => scheduler.tick(), waiting: scheduler.runWaiting,
    externalEmailReady: externalEmailRecovery({ store, features }),
    services: ({ marketing: products } = {}) => ({
      enabled: scheduler.active(), handlers: scheduler.kinds(),
      sms: Boolean(sms?.configured), email: Boolean(email?.configured), ownerEmail: emailAddress.test(live(ownerEmail) ?? ''), ai: Boolean(runtime.configured),
      customerTextToAi: draftingFor({ model: runtime, guides, customerTextToAi: live(customerTextToAi) }) !== null,
      externalEmail: externalEmailAvailable({ features, email }),
      marketingTools: marketingToolkit({ features, growth, growthMail, model: runtime, customerTextToAi, communications, email, leadSecrets,
        lifecycle: customerEmail, social, socialWork, creativeWork, adsWork, searchConsoleCredentials, searchConsoleSites, visitorMetrics,
        marketed: Array.isArray(products) ? products.filter(product => product.marketed).map(product => product.product) : Array.isArray(marketed) ? marketed : defaultMarketed }),
      creative: (() => { const config = creativeWork.config(); const on = creativeOn && creativeWork.enabled(); return { declared: creativeOn, enabled: on, videoProvider: on ? config.videoProvider : null, dailyRenderCap: config.dailyRenderCap }; })(),
    }),
  });
  return { store, notifier, model: runtime, actions, scheduler, admin, tick: scheduler.tick, active: scheduler.active, runWaiting: scheduler.runWaiting, creative: creativeWork };
}
