/**
 * The Support Concierge's handlers and its one action. They need the three server-only database
 * operations that the `platform.agents.concierge.v1` migration adds, so they register only when the
 * database declares that feature (the Hub reads its release metadata at boot). Without it the sweep
 * schedule simply stays due and nothing fails every five minutes. Sending an approved reply also
 * needs the inbox service.
 */
import { answerExecutor } from './answers.mjs';
import { replyExecutor } from './executor.mjs';
import { sweepHandler } from './sweep.mjs';
import { triageHandler } from './triage.mjs';
import { salesDeclared } from '../sales/index.mjs';

export const conciergeFeature = 'platform.agents.concierge.v1';
/** Support answers the Concierge may send without the owner's session (supabase/migrations/20261105120000_concierge_answers.sql). */
export const answersFeature = 'platform.agents.concierge-autosend.v1';

const has = (features, feature) => (features instanceof Set ? features.has(feature) : Array.isArray(features) && features.includes(feature));
const declared = features => has(features, conciergeFeature);

/**
 * `customerTextToAi` is the owner's explicit switch (HUB_AGENTS_CUSTOMER_TEXT_TO_AI, exactly "true"). Customer text can go to the
 * model only when it is on, a model key is set and the guide library is there; otherwise triage is rules-only, as before.
 */
export const draftingFor = ({ model = null, guides = null, customerTextToAi = false } = {}) =>
  (customerTextToAi === true && model?.configured === true && typeof model.run === 'function' && typeof guides?.top === 'function' ? { model, guides } : null);

export function conciergeHandlers({ store, notifier, features = null, log, model = null, guides = null, customerTextToAi = false }) {
  if (!declared(features)) return {};
  const drafting=draftingFor({model,guides,customerTextToAi});
  const followups=features?.has?.('platform.agents.customer-growth.v1')===true || (Array.isArray(features)&&features.includes('platform.agents.customer-growth.v1'));
  return {
    'concierge.sweep': sweepHandler({ store }),
    // A prospect's message goes to the Sales Executive once the database declares it and the owner has resumed it (sales_handoff decides).
    'concierge.communication': triageHandler({ store, notifier, log, drafting: drafting?{...drafting,followups}:null, answers: has(features, answersFeature),
      sales: salesDeclared(features) && typeof store.salesHandoff === 'function' }),
  };
}

/** The Concierge's actions: sending an approved reply (with the owner's session) and sending an answer (without). Both need the inbox service as well as the database feature. */
export function conciergeExecutors({ communications = null, store, notifier, features = null, log }) {
  if (!declared(features) || typeof communications?.reply !== 'function') return {};
  return {
    'communication.reply': replyExecutor({ communications, store, notifier, log }),
    // Answers go out without the owner's session, so they need the database's answer operation and the inbox's server path.
    ...(has(features, answersFeature) && typeof communications.answer === 'function' ? { 'communication.answer': answerExecutor({ communications, notifier, log }) } : {}),
  };
}
