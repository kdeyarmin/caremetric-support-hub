/**
 * What each product does, feature by feature, and why it matters, in the product's own published words: the companion to the fact sheet
 * (facts.mjs), which keeps prices, offers and who each product is for. The Creative Director, the Content Marketer, the Sales Executive
 * and the Social Media Manager write from it, and their checks allow its numbers.
 *
 * `npm run refresh:features` reads both catalogs from the products' own public pages (`-- --check` says whether they have moved on):
 * - CareMetric Intel (intel-features.json), from https://www.caremetricintel.com/features and its home page: every published feature
 *   with its area and the plan or role it needs, why each part matters, the data behind it (what is included, the source, the decision it
 *   helps make and its limit), each care setting, the manager view, the questions and answers, and the site's own caveats.
 * - CareMetric CareBase (carebase-features.json), from https://cmcarebase.com/features, its home page and /faq: every capability by
 *   area with the plan or add-on it needs, why it matters and the tools that set it apart, the newest tools, a resident's record from
 *   inquiry to move-out, what each role sees and does, before and with CareBase, each chapter's requirements, the questions and answers,
 *   and the site's own caveats.
 * The AI team names no other product, so vendor names on the pages are written generically; each catalog lists those edits.
 */
import { readFileSync } from 'node:fs';
import { factsRevision } from './facts.mjs';
import { allowedNumbers, normalizeTerms } from './validate.mjs';

const deepFreeze = value => { if (value && typeof value === 'object') for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); };
const read = name => deepFreeze(JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')));

export const productFeatures = deepFreeze({ 'caremetric-intel': read('intel-features.json'), carebase: read('carebase-features.json') });
/** The product slugs with a catalog; facts keys (intel, carebase) are accepted too. */
const slugOf = product => ({ intel: 'caremetric-intel' })[product] ?? product;

/**
 * The product's catalog, as text for a prompt or a fact check; empty for a product without one. It is written in the team's fixed
 * vocabulary (validate.mjs normalizeTerms), as everything the team publishes is.
 */
export function featuresText(product) {
  const slug = slugOf(product);
  const text = slug === 'carebase' ? carebaseText(productFeatures.carebase) : slug === 'caremetric-intel' ? intelText(productFeatures[slug]) : '';
  return text ? normalizeTerms(text).text : '';
}

function carebaseText(catalog) {
  const total = catalog.areas.reduce((sum, area) => sum + area.capabilities.length, 0);
  return [
    `CareMetric CareBase capabilities (published at ${catalog.sources.features}, ${catalog.sources.home} and ${catalog.sources.faq}, read ${catalog.reviewed})`,
    `What it is: ${catalog.overview} ${catalog.summary}`,
    `${total} capabilities in ${catalog.areas.length} areas. ${catalog.intro} ${catalog.legend}`,
    '',
    'Why it matters, and the tools that set it apart:',
    ...catalog.pillars.map(pillar => `- ${pillar.title} (${pillar.area}): ${pillar.why}`),
    '',
    'Every capability, by area (a bracket names the plan or add-on it needs):',
    ...catalog.areas.map(area => `- ${area.name} [${area.plan}]: ${area.intro} ${area.capabilities.join('; ')}.${area.note ? ` ${area.note}` : ''}`),
    '',
    'The newest tools:',
    ...catalog.newest.map(item => `- ${item.name} (${item.headline}): ${item.does}`),
    '',
    'A resident\'s record, from inquiry to move-out:',
    ...catalog.lifecycle.map(item => `- ${item.step}: ${item.text}`),
    '',
    'What each role sees and does (access is enforced in the database):',
    ...catalog.roles.map(item => `- ${item.role}: sees ${item.sees} Does: ${item.does}`),
    '',
    'Before, and with CareBase:',
    ...catalog.beforeAfter.map(item => `- Before: ${item.before}. With CareBase: ${item.after}.`),
    '',
    'By facility type:',
    ...catalog.chapters.map(item => `- ${item.chapter} (${item.title}): ${item.text} Highlights: ${item.highlights.join('; ')}.`),
    '',
    'Questions and answers:', ...catalog.faq.map(item => `- ${item.question} ${item.answer}`),
    '',
    'What the site itself says not to imply:', ...catalog.caveats.map(caveat => `- ${caveat}`),
  ].join('\n');
}

function intelText(catalog) {
  const total = catalog.areas.reduce((sum, area) => sum + area.features.length, 0);
  const lines = [
    `CareMetric Intel features and data (published at ${catalog.sources.features} and ${catalog.sources.home}, read ${catalog.reviewed})`,
    `What it is: ${catalog.overview}`,
    `${total} features in ${catalog.areas.length} areas. ${catalog.legend}`,
    '',
    'Why each part matters:',
    ...catalog.pillars.map(pillar => `- ${pillar.title} (${pillar.area}): ${pillar.why}`),
    '',
    'Every feature, by area (a bracket names the plan or role a feature needs):',
  ];
  for (const area of catalog.areas) {
    lines.push(`${area.name}: ${area.intro}`);
    for (const feature of area.features) lines.push(`- ${feature.name}${feature.access ? ` [${feature.access}]` : ''}: ${feature.does}`);
  }
  lines.push('', 'The data behind it:');
  for (const family of catalog.data) {
    lines.push(`- ${family.family}: ${family.headline} Includes: ${family.includes.join('; ')}. Source: ${family.source}. The decision it helps make: ${family.question} ${family.decision} Limit: ${family.limit}`);
  }
  lines.push('', 'By care setting:', ...catalog.settings.map(setting => `- ${setting.name}: ${setting.text}`));
  lines.push('', 'For managers:', ...catalog.managers.map(item => `- ${item.name}: ${item.text}`));
  lines.push('', 'Questions and answers:', ...catalog.faq.map(item => `- ${item.question} ${item.answer}`));
  lines.push('', 'What the site itself says not to imply:', ...catalog.caveats.map(caveat => `- ${caveat}`));
  return lines.join('\n');
}

// Words that tie a plan item's text to one of the "why it matters" pillars, in the pillars' order on each site.
const carebaseWords = [
  /\b(surveys?|surveyors?|binder|deficienc|citations?|readiness)/i, // Prepare for your next survey
  /\b(courses?|education|in-?service|training hours|curriculum|quizzes)\b/i, // Spend less on required education
  /\b(reminders?|chasing|overdue|follow-?up|tasks?|deadlines?)\b/i, // Spend less time chasing records
  /\b(chapters? 2[68]00|2[68]00|dementia|direct care|state-specific)\b/i, // Pennsylvania is built into the workflow
  /\b(hospital returns?|change of condition|change-of-condition|reassessments?|support-plan reviews?)\b/i, // The next step stays connected to the record
  /\b(policies|reviewed|reviewer|ai-assisted|presenter)\b/i, // Training prepared for you. AI reviewed by people.
  /\b(price[ds]?|pricing|per facility|headcount|per-resident|per-staff)\b/i, // A price based on your facility, not your headcount
];
const intelWords = [
  /\b(market|territor(?:y|ies)|count(?:y|ies)|demographic|service area)/i,
  /\b(target list|lead list|prospect|physicians?|referral sources?|provider search)/i,
  /\b(crm|accounts?|relationships?|contacts?|marketing book|pipeline)\b/i,
  /\b(visits?|routes?|field|call plan|call sheet|check-?in)\b/i,
  /\b(referrals?|admissions?|outcomes?|conversion|lost reasons?)\b/i,
  /\b(briefs?|reports?|imports?|meeting)\b/i,
  /\b(expenses?|mileage|stark|meals?|reimburse|receipts?)/i,
  /\b(competitors?|competition|market share|star ratings?)\b/i,
  /\b(email campaigns?|campaigns?|newsletters?)\b/i,
  /\b(pre-visit|prepared|debrief)\b/i,
  /\b(response times?|answer(?:ing)? referrals|availability|accepting referrals)\b/i,
  /\b(site finder|new (?:offices?|locations?|sites?)|expan(?:d|sion)|where to grow)\b/i,
];

/**
 * How to use a product catalog, for any prompt that carries one (`catalogBlocks`). The catalog follows the prompt as its own cached
 * block, one per product the request is about.
 */
export const catalogGuidance = `What each product does: when a product's own published catalog follows these instructions ("CareMetric Intel features and data" or "CareMetric CareBase capabilities"), use it to be specific. Name the feature or capability that answers the reader, and say why it matters in the catalog's own terms: the decision it helps make, the work it saves, the record it keeps. Stay inside what it says: a feature with a plan or role label is not on every plan, and a module may not be in every subscription. Never present public data as confirmed referrals, a tool as making anyone compliant or survey-ready, or a readiness score as a prediction of survey results; never promise savings. Quote none of its percentages, and repeat none of its questions as claims. Never let one feature stand for the whole product: across your work, show the range of what it does. For Intel, email campaigns are one feature on two plans, never the point of the product (the fact sheet's "How to present it"): do not lead with emailing referral sources or make email the whole subject; show it as one part of the workspace.`;

/** The system-prompt blocks for these products' catalogs (cached; products without one are left out, each product once). */
export function catalogBlocks(products = []) {
  const list = (Array.isArray(products) ? products : []).filter(product => typeof product === 'string');
  return [...new Set(list.map(slugOf))].map(featuresText).filter(Boolean).map(text => ({ text, cache: true }));
}

/** Every catalog's text, for a vocabulary (the words a check treats as the products' own). */
export const featuresTexts = () => Object.keys(productFeatures).map(featuresText);

const numberCache = new Map();
/**
 * The numbers a text about `product` may state: the fact sheet's and that product's own catalog's, never another product's (validate.mjs
 * allowedNumbers). Read again when the facts change (Intel's prices).
 */
export function catalogNumbers(product) {
  const key = `${factsRevision}:${slugOf(product ?? '')}`;
  if (!numberCache.has(key)) numberCache.set(key, allowedNumbers([featuresText(product ?? '')]));
  return numberCache.get(key);
}

/**
 * Pillars that are one part of the product and never what a brief leads with. Owner direction 2026-11-12: sending emails to referral
 * sources is not the point of Intel and is never the whole focus (facts.mjs, `present`), so its email campaigns pillar is not a lead.
 * Owner direction 2026-11-14: Intel is a marketing workspace, not a compliance product, and its expense tracking (spend in view of policy
 * and the Stark limit) is a small part of it, so its expenses pillar is not a lead either. Field activity, which logs expenses among much
 * else, still leads. Owner direction 2026-11-16: AI is text only in what the team writes, so Intel's pre-visit card and spoken debrief
 * pillar is not a lead; the catalog keeps the site's words, and the field-visit pillar still leads.
 */
const supportingAreas = { 'caremetric-intel': /\bemail campaigns\b|\bexpenses, mileage\b|\bspoken debrief\b/i };

/**
 * The "why it matters" pillar a planned brief leads with: the one its plan text is about (the most specific match: a later pillar's words,
 * such as competitors, win over the general ones), else the next in turn this plan has not used, so a run of plans covers
 * everything the product does. A supporting pillar (`supportingAreas`) never leads, even when the plan text names it. Null for a product
 * without a catalog.
 */
export function focusFor(product, text = '', turn = 0, used = new Set()) {
  const slug = slugOf(product);
  const pillars = productFeatures[slug]?.pillars ?? [];
  const supporting = supportingAreas[slug];
  const leads = pillars.filter(pillar => !supporting?.test(pillar.area));
  if (!leads.length) return null;
  const words = slug === 'carebase' ? carebaseWords : intelWords;
  const matches = pillars.filter((pillar, index) => words[index]?.test(text) && leads.includes(pillar));
  const named = matches.at(-1);
  if (named && !used.has(named.title)) return named;
  const start = ((turn % leads.length) + leads.length) % leads.length;
  const order = [...leads.slice(start), ...leads.slice(0, start)];
  return order.find(pillar => !used.has(pillar.title)) ?? order[0];
}

/** The site's own paragraph for a care setting (`hospitals`, `nursing homes`, ...), or null. */
export const careSettingText = (product, setting) => productFeatures[slugOf(product)]?.settings?.find(item => item.name.toLowerCase() === String(setting ?? '').toLowerCase())?.text ?? null;
