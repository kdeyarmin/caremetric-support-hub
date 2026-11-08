/**
 * Which products the AI team markets to new customers. The owner switches each product on or off on the AI team page ("Products we
 * market"); the switches live in the database (supabase/migrations/20261108210000_marketing_switches.sql) and every marketing task
 * reads them when it starts, so a change applies to the next run without a restart. On 2026-11-08 the owner decided CareBase stays in
 * a pilot with a few facilities they choose, so only CareMetric Intel starts switched on. For a product switched off:
 *
 * - the Marketing Manager discovers, researches and emails no prospects;
 * - the Social Media Manager writes no posts, reply links or ads, and raises no budget (an existing ad may still be paused);
 * - the Content Marketer writes no help-center articles or outreach drafts;
 * - the Sales Executive drafts no answer to a prospect asking about it: the conversation is left to the owner, who decides (for
 *   CareBase, who joins the pilot).
 *
 * Customers are not affected: onboarding, trial, renewal and support work for CareBase customers (the pilot facilities) goes on.
 * Until the database declares `platform.agents.marketing.v1`, the Hub markets the default below.
 */
export const marketingFeature = 'platform.agents.marketing.v1';
export const marketableProducts = Object.freeze(['caremetric-intel', 'carebase', 'advisors']);
export const defaultMarketed = Object.freeze(['caremetric-intel']);
const aliases = { intel: 'caremetric-intel' };

/** The canonical key for a product: the Content Marketer calls Intel "intel". */
export const productKey = product => aliases[product] ?? product;

/**
 * The products marketed for this run. `marketed` is a list, a function that reads the owner's switches (the Hub's), or null (unit
 * tests and callers built without a policy: every product). A switch list that cannot be understood markets nothing; a read that fails
 * throws, so the task is retried rather than marketing a product the owner switched off.
 */
export async function marketedNow(marketed) {
  if (typeof marketed !== 'function') return marketed ?? null;
  const list = await marketed();
  return Array.isArray(list) ? [...new Set(list.map(productKey))].filter(product => marketableProducts.includes(product)) : [];
}

/** Whether the team may market `product`, given the list for this run (null markets every product). */
export const markets = (marketed, product) => marketed == null || (Array.isArray(marketed) && marketed.includes(productKey(product)));
