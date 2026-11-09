/**
 * The Content Marketer's monthly outreach drafts: listing descriptions for software directories and short partnership pitches
 * that the owner can copy and send personally. The model writes them from the fact sheet; this module checks each one with the
 * same rules as an article (validate.mjs) and builds the one email that carries them, to the owner and nobody else. A draft that
 * fails a check is left out and only the name of the check is recorded. Each draft comes with its product's website address carrying
 * campaign tags (../links.mjs: the directory or "partner" as the source, listing-<product> or pitch-<product>), for the owner to give
 * the directory or put in the pitch, so a lead from it shows where it came from.
 */
import { markets } from '../marketing.mjs';
import { factSheetText, productPages, products } from './facts.mjs';
import { allowedNumbers, markupProblems, normalizeTerms, textProblems } from './validate.mjs';
import { campaignTags, taggedUrl } from '../links.mjs';

export const outreachPromptVersion = 'outreach.3';
export const maxDrafts = 5;

export const directories = Object.freeze({ capterra: 'Capterra', g2: 'G2', getapp: 'GetApp', software_advice: 'Software Advice' });
export const audiences = Object.freeze({
  provider_association: 'State and regional provider associations',
  senior_care_consultant: 'Senior-care consultants',
  pharmacy_partner: 'Pharmacy partners',
  therapy_partner: 'Therapy partners',
  compliance_trainer: 'Compliance trainers',
});
// Directories list software, so a listing is for CareBase or Intel; a pitch may be for any of the three.
const listingProducts = ['carebase', 'intel'];
const pitchProducts = ['carebase', 'intel', 'advisors'];
/** The products this month's drafts may be for: those the team markets (marketing.mjs; null markets every product). */
export const outreachProducts = (marketed = null) => ({
  listings: listingProducts.filter(product => markets(marketed, product)), pitches: pitchProducts.filter(product => markets(marketed, product)),
});

export const outreachLimits = Object.freeze({ tagline: [20, 120], description: [200, 1200], subject: [10, 90], body: [200, 1400] });

export const outreachSystemPrompt = `You draft outreach for CareMetric, a small company that makes software and offers consulting for healthcare and senior-care organizations. The company's owner reads every draft and sends the ones they like personally. Nothing you write is sent automatically.

Write two kinds of draft:
- Listing descriptions for software directories (Capterra, G2, GetApp, Software Advice): a tagline of ${outreachLimits.tagline.join(' to ')} characters and a description of ${outreachLimits.description.join(' to ')} characters for one product, written for the directory's buyers. Only CareMetric CareBase and CareMetric Intel are software.
- Short partnership pitches the owner can email to a kind of partner (state and regional provider associations, senior-care consultants, pharmacy partners, therapy partners, compliance trainers): a subject of ${outreachLimits.subject.join(' to ')} characters and a body of ${outreachLimits.body.join(' to ')} characters that says what CareMetric offers that partner's members or clients and suggests one simple next step by email or through the product's website. Write it as a template: no names, greetings to a named person or signatures; the owner adds those.

Rules:
- Use only facts from the fact sheet below. Prices, trials and plan details must match it exactly, and every number you write must appear in it.
- Never promise or guarantee an outcome, and never say a product ensures compliance, passes an inspection or prevents citations.
- Never offer a phone call, a sales call, a meeting or a demo, and never mention AI that uses voice or the phone: CareMetric's AI is text only.
- Never name competitors, customers or real people, and include no email addresses or phone numbers. Use plain text: no markdown, links or HTML; a product's website may be named as a bare domain (cmcarebase.com).
- Vocabulary: "Assisted Living Facility" or "ALF", never "Assisted Living Residence" or "ALR"; the state's inspectors are "surveyors", never "auditors". In anything about CareBase, never use the words "prove", "proof" or "evidence".

Answer with one JSON object and nothing else: listings (up to ${maxDrafts}) and pitches (up to ${maxDrafts}), each for one product.

${factSheetText()}`;

export const outreachSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['listings', 'pitches'],
  properties: {
    listings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['directory', 'product', 'tagline', 'description'],
        properties: { directory: { type: 'string', enum: Object.keys(directories) }, product: { type: 'string', enum: listingProducts }, tagline: { type: 'string' }, description: { type: 'string' } },
      },
    },
    pitches: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['audience', 'product', 'subject', 'body'],
        properties: { audience: { type: 'string', enum: Object.keys(audiences) }, product: { type: 'string', enum: pitchProducts }, subject: { type: 'string' }, body: { type: 'string' } },
      },
    },
  },
};

/** The user message: the month it is for, and how many of each to write. Nothing per customer. */
export function outreachUserMessage(month, marketed = null) {
  const offered = outreachProducts(marketed);
  if (marketed == null) return `Write this month's outreach drafts (${month}): up to ${maxDrafts} directory listings, covering both software products and the four directories, and up to ${maxDrafts} partnership pitches, one for each kind of partner where a product fits.`;
  const names = list => list.map(product => products[product].name).join(' and ');
  const listingWords = offered.listings.length ? `up to ${maxDrafts} directory listings for ${names(offered.listings)}, covering the four directories` : 'no directory listings';
  return `Write this month's outreach drafts (${month}) only for ${names(offered.pitches)}; the other products are not marketed yet: ${listingWords}, and up to ${maxDrafts} partnership pitches, one for each kind of partner where the product fits.`;
}

const clean = value => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
const within = (value, [min, max]) => value.length >= min && value.length <= max;
const numbers = allowedNumbers([]);
// Bare domains of the company's own sites may be named; any other address, and any link syntax, is refused.
const ownDomains = new Set(['caremetric.ai', 'help.caremetric.ai', ...productPages.map(page => new URL(page.url).hostname.replace(/^www\./, ''))]);
const addressPattern = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ai|org|net|io|gov|us)\b/gi;

function draftProblems(texts, product) {
  const joined = texts.join('\n');
  const reasons = new Set([...markupProblems(joined).filter(reason => !reason.startsWith('link_')), ...textProblems(joined, { product, numbers })]);
  if (/[*_`#[\]<>]/.test(joined)) reasons.add('markup');
  // An email address is judged by textProblems (contact_detail), not again here as a link.
  for (const address of joined.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ').match(addressPattern) ?? []) {
    if (!ownDomains.has(address.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[/?#].*$/, '').toLowerCase())) reasons.add('link_not_allowed');
  }
  return [...reasons];
}

/**
 * Checks the model's answer. Returns { listings, pitches, dropped, reasons, rewrites }: the drafts that passed (terms rewritten),
 * how many were left out and the sorted names of the checks they failed.
 */
export function checkOutreach(output, { marketed = null } = {}) {
  const reasons = new Set();
  let dropped = 0;
  let rewrites = 0;
  const term = value => { const result = normalizeTerms(clean(value)); rewrites += result.rewrites; return result; };
  const keep = (problems) => { if (problems.length === 0) return true; dropped += 1; for (const reason of problems) reasons.add(reason); return false; };

  const listings = [];
  for (const item of (Array.isArray(output?.listings) ? output.listings : []).slice(0, maxDrafts)) {
    const tagline = term(item?.tagline);
    const description = term(item?.description);
    const problems = [];
    if (!directories[item?.directory] || !listingProducts.includes(item?.product)) problems.push('unknown_target');
    else if (!markets(marketed, item.product)) problems.push('not_marketed');
    if (!within(tagline.text, outreachLimits.tagline) || /\n/.test(tagline.text)) problems.push('tagline_length');
    if (!within(description.text, outreachLimits.description)) problems.push('description_length');
    if (tagline.ambiguous || description.ambiguous) problems.push('ambiguous_term');
    problems.push(...draftProblems([tagline.text, description.text], item?.product));
    if (keep(problems)) listings.push({ directory: item.directory, product: item.product, tagline: tagline.text, description: description.text });
  }
  const pitches = [];
  for (const item of (Array.isArray(output?.pitches) ? output.pitches : []).slice(0, maxDrafts)) {
    const subject = term(item?.subject);
    const body = term(item?.body);
    const problems = [];
    if (!audiences[item?.audience] || !pitchProducts.includes(item?.product)) problems.push('unknown_target');
    else if (!markets(marketed, item.product)) problems.push('not_marketed');
    if (!within(subject.text, outreachLimits.subject) || /\n/.test(subject.text)) problems.push('subject_length');
    if (!within(body.text, outreachLimits.body)) problems.push('body_length');
    if (subject.ambiguous || body.ambiguous) problems.push('ambiguous_term');
    problems.push(...draftProblems([subject.text, body.text], item?.product));
    if (keep(problems)) pitches.push({ audience: item.audience, product: item.product, subject: subject.text, body: body.text });
  }
  return { listings, pitches, dropped, reasons: [...reasons].sort(), rewrites };
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const home = product => productPages.find(page => page.id === `${product}-home`)?.url ?? products[product].site;
/** The product's home page with the listing's campaign tags: the directory as the source. */
export const listingLink = item => taggedUrl(home(item.product), campaignTags.listing({ directory: item.directory, product: item.product }));
/** The product's home page with the pitch's campaign tags: "partner" as the source, the audience as the content. */
export const pitchLink = item => taggedUrl(home(item.product), campaignTags.pitch({ audience: item.audience, product: item.product }));

/**
 * The owner's email. The stored body (shown on the Team screen) holds counts only; the drafts travel in the email's blocks,
 * which the notifier never stores.
 */
export function composeOutreachEmail({ month, label, listings, pitches, dropped, reasons }) {
  const total = listings.length + pitches.length;
  const subject = total ? `Outreach drafts for ${label}: ${plural(listings.length, 'listing')}, ${plural(pitches.length, 'pitch').replace('pitchs', 'pitches')}` : `Outreach drafts for ${label}: none passed the checks`;
  const left = dropped ? ` ${plural(dropped, 'draft')} did not pass the checks and ${dropped === 1 ? 'was' : 'were'} left out (${reasons.map(reason => reason.replaceAll('_', ' ')).join(', ')}).` : '';
  const body = total
    ? `${plural(listings.length, 'directory listing')} and ${plural(pitches.length, 'partnership pitch').replace('pitchs', 'pitches')} are ready for you to send yourself.${left} Nothing was sent to anyone else.`
    : `No draft passed the checks this month (${reasons.map(reason => reason.replaceAll('_', ' ')).join(', ') || 'none were written'}). Nothing was sent to anyone else.`;
  const blocks = [
    { type: 'callout', tone: 'info', title: 'For you to send.', text: 'These are drafts for you to copy, adjust and send personally. Nothing was sent to a directory, a partner or a customer. Each comes with a website address that carries campaign tags: use it as the listing\'s website or the link in the pitch, so a lead from it shows where it came from.' },
    ...listings.flatMap(item => {
      const link = listingLink(item);
      return [
        { type: 'paragraph', text: `${directories[item.directory]} listing for ${products[item.product].name}` },
        { type: 'message', text: `Tagline: ${item.tagline}\n\n${item.description}` },
        { type: 'message', text: `Website address for this listing:\n${link}`, links: [link] },
      ];
    }),
    ...pitches.flatMap(item => {
      const link = pitchLink(item);
      return [
        { type: 'paragraph', text: `Pitch to ${audiences[item.audience].toLowerCase()} about ${products[item.product].name}` },
        { type: 'message', text: `Subject: ${item.subject}\n\n${item.body}` },
        { type: 'message', text: `Link to use in this pitch:\n${link}`, links: [link] },
      ];
    }),
    ...(dropped ? [{ type: 'paragraph', text: `Left out by the checks: ${plural(dropped, 'draft')} (${reasons.map(reason => reason.replaceAll('_', ' ')).join(', ')}).` }] : []),
    { type: 'paragraph', text: 'Every draft uses only the prices and claims in the CareMetric fact sheet (docs/GTM_FACTS.md). Check them before you send.' },
  ];
  return { subject, body, blocks, dedupeMonth: month };
}
