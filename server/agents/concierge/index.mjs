/**
 * The Support Concierge's handlers and its one action. They need the three server-only database
 * operations that the `platform.agents.concierge.v1` migration adds, so they register only when the
 * database declares that feature (the Hub reads its release metadata at boot). Without it the sweep
 * schedule simply stays due and nothing fails every five minutes. Sending an approved reply also
 * needs the inbox service.
 */
import { replyExecutor } from './executor.mjs';
import { sweepHandler } from './sweep.mjs';
import { triageHandler } from './triage.mjs';

export const conciergeFeature = 'platform.agents.concierge.v1';

const declared = features => (features instanceof Set ? features.has(conciergeFeature) : Array.isArray(features) && features.includes(conciergeFeature));

/**
 * `customerTextToAi` is the owner's explicit switch (HUB_AGENTS_CUSTOMER_TEXT_TO_AI, exactly "true"). Customer text can go to the
 * model only when it is on, a model key is set and the guide library is there; otherwise triage is rules-only, as before.
 */
export const draftingFor = ({ model = null, guides = null, customerTextToAi = false } = {}) =>
  (customerTextToAi === true && model?.configured === true && typeof model.run === 'function' && typeof guides?.top === 'function' ? { model, guides } : null);

export function conciergeHandlers({ store, notifier, features = null, log, model = null, guides = null, customerTextToAi = false, bookingUrl = null }) {
  if (!declared(features)) return {};
  return {
    'concierge.sweep': sweepHandler({ store }),
    'concierge.communication': triageHandler({ store, notifier, log, drafting: draftingFor({ model, guides, customerTextToAi }), bookingUrl }),
  };
}

/** The Concierge's one action: sending an approved reply. Needs the inbox service as well as the database feature. */
export function conciergeExecutors({ communications = null, store, notifier, features = null, log }) {
  if (!declared(features) || typeof communications?.reply !== 'function') return {};
  return { 'communication.reply': replyExecutor({ communications, store, notifier, log }) };
}
