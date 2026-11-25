/**
 * Everything the code decides about a piece of creative before the owner may see it. Each rule gives `pass`, `warn` or `block` with a
 * plain-words reason; the asset's verdict is the worst of them. A blocked asset is never proposed and never shown on the Creative screen
 * (only counted); a warned asset is proposed with its warnings beside it and can never be approved automatically.
 *
 * Copy rules (`checkCopy`), run on every word the asset shows or carries (headline, primary text, description, call to action, the
 * layout's statistic, quote, checklist and video lines, alt text):
 * - phi: no personal or health information, no identifier, no named patient, resident or person (block).
 * - personal_attributes: no assertion or implication of the reader's health, finances, age or other personal attributes. Meta's
 *   personal-attributes policy makes it a block there and a warning elsewhere.
 * - unsubstantiated_claim: no guarantee, compliance assurance ("100% compliant", "ensures compliance"), certification, superlative or
 *   outcome promise, unless the exact claim is in the Sales Executive's fact source (the fact sheet and the sales playbook) (block).
 * - government_endorsement: nothing that says or implies CMS, Medicare, Medicaid, a state or another government body approves,
 *   endorses, certifies or partners with CareMetric (block).
 * - offer_mismatch: only the billing system's live offers (offers.mjs), for the products they apply to, with their own percentage and
 *   length, no code to type (the Founders Sale applies itself), no deadline or scarcity it does not have, and only the fact sheet's prices
 *   for this product (block).
 * - brand_name: "CareMetric" is one word with that capitalization; product names are exactly CareBase, CareMetric CareBase, CareMetric
 *   Intel (or Intel) and CareMetric Healthcare Advisors (block).
 * - banned_phrase and required_disclaimer: the brand kit's lists (block).
 * - fact_sheet: every other fact-sheet rule the Content Marketer and Sales Executive follow: unlisted numbers, named competitors,
 *   testimonials, voice AI, a call or demo as a step, "prove" about CareBase, the fixed vocabulary, contact details, mentions of AI (block).
 * - plain_language: copy a busy owner could not understand on the first read (owner direction 2026-11-12): an empty buzzword, a string of
 *   one- or two-word fragments, or an overlong sentence (content/validate.mjs `unclearCopy`; block).
 * - public_data: copy about CareMetric Intel that calls its data public, publicly available or free ("public Medicare data"); it names
 *   the source instead, "Medicare data" or "CMS ratings" (owner direction 2026-11-17; content/validate.mjs `publicDataWords`; block).
 *
 * Visual rules (`checkVisual`): brand_colors (every color the asset paints is one of the product's brand colors: its theme's, from the app's
 * own code, or the owner's brand kit; block); contrast (WCAG AA for every text run, block); text_heavy (more than a fifth of the picture is
 * text, warn); images (only the logo, the theme's own brand imagery and screenshots the owner attested carry no patient, resident or
 * personal information, block); logo_ground (a logo placed where it does not sit cleanly, such as its own white box on a colored or dark
 * background: block); a color from the owner's kit replaced for contrast, an uploaded logo that could not be used on a background, and fonts
 * the Hub does not bundle (brand_deviation, warn). Video rules (`checkVideo`): captions (block when missing).
 * Platform rules come from specs.mjs (`validateAsset`): wrong size or type, too large, wrong length or copy over a platform's limit block;
 * copy past where the feed cuts it off warns.
 */
import { screenIdentifiers } from '../concierge/screen.mjs';
import { catalogNumbers } from '../content/features.mjs';
import { factSheetText, factsRevision } from '../content/facts.mjs';
import { allowedNumbers, longestSentence, normalizeTerms, textProblems, unclearCopy } from '../content/validate.mjs';
import { productAmounts } from '../../growth/draft.mjs';
import { offersMeeting, playbookFor, playbookText } from '../../growth/playbook.mjs';
import { contrastRatio, meetsAA } from './brand.mjs';
import { snapshotAltText } from './data.mjs';
import { liveOffers, offerFor } from './offers.mjs';
import { textLimits, validateAsset } from './specs.mjs';

// .3 (2026-11-17): a county snapshot is checked the same way when it is drafted and when it is rendered, and its alt text is the data's.
// .4 (2026-11-17, later): copy about Intel never calls its data public (`public_data`).
export const complianceVersion = 'creative-compliance.4';
export const rules = Object.freeze(['phi', 'personal_attributes', 'unsubstantiated_claim', 'government_endorsement', 'offer_mismatch', 'brand_name',
  'banned_phrase', 'required_disclaimer', 'fact_sheet', 'plain_language', 'public_data', 'brand_colors', 'logo_ground', 'contrast', 'text_heavy', 'images', 'brand_deviation', 'captions', 'platform']);

const block = (rule, message) => ({ rule, level: 'block', message });
const warn = (rule, message) => ({ rule, level: 'warn', message });

let sourceCache = { revision: -1 };
/**
 * The Sales Executive's fact source, lowercased, and the numbers a creative may state: read again when the facts change (Intel's catalog).
 * A claim (a guarantee, a superlative, a compliance assurance) is allowed only when the fact sheet or the playbook says it. Intel's
 * published feature catalog (content/features.mjs) adds its numbers ("up to 2,000 accounts", "45 days without a visit") but vouches for
 * no claim: its own wording includes negations ("no savings ... is guaranteed", "not legal advice") that must not let the claim through.
 */
const factSource = () => {
  if (sourceCache.revision !== factsRevision) {
    sourceCache = { revision: factsRevision, text: `${factSheetText()}\n${playbookText()}`.toLowerCase() };
  }
  return sourceCache;
};
// The numbers a creative about `product` may state: the fact sheet's, and its own product's catalog's (never another product's).
const numbersFor = product => catalogNumbers(product);

// ---- Patterns --------------------------------------------------------------------------------------------------------------------------

// A role word in any case, then a capitalized name: "resident Mary Jones", "Patient John", "Mrs. Smith".
const roleWords = ['patient', 'resident', 'client', 'member', 'caregiver', 'aide', 'nurse', 'employee', 'mr', 'mrs', 'ms', 'miss', 'dr'];
const namedPerson = new RegExp(String.raw`\b(?:${roleWords.map(word => `[${word[0]}${word[0].toUpperCase()}]${word.slice(1)}`).join('|')})\.?\s+(?:named\s+|called\s+)?[A-Z][a-z]{1,20}(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]{1,20})?\b`);
const healthOfPerson = /\b(?:his|her|their|my|your)\s+(?:diagnosis|diagnoses|condition|illness|disease|dementia|alzheimer'?s|medications?|prescriptions?|symptoms?|treatment|care plan|medical history|health record)\b/i;
const personalAttributes = new RegExp([
  String.raw`\b(?:are you|do you (?:have|suffer|feel)|you(?:'re| are)|if you(?:'re| are))\s+(?:\w+\s+){0,2}(?:suffering|struggling with (?:your )?(?:health|weight|debt|money|bills|depression|anxiety)|diagnosed|sick|ill|depressed|anxious|in debt|broke|bankrupt|disabled|overweight|obese|diabetic|addicted|pregnant|elderly|old|over \d{2}|under \d{2}|unemployed|divorced|gay|lesbian|transgender|christian|muslim|jewish|hindu|buddhist|black|white|hispanic|latino|asian|a senior|a veteran|on medicare|on medicaid)\b`,
  String.raw`\byour\s+(?:diagnosis|condition|illness|disability|debt|credit score|medical|health|age|religion|ethnicity|race|sexual|gender|income|criminal|arrest)\b`,
  String.raw`\b(?:other|meet)\s+(?:seniors|singles|christians|muslims|veterans|diabetics|patients)\s+(?:like you|near you)\b`,
  String.raw`\b(?:people|those) (?:like you|your age)\b`,
].join('|'), 'i');
const claimPatterns = [
  ['guarantee', /\bguarantee[sd]?\b|\bguaranteeing\b|\bwarrant(?:y|ies|ed)\b|\brisk[- ]free\b|\bmoney[- ]back\b|\bno risk\b/gi],
  ['compliance_assurance', /\b100\s?%\s+(?:compliant|compliance|accurate|success|ready|survey[- ]ready)\b|\b(?:fully|always|automatically|totally|completely)\s+compliant\b|\bensur(?:e|es|ed|ing)\s+(?:\w+\s+){0,2}compliance\b|\b(?:keeps?|make[s]?|stay[s]?)\s+(?:you\s+|your\s+(?:\w+\s+){0,2})?compliant\b|\bcompliance\s+(?:is\s+)?(?:guaranteed|assured|automatic)\b|\bpass(?:es|ed|ing)?\s+(?:\w+\s+){0,3}(?:inspections?|surveys?|audits?)\b|\b(?:survey|inspection|audit|citation|deficiency)[- ](?:proof|free)\b|\b(?:zero|no more)\s+(?:citations|deficiencies|violations|fines)\b|\b(?:keep|keeps|keeping|stay|stays|staying|remain|remains|remaining)\s+(?:\w+[\s-]+){0,3}compliant\b|\bcompliant\s+(?:automatically|always|every time|guaranteed)\b|\b(?:stark|anti-?kickback)[- ](?:compliant|safe|proof)\b|\bnever\s+(?:exceed|break|violate|go over|cross)\s+(?:\w+\s+){0,2}(?:stark|anti-?kickback|limits?)\b|\b(?:avoid|avoids|prevent|prevents|eliminate|eliminates|stop|stops)\s+(?:\w+[\s-]+){0,2}(?:stark|anti-?kickback|compliance|regulatory)\s+(?:violations?|risks?|issues?|problems?|penalties|fines)\b/gi],
  ['certification', /\b(?:hipaa|soc\s?2|hitrust|iso\s?27001)[- ]?(?:certified|certification|compliant|accredited)\b|\b(?:certified|accredited)\s+(?:by|under)\b/gi],
  ['superlative', /#\s?1\b|\bnumber[- ]one\b|\bthe (?:best|leading|top[- ]rated|most trusted|only)\b|\bindustry[- ]leading\b|\bworld[- ]class\b|\bunmatched\b|\bunbeatable\b/gi],
  ['outcome', /\b(?:double|triple|10x|2x|3x)\s+(?:your\s+)?(?:referrals|revenue|census|admissions|leads|sales)\b|\b(?:more|guaranteed)\s+(?:referrals|revenue|admissions)\s+(?:in|within)\b|\bincrease (?:your )?(?:referrals|revenue|census) by\b/gi],
];
const government = /\b(?:cms|medicare|medicaid|hhs|dhs|the state|commonwealth|federal government|government|department of (?:health|human services)|fda|onc)\s*[- ]?(?:approved|endorsed|certified|recognized|sanctioned|accredited|backed|partner(?:ed)?|affiliated)\b|\b(?:approved|endorsed|certified|recognized|sanctioned|accredited|backed)\s+by\s+(?:the\s+)?(?:cms|medicare|medicaid|hhs|dhs|state|commonwealth|federal|government|department|fda|onc)\b|\b(?:official|authorized)\s+(?:cms|medicare|medicaid|government|state)\s+(?:partner|vendor|program|tool|software)\b|\bin partnership with\s+(?:cms|medicare|medicaid|hhs|dhs|the state|the government)\b|\b(?:a|an|the)\s+(?:cms|medicare|medicaid|government)\s+program\b/i;
const brandVariants = /\b(?:care[\s.-]+metric|caremetric)\b/gi;
const productVariants = [
  [/\bcare[\s.-]+base\b/gi, 'CareBase'], [/\bcarebase\b/gi, 'CareBase'],
];
const codeWords = /\b[A-Z]{3,20}\d{1,4}\b/g;
const codeEntry = /\b(?:use|enter|apply|redeem|with)\s+(?:the\s+)?(?:promo(?:tion(?:al)?)?\s+|discount\s+|coupon\s+)?code\b|\bcode\s*:\s*[A-Z0-9]{3,}\b|\bpromo code\b|\bcoupon code\b/i;
const urgency = /\b(?:limited[- ]time|ends? (?:soon|today|tonight|tomorrow|friday|monday|this week|this month)|last chance|while (?:supplies|spots) last|only \d+ (?:spots|seats|places) left|act now|hurry|deadline|expires? (?:soon|on|at|today))\b/i;
const offerMention = /\bfounders\s+sale\b|\b\d{1,3}\s?%\s+off\b|\bfirst\s+\d{1,2}\s+months\b/i;

const clipped = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Every piece of text an asset shows or carries, in one place. */
export function copyText(copy = {}) {
  const overlay = copy.overlay ?? {};
  return [copy.headline, copy.primaryText, copy.description, copy.cta, copy.altText, overlay.stat, overlay.statLabel, overlay.statSource, overlay.quote,
    overlay.quoteSource, overlay.offerLine, overlay.kicker, ...(Array.isArray(overlay.checklist) ? overlay.checklist : []),
    ...(Array.isArray(overlay.beats) ? overlay.beats : [])].filter(value => typeof value === 'string' && value.trim()).join('\n');
}

const factSheetCodes = {
  unlisted_price: 'states a price the fact sheet does not', unlisted_number: 'states a number the fact sheet does not',
  competitor_named: 'names a competitor', testimonial: 'quotes or refers to customers, testimonials or case studies (none are approved)',
  voice_claim: 'describes AI that uses voice or the phone', call_offer: 'offers a call, meeting or demo as a step', ai_mention: 'mentions AI or how it was written',
  prove_word: 'uses "prove", "proof" or "evidence" about CareBase', vocabulary: 'uses words outside the fixed vocabulary (ALR, auditor)',
  contact_detail: 'carries an email address or phone number', personal_information: 'appears to carry personal information',
  trial_terms: 'says the Intel trial needs a credit card to start (it needs none; a card added before it ends keeps the plan)',
  public_data: 'calls Intel\'s data public (name the source instead: Medicare data, CMS ratings)',
};

/**
 * A county snapshot (data.mjs): the figure, its label, its source and the alt text code writes from them are the data's, exactly, and
 * nothing the model wrote carries a number of its own (the data's year aside). The fact sheet's number rules do not apply to the
 * code-printed figure, so `checkCopy` reads a snapshot's copy without it (`withoutFigure`) and this check reads the figure. The same two
 * checks run when the snapshot is drafted and when it is rendered (tasks.mjs).
 * @returns {{ rule: string, level: 'warn'|'block', message: string }[]}
 */
export function checkData({ copy = {}, facts = null }) {
  if (!facts?.stat) return [];
  const findings = [];
  const overlay = copy.overlay ?? {};
  if (copy.layout !== 'stat' || overlay.stat !== facts.stat || overlay.statLabel !== facts.statLabel || overlay.statSource !== facts.statSource) {
    findings.push(block('data_figure', 'The figure, its label or its source differs from the public data it came from.'));
  }
  // The code's own alt text is the figure again; alt text a model wrote (a snapshot drafted before 2026-11-17) is read like its other words.
  const altText = copy.altText === snapshotAltText(facts) ? null : copy.altText;
  const written = [copy.headline, copy.primaryText, copy.description, copy.cta, altText, overlay.kicker, overlay.quote, overlay.quoteSource, overlay.offerLine,
    ...(Array.isArray(overlay.checklist) ? overlay.checklist : []), ...(Array.isArray(overlay.beats) ? overlay.beats : [])]
    .filter(value => typeof value === 'string').join('\n');
  if ((written.match(/\d[\d,.]*/g) ?? []).some(number => number.replace(/[.,]$/, '') !== String(facts.dataYear ?? ''))) {
    findings.push(block('data_number', 'Only the printed figure carries a number. The words around it state no other number, share or amount.'));
  }
  return findings;
}

/**
 * A snapshot's copy without the code-printed figure, for the copy rules (checkData reads the figure). With the brief's `facts`, the alt
 * text code wrote from the figure is left out too.
 */
export const withoutFigure = (copy, facts = null) => ({ ...copy, ...(facts?.stat && copy.altText === snapshotAltText(facts) ? { altText: '' } : {}),
  overlay: { ...(copy.overlay ?? {}), stat: '', statLabel: '', statSource: '' } });

/**
 * @param {object} input
 * @param {'carebase'|'caremetric-intel'} input.product
 * @param {'meta'|'linkedin'|'google'|'youtube'} input.platform
 * @param {object} input.copy { headline, primaryText, description, cta, altText, overlay }
 * @param {string|null} [input.offerCode] the brief's offer, if any
 * @param {object} [input.brandKit] { bannedPhrases, requiredDisclaimers }
 * @returns {{ rule: string, level: 'warn'|'block', message: string }[]}
 */
export function checkCopy({ product, platform, copy = {}, offerCode = null, brandKit = {} }) {
  const findings = [];
  const raw = copyText(copy);
  const terms = normalizeTerms(raw);
  const text = terms.text;
  const lower = text.toLowerCase();
  const source = factSource();

  // phi
  if (screenIdentifiers(text).flagged) findings.push(block('phi', 'It appears to contain a personal identifier (a record number, date of birth, Medicare number or similar).'));
  if (namedPerson.test(text)) findings.push(block('phi', 'It names a person. Creative never names a patient, resident or anyone else.'));
  if (healthOfPerson.test(text)) findings.push(block('phi', 'It talks about a person\'s health or care. Creative speaks about organizations and their work only.'));

  // personal attributes
  if (personalAttributes.test(text)) {
    findings.push(platform === 'meta'
      ? block('personal_attributes', 'It asserts or implies something about the reader\'s personal attributes, which Meta\'s advertising policy does not allow.')
      : warn('personal_attributes', 'It asserts or implies something about the reader\'s personal attributes. Speak about organizations and their work instead.'));
  }

  // unsubstantiated claims, unless the exact claim is in the fact source
  for (const [kind, pattern] of claimPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (!source.text.includes(match[0].toLowerCase())) {
        findings.push(block('unsubstantiated_claim', `"${clipped(match[0])}" is a ${kind === 'compliance_assurance' ? 'compliance assurance' : kind} the fact source does not support.`));
        break;
      }
    }
  }

  // government endorsement
  if (government.test(text)) findings.push(block('government_endorsement', 'It says or implies that CMS, Medicare, Medicaid or a government body approves, endorses or partners with CareMetric.'));

  // offers and prices, against the billing data
  const offer = offerCode ? offerFor(offerCode) : null;
  if (offerCode && !offer) findings.push(block('offer_mismatch', `The brief names the offer ${clipped(offerCode)}, which is not a live offer in billing.`));
  if (offer && !offer.products.includes(product)) findings.push(block('offer_mismatch', `The ${offer.name} does not apply to this product.`));
  for (const code of new Set(raw.match(codeWords) ?? [])) {
    if (!liveOffers[code]) findings.push(block('offer_mismatch', `${clipped(code)} is not a live offer code.`));
  }
  if (codeEntry.test(text)) findings.push(block('offer_mismatch', 'It asks people to enter a code, but the Founders Sale is applied automatically when paid service starts.'));
  if (urgency.test(text)) findings.push(block('offer_mismatch', 'It claims a deadline or limited availability the offer does not have.'));
  if (offerMention.test(text)) {
    const named = offer ?? liveOffers.FOUNDERS75;
    if (!named.products.includes(product)) findings.push(block('offer_mismatch', `The ${named.name} does not apply to this product.`));
    for (const match of text.matchAll(/(\d{1,3})\s?%\s+off\b/gi)) {
      if (Number(match[1]) !== named.percentOff) findings.push(block('offer_mismatch', `It says ${match[1]}% off; billing applies ${named.percentOff}%.`));
    }
    for (const match of text.matchAll(/\bfirst\s+(\d{1,2})\s+months\b/gi)) {
      if (Number(match[1]) !== named.months) findings.push(block('offer_mismatch', `It says the first ${match[1]} months; billing applies the first ${named.months}.`));
    }
  }
  const book = playbookFor(product);
  if (book) {
    const own = productAmounts(book.factsKey);
    if ((text.match(/\$\s?(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?/g) ?? []).some(amount => !own.has(Number(amount.replace(/[$,\s]/g, ''))))) {
      findings.push(block('offer_mismatch', 'It states a price that is not this product\'s listed price.'));
    }
  }

  // brand and product names
  for (const match of raw.matchAll(brandVariants)) {
    if (match[0] !== 'CareMetric') { findings.push(block('brand_name', `"${clipped(match[0])}" must be written "CareMetric", one word.`)); break; }
  }
  for (const [pattern, exact] of productVariants) {
    const wrong = [...raw.matchAll(pattern)].find(match => match[0] !== exact);
    if (wrong) { findings.push(block('brand_name', `"${clipped(wrong[0])}" must be written "${exact}".`)); break; }
  }
  if (/\bcaremetric\s+intelligence\b|\bintel\s*metric\b/i.test(raw)) findings.push(block('brand_name', 'The product is "CareMetric Intel" (or "Intel").'));

  // the brand kit's lists
  for (const phrase of Array.isArray(brandKit?.bannedPhrases) ? brandKit.bannedPhrases : []) {
    const wanted = String(phrase ?? '').trim().toLowerCase();
    if (wanted && lower.includes(wanted)) findings.push(block('banned_phrase', `"${clipped(phrase)}" is on the brand kit's banned list.`));
  }
  for (const disclaimer of Array.isArray(brandKit?.requiredDisclaimers) ? brandKit.requiredDisclaimers : []) {
    const wanted = String(disclaimer ?? '').trim().toLowerCase();
    if (wanted && !lower.includes(wanted)) findings.push(block('required_disclaimer', `The brand kit requires "${clipped(disclaimer)}" and it is missing.`));
  }

  // every other fact-sheet rule, which the claims above do not already cover
  if (terms.ambiguous) findings.push(block('fact_sheet', 'It names an auditor of a kind the vocabulary cannot rewrite.'));
  const handled = new Set(['guarantee', 'compliance_assurance', 'certification_claim']);
  for (const code of textProblems(text, { product: book?.factsKey ?? null, numbers: numbersFor(product) })) {
    if (handled.has(code)) continue;
    if (code === 'personal_information') { if (!findings.some(item => item.rule === 'phi')) findings.push(block('phi', 'It appears to carry personal information.')); continue; }
    if (code === 'public_data') { findings.push(block('public_data', 'It calls Intel\'s data public. Name the source instead: "Medicare data", "CMS and Census data" or "CMS ratings".')); continue; }
    findings.push(block('fact_sheet', `It ${factSheetCodes[code] ?? code.replaceAll('_', ' ')}.`));
  }
  // Easy to read and makes sense on the first pass: the same check the Social Media Manager runs on every post and ad.
  const plainWords = {
    empty_words: 'It uses an empty marketing word (unlock, empower, leverage, seamless, solution and the like). Say plainly what the product does.',
    fragments: 'It strings one- or two-word fragments together. Write a complete sentence that says who it is for and what it does.',
    long_sentence: `It has a sentence over ${longestSentence} words. Break it into short, plain sentences.`,
  };
  for (const code of unclearCopy(text)) findings.push(block('plain_language', plainWords[code]));
  // A figure on the image carries its source on the image (the stat layout prints it beneath).
  const overlay = copy.overlay ?? {};
  if (copy.layout === 'stat' && String(overlay.stat ?? '').trim() && !String(overlay.statSource ?? '').trim()) {
    findings.push(block('stat_source', 'It shows a figure without its source. A stat image names where the number comes from.'));
  }
  // CareMetric does no personal demos, calls or meetings: the same check the Social Media Manager runs on every post and ad.
  if (offersMeeting(text) && !findings.some(item => item.rule === 'fact_sheet' && item.message.includes(factSheetCodes.call_offer))) {
    findings.push(block('fact_sheet', 'It offers a call, a meeting, a demo or a time to talk; CareMetric does none, so the next step is the free trial or the product\'s own page.'));
  }
  return findings;
}

/**
 * @param {object} report what the layout drew: { width, height, texts: [{ role, color, background, fontSize, bold, area }], images: [{ kind, attested }],
 *   adjustments: ['textColor', ...], fonts: { substituted: boolean } }
 */
export function checkVisual(report = {}) {
  const findings = [];
  const width = Number(report.width) || 1080;
  if (Array.isArray(report.colors) && Array.isArray(report.allowed)) {
    const allowed = new Set(report.allowed.map(color => String(color).toUpperCase()));
    const off = report.colors.map(color => String(color).toUpperCase()).filter(color => !allowed.has(color));
    if (off.length) findings.push(block('brand_colors', `It uses ${off.slice(0, 3).join(', ')}${off.length > 3 ? ` and ${off.length - 3} more` : ''}, which ${off.length === 1 ? 'is' : 'are'} not among the product's brand colors.`));
  } else findings.push(block('brand_colors', 'The renderer did not report its colors, so they could not be checked against the brand.'));
  for (const run of Array.isArray(report.texts) ? report.texts : []) {
    const ratio = contrastRatio(run.color, run.background);
    if (!meetsAA(ratio, { fontSize: run.fontSize, bold: run.bold, canvasWidth: width })) {
      findings.push(block('contrast', `The ${run.role ?? 'text'} has a contrast of ${ratio.toFixed(2)}:1, below WCAG AA.`));
    }
  }
  // A video reports its busiest picture's text (`textArea`); a still, the sum of its runs.
  const area = Number.isFinite(report.textArea) ? report.textArea : (Array.isArray(report.texts) ? report.texts : []).reduce((sum, run) => sum + (Number(run.area) || 0), 0);
  const share = area / (width * (Number(report.height) || width));
  if (share > 0.2) findings.push(warn('text_heavy', `Text covers about ${Math.round(share * 100)}% of the picture; platforms deliver text-heavy images less.`));
  for (const image of Array.isArray(report.images) ? report.images : []) {
    if (!['logo', 'brand', 'screenshot'].includes(image.kind)) findings.push(block('images', 'It uses an image that is not a logo, the theme\'s own brand imagery or one of the brand kit\'s screenshots.'));
    else if (image.kind === 'screenshot' && image.attested !== true) findings.push(block('images', 'It uses a screenshot nobody confirmed is free of patient, resident or personal information.'));
    // A logo goes only where it sits cleanly: never its own white box on a colored or dark background (logo.mjs).
    else if (image.kind === 'logo' && image.fits !== true) findings.push(block('logo_ground', `The logo was placed on ${image.on ?? 'a background'} where it does not sit cleanly${image.ground && image.ground !== 'transparent' ? ` (it has a solid ${image.ground} background of its own)` : ''}.`));
  }
  if (typeof report.logoMisfit === 'string' && report.logoMisfit) {
    findings.push(warn('brand_deviation', `The brand kit's logo was not used here because ${report.logoMisfit}; the official logo or the product name was used instead. A PNG with a transparent background works on every layout.`));
  }
  for (const field of Array.isArray(report.adjustments) ? report.adjustments : []) {
    findings.push(warn('brand_deviation', `The brand kit's ${field === 'textColor' ? 'text' : field === 'primaryColor' ? 'primary' : 'accent'} color did not have enough contrast where it was used, so the theme's own darkest or lightest color was used there.`));
  }
  if (report.fonts?.substituted) findings.push(warn('brand_deviation', 'The brand kit names a font the Hub does not have, so the theme\'s own font was used.'));
  return findings;
}

/** A video must carry captions: burned into the picture (`burned`) and as WebVTT cues (`cues`). */
export function checkVideo({ burned = false, cues = 0 } = {}) {
  return burned && cues > 0 ? [] : [block('captions', 'Every video needs captions burned into the picture, and these are missing.')];
}

/** The platform's own limits for the finished file. */
export function checkPlatform(asset) {
  const verdict = validateAsset(asset);
  return [...verdict.errors.map(item => block('platform', item.message)), ...verdict.warnings.map(item => warn('platform', item.message))];
}

/** The platform's copy lengths alone, for a draft that has no file yet. */
export function checkText(platform, copy = {}) {
  const limits = textLimits[platform];
  if (!limits) return [block('platform', 'Unknown platform.')];
  const names = { headline: 'headline', primaryText: 'primary text', description: 'description' };
  return Object.entries(names).flatMap(([field, label]) => {
    const length = String(copy[field] ?? '').length;
    if (length > limits[field].max) return [block('platform', `The ${label} is ${length} characters; the platform allows ${limits[field].max}.`)];
    if (length > limits[field].recommended) return [warn('platform', `The ${label} is ${length} characters; past ${limits[field].recommended} the feed cuts it off.`)];
    return [];
  });
}

/** The worst finding decides: `{ verdict: 'pass'|'warn'|'block', reasons, version }`. Reasons are unique and plain words. */
export function verdictOf(findings) {
  const seen = new Set();
  const reasons = findings.filter(item => { const key = `${item.level}:${item.rule}:${item.message}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'block' ? -1 : 1)).slice(0, 20);
  const verdict = reasons.some(item => item.level === 'block') ? 'block' : reasons.length ? 'warn' : 'pass';
  return { verdict, reasons, version: complianceVersion };
}

/** One line for an approval card or a run summary: "Passed every check", "2 warnings", "Blocked: 1 problem". */
export function badgeText({ verdict, reasons = [] }) {
  if (verdict === 'pass') return 'Passed every check';
  if (verdict === 'warn') return `Passed with ${plural(reasons.length, 'warning')}`;
  return `Blocked: ${plural(reasons.filter(item => item.level === 'block').length, 'problem')}`;
}
