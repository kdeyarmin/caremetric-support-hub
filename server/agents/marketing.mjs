/**
 * Which products the AI team markets to new customers. On 2026-11-08 the owner decided CareBase stays in a pilot with a few
 * facilities they choose, and the team markets CareMetric Intel only. So by default:
 *
 * - the Marketing Manager discovers, researches and emails prospects for Intel only;
 * - the Social Media Manager writes posts, replies and ads for Intel only (an existing ad for another product may still be paused, but
 *   gets no new copy and no budget increase);
 * - the Content Marketer writes help-center articles and outreach drafts for Intel only;
 * - the Sales Executive drafts no answer to a prospect asking about a product that is not marketed: the conversation is left to the
 *   owner, who decides who joins the pilot.
 *
 * Customers are not affected: onboarding, trial, renewal and support work for CareBase customers (the pilot facilities) goes on.
 *
 * `HUB_MARKETED_PRODUCTS` changes the list: product keys separated by commas (`caremetric-intel`, `carebase`, `advisors`), or `none`.
 * Unset or empty means the default below. Unknown keys are ignored, so a misspelt value markets less, never more.
 */
export const marketableProducts = Object.freeze(['caremetric-intel', 'carebase', 'advisors']);
export const defaultMarketed = Object.freeze(['caremetric-intel']);
const aliases = { intel: 'caremetric-intel' };

/** The canonical key for a product: the Content Marketer calls Intel "intel". */
export const productKey = product => aliases[product] ?? product;

export function marketedProducts(env = {}) {
  const raw = String(env?.HUB_MARKETED_PRODUCTS ?? '').trim().toLowerCase();
  if (!raw) return [...defaultMarketed];
  if (raw === 'none') return [];
  return [...new Set(raw.split(',').map(value => productKey(value.trim())).filter(value => marketableProducts.includes(value)))];
}

/**
 * Whether the team may market `product`. A `marketed` of null (unit tests, and callers built without a policy) markets every
 * product; the Hub always passes the list from `marketedProducts(process.env)`.
 */
export const markets = (marketed, product) => marketed == null || (Array.isArray(marketed) && marketed.includes(productKey(product)));
