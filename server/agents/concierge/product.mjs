/**
 * Which product a support message is about when its conversation names none (the Nov 24 follow-up, server/growth/first-replies.mjs;
 * 20261124151000_first_replies_concierge.sql). An email reaches the support address with a product only when it was sent to a
 * "+product" address, which nobody uses: all 23 emails of the 60 days to November 24 arrived without one, so the Concierge told the
 * model "product: unknown" and offered nothing better than the acknowledgment.
 *
 * The product, in order:
 * 1. the conversation's own (`conversation`);
 * 2. the one the sender already uses or asked about, from the database (`senderProduct` on the snapshot: their billing account, their
 *    website leads, their business's roster prospect), only when exactly one (`sender`);
 * 3. the one product the message names, unmistakably: "CareMetric Intel" or Intel (not an Intel chip), CareBase, "CareMetric Breathe"
 *    or the Breathe app, never the everyday verb (`mention`). Naming two is "can't tell".
 * Otherwise none: the model reads every product's guides and names the product its answer is about (prompt.mjs).
 *
 * Only the product's slug and where it came from are kept; nothing the customer wrote.
 */
export const productNames = Object.freeze({
  carebase: 'CareMetric CareBase', 'caremetric-intel': 'CareMetric Intel', breathe: 'CareMetric Breathe', advisors: 'CareMetric Healthcare Advisors',
  'caremetric-emr': 'CareMetric EMR', 'caremetric-go': 'CareMetric Go', pennsync: 'CareMetric PennSync',
});

const slug = /^[a-z0-9-]{2,40}$/;
// "Intel" alone is the product unless a chip, a processor or the company that makes them follows it.
const intelHardware = 'processors?|chips?|cpus?|core|graphics|i[3579]|celeron|pentium|xeon|iris|wi-?fi|drivers?|inside|corp(?:oration)?|arc|evo|nuc';
const mentions = [
  ['caremetric-intel', new RegExp(String.raw`\bCareMetric\s+Intel\b|\bIntel\b(?!\s+(?:${intelHardware})\b)`)],
  ['carebase', /\bcare-?base\b/i],
  // "Breathe" is an everyday word, and in a healthcare message a clinical one: only the product's full name or the app counts.
  ['breathe', /\bCareMetric\s+Breathe\b|\bBreathe\s+(?:app|application|platform|portal|account|software|log-?in|subscription|dashboard)\b/i],
];

/** The one product `text` names, or null when it names none or more than one. */
export function mentionedProduct(text) {
  const value = String(text ?? '');
  const found = mentions.filter(([, pattern]) => pattern.test(value)).map(([product]) => product);
  return found.length === 1 ? found[0] : null;
}

/**
 * The product a message is about and where that came from: `{ slug, source }`, source being conversation, sender or mention, or
 * `{ slug: null, source: null }` when nobody can tell.
 */
export function messageProduct({ productSlug = null, senderProduct = null, subject = null, body = '' } = {}) {
  if (typeof productSlug === 'string' && slug.test(productSlug)) return { slug: productSlug, source: 'conversation' };
  if (typeof senderProduct === 'string' && slug.test(senderProduct)) return { slug: senderProduct, source: 'sender' };
  const named = mentionedProduct(`${subject ?? ''}\n${body ?? ''}`);
  return named ? { slug: named, source: 'mention' } : { slug: null, source: null };
}
