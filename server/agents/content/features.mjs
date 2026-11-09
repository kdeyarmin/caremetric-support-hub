/**
 * What each product does, feature by feature, and why it matters, in the product's own published words: the companion to the fact sheet
 * (facts.mjs), which keeps prices, offers and who each product is for.
 *
 * CareMetric Intel's catalog (intel-features.json) is read from https://www.caremetricintel.com/features and its home page by
 * `npm run refresh:intel-features` (`-- --check` says whether the live pages have moved on): every published feature with its area and the
 * plan or role it needs, why each area matters, the data behind it (what is included, the source, the decision it helps make and its
 * limit), each care setting, the manager view, the product questions and answers, and the site's own caveats. The EMR vendors Intel names
 * for its CSV imports are written generically, because the AI team names no other product; the catalog lists those edits.
 */
import { readFileSync } from 'node:fs';
import { normalizeTerms } from './validate.mjs';

const deepFreeze = value => { if (value && typeof value === 'object') for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); };
const intel = deepFreeze(JSON.parse(readFileSync(new URL('./intel-features.json', import.meta.url), 'utf8')));

export const productFeatures = deepFreeze({ 'caremetric-intel': intel });

/**
 * The product's catalog, as text for a prompt or a fact check; empty for a product without one. It is written in the team's fixed
 * vocabulary (validate.mjs normalizeTerms), as everything the team publishes is.
 */
export function featuresText(product) {
  return normalizeTerms(catalogText(product)).text;
}

function catalogText(product) {
  const catalog = productFeatures[product];
  if (!catalog) return '';
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

// Words that tie a plan item's text to one of the "why it matters" pillars, in the pillars' order on the site.
const pillarWords = [
  /\b(market|territor(?:y|ies)|count(?:y|ies)|demographic|service area)/i,
  /\b(target list|lead list|prospect|physicians?|referral sources?|provider search)/i,
  /\b(crm|accounts?|relationships?|contacts?|marketing book|pipeline)\b/i,
  /\b(visits?|routes?|field|call plan|call sheet|check-?in)\b/i,
  /\b(referrals?|admissions?|outcomes?|conversion|lost reasons?)\b/i,
  /\b(briefs?|reports?|imports?|meeting)\b/i,
  /\b(expenses?|mileage|stark|meals?|reimburse|receipts?)/i,
  /\b(competitors?|competition|market share|star ratings?)\b/i,
  /\b(email campaigns?|campaigns?|newsletters?)\b/i,
];

/**
 * The "why it matters" pillar a planned brief leads with: the one its plan text is about (the most specific match: a later pillar's words,
 * such as expenses or competitors, win over the general ones), else the next in turn this plan has not used, so a run of plans covers
 * everything Intel does. Null for a product without a catalog.
 */
export function focusFor(product, text = '', turn = 0, used = new Set()) {
  const pillars = productFeatures[product]?.pillars ?? [];
  if (!pillars.length) return null;
  const matches = pillars.filter((pillar, index) => pillarWords[index]?.test(text));
  const named = matches.at(-1);
  if (named && !used.has(named.title)) return named;
  const start = ((turn % pillars.length) + pillars.length) % pillars.length;
  const order = [...pillars.slice(start), ...pillars.slice(0, start)];
  return order.find(pillar => !used.has(pillar.title)) ?? order[0];
}

/** The site's own paragraph for a care setting (`hospitals`, `nursing homes`, ...), or null. */
export const careSettingText = (product, setting) => productFeatures[product]?.settings.find(item => item.name.toLowerCase() === String(setting ?? '').toLowerCase())?.text ?? null;
