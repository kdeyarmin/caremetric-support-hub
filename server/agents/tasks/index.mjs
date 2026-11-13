import { formTargets, probeTargets } from '../targets.mjs';
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
 */
export function builtInHandlers({ store, notifier, model = null }, {
  publicOrigin, fetchImpl = fetch, log, services = {}, communications = null, features = null, guides = null, customerTextToAi = false, leadSecrets = {}, lifecycle = {},
  marketed = null, searchConsoleSites = undefined, inboundFollowup = false, toolkit = null, watchdogIdleDays = 3,
} = {}) {
  const targets = probeTargets({ publicOrigin });
  return {
    ...probeHandlers({ store, notifier, targets, alertTargets: formTargets, fetchImpl, log }),
    ...briefHandlers({ store, notifier, publicOrigin, services, features, toolkit, watchdogIdleDays, labels: Object.fromEntries([...targets, ...formTargets].map(target => [target.key, target.label])), log }),
    ...seoHandlers({ store, notifier, model, publicOrigin, fetchImpl, searchConsoleSites, log }),
    ...accountsHandlers({ store, notifier, publicOrigin, features, log }),
    ...lifecycleHandlers({ store, features, lifecycle, log }),
    ...offerHandlers({ store, features, log }),
    ...growthHandlers({ store, notifier, publicOrigin, features, leadSecrets, fetchImpl, log, inboundFollowup }),
    ...importHandlers({ communications }),
    ...conciergeHandlers({ store, notifier, features, log, model, guides, customerTextToAi }),
    ...contentHandlers({ store, notifier, model, features, marketed, log }),
    ...autonomyHandlers({ store, notifier, publicOrigin, features, log }),
  };
}
