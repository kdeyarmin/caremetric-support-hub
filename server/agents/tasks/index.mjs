import { probeTargets } from '../targets.mjs';
import { briefHandlers } from './brief.mjs';
import { probeHandlers } from './probe.mjs';
import { seoHandlers } from './seo.mjs';

/**
 * The handlers every Hub server ships with. They are always registered; nothing runs unless
 * HUB_AGENTS_ENABLED is true and the owner has resumed the agent that owns the work.
 * `services` says which owner channels exist (the brief mentions a missing one).
 */
export function builtInHandlers({ store, notifier }, { publicOrigin, fetchImpl = fetch, log, services = {} } = {}) {
  const targets = probeTargets({ publicOrigin });
  return {
    ...probeHandlers({ store, notifier, targets, fetchImpl, log }),
    ...briefHandlers({ store, notifier, publicOrigin, services, labels: Object.fromEntries(targets.map(target => [target.key, target.label])), log }),
    ...seoHandlers({ store, notifier, publicOrigin, fetchImpl, log }),
  };
}
