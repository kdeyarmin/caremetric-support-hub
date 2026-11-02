import { probeTargets } from '../targets.mjs';
import { probeHandlers } from './probe.mjs';

/**
 * The handlers every Hub server ships with. They are always registered; nothing runs unless
 * HUB_AGENTS_ENABLED is true and the owner has resumed the agent that owns the work.
 */
export function builtInHandlers({ store, notifier }, { publicOrigin, fetchImpl = fetch, log } = {}) {
  return {
    ...probeHandlers({ store, notifier, targets: probeTargets({ publicOrigin }), fetchImpl, log }),
  };
}
