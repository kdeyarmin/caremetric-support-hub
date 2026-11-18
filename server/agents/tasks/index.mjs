import { formTargets, probeTargets } from '../targets.mjs';
import { live } from '../../live.mjs';
import { conciergeHandlers } from '../concierge/index.mjs';
import { accountsHandlers } from './accounts.mjs';
import { autonomyHandlers } from './autonomy.mjs';
import { briefHandlers } from './brief.mjs';
import { growthHandlers } from './growth.mjs';
import { contentHandlers } from './content.mjs';
import { importHandlers } from './import.mjs';
import { lifecycleHandlers } from './lifecycle.mjs';
import { offerHandlers } from './offers.mjs';
import { probeHandlers } from './probe.mjs';
import { seoHandlers } from './seo.mjs';
import { summaryHandlers } from './summary.mjs';

/**
 * The handlers every Hub server ships with. They are always registered; nothing runs unless
 * "Run the AI team" is on in Settings and the owner has resumed the agent that owns the work.
 * `services` says which owner channels exist (the brief mentions a missing one), and
 * `communications` is the inbox service the import handlers copy other applications' messages into, and
 * `features` is the set of features the database declares (the Concierge and the Growth Manager register only when their own is there),
 * `model`, `guides` and `customerTextToAi` decide whether the Concierge may send a plain question's scrubbed text to the model,
 * `leadSecrets` are the products' lead secrets the form checks sign with (never logged or stored).
 * `lifecycle` is how the Account Manager's customer emails are sent ({ mail, postalAddress, publicOrigin }), and
 * the Content Marketer's handlers register only when the database declares its feature and `model` has a key, the hourly
 * autonomy check only when the database declares autonomy steps, and the Account Manager's offers only when it declares offers.
 * `summary` is the owner's end-of-day summary settings ({ enabled, hour }, summary.mjs); its task registers once the database declares it,
 * and while it is on the scheduled morning brief is not sent.
 */
export function builtInHandlers({ store, notifier, model = null }, {
  publicOrigin, fetchImpl = fetch, log, services = {}, communications = null, features = null, guides = null, customerTextToAi = false, autoAcknowledge = false, leadSecrets = {}, lifecycle = {},
  marketed = null, searchConsoleSites = undefined, inboundFollowup = false, toolkit = null, watchdogIdleDays = 3,
  feed = null, rosterStates = null, contentCountyTopics = false, summary = {},
} = {}) {
  const targets = probeTargets({ publicOrigin });
  const labels = Object.fromEntries([...targets, ...formTargets].map(target => [target.key, target.label]));
  const summaries = summaryHandlers({ store, notifier, publicOrigin, services, labels, features, toolkit, watchdogIdleDays, settings: summary, log });
  // The morning brief steps aside only for a summary this server can send.
  const inSummary = () => Boolean(summaries['summary.daily']) && live(summary.enabled) === true;
  return {
    ...probeHandlers({ store, notifier, targets, alertTargets: formTargets, fetchImpl, log }),
    ...briefHandlers({ store, notifier, publicOrigin, services, features, toolkit, watchdogIdleDays, labels, inSummary, log }),
    ...summaries,
    ...seoHandlers({ store, notifier, model, publicOrigin, fetchImpl, searchConsoleSites, log }),
    ...accountsHandlers({ store, notifier, publicOrigin, features, log }),
    ...lifecycleHandlers({ store, features, lifecycle, log }),
    ...offerHandlers({ store, features, log }),
    ...growthHandlers({ store, notifier, publicOrigin, features, leadSecrets, fetchImpl, log, inboundFollowup }),
    ...importHandlers({ communications }),
    ...conciergeHandlers({ store, notifier, features, log, model, guides, customerTextToAi, autoAcknowledge }),
    ...contentHandlers({ store, notifier, model, features, marketed, log, feed, rosterStates, countyTopics: contentCountyTopics, searchConsoleSites, fetchImpl }),
    ...autonomyHandlers({ store, notifier, publicOrigin, features, log }),
  };
}
