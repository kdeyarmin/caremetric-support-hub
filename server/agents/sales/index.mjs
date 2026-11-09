/**
 * The Sales Executive (supabase/migrations/20261108180000_sales_executive.sql): answers CareBase and Intel prospects the Support
 * Concierge hands over (`sales.reply`) and sends the owner a weekly pipeline review (`sales.review`). Its handlers register only when
 * the database declares `platform.agents.sales-executive.v1`; the review also needs the customer-growth records.
 *
 * Prospect text goes to the model only when the owner's switch for customer text (HUB_AGENTS_CUSTOMER_TEXT_TO_AI) is on and a model
 * key is set. Without them every handed-over prospect still gets the fixed sales acknowledgment, exactly as before.
 */
import { salesReplyHandler } from './reply.mjs';
import { salesReviewHandler } from './review.mjs';

export const salesFeature = 'platform.agents.sales-executive.v1';
export const salesDeclared = features => (features instanceof Set ? features.has(salesFeature) : Array.isArray(features) && features.includes(salesFeature));

/** `{ model }` when prospect text may go to the model, or null. */
export const salesDraftingFor = ({ model = null, customerTextToAi = false } = {}) =>
  (customerTextToAi === true && model?.configured === true && typeof model.run === 'function' ? { model } : null);

const answersFeature = 'platform.agents.concierge-autosend.v1';

export function salesHandlers({ store, notifier, model = null, growth = null, features = null, customerTextToAi = false, publicOrigin = null, guides = null, marketed = null, log }) {
  if (!salesDeclared(features)) return {};
  const drafting = salesDraftingFor({ model, customerTextToAi });
  const answers = features instanceof Set ? features.has(answersFeature) : Array.isArray(features) && features.includes(answersFeature);
  return {
    'sales.reply': salesReplyHandler({ store, notifier, drafting: drafting ? { ...drafting, guides } : null, answers, marketed, log }),
    ...(growth?.store?.snapshot ? { 'sales.review': salesReviewHandler({ store, growth, notifier, publicOrigin, log }) } : {}),
  };
}
