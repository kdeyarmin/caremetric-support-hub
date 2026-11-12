/**
 * Everything the code decides about a model's draft. The model is asked for one structured article (prompt.mjs); this module
 * decides whether it may be offered to the owner at all, and builds the exact article that is previewed and, once the owner
 * approves it, published. A draft that fails a check proposes nothing: the task records the names of the checks it failed,
 * never the draft.
 *
 * The checks are blunt on purpose. A false rejection costs one week's article; a missed bad claim would be published under
 * CareMetric's name. Passing them publishes nothing either: the owner still reads and approves the whole article.
 *
 * - Terms are rewritten where the meaning is plain: Assisted Living Residence and ALR become Assisted Living Facility and
 *   ALF, an auditor (or a DHS audit) becomes a surveyor (an inspection). An auditor of some other kind (a financial auditor)
 *   cannot be rewritten and rejects the draft.
 * - Rejected: lengths and shapes outside the limits below; a citation that is not an https address on an allowed host or
 *   not one of the curated official sources; a link of any other kind; HTML, images or tables; a price, percentage or
 *   number-with-a-unit that neither the fact sheet nor the topic's facts state; a guarantee; a legal or compliance
 *   assurance; a certification; voice or phone AI; a call or demo as a step; a named competitor; "prove" or "proof" about
 *   CareBase; personal or health information, an email address or a phone number; a claim to be an AI.
 */
import { screenIdentifiers } from '../concierge/screen.mjs';
import { phoneNumber } from '../concierge/redact.mjs';
import {
  allowedAmounts, allowedHost, allowedPercents, articleHomeUrl, articleUrl, factSheetText, factsRevision, legalDisclaimer, officialSources, productBySlug, productPage,
  productPages, products, servedElsewhere,
} from './facts.mjs';
import { linkTags, tagLinks, untaggedUrl } from '../links.mjs';

export const limits = Object.freeze({
  title: [20, 90], slug: [10, 80], description: [70, 160], summary: [80, 320], outlineItems: [3, 8], outlineItem: [3, 100],
  body: [1200, 4200], sections: [3, 8], faqItems: [2, 4], question: [10, 150], answer: [30, 450], links: [1, 3], citations: [0, 4],
  preview: 6000,
});

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const productSlugs = { carebase: products.carebase.slug, intel: products.intel.slug, advisors: products.advisors.slug };

// ---- Vocabulary -------------------------------------------------------------------------------------------------------------------

/** "Facility" in the case the original word was written in. */
const matchCase = (original, replacement) => {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original === original.toLowerCase()) return replacement.toLowerCase();
  return replacement.replace(/\b[a-z]/g, letter => letter.toUpperCase());
};
const otherAuditors = /\b(?:financial|internal|external|independent|outside|cpa|certified public|billing|medicare|medicaid|insurance|payer|tax|it|security|soc ?2?|third[- ]party|compliance)\s+auditors?\b/i;
const rewrites = [
  [/\bassisted living residences\b/gi, match => matchCase(match, 'assisted living facilities')],
  [/\bassisted living residence\b/gi, match => matchCase(match, 'assisted living facility')],
  [/\bALRs\b/g, () => 'ALFs'], [/\bALR\b/g, () => 'ALF'],
  [/\b(DHS|state|licensing|department|state's|department's|regulatory)\s+audits\b/gi, (_, who) => `${who} inspections`],
  [/\b(DHS|state|licensing|department|state's|department's|regulatory)\s+audit\b/gi, (_, who) => `${who} inspection`],
  [/\b(an) auditor\b/gi, (_, article) => `${article[0]} surveyor`],
  [/\bauditors\b/gi, match => matchCase(match, 'surveyors')], [/\bauditor\b/gi, match => matchCase(match, 'surveyor')],
];

/** Rewrites the fixed vocabulary. `ambiguous` is true when an auditor of some other kind appears, which no rewrite can fix. */
export function normalizeTerms(value) {
  let text = String(value ?? '');
  const ambiguous = otherAuditors.test(text);
  let count = 0;
  for (const [pattern, replace] of rewrites) text = text.replace(pattern, (...match) => { count += 1; return replace(...match); });
  return { text, rewrites: count, ambiguous };
}

/** Words that must never survive into published text (anything normalizeTerms could not fix). */
const forbiddenTerms = /\bALRs?\b|\bassisted living residences?\b|\bauditors?\b/i;

// ---- Numbers ------------------------------------------------------------------------------------------------------------------------

const unitFamilies = [
  ['minute', /^(?:minutes?|mins?)$/], ['hour', /^(?:hours?|hrs?)$/], ['day', /^days?$/], ['week', /^weeks?$/], ['month', /^months?$/],
  ['year', /^(?:years?|yrs?)$/], ['resident', /^residents?$/], ['bed', /^beds?$/],
  ['staff', /^(?:staff|employees?|caregivers?|people|persons?|aides?|nurses?|marketers?|liaisons?)$/],
  ['facility', /^(?:facilit(?:y|ies)|homes?|buildings?|locations?|sites?|agenc(?:y|ies)|organizations?|offices?)$/],
  ['customer', /^(?:customers?|clients?|users?|operators?|providers?|partners?)$/], ['seat', /^seats?$/], ['county', /^count(?:y|ies)$/],
  ['state', /^states?$/], ['branch', /^branch(?:es)?$/], ['citation', /^(?:citations?|deficienc(?:y|ies)|violations?|findings?|fines?)$/],
  ['referral', /^(?:referrals?|admissions?|patients?|leads?|visits?)$/], ['course', /^(?:courses?|modules?|lessons?|videos?)$/], ['time', /^times?$/],
];
const unitOf = word => unitFamilies.find(([, pattern]) => pattern.test(word))?.[0] ?? null;
const numberWords = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
// Words that may stand between a number and its unit ("40 scheduled working hours", "3 marketer seats", "10 new customers").
const qualifiers = new Set(['more', 'fewer', 'less', 'additional', 'extra', 'full', 'new', 'scheduled', 'working', 'business', 'calendar', 'licensed',
  'marketer', 'manager', 'annual', 'direct', 'care', 'training', 'unannounced', 'separate', 'paying', 'active', 'other']);
const chapterNumbers = new Set(['2600', '2800', '6400', '3270', '3280', '3290']);
// The whole number, decimals included: "6.5 months" is 6.5 months, never 6.
const numberStart = new RegExp(String.raw`(?<![\w.$§,/])((?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?|${Object.keys(numberWords).join('|')})(?=\s|[-–])`, 'gi');
/** A written number as a number: "1,299.50" is 1299.5 and "199.00" is 199, so equal amounts compare equal however they are written. */
const numberOf = text => Number(String(text).replace(/[$,%\s]/g, ''));

/** Every number written with a unit, as "12:hour" or "6.5:month". A bare number (a section, a year, a list marker) is not one. */
export function numbersIn(value) {
  const text = String(value ?? '');
  const found = new Set();
  for (const match of text.matchAll(numberStart)) {
    // A regulation's own numbers are names, not counts: "Chapter 2600 homes", "§ 20.31", "Chapters 2600 and 2800".
    // A section is named by its chapter ("2800.132"), so the whole part is what marks it; a list of sections ("§ 2600.132(c) and 2800.132") counts too.
    if (chapterNumbers.has(match[1].replace(/,/g, '').split('.')[0])
      || /(?:chapters?|ch\.|§+|sections?|part|title|code)\s*(?:\d+(?:\.\d+)?(?:\([a-z0-9]+\))*\s*(?:and|or|,)\s*)?$/i.test(text.slice(Math.max(0, match.index - 32), match.index))) continue;
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 80);
    const words = /^(?:\s*[-–]\s*|\s+)([a-z' ]+)/i.exec(after)?.[1].trim().toLowerCase().split(/\s+/).slice(0, 4) ?? [];
    for (const word of words) {
      const unit = unitOf(word);
      if (unit) {
        found.add(`${numberWords[match[1].toLowerCase()] ?? numberOf(match[1])}:${unit}`);
        break;
      }
      if (!qualifiers.has(word)) break;
    }
  }
  return [...found];
}
// Amounts and percentages are read whole (decimals included) and compared as numbers: "$199.00" is the listed $199, "$199.99" is not.
const amountPattern = /\$\s?((?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?)/g;
const percentPattern = /((?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?)\s?(?:%|percent\b)/gi;
const amountsIn = value => [...String(value ?? '').matchAll(amountPattern)].map(match => numberOf(match[1]));
const percentsIn = value => [...String(value ?? '').matchAll(percentPattern)].map(match => numberOf(match[1]));
let sheetCache = { revision: -1 };
/** What the checks derive from the fact sheet, derived again when the facts change (Intel's catalog, useAppCatalogFacts). */
const sheet = () => {
  if (sheetCache.revision === factsRevision) return sheetCache;
  const text = factSheetText();
  sheetCache = {
    revision: factsRevision, amounts: new Set(allowedAmounts.map(numberOf)), percents: new Set(allowedPercents.map(numberOf)),
    numbers: numbersIn(text), words: new Set(text.match(/[A-Z][a-z]+|[A-Z]/g)),
  };
  return sheetCache;
};

/** The numbers-with-units a text may state: the fact sheet's and those in the given facts. */
export const allowedNumbers = (facts = []) => new Set([...sheet().numbers, ...facts.flatMap(numbersIn)]);

// ---- Claims -------------------------------------------------------------------------------------------------------------------------

const competitors = ['Trella', 'Definitive Healthcare', 'Marketware', 'Aline', 'WelcomeHome', 'PointClickCare', 'MatrixCare', 'Yardi', 'Eldermark', 'ALIS',
  'Relias', 'Caremerge', 'August Systems', 'Experience Care', 'eMARLink', 'Netsmart', 'Homecare Homebase', 'WellSky', 'Axxess', 'HCHB'];
const competitorPattern = new RegExp(String.raw`\b(?:${competitors.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\b`);

/** Each rule is a reason code and what it finds. They run over everything that would be published. */
const claimRules = [
  ['guarantee', /\bguarantee[sd]?\b|\bguaranteeing\b|\bwarrant(?:y|ies|ed)\b|\bpromise[sd]?\b|\brisk[- ]free\b|\b100\s?%\s+(?:of|compliant|ready|accurate|success)|\bmoney[- ]back\b/i],
  ['compliance_assurance', new RegExp([
    String.raw`\bensur(?:e|es|ed|ing)\s+(?:\w+\s+){0,2}compliance\b`,
    String.raw`\b(?:fully|always|automatically|totally|completely|100\s?%)\s+compliant\b`,
    String.raw`\b(?:keep|keeps|keeping|kept|make|makes|making|stay|stays|staying|remain|remains|remaining)\s+(?:you\s+|yourself\s+|your\s+(?:\w+\s+){0,2})?compliant\b`,
    String.raw`\bcompliance\s+(?:is\s+)?(?:guaranteed|assured|automatic)\b`,
    String.raw`\bpass(?:es|ed|ing)?\s+(?:\w+\s+){0,3}(?:inspections?|surveys?|audits?)\b`,
    String.raw`\b(?:survey|inspection|audit|citation|deficiency)[- ](?:proof|free)\b`,
    String.raw`\b(?:zero|no more)\s+(?:citations|deficiencies|violations|fines)\b`,
    String.raw`\bnever\s+(?:be\s+|get\s+)?(?:cited|fined|written up)\b`,
    String.raw`\b(?:avoid|eliminate|prevent)s?\s+(?:all|any|every)\s+(?:citations?|deficienc(?:y|ies)|violations?|fines?)\b`,
    String.raw`\beliminat(?:e|es|ing)\s+(?:citations|deficiencies)\b`,
    String.raw`\blegally\s+(?:compliant|protected|safe)\b`,
  ].join('|'), 'i')],
  ['certification_claim', /\b(?:hipaa|soc\s?2|hitrust|iso\s?27001)[- ](?:certified|certification|compliant|accredited)\b|\b(?:certified|accredited)\s+(?:by|under)\s+(?:hipaa|soc\s?2)\b|\bendorsed by\b|\b(?:carebase|caremetric|intel|our (?:software|platform|product)|the (?:software|platform))\s+(?:is|are|was|has been|have been)\s+(?:\w+\s+)?(?:approved|endorsed|certified|recognized|accredited)\b|\b(?:dhs|department|state|commonwealth)[- ]approved\s+(?:software|platform|system|product|vendor|solution|app)\b|\buptime\b|\b24\/7\s+(?:support|service|help|monitoring|access)\b/i],
  // Voice is about the product's AI: a marketer who makes calls is ordinary advice, an AI that answers them is a claim.
  ['voice_claim', /\bvoice\s+(?:assistant|agent|ai|bot)\b|\bai\s+(?:phone|voice|receptionist|caller|calls?)\b|\bphone\s+(?:assistant|agent|bot)\b|\b(?:ai|assistant|copilot|bot|chatbot|carebase|intel|software|platform)\b[^.\n]{0,40}\b(?:answers?|answering|makes?|making|places?|placing|handles?|handling|takes?|taking)\s+(?:your\s+)?(?:phone\s+)?calls\b/i],
  // A call or a demo with CareMetric as a step: both products are tried online and Advisors starts with its request form.
  ['call_offer', /\b(?:book|schedule|request|get|see)\s+(?:a\s+|an\s+|your\s+)?(?:free\s+|live\s+|quick\s+|personal\s+)?demo\b|\bsales\s+call\b|\b(?:call|phone)\s+us\b|\bgive us a (?:call|ring)\b|\bcall (?:our|the caremetric) (?:team|sales|support)\b|\b(?:schedule|book|set up|arrange)\s+(?:a\s+)?(?:call|meeting)\s+with\s+(?:us|our team|caremetric|the caremetric team)\b/i],
  ['ai_mention', /\bas an ai\b|\blanguage model\b|\bi am an? (?:ai|assistant|bot|model)\b|\bchatgpt\b|\bthis (?:article|draft|pitch) was (?:written|generated|drafted) by\b|\bsystem prompt\b/i],
  ['testimonial', /\b(?:our|happy|satisfied)\s+(?:customers?|clients?|users?)\b|\b(?:customers?|clients?|users?)\s+(?:say|said|tell us|love|rave)\b|\bcase stud(?:y|ies)\b|\btestimonials?\b/i],
];
// "Evidence" joins them on the owner's confirmation of 2026-11-08 (docs/GTM_FACTS.md, Vocabulary).
const proveWords = /\b(?:prove[sdn]?|proving|proof|evidence[ds]?|evidencing)\b/i;
const honorificName = /\b(?:Mr|Mrs|Ms|Miss|Mx|Dr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+)?/g;
const namedPerson = /\b(?:resident|patient|client|employee|aide|caregiver)\s+(?:named|called)\s+[A-Z]/;
const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const companyEmail = /^(?:hello|support)@caremetric\.ai$/i;

/**
 * Problems in text that would be published or sent. `product` is the product key it is about (carebase, intel, advisors);
 * `numbers` is the set of numbers-with-units it may state (null skips that check).
 */
export function textProblems(value, { product = null, numbers = null } = {}) {
  const text = String(value ?? '');
  const reasons = new Set();
  if (amountsIn(text).some(amount => !sheet().amounts.has(amount))) reasons.add('unlisted_price');
  if (percentsIn(text).some(percent => !sheet().percents.has(percent))) reasons.add('unlisted_number');
  if (numbers && numbersIn(text).some(pair => !numbers.has(pair))) reasons.add('unlisted_number');
  for (const [code, pattern] of claimRules) if (pattern.test(text)) reasons.add(code);
  if (competitorPattern.test(text)) reasons.add('competitor_named');
  if ((product === 'carebase' || /\bcarebase\b/i.test(text)) && proveWords.test(text)) reasons.add('prove_word');
  if (forbiddenTerms.test(text)) reasons.add('vocabulary');
  if (screenIdentifiers(text).flagged || namedPerson.test(text)) reasons.add('personal_information');
  if ([...text.matchAll(honorificName)].some(match => match[0].split(/[\s.]+/).slice(1).filter(Boolean).some(word => !sheet().words.has(word)))) reasons.add('personal_information');
  if ((text.match(emailPattern) ?? []).some(address => !companyEmail.test(address)) || new RegExp(phoneNumber.source).test(text)) reasons.add('contact_detail');
  return [...reasons];
}

// ---- Plain language ---------------------------------------------------------------------------------------------------------------------

// Empty marketing words the team never writes (facts.mjs `writing`): they sound like an ad and say nothing a reader can picture. None of
// them appears in either product's published catalog. "Elevated" is left out: "elevated readmissions" is a plain fact about a county.
const emptyWords = /\b(?:unlock(?:s|ed|ing)?|empower(?:s|ed|ing|ment)?|leverag(?:e|es|ed|ing)|synerg(?:y|ies|istic)|seamless(?:ly)?|robust|revolutioni[sz](?:e|es|ed|ing)|supercharg(?:e|es|ed|ing)|game[- ]?changers?|next[- ]level|cutting[- ]edge|elevat(?:e|es|ing)|transform(?:s|ed|ing|ative)?|solutions?|journeys?)\b/i;
/** The most words a sentence of marketing copy may run to. */
export const longestSentence = 30;

/**
 * Why marketing copy would be hard to read or understand (owner direction 2026-11-12: some ad copy did not make sense), as reason codes:
 * `empty_words` (a buzzword from the list above), `fragments` (three or more one- or two-word sentences in a row, as in "Territory.
 * Clarity. Growth.") and `long_sentence` (a sentence over `longestSentence` words). Links are ignored, and each line is read on its own,
 * so a checklist's items or a video's beats are never run together.
 */
export function unclearCopy(value) {
  const text = String(value ?? '').replace(/https?:\/\/\S+/g, ' ');
  const reasons = new Set();
  if (emptyWords.test(text)) reasons.add('empty_words');
  for (const line of text.split(/\n+/)) {
    let run = 0;
    for (const sentence of line.split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(Boolean)) {
      const words = sentence.split(/\s+/).filter(word => /\w/.test(word));
      run = words.length <= 2 && /[.!?]$/.test(sentence) ? run + 1 : 0;
      if (run >= 3) reasons.add('fragments');
      if (words.length > longestSentence) reasons.add('long_sentence');
    }
  }
  return [...reasons];
}

// ---- Links and markup ----------------------------------------------------------------------------------------------------------------

const curatedUrls = new Map([...Object.values(officialSources).map(source => [source.url, source.label]), ...productPages.map(page => [page.url, page.label])]);

/** An https address on an allowed host, with no credentials or port, as a URL; null otherwise. */
export function allowedUrl(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedHost(url.hostname)) return null;
  return url;
}
// Every Markdown link target (whatever its scheme: a javascript: target is a link the renderer would drop) and every bare address.
const urlsIn = markdown => {
  const text = String(markdown ?? '');
  return [...new Set([
    ...[...text.matchAll(/\]\(\s*<?([^)\s>]+)>?\s*(?:"[^"]*")?\s*\)/g)].map(match => match[1]),
    ...[...text.matchAll(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s)<>\]"']+/gi)].map(match => match[0].replace(/[.,;:!?]+$/, '')),
  ])];
};

/** Problems with the links and markup in published Markdown: only curated https addresses on allowed hosts, no HTML, images or tables. */
export function markupProblems(markdown) {
  const text = String(markdown ?? '');
  const reasons = new Set();
  // The same floor the database's check holds (a tag can start without ending), so a draft the database would refuse is never proposed.
  if (/<[a-z/!?]/i.test(text)) reasons.add('html');
  if (/!\[[^\]]*\]\(/.test(text) || /^\s*\|.*\|\s*$/m.test(text)) reasons.add('unsupported_markup');
  for (const address of urlsIn(text)) {
    if (!allowedUrl(address)) reasons.add('link_not_allowed');
    // A product page with well-formed campaign tags (links.mjs) is that page; any other query or a malformed tag is unlisted.
    else if (!curatedUrls.has(address) && !curatedUrls.has(untaggedUrl(address))) reasons.add('link_unlisted');
  }
  return [...reasons];
}

// ---- The article ----------------------------------------------------------------------------------------------------------------------

const clean = value => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
const oneLine = value => clean(value).replace(/\s+/g, ' ');
const within = (value, [min, max]) => value.length >= min && value.length <= max;

/**
 * The Markdown that is published: the summary, the body, the questions, the sources, the links and, for a regulation, the fixed
 * disclaimer. Every product page in it carries campaign tags (help_center / article / content-<product>, links.mjs); the official
 * sources it cites and help-center addresses are left exactly as they are.
 */
export function assembleArticle({ summary, body, faq, citations, links }, topic) {
  const parts = [`**In short:** ${summary}`, body];
  if (faq.length) parts.push('## Frequently asked questions', ...faq.flatMap(item => [`### ${item.question}`, item.answer]));
  if (citations.length) parts.push('## Sources', citations.map(url => `- [${curatedUrls.get(url)}](${url})`).join('\n'));
  if (links.length) parts.push('## Learn more', links.map(id => { const page = productPage(id); return `- [${page.label}](${page.url})`; }).join('\n'));
  if (topic.kind === 'regulation') parts.push(`*${legalDisclaimer}*`);
  return tagLinks(parts.join('\n\n'), linkTags.article(topic.product));
}

/**
 * What the owner reads and approves: where the article will live, then the whole article exactly as it will be published. A
 * CareMetric Intel article lives on Intel's website (its canonical address) and stays readable in the help center.
 */
export function previewOf(article) {
  const product = productBySlug(article.product);
  return [
    ...(servedElsewhere(article.product)
      ? [`Publish on ${product?.name ?? article.product}'s website: ${articleHomeUrl(article.product, article.slug)}`,
        `Also readable in the help center (its canonical link points to the address above): ${articleUrl(article.slug)}`]
      : [`Publish on the public help center: ${articleUrl(article.slug)}`]),
    `Product: ${product?.name ?? article.product}`,
    `Title: ${article.title}`,
    `Description: ${article.description}`,
    '',
    article.body,
  ].join('\n');
}

/**
 * Checks a stored article again before it is published (the executor's last look): its shape, its links and markup, the claims,
 * the vocabulary, personal information and, for a regulation, the disclaimer. Numbers were checked against the topic when it
 * was proposed and the owner read them; they are not checked here, because a topic may have changed since.
 */
export function checkArticle(article) {
  const reasons = new Set();
  const { slug, product, kind, title, description, body } = article ?? {};
  if (typeof slug !== 'string' || !slugPattern.test(slug) || !within(slug, limits.slug)) reasons.add('slug_format');
  if (!productBySlug(product)) reasons.add('product_unknown');
  if (!['regulation', 'marketing'].includes(kind)) reasons.add('kind_unknown');
  if (typeof title !== 'string' || !within(title, limits.title)) reasons.add('title_length');
  if (typeof description !== 'string' || !within(description, limits.description)) reasons.add('description_length');
  if (typeof body !== 'string' || body.length < limits.body[0] || body.length > limits.preview) reasons.add('body_length');
  if (kind === 'regulation' && !String(body ?? '').includes(legalDisclaimer)) reasons.add('missing_disclaimer');
  const productKey = Object.keys(productSlugs).find(key => productSlugs[key] === product) ?? null;
  for (const reason of [...markupProblems(body), ...textProblems([title, description, body].join('\n'), { product: productKey })]) reasons.add(reason);
  return [...reasons].sort();
}

/**
 * Turns the model's answer for `topic` into the article to propose, or says why it cannot be offered.
 * Returns { ok: true, article, preview, rewrites } or { ok: false, reasons, rewrites }. `article` is exactly the action's input.
 */
export function checkDraft(output, { topic, promptVersion = null, features = '' }) {
  const reasons = new Set();
  let rewrites = 0;
  let ambiguous = false;
  const term = value => { const result = normalizeTerms(value); rewrites += result.rewrites; ambiguous ||= result.ambiguous; return result.text; };

  const title = term(oneLine(output?.title));
  const slug = oneLine(output?.slug).toLowerCase();
  const description = term(oneLine(output?.metaDescription));
  const summary = term(oneLine(output?.summary));
  const outline = Array.isArray(output?.outline) ? output.outline.map(oneLine) : [];
  // One title per page: a heading the model wrote at the top level becomes a section.
  let body = term(clean(output?.body)).replace(/^# (?=\S)/gm, () => { rewrites += 1; return '## '; });
  const faq = (Array.isArray(output?.faq) ? output.faq : []).map(item => ({ question: term(oneLine(item?.question)), answer: term(oneLine(item?.answer)) }));
  const citations = [...new Set((Array.isArray(output?.citations) ? output.citations : []).map(value => oneLine(value)))];
  const links = [...new Set(Array.isArray(output?.internalLinks) ? output.internalLinks : [])];

  if (ambiguous) reasons.add('ambiguous_term');
  if (!within(title, limits.title)) reasons.add('title_length');
  if (/[#*_`[\]<>|]/.test(title)) reasons.add('title_format');
  if (!slugPattern.test(slug) || !within(slug, limits.slug)) reasons.add('slug_format');
  if (!within(description, limits.description)) reasons.add('description_length');
  if (!within(summary, limits.summary)) reasons.add('summary_length');
  if (!within(outline, limits.outlineItems) || outline.some(item => !within(item, limits.outlineItem))) reasons.add('outline');
  if (!within(body, limits.body)) reasons.add('body_length');
  const sections = body.match(/^## \S/gm)?.length ?? 0;
  if (sections < limits.sections[0] || sections > limits.sections[1]
    || /^#{2,3}\s*(?:sources|references|citations|learn more|frequently asked questions|faqs?)\b/im.test(body)) reasons.add('structure');
  if (!within(faq, limits.faqItems) || faq.some(item => !within(item.question, limits.question) || !item.question.endsWith('?') || !within(item.answer, limits.answer))) reasons.add('faq');
  if (!within(links, limits.links) || links.some(id => !productPage(id))) reasons.add('internal_links');
  if (!within(citations, limits.citations) || (topic.kind === 'regulation' && citations.length === 0)) reasons.add('citation_count');
  for (const url of citations) {
    if (!allowedUrl(url)) reasons.add('citation_host');
    else if (!curatedUrls.has(url)) reasons.add('citation_unlisted');
  }

  const product = productSlugs[topic.product];
  // The topic's own facts, and the numbers the product's published catalog states (content/features.mjs).
  const numbers = allowedNumbers([topic.title, topic.angle, ...topic.facts, features]);
  for (const reason of markupProblems(body)) reasons.add(reason);
  for (const reason of textProblems([title, description, summary, body, ...faq.flatMap(item => [item.question, item.answer])].join('\n'), { product: topic.product, numbers })) reasons.add(reason);
  if (reasons.size > 0) return { ok: false, reasons: [...reasons].sort(), rewrites };

  const article = {
    slug, product, topic: topic.key, kind: topic.kind, title, description,
    body: assembleArticle({ summary, body, faq, citations, links }, topic),
    ...(promptVersion ? { promptVersion } : {}),
  };
  const preview = previewOf(article);
  if (preview.length > limits.preview) return { ok: false, reasons: ['too_long'], rewrites };
  const last = checkArticle(article);
  if (last.length > 0) return { ok: false, reasons: last, rewrites };
  return { ok: true, article, preview, rewrites };
}
