/**
 * Everything the code decides about the Sales Executive's draft reply. The model is asked for a draft; this module decides whether it
 * may be offered to the owner at all. A draft that fails any check is dropped and the run records only the check's name, never the
 * draft. Passing the checks sends nothing: the owner still reads and approves the exact text.
 *
 * - Terms are rewritten where the meaning is plain (Assisted Living Residence and ALR become Assisted Living Facility and ALF, an
 *   auditor becomes a surveyor); an auditor of another kind rejects the draft.
 * - Product pages get the Sales Executive's campaign tags (../links.mjs: sales-<product>, the route as the medium); guides never do. A
 *   text message whose tags would take it past 320 characters goes out with untagged links instead.
 * - Rejected: an empty or overlong reply; markup; a link that is not one of the product's own pages (tagged or not) or a help-center guide it was given; an
 *   identifier; anything the fact-sheet rules refuse (an unlisted price or number, a guarantee or compliance assurance, a
 *   certification, voice AI, a call or demo as a step, a named competitor, testimonials, "prove" about CareBase, contact details);
 *   a price of the other product; a promise of a refund, a credit, a trial extension, special pricing or a time frame; a mention of
 *   AI or the instructions; a repeat of a name or identifier-like token from the prospect's message; a long quotation of it.
 */
import { echoCandidates, quotesCustomer, wordsOf } from '../concierge/draft.mjs';
import { screenIdentifiers } from '../concierge/screen.mjs';
import { smsLimit, wrapReply } from '../concierge/templates.mjs';
import { factSheetText, factsRevision, helpCenterOrigin } from '../content/facts.mjs';
import { allowedNumbers, normalizeTerms, textProblems } from '../content/validate.mjs';
import { campaignTags, linkAllowed, tagLinks } from '../links.mjs';
import { productAmounts } from '../../growth/draft.mjs';
import { linkablePages, playbookFor, playbookText } from '../../growth/playbook.mjs';

export const emailReplyLimit = 1500;
/** The word limit the model is given for each route. */
export const wordLimits = Object.freeze({ email: 170, chat: 120, sms: 45 });

let sheetCache = { revision: -1 };
/** The numbers and words of the fact sheet and playbook, read again when the facts change (Intel's catalog). */
const sheet = () => {
  if (sheetCache.revision !== factsRevision) {
    sheetCache = { revision: factsRevision, numbers: allowedNumbers([]), vocabulary: new Set(wordsOf(`${factSheetText()}\n${playbookText()}`)) };
  }
  return sheetCache;
};
const markup = /[<>`]|\]\(|\*\*|__|^#{1,6}\s|^\s*[-*•]\s/m;
const linkPattern = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const trailing = /[.,;:!?)\]]+$/;
const promise = /\b(?:refund(?:s|ed)?|credit(?:s|ed)? (?:to|back|your)|extend(?:ed|ing)? (?:your |the )?trial|trial extension|special (?:price|pricing|rate|discount)|custom (?:price|pricing|discount)|price match|(?:extra|additional) discount|within (?:\d+|a|an|one|two|three|four|five|the next) (?:minutes?|hours?|days?|business|weeks?)|by (?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|end of (?:the )?(?:day|week))|we will (?:fix|resolve|refund|credit|waive))\b/i;
const aiMention = /\b(?:as an ai|language model|artificial intelligence|ai assistant|automated (?:reply|response|assistant)|chatbot|i am an? (?:ai|assistant|bot|model))\b|\bsystem prompt\b|\b(?:my|these|the) instructions\b/i;

/** The links a reply about `product` may contain: the product's own pages. No booking page: CareMetric sells without meetings. */
export function replyLinks(product) {
  return linkablePages(product).map(page => ({ label: page.label, url: page.url }));
}

/** Published, public help-center guides as links (`{ label, url }`), only on the help center's own article addresses. */
export function guideLinks(guides = []) {
  const prefix = `${helpCenterOrigin}/help/articles/`;
  return (Array.isArray(guides) ? guides : []).filter(guide => typeof guide?.url === 'string' && guide.url.startsWith(prefix) && /^[a-z0-9.-]+$/.test(guide.url.slice(prefix.length)))
    .slice(0, 3).map(guide => ({ label: String(guide.title ?? 'Guide').slice(0, 150), url: guide.url }));
}

/**
 * @param {object} input
 * @param {string} input.reply the model's draft
 * @param {'carebase'|'caremetric-intel'} input.product
 * @param {'sms'|'email'|'chat'} input.route
 * @param {{ url: string }[]} input.guides the help-center guides the model was offered
 * @param {string} input.text the scrubbed prospect text the model was shown (with any history)
 * @returns {{ ok: true, reply: string, body: string } | { ok: false, reason: string }}
 */
export function checkSalesReply({ reply, product, route, guides = [], text = '' }) {
  const book = playbookFor(product);
  if (!book) return { ok: false, reason: 'product' };
  const terms = normalizeTerms(String(reply ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  if (terms.ambiguous) return { ok: false, reason: 'vocabulary' };
  const normalized = terms.text;
  if (!normalized) return { ok: false, reason: 'empty' };
  const body = wrapReply(normalized, route);
  if (route === 'sms' ? body.length > smsLimit : normalized.length > emailReplyLimit) return { ok: false, reason: 'too_long' };
  if (markup.test(normalized)) return { ok: false, reason: 'markup' };
  const allowed = new Set([...replyLinks(product), ...guides].map(link => link.url));
  const links = (normalized.match(linkPattern) ?? []).map(url => url.replace(trailing, ''));
  if (links.some(url => !linkAllowed(url, allowed))) return { ok: false, reason: 'link' };
  const words = normalized.replace(linkPattern, ' ');
  if (screenIdentifiers(words).flagged) return { ok: false, reason: 'identifier' };
  const problems = textProblems(words, { product: book.factsKey, numbers: sheet().numbers });
  if (problems.length) return { ok: false, reason: problems[0] };
  const own = productAmounts(book.factsKey);
  if ((words.match(/\$\s?(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?/g) ?? []).some(amount => !own.has(Number(amount.replace(/[$,\s]/g, ''))))) return { ok: false, reason: 'other_product_price' };
  if (promise.test(words)) return { ok: false, reason: 'promise' };
  if (aiMention.test(words)) return { ok: false, reason: 'ai_mention' };
  const lowered = words.toLowerCase();
  if (echoCandidates(text, sheet().vocabulary).some(word => new RegExp(String.raw`\b${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`).test(lowered))) return { ok: false, reason: 'name_echo' };
  if (quotesCustomer(words, text)) return { ok: false, reason: 'quotes_customer' };
  // The lengths above were judged on the words as written; tags make a link longer, which only a text message has to fit.
  const tagged = tagLinks(normalized, campaignTags.sales({ product, route }));
  const taggedBody = wrapReply(tagged, route);
  if (route === 'sms' && taggedBody.length > smsLimit) {
    const plain = tagLinks(normalized, null);
    return { ok: true, reply: plain, body: wrapReply(plain, route) };
  }
  return { ok: true, reply: tagged, body: taggedBody };
}
