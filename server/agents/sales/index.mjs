/**
 * The Sales Executive (supabase/migrations/20261108180000_sales_executive.sql): answers CareBase and Intel prospects the Support
 * Concierge hands over (`sales.reply`) and sends the owner a weekly pipeline review (`sales.review`). Its handlers register only when
 * the database declares `platform.agents.sales-executive.v1`; the review also needs the customer-growth records.
 *
 * Prospect text goes to the model only when the owner's switch for customer text (Settings → AI team) is on and a model
 * key is set. Without them every handed-over prospect still gets the fixed sales acknowledgment, exactly as before.
 */
import { salesReplyHandler } from './reply.mjs';
import { salesReviewHandler } from './review.mjs';
import { live } from '../../live.mjs';
import { hasGrowthPriority } from '../../growth/priority.mjs';

export const salesFeature = 'platform.agents.sales-executive.v1';
export const salesDeclared = features => (features instanceof Set ? features.has(salesFeature) : Array.isArray(features) && features.includes(salesFeature));

/** `{ model }` when prospect text may go to the model, or null. */
export const salesDraftingFor = ({ model = null, customerTextToAi = false } = {}) =>
  (customerTextToAi === true && model?.configured === true && typeof model.run === 'function' ? { model } : null);

const answersFeature = 'platform.agents.concierge-autosend.v1';

/**
 * `salesContext` is the owner's switch "Give the Sales Executive the account brief" (Settings → Customer growth); `growthContext` reads a
 * prospect's account context (context.mjs `salesGrowthContextReader`, or the store's own). Both need the database's reading
 * (platform.agents.growth-priority.v1, 20261117190000_growth_priority.sql).
 */
export function salesHandlers({ store, notifier, model = null, growth = null, features = null, customerTextToAi = false, publicOrigin = null, guides = null, marketed = null,
  salesContext = false, growthContext = null, log }) {
  if (!salesDeclared(features)) return {};
  // The owner's switch (Settings → AI team) is read for each message.
  const drafting = () => { const allowed = salesDraftingFor({ model, customerTextToAi: live(customerTextToAi) }); return allowed ? { ...allowed, guides } : null; };
  const answers = features instanceof Set ? features.has(answersFeature) : Array.isArray(features) && features.includes(answersFeature);
  return {
    'sales.reply': salesReplyHandler({ store, notifier, drafting, answers, marketed, log,
      context: growthContext ?? (typeof store?.salesGrowthContext === 'function' ? store.salesGrowthContext : null),
      contextOn: () => hasGrowthPriority(features) && live(salesContext) === true }),
    ...(growth?.store?.snapshot ? { 'sales.review': salesReviewHandler({ store, growth, notifier, publicOrigin, log }) } : {}),
  };
}
