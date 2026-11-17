/**
 * Everything the code decides about the Sales Executive's draft reply. The model is asked for a draft; this module decides whether it
 * may be offered to the owner at all. A draft that fails any check is dropped and the run records only the check's name, never the
 * draft. Passing the checks sends nothing: the owner still reads and approves the exact text.
 *
 * - Terms are rewritten where the meaning is plain (Assisted Living Residence and ALR become Assisted Living Facility and ALF, an
 *   auditor becomes a surveyor); an auditor of another kind rejects the draft.
 * - Rejected: an empty or overlong reply; markup; a link that is not one of the product's own pages or a help-center guide it was given; an
 *   identifier; anything the fact-sheet rules refuse (an unlisted price or number, a guarantee or compliance assurance, a
 *   certification, voice AI, a call or demo as a step, a named competitor, testimonials, "prove" about CareBase, contact details);
 *   a price of the other product; an offer of a demo, a call, a meeting or a conversation (`offersMeeting`: CareMetric does no personal
 *   demos with anyone; declining one is fine); a promise of a refund, a credit, a trial extension, special pricing or a time frame; a mention of
 *   AI or the instructions; a repeat of a name or identifier-like token from the prospect's message; a long quotation of it;
 *   the agency's own standing (`ownStanding`: a star rating, a rank, its share or its patient counts; review 2026-11-17, row 2.9); a
 *   sentence that says or implies CareMetric saw the prospect open, view or read something (`mentionsOpen`: the Sales Executive may be
 *   told whether the market report was opened, and must never let it show), unless the prospect said so themselves.
 * - A reply that passes gets campaign tags on its product links (links.mjs: caremetric / the route / sales-<product>); help-center
 *   guides are never tagged. A text message keeps its links untagged when the tags would not fit in one message. A link the model
 *   wrote with tags of its own is read as the page it points to only when the tags are well formed (links.mjs `untaggedUrl`).
 */
import { echoCandidates, quotesCustomer, wordsOf } from '../concierge/draft.mjs';
import { screenIdentifiers } from '../concierge/screen.mjs';
import { smsLimit, wrapReply } from '../concierge/templates.mjs';
import { factSheetText, factsRevision, helpCenterOrigin } from '../content/facts.mjs';
import { catalogNumbers, featuresTexts } from '../content/features.mjs';
import { allowedNumbers, normalizeTerms, textProblems } from '../content/validate.mjs';
import { productAmounts } from '../../growth/draft.mjs';
import { emailStatesStanding } from '../../growth/standing.mjs';
import { mentionsOpen } from '../../growth/opens.mjs';
import { linkablePages, offersMeeting, playbookFor, playbookText } from '../../growth/playbook.mjs';
import { linkTags, tagLinks, untagLinks } from '../links.mjs';

export const emailReplyLimit = 1500;
/** The word limit the model is given for each route. */
export const wordLimits = Object.freeze({ email: 170, chat: 120, sms: 45 });

let sheetCache = { revision: -1 };
/** The numbers and words of the fact sheet, the playbook and the product catalogs, read again when the facts change (Intel's catalog). */
const sheet = () => {
  if (sheetCache.revision !== factsRevision) {
    sheetCache = { revision: factsRevision, numbers: allowedNumbers([]), vocabulary: new Set(wordsOf(`${factSheetText()}\n${playbookText()}\n${featuresTexts().join('\n')}`)) };
  }
  return sheetCache;
};
const markup = /[<>`]|\]\(|\*\*|__|^#{1,6}\s|^\s*[-*•]\s/m;
const linkPattern = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const trailing = /[.,;:!?)\]]+$/;
const promise = /\b(?:refund(?:s|ed)?|credit(?:s|ed)? (?:to|back|your)|extend(?:ed|ing)? (?:your |the )?trial|trial extension|special (?:price|pricing|rate|discount)|custom (?:price|pricing|discount)|price match|(?:extra|additional) discount|within (?:\d+|a|an|one|two|three|four|five|the next) (?:minutes?|hours?|days?|business|weeks?)|by (?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|end of (?:the )?(?:day|week))|we will (?:fix|resolve|refund|credit|waive))\b/i;
/**
 * The prospect's own agency's standing (owner rule: never stated to an agency): what the growth email's check refuses (a star rating, a
 * rank, "the fourth-largest"), and its share or its patient, admission or referral counts stated as a fact about the agency.
 */
const ownShare = /\b(?:your|the agency's|your agency's|your organization's)\s+(?:(?:market|county|referral|patient|admissions?)\s+share|share\s+of\s+(?:the\s+)?(?:market|county|patients|referrals|admissions))\s+(?:is|was|stands|sits|has|grew|fell|dropped|of|at|around|about|near)\b/i;
const ownCount = /\b(?:you|your agency|your team|your organization)\s+(?:have|has|had|served|serve|admitted|admit|treated|treat|cared for|took in|received)\s+(?:about\s+|around\s+|roughly\s+|over\s+|nearly\s+|more than\s+|fewer than\s+|almost\s+)?\d[\d,]*\s+(?:medicare\s+)?(?:patients|admissions|referrals|beneficiaries|episodes)\b/i;
export const ownStanding = words => emailStatesStanding(words) || ownShare.test(words) || ownCount.test(words);

export { mentionsOpen } from '../../growth/opens.mjs';

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
 * @param {string} [input.prospect] the prospect's own words only (their messages, never CareMetric's): whether they said they opened it
 * @returns {{ ok: true, reply: string, body: string } | { ok: false, reason: string }}
 */
export function checkSalesReply({ reply, product, route, guides = [], text = '', prospect = '' }) {
  const book = playbookFor(product);
  if (!book) return { ok: false, reason: 'product' };
  const terms = normalizeTerms(untagLinks(String(reply ?? '')).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  if (terms.ambiguous) return { ok: false, reason: 'vocabulary' };
  const normalized = terms.text;
  if (!normalized) return { ok: false, reason: 'empty' };
  const body = wrapReply(normalized, route);
  if (route === 'sms' ? body.length > smsLimit : normalized.length > emailReplyLimit) return { ok: false, reason: 'too_long' };
  if (markup.test(normalized)) return { ok: false, reason: 'markup' };
  const allowed = new Set([...replyLinks(product), ...guides].map(link => link.url));
  const links = (normalized.match(linkPattern) ?? []).map(url => url.replace(trailing, ''));
  if (links.some(url => !allowed.has(url))) return { ok: false, reason: 'link' };
  const words = normalized.replace(linkPattern, ' ');
  if (screenIdentifiers(words).flagged) return { ok: false, reason: 'identifier' };
  const problems = textProblems(words, { product: book.factsKey, numbers: book.factsKey ? catalogNumbers(book.factsKey) : sheet().numbers });
  if (problems.length) return { ok: false, reason: problems[0] };
  const own = productAmounts(book.factsKey);
  if ((words.match(/\$\s?(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?/g) ?? []).some(amount => !own.has(Number(amount.replace(/[$,\s]/g, ''))))) return { ok: false, reason: 'other_product_price' };
  if (offersMeeting(words)) return { ok: false, reason: 'meeting_offer' };
  if (promise.test(words)) return { ok: false, reason: 'promise' };
  if (aiMention.test(words)) return { ok: false, reason: 'ai_mention' };
  if (ownStanding(words)) return { ok: false, reason: 'own_standing' };
  if (mentionsOpen(words, prospect)) return { ok: false, reason: 'mentions_open' };
  const lowered = words.toLowerCase();
  if (echoCandidates(text, sheet().vocabulary).some(word => new RegExp(String.raw`\b${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`).test(lowered))) return { ok: false, reason: 'name_echo' };
  if (quotesCustomer(words, text)) return { ok: false, reason: 'quotes_customer' };
  // Tagged after every check, on the page addresses the check accepted. A text message keeps them untagged if one message cannot hold them.
  const tagged = tagLinks(normalized, linkTags.sales(product, route));
  const taggedBody = wrapReply(tagged, route);
  if (route === 'sms' ? taggedBody.length > smsLimit : tagged.length > emailReplyLimit) return { ok: true, reply: normalized, body };
  return { ok: true, reply: tagged, body: taggedBody };
}
