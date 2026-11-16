#!/usr/bin/env node
/**
 * Rebuilds the product feature catalogs the AI team writes from (server/agents/content/features.mjs), from each product's own public
 * pages:
 * - CareMetric Intel (intel-features.json): https://www.caremetricintel.com/features (every feature, its area and the plan or role it
 *   needs) and the home page (why each area matters, the data behind it with its sources and limits, the care settings, the manager view,
 *   and the questions and answers).
 * - CareMetric CareBase (carebase-features.json): https://cmcarebase.com/features (every capability by area with the plan or add-on it
 *   needs, the newest tools, the resident lifecycle and what each role sees and does), the home page (why it matters, the tools that set
 *   it apart, before and after, and each chapter's requirements) and /faq (the questions and answers).
 *
 *   npm run refresh:features                                    # fetch every page
 *   node scripts/refresh-product-features.mjs --from <folder>     # from saved copies: intel-home.html, intel-features.html,
 *                                                               # carebase-home.html, carebase-features.html, carebase-faq.html
 *   npm run refresh:features -- --check                         # fail if a committed catalog differs from the live pages
 *   npm run refresh:features -- --only caremetric-intel         # one product (caremetric-intel or carebase); combines with the others
 *
 * The AI team names no other product, so the EMR vendors Intel names for its CSV imports are written generically (each catalog lists
 * its `edits`), and any other product's name stops the refresh. Prices are left to the fact sheet. Review the diff before committing.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

async function page(site, path, saved) {
  if (saved) return readFile(saved, 'utf8');
  const response = await fetch(`${site}${path}`, { headers: { accept: 'text/html' } });
  if (!response.ok) throw new Error(`${site}${path} answered ${response.status}`);
  return response.text();
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', middot: '·' };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => (code[0] === '#'
  ? String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : entities[code] ?? whole));
const clean = fragment => decode(String(fragment ?? '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, ''))
  .replace(/\s+/g, ' ').trim();
const pageText = html => clean(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ''));
const first = (pattern, text) => pattern.exec(text)?.[1] ?? null;

// Wording the AI team may not repeat, rewritten: other products' names (content/validate.mjs), so Intel's EMR import layouts are described
// without the vendors' names, and the AI apps and CRM Intel connects to without theirs; and demos and sales calls, which CareMetric does
// not offer (growth/playbook.mjs offersMeeting). Intel's published count of its datasets stays: the owner approved data-scale figures on
// 2026-11-16 (docs/INTEL_MARKETING_PLAYBOOK.md, "Decisions for the owner"), and a catalog's numbers are ones drafts may state.
const vendorEdit = replacement => `EMR vendors named on the page are written generically: "${replacement}"`;
const productEdit = replacement => `Other products named on the page are written generically: "${replacement}"`;
const generic = [
  [/Saved layouts cover HCHB, WellSky, Axxess and MatrixCare\./g, 'Saved layouts cover common home health and hospice EMR reports.', vendorEdit],
  [/Saved layouts support common reports from Homecare Homebase, WellSky, Axxess, and MatrixCare\. These are file-based imports; the listed layouts do not imply a live connection to those vendors\./g,
    'Saved layouts support common home health and hospice EMR reports. These are file-based imports, not live EMR connections.', vendorEdit],
  [/Scheduled MatrixCare delivery/g, 'Scheduled EMR report delivery', vendorEdit],
  [/MatrixCare reports can be delivered/g, 'Some EMR reports can be delivered', vendorEdit],
  [/\(or have MatrixCare deliver it on a schedule\)/g, '(or have a supported EMR deliver it on a schedule)', vendorEdit],
  [/start from a saved layout for Homecare Homebase, WellSky, Axxess, or MatrixCare\. These are file-based imports; the listed layouts do not imply a live vendor connection\./g,
    'start from a saved layout for a common home health or hospice EMR report. These are file-based imports, not live EMR connections.', vendorEdit],
  [/connect Claude, ChatGPT or any MCP app to Intel/g, 'connect an AI app that supports MCP to Intel', productEdit],
  [/accounts to HubSpot as companies/g, 'accounts to a supported CRM as companies', productEdit],
  [/ ?You can also explore demo options with fictional facility data before setting up your own organization\./g, '', () => 'A sentence offering demo options is left out: CareMetric offers no demos.'],
  [/without a sales call/g, 'on your own', () => '"Without a sales call" is written "on your own": the team never mentions sales calls.'],
];
// The products the team never names (content/validate.mjs keeps the same list).
const vendors = /\b(HCHB|Homecare Homebase|WellSky|Axxess|MatrixCare|Trella|Definitive Healthcare|Marketware|Aline|WelcomeHome|PointClickCare|Yardi|Eldermark|ALIS|Relias|Caremerge|August Systems|Experience Care|eMARLink|Netsmart)\b/;
let edits = new Set();
function sanitize(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const [pattern, replacement, why] of generic) {
      pattern.lastIndex = 0;
      if (pattern.test(out)) { edits.add(why(replacement)); out = out.replace(pattern, replacement); }
    }
    if (vendors.test(out)) throw new Error(`Another product is named and has no generic wording yet: "${out.slice(0, 160)}". Add a rule to \`generic\`.`);
    return out;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  return value;
}

/** Intel's primary audience, in the fact sheet's order (server/agents/creative/copy.mjs `segments`; owner decision 2026-11-16). */
const intelPrimarySettings = ['Home health agencies', 'Hospice agencies', 'Hospitals', 'Nursing homes', 'Personal care homes'];

export function extractIntel(home, features) {
  const areas = [...features.matchAll(/<section id="([a-z-]+)" class="cm-features-area"[\s\S]*?<\/section>/g)].map(([section, key]) => ({
    key,
    name: clean(first(/<h2[^>]*>([\s\S]*?)<\/h2>/, section)),
    intro: clean(first(/<\/h2>\s*<p>([\s\S]*?)<\/p>/, section)),
    features: [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, item]) => item).filter(item => /<h3>/.test(item)).map(item => {
      const paragraphs = [...item.matchAll(/<p( class="cm-features-access")?>([\s\S]*?)<\/p>/g)];
      return {
        name: clean(first(/<h3>([\s\S]*?)<\/h3>/, item)),
        does: paragraphs.filter(([, access]) => !access).map(([, , text]) => clean(text)).join(' '),
        access: paragraphs.filter(([, access]) => access).map(([, , text]) => clean(text)).join(' ') || null,
      };
    }),
  }));
  const pillars = [...home.matchAll(/<article class="cm-capability-card">([\s\S]*?)<\/article>/g)].map(([, card]) => card)
    .filter(card => /cm-feature-number/.test(card) && /cm-feature-tag/.test(card))
    .map(card => ({ title: clean(first(/<h3>([\s\S]*?)<\/h3>/, card)), why: clean(first(/<\/h3>\s*<p>([\s\S]*?)<\/p>/, card)), area: clean(first(/<span class="cm-feature-tag">([\s\S]*?)<\/span>/, card)) }));
  const cardsOf = html => [...html.matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map(([, name, text]) => ({ name: clean(name), text: clean(text) }));
  // Each care setting the home page names: the cards of its care-settings grid, which ends with the grid's last card. The note under the
  // grid (every plan welcomes other specialties; coverage varies by setting) is one of the site's caveats.
  const grid = home.slice(home.indexOf('cm-care-settings-grid'));
  const settingCards = cardsOf(grid.slice(0, grid.indexOf('</article></div>')));
  const settingsNote = clean(first(/<p class="cm-plan-note">([\s\S]*?)<\/p>/, sectionOf(home, 'care-settings')));
  // Intel's primary audience (owner decision 2026-11-16, docs/GTM_FACTS.md "For" and "Secondary markets"), by name and in the fact
  // sheet's order wherever the site lists them; every other setting is a secondary market. The tests hold the five to the fact sheet.
  const settings = intelPrimarySettings.map(name => settingCards.find(card => card.name.toLowerCase() === name.toLowerCase())).filter(Boolean);
  const otherSettings = settingCards.filter(card => !settings.includes(card));
  // The manager view: its own section's numbered outcomes ("Focus the work before the week starts", ...).
  const managers = cardsOf(first(/<ul class="cm-outcome-list">([\s\S]*?)<\/ul>/, sectionOf(home, 'for-managers')) ?? '');
  const tabs = Object.fromEntries([...home.matchAll(/id="(_R_[^"]+-tab-\d+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?\s*<span>([\s\S]*?)<\/span>/g)].map(([, tab, label]) => [tab, clean(label)]));
  const data = [...home.matchAll(/role="tabpanel" aria-labelledby="([^"]+)"[^>]*class="cm-data-panel"[^>]*>([\s\S]*?<p class="cm-data-limit">[\s\S]*?<\/p>)/g)].map(([, tab, panel]) => ({
    family: tabs[tab] ?? null,
    headline: clean(first(/<h3>([\s\S]*?)<\/h3>/, panel)),
    includes: [...panel.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, item]) => clean(item)),
    source: clean(first(/<strong>Source<\/strong>\s*<p>([\s\S]*?)<\/p>/, panel)),
    question: clean(first(/<h4>([\s\S]*?)<\/h4>/, panel)),
    decision: clean(first(/<\/h4>\s*<p>([\s\S]*?)<\/p>/, panel)),
    limit: clean(first(/<p class="cm-data-limit">([\s\S]*?)<\/p>/, panel)),
  }));
  const faq = [];
  for (const [, block] of home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let found;
    try { found = JSON.parse(block); } catch { continue; }
    for (const node of found?.['@graph'] ?? [found]) {
      if (node?.['@type'] === 'FAQPage') for (const item of node.mainEntity ?? []) faq.push({ question: item.name, answer: item.acceptedAnswer?.text ?? '' });
    }
  }
  const caveats = [];
  for (const html of [home, features]) {
    for (const [, fragment] of html.matchAll(/<p[^>]*>((?:Feature availability|Coverage depends|Available research and analysis)[\s\S]*?)<\/p>/g)) {
      const text = clean(fragment);
      if (!caveats.includes(text)) caveats.push(text);
    }
  }
  if (settingsNote && !caveats.includes(settingsNote)) caveats.push(settingsNote);
  const count = /<p>(\d+)(?:<!-- -->)?\s*features in/.exec(features);
  return sanitize({
    overview: clean(first(/<p class="cm-hero-description">([\s\S]*?)<\/p>/, home)),
    legend: clean(first(/<p class="cm-features-legend">([\s\S]*?)<\/p>/, features)),
    publishedCount: count ? Number(count[1]) : null,
    pillars, areas, data,
    settings, otherSettings, managers,
    // Purchasing and the end of the trial are the fact sheet's (prices come from Intel's catalog); the rest are product answers.
    faq: faq.filter(item => !/^(How do we purchase|What happens when the trial ends)/.test(item.question)),
    caveats,
  });
}

/** The page without what the extractors never read: drawings, attributes and comments. */
const plain = html => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<([a-z][a-z0-9]*)\s[^>]*?(\/?)>/gi, '<$1$2>');

function faqOf(html, skip = /^$/) {
  const faq = [];
  for (const [, block] of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let found;
    try { found = JSON.parse(block); } catch { continue; }
    for (const node of found?.['@graph'] ?? (Array.isArray(found) ? found : [found])) {
      if (node?.['@type'] === 'FAQPage') for (const item of node.mainEntity ?? []) if (!skip.test(item.name)) faq.push({ question: item.name, answer: item.acceptedAnswer?.text ?? '' });
    }
  }
  return faq;
}

/** A page's `<section id="…">`, as published (empty when the page has none). */
function sectionOf(html, id) {
  const start = html.search(new RegExp(`<section\\b[^>]*\\bid="${id}"`));
  return start < 0 ? '' : html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
}

/**
 * CareBase's capability index (cmcarebase.com/features#capability-index): one card per area (`<article id="resident-care">`), each with
 * its published count, name, a line on what it is for, the plan or add-on it needs, every capability, and any note under the list.
 */
function capabilityAreas(features) {
  return [...sectionOf(features, 'capability-index').matchAll(/<article\b[^>]*\bid="([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/article>/g)].map(([, key, html]) => {
    const card = plain(html);
    const count = first(/(\d+) capabilit(?:y|ies)\b/, clean(first(/^([\s\S]*?)<h3>/, card)));
    return {
      key,
      name: clean(first(/<h3>([\s\S]*?)<\/h3>/, card)),
      intro: clean(first(/<\/h3><p>([\s\S]*?)<\/p>/, card)),
      plan: clean(first(/<\/h3><p>[\s\S]*?<\/p><p>([\s\S]*?)<\/p><ul>/, card)),
      count: count === null ? null : Number(count),
      capabilities: [...(first(/<ul>([\s\S]*?)<\/ul>/, card) ?? '').matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, item]) => clean(item)),
      note: clean(first(/<\/ul><p>([\s\S]*?)<\/p>/, card)) || null,
    };
  });
}

export function extractCarebase({ home, features, faq }) {
  const f = plain(features);
  const h = plain(home);
  const areas = capabilityAreas(features);
  const index = plain(sectionOf(features, 'capability-index'));
  // The newest tools ("A closer look"): each card's last label is the tool's name, whatever the label before it ("New", "In focus").
  const newest = [...plain(sectionOf(features, 'recently-shipped')).matchAll(/<span>([^<]+)<\/span><\/div><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p>/g)]
    .map(([, name, headline, text]) => ({ name: clean(name), headline: clean(headline), does: clean(text) }));
  const lifecycle = [...plain(sectionOf(features, 'resident-lifecycle')).matchAll(/<li><div><span>\d\d<\/span><div><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p>/g)]
    .map(([, step, text]) => ({ step: clean(step), text: clean(text) }));
  const roles = [...plain(sectionOf(features, 'roles')).matchAll(/<span>\d\d<\/span><h3>([\s\S]*?)<\/h3><\/div><p><span>Sees<\/span>([\s\S]*?)<\/p><p><span>Does<\/span>([\s\S]*?)<\/p>/g)]
    .map(([, role, sees, does]) => ({ role: clean(role), sees: clean(sees), does: clean(does) }));
  const pillars = [...h.matchAll(/<span>0\d<\/span><span>([^<]+)<\/span><\/div><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p>/g)].map(([, area, title, why]) => ({ title: clean(title), why: clean(why), area: clean(area) }));
  // The tools that set it apart: each a heading, what it does, and a closing line; the "What sets it apart" section only.
  const apartFrom = h.indexOf('What sets it apart');
  const apart = apartFrom < 0 ? [] : [...h.slice(apartFrom, h.indexOf('</section>', apartFrom)).matchAll(/<h3>([\s\S]*?)<\/h3>((?:<p>[\s\S]*?<\/p>)+)/g)].map(([, title, paragraphs]) => {
    const parts = [...paragraphs.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(([, text]) => clean(text)).filter(Boolean);
    return { title: clean(title), why: parts.slice(0, -1).join(' ') || parts[0], area: parts.length > 1 ? parts.at(-1) : 'What sets it apart' };
  });
  const beforeAfter = [...h.matchAll(/<span><span>Before: <\/span>([\s\S]*?)<\/span><span><span>With CareBase: <\/span>([\s\S]*?)<\/span>/g)].map(([, before, after]) => ({ before: clean(before), after: clean(after) }));
  const chapters = [...h.matchAll(/<span>(55 Pa\. Code Chapter \d+)<\/span><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p><p>([\s\S]*?)<\/p><ul>([\s\S]*?)<\/ul>/g)].map(([, chapter, title, text, record, list]) => ({
    chapter: clean(chapter), title: clean(title), text: `${clean(text)} ${clean(record)}`.trim(), highlights: [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, item]) => clean(item)),
  }));
  // The page's own figure ("112 capabilities across 8 areas"), which the refresh checks against what it read.
  const published = /(\d+)\+? capabilities across (\d+)\b/.exec(clean(f));
  const intro = /The full capability index[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(f)?.[1];
  // Which plan covers what: the note beside the index's heading ("A plan that fits your facility"), a title, its text and a link.
  const plans = /<div><p>[^<]*<\/p><p>([\s\S]*?)<\/p><a>/.exec(index)?.[1];
  const caveats = [
    ...apart.flatMap(item => (/not a prediction/.test(item.why) ? [item.why.split('. ').find(sentence => /not a prediction/.test(sentence))] : [])),
    ...faqOf(faq).filter(item => /^Does it guarantee|^What does it not replace/.test(item.question)).map(item => item.answer),
  ].filter(Boolean);
  return sanitize({
    overview: clean(/<\/h1>[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(h)?.[1]),
    summary: clean(/In plain English[\s\S]*?<\/h2>(?:<\/div>)?<p>([\s\S]*?)<\/p>/.exec(h)?.[1]),
    intro: clean(intro), legend: clean(plans),
    publishedCount: published ? Number(published[1]) : null,
    publishedAreas: published ? Number(published[2]) : null,
    pillars: [...pillars, ...apart], areas, newest, lifecycle, roles, beforeAfter, chapters,
    // Prices are the fact sheet's (read from billing); the rest are product answers.
    faq: faqOf(faq, /^How much does it cost/),
    caveats: [...new Set(caveats)],
  });
}

export const products = {
  'caremetric-intel': {
    file: 'intel-features.json', site: 'https://www.caremetricintel.com',
    pages: { home: ['/', 'intel-home.html'], features: ['/features', 'intel-features.html'] },
    extract: ({ home, features }) => extractIntel(home, features),
    check: body => {
      const total = body.areas.reduce((sum, area) => sum + area.features.length, 0);
      // All five primary settings, the manager outcomes, and no pillar read as a care setting or a manager outcome.
      const strays = [...body.settings, ...body.otherSettings, ...body.managers].filter(card => body.pillars.some(pillar => pillar.title === card.name)).length;
      if (body.areas.length < 5 || total < 50 || body.data.length < 5 || body.pillars.length < 5 || body.settings.length !== 5 || body.managers.length < 3 || strays) {
        throw new Error(`Intel's pages changed shape (areas ${body.areas.length}, features ${total}, data ${body.data.length}, pillars ${body.pillars.length}, settings ${body.settings.length}, managers ${body.managers.length}${strays ? `, ${strays} pillars read as settings or managers` : ''}); update the extractor.`);
      }
      if (body.publishedCount && body.publishedCount !== total) throw new Error(`Intel's features page says ${body.publishedCount} features but ${total} were read.`);
      return `${body.areas.length} areas, ${total} features, ${body.data.length} data families and ${body.faq.length} answers`;
    },
  },
  carebase: {
    file: 'carebase-features.json', site: 'https://cmcarebase.com',
    pages: { home: ['/', 'carebase-home.html'], features: ['/features', 'carebase-features.html'], faq: ['/faq', 'carebase-faq.html'] },
    extract: pages => extractCarebase(pages),
    check: body => {
      const total = body.areas.reduce((sum, area) => sum + area.capabilities.length, 0);
      // An area read without its name, its line, its plan or every capability it counts; a chapter card read as a reason to choose it.
      const partial = body.areas.filter(area => !area.name || !area.intro || !area.plan || area.capabilities.length !== area.count).map(area => area.key);
      const strays = body.pillars.filter(pillar => body.chapters.some(chapter => chapter.title === pillar.title)).length;
      if (!body.overview || !body.summary || !body.intro || !body.legend || body.areas.length < 6 || total < 80 || partial.length || body.pillars.length < 3 || strays
        || !body.newest.length || body.roles.length < 4 || body.lifecycle.length < 4 || body.beforeAfter.length < 2 || body.chapters.length < 2 || body.faq.length < 10) {
        throw new Error(`CareBase's pages changed shape (areas ${body.areas.length}, capabilities ${total}${partial.length ? `, partly read: ${partial.join(', ')}` : ''}, pillars ${body.pillars.length}${strays ? ` (${strays} from the chapters)` : ''}, newest ${body.newest.length}, roles ${body.roles.length}, lifecycle ${body.lifecycle.length}, before and after ${body.beforeAfter.length}, chapters ${body.chapters.length}, answers ${body.faq.length}${body.intro && body.legend ? '' : ', no intro or plan note'}); update the extractor.`);
      }
      if (body.publishedCount !== total || body.publishedAreas !== body.areas.length) {
        throw new Error(`CareBase's features page says ${body.publishedCount ?? 'no number of'} capabilities across ${body.publishedAreas ?? 'no number of'} areas but ${total} across ${body.areas.length} were read.`);
      }
      return `${body.areas.length} areas, ${total} capabilities, ${body.pillars.length} reasons and ${body.faq.length} answers`;
    },
  },
};

async function main() {
  const from = option('--from');
  const only = option('--only');
  if (only && !products[only]) throw new Error(`--only takes one of: ${Object.keys(products).join(', ')}.`);
  let stale = false;
  for (const [product, spec] of Object.entries(products)) {
    if (only && product !== only) continue;
    const pages = Object.fromEntries(await Promise.all(Object.entries(spec.pages).map(async ([name, [path, saved]]) => [name, await page(spec.site, path, from ? `${from}/${saved}` : null)])));
    edits = new Set();
    const body = spec.extract(pages);
    const summary = spec.check(body);
    const catalog = {
      product,
      sources: Object.fromEntries(Object.entries(spec.pages).map(([name, [path]]) => [name, `${spec.site}${path}`])),
      contentSha256: createHash('sha256').update(Object.values(pages).map(pageText).join('\n')).digest('hex').slice(0, 16),
      edits: [...edits].sort(),
      ...body,
    };
    const target = new URL(`../server/agents/content/${spec.file}`, import.meta.url);
    const current = await readFile(target, 'utf8').then(JSON.parse).catch(() => null);
    const comparable = value => JSON.stringify({ ...value, reviewed: undefined });
    if (args.includes('--check')) {
      if (!current || comparable(current) !== comparable(catalog)) { console.error(`${product}: the published features changed; run npm run refresh:features and review the diff.`); stale = true; }
      else console.log(`${product}: current (${summary}).`);
      continue;
    }
    const reviewed = current && comparable(current) === comparable(catalog) ? current.reviewed : new Date().toISOString().slice(0, 10);
    await writeFile(target, `${JSON.stringify({ reviewed, ...catalog }, null, 2)}\n`);
    console.log(`${product}: wrote ${summary}.`);
  }
  if (stale) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
