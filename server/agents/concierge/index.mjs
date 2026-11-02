/**
 * The Support Concierge's handlers. They need the three server-only database operations that the
 * `platform.agents.concierge.v1` migration adds, so they register only when the database declares
 * that feature (the Hub reads its release metadata at boot). Without it the sweep schedule simply
 * stays due and nothing fails every five minutes.
 */
import { sweepHandler } from './sweep.mjs';
import { triageHandler } from './triage.mjs';

export const conciergeFeature = 'platform.agents.concierge.v1';

const declared = features => (features instanceof Set ? features.has(conciergeFeature) : Array.isArray(features) && features.includes(conciergeFeature));

export function conciergeHandlers({ store, notifier, features = null, log }) {
  if (!declared(features)) return {};
  return {
    'concierge.sweep': sweepHandler({ store }),
    'concierge.communication': triageHandler({ store, notifier, log }),
  };
}
