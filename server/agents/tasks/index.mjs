import { probeTargets } from '../targets.mjs';
import { conciergeHandlers } from '../concierge/index.mjs';
import { accountsHandlers } from './accounts.mjs';
import { briefHandlers } from './brief.mjs';
import { contentHandlers } from './content.mjs';
import { importHandlers } from './import.mjs';
import { lifecycleHandlers } from './lifecycle.mjs';
import { probeHandlers } from './probe.mjs';
import { seoHandlers } from './seo.mjs';

/**
 * The handlers every Hub server ships with. They are always registered; nothing runs unless
 * HUB_AGENTS_ENABLED is true and the owner has resumed the agent that owns the work.
 * `services` says which owner channels exist (the brief mentions a missing one), and
 * `communications` is the inbox service the import handlers copy other applications' messages into, and
 * `features` is the set of features the database declares (the Concierge registers only when its own is there), and
 * `model`, `guides` and `customerTextToAi` decide whether the Concierge may send a plain question's scrubbed text to the model, and
 * `lifecycle` is how the Account Manager's customer emails are sent ({ mail, postalAddress, bookingUrl, publicOrigin }), and
 * the Content Marketer's handlers register only when the database declares its feature and `model` has a key.
 */
export function builtInHandlers({ store, notifier, model = null }, { publicOrigin, fetchImpl = fetch, log, services = {}, communications = null, features = null, guides = null, customerTextToAi = false, lifecycle = {} } = {}) {
  const targets = probeTargets({ publicOrigin });
  return {
    ...probeHandlers({ store, notifier, targets, fetchImpl, log }),
    ...briefHandlers({ store, notifier, publicOrigin, services, labels: Object.fromEntries(targets.map(target => [target.key, target.label])), log }),
    ...seoHandlers({ store, notifier, model, publicOrigin, fetchImpl, log }),
    ...accountsHandlers({ store, notifier, publicOrigin, features, log }),
    ...lifecycleHandlers({ store, features, lifecycle, log }),
    ...importHandlers({ communications }),
    ...conciergeHandlers({ store, notifier, features, log, model, guides, customerTextToAi }),
    ...contentHandlers({ store, notifier, model, features, log }),
  };
}
