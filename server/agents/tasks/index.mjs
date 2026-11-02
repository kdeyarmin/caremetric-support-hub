import { probeTargets } from '../targets.mjs';
import { conciergeHandlers } from '../concierge/index.mjs';
import { briefHandlers } from './brief.mjs';
import { importHandlers } from './import.mjs';
import { probeHandlers } from './probe.mjs';
import { seoHandlers } from './seo.mjs';

/**
 * The handlers every Hub server ships with. They are always registered; nothing runs unless
 * HUB_AGENTS_ENABLED is true and the owner has resumed the agent that owns the work.
 * `services` says which owner channels exist (the brief mentions a missing one), and
 * `communications` is the inbox service the import handlers copy other applications' messages into, and
 * `features` is the set of features the database declares (the Concierge registers only when its own is there).
 */
export function builtInHandlers({ store, notifier }, { publicOrigin, fetchImpl = fetch, log, services = {}, communications = null, features = null } = {}) {
  const targets = probeTargets({ publicOrigin });
  return {
    ...probeHandlers({ store, notifier, targets, fetchImpl, log }),
    ...briefHandlers({ store, notifier, publicOrigin, services, labels: Object.fromEntries(targets.map(target => [target.key, target.label])), log }),
    ...seoHandlers({ store, notifier, publicOrigin, fetchImpl, log }),
    ...importHandlers({ communications }),
    ...conciergeHandlers({ store, notifier, features, log }),
  };
}
