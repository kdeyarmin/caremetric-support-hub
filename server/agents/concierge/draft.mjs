/**
 * Everything the code decides about a model's draft reply. The model is asked for a draft; this module
 * decides whether it may be offered to the owner at all. A draft that fails any check is dropped, the
 * owner is offered the fixed acknowledgment instead, and the run records only the name of the check, never
 * the draft. Passing the checks does not send anything: the owner still reads and approves the exact text.
 *
 * The checks are blunt on purpose. A false rejection costs the owner nothing but a fixed acknowledgment in
 * place of a drafted answer; a missed bad draft is the thing the owner would have to catch.
 *
 * - Terms are rewritten, not rejected: Assisted Living Residence and ALR become Assisted Living Facility and
 *   ALF, and auditor becomes surveyor, because the company's customer-facing vocabulary is fixed.
 * - Rejected: no reply or no cited guide, a reply that is too long for its channel, markup, a link, an email
 *   address or a phone number, an identifier (the same screen the inbound message went through), a dollar
 *   amount or percentage the guides do not state, any mention of a call, phone, voicemail, meeting or demo,
 *   a promise (a refund, a credit, a guarantee, a time frame, a day), legal, compliance or medical advice, a
 *   claim to be an AI, a reference to the prompt, a repeat of a name or identifier-like token from the
 *   customer's message that the guides do not use, and a long verbatim quotation of the customer.
 */
import { phoneNumber } from './redact.mjs';
import { screenIdentifiers } from './screen.mjs';
import { smsLimit, wrapReply } from './templates.mjs';

export const emailReplyLimit = 1500;

const rewrites = [
  [/\bAssisted Living Residences\b/gi, 'Assisted Living Facilities'], [/\bAssisted Living Residence\b/gi, 'Assisted Living Facility'],
  [/\bALRs\b/g, 'ALFs'], [/\bALR\b/g, 'ALF'],
  [/\bAuditors\b/g, 'Surveyors'], [/\bauditors\b/g, 'surveyors'], [/\bAuditor\b/g, 'Surveyor'], [/\bauditor\b/g, 'surveyor'],
];

export function normalizeTerms(text) {
  return rewrites.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(text ?? ''));
}

export const wordsOf = text => String(text ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? [];

// Capitalized everyday words that a reply may share with a message without echoing anyone's name.
const everyday = new Set([
  'thanks', 'thank', 'please', 'hello', 'regards', 'sincerely', 'team', 'support', 'help', 'center', 'hub', 'pennsylvania', 'department', 'human', 'services',
  'assisted', 'living', 'facility', 'facilities', 'personal', 'care', 'home', 'homes', 'carebase', 'caremetric', 'breathe', 'intel', 'pennsync', 'advisors',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'english', 'spanish', 'google', 'chrome', 'safari', 'firefox', 'edge', 'windows', 'apple', 'android', 'excel', 'word',
  'pdf', 'csv', 'sms', 'alf', 'hipaa', 'dhs', 'login', 'email', 'dashboard', 'reports', 'report', 'export', 'import', 'staff', 'roster', 'training', 'courses',
]);

const identifierToken = /\b(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{5,40}\b|\b[A-Z]{4,20}\b/g;
const capitalizedWord = /\b[A-Z][a-z]{2,20}\b/g;

/** Names and identifier-like tokens in the customer's message that a reply must not repeat (those the guides use are fine). */
function echoCandidates(text, vocabulary) {
  const found = new Set();
  for (const match of text.matchAll(capitalizedWord)) {
    // A capital that starts a sentence is usually only grammar, unless another capitalized word follows it (a name: "Pat Example").
    const starts = match.index === 0 || /[.!?:]\s*$|\n\s*$/.test(text.slice(Math.max(0, match.index - 6), match.index));
    if (starts && !/^ [A-Z][a-z]{2}/.test(text.slice(match.index + match[0].length, match.index + match[0].length + 4))) continue;
    found.add(match[0]);
  }
  for (const match of text.matchAll(identifierToken)) found.add(match[0]);
  return [...found].filter(word => !vocabulary.has(word.toLowerCase()) && !everyday.has(word.toLowerCase()));
}

function quotesCustomer(reply, text, size = 8) {
  const source = wordsOf(text);
  if (source.length < size) return false;
  const grams = new Set();
  for (let index = 0; index + size <= source.length; index += 1) grams.add(source.slice(index, index + size).join(' '));
  const target = wordsOf(reply);
  for (let index = 0; index + size <= target.length; index += 1) if (grams.has(target.slice(index, index + size).join(' '))) return true;
  return false;
}

const amountPattern = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%/g;
const amountsIn = text => new Set((String(text).match(amountPattern) ?? []).map(value => value.replace(/\s/g, '')));

const markup = /[<>`]|\]\(|\*\*|__|^#{1,6}\s/m;
const contactDetail = new RegExp(String.raw`\bhttps?:|\bwww\.|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|${phoneNumber.source}`, 'i');
const voiceOffer = /\b(?:calls?|called|calling|phone|phones|telephone|voicemail|dial|meeting|meetings|demo)\b/i;
const promise = /\b(?:refund(?:s|ed)?|credit(?:s|ed)? (?:to|back|your)|guarantee[ds]?|promise[ds]?|waive[ds]?|free of charge|at no (?:extra )?(?:cost|charge)|within (?:\d+|a|an|one|two|three|four|five|the next) (?:minutes?|hours?|days?|business|weeks?)|by (?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|end of (?:the )?(?:day|week))|we will (?:fix|resolve|refund|credit|waive))\b/i;
const advice = /\b(?:hipaa[- ]compliant|compliance is guaranteed|(?:will|would) (?:pass|satisfy) (?:a |an |the )?(?:survey|inspection|audit)|legally (?:required|compliant|binding)|medical advice|diagnos\w+|dosages?|prescri\w+)\b/i;
const aiMention = /\b(?:as an ai|language model|artificial intelligence|ai assistant|automated (?:reply|response|assistant)|chatbot|i am an? (?:ai|assistant|bot|model))\b/i;
const promptEcho = /\bg[1-3]\b|\bsystem prompt\b|\b(?:my|these|the) instructions\b/i;

/**
 * @param {object} input
 * @param {string} input.reply the model's draft
 * @param {string[]} input.citations the guide ids it says it used (g1, g2, g3)
 * @param {{title: string, summary: string, body: string}[]} input.guides the guides it was given
 * @param {string} input.text the scrubbed customer text the model was shown
 * @param {'sms'|'email'|'chat'} input.route how the reply would travel
 * @returns {{ ok: true, reply: string, body: string, citations: string[] } | { ok: false, reason: string }}
 */
export function checkDraft({ reply, citations, guides, text, route }) {
  const normalized = normalizeTerms(String(reply ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  if (!normalized) return { ok: false, reason: 'empty' };
  const cited = [...new Set(Array.isArray(citations) ? citations : [])];
  if (cited.length === 0 || cited.some(id => !/^g[1-3]$/.test(id) || Number(id.slice(1)) > guides.length)) return { ok: false, reason: 'citation' };
  const body = wrapReply(normalized, route);
  if (route === 'sms' ? body.length > smsLimit : normalized.length > emailReplyLimit) return { ok: false, reason: 'too_long' };
  if (markup.test(normalized)) return { ok: false, reason: 'markup' };
  if (contactDetail.test(normalized)) return { ok: false, reason: 'contact_detail' };
  if (screenIdentifiers(normalized).flagged) return { ok: false, reason: 'identifier' };
  const guideText = guides.map(guide => `${guide.title} ${guide.summary} ${guide.body}`).join('\n');
  const allowed = amountsIn(guideText);
  if ([...amountsIn(normalized)].some(amount => !allowed.has(amount))) return { ok: false, reason: 'unlisted_amount' };
  if (voiceOffer.test(normalized)) return { ok: false, reason: 'voice_offer' };
  if (promise.test(normalized)) return { ok: false, reason: 'promise' };
  if (advice.test(normalized)) return { ok: false, reason: 'advice' };
  if (aiMention.test(normalized)) return { ok: false, reason: 'ai_mention' };
  if (promptEcho.test(normalized)) return { ok: false, reason: 'prompt_echo' };
  const vocabulary = new Set(wordsOf(guideText));
  const lowered = normalized.toLowerCase();
  if (echoCandidates(text, vocabulary).some(word => new RegExp(String.raw`\b${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`).test(lowered))) return { ok: false, reason: 'name_echo' };
  if (quotesCustomer(normalized, text)) return { ok: false, reason: 'quotes_customer' };
  return { ok: true, reply: normalized, body, citations: cited };
}
