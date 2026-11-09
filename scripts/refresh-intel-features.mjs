#!/usr/bin/env node
/**
 * Rebuilds server/agents/content/intel-features.json, CareMetric Intel's published feature catalog, from Intel's own public pages:
 * https://www.caremetricintel.com/features (every feature, its area and the plan or role it needs) and the home page (why each area
 * matters, the data behind it with its sources and limits, the care settings, the manager view, and the questions and answers).
 *
 *   npm run refresh:intel-features                      # fetch both pages
 *   node scripts/refresh-intel-features.mjs --home home.html --features features.html   # from saved copies
 *   node scripts/refresh-intel-features.mjs --check     # fail if the committed catalog differs from the live pages
 *
 * The AI team may not name other products, so the EMR vendors Intel names for its CSV imports are written generically here (and the
 * catalog says so in `edits`). Nothing else is reworded. Review the diff before committing.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const target = new URL('../server/agents/content/intel-features.json', import.meta.url);
const site = 'https://www.caremetricintel.com';
const args = process.argv.slice(2);
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

async function page(path, file) {
  if (file) return readFile(file, 'utf8');
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

// The AI team names no other product (content/validate.mjs), so Intel's EMR import layouts are described without the vendors' names.
const generic = [
  [/Saved layouts cover HCHB, WellSky, Axxess and MatrixCare\./g, 'Saved layouts cover common home health and hospice EMR reports.'],
  [/Saved layouts support common reports from Homecare Homebase, WellSky, Axxess, and MatrixCare\. These are file-based imports; the listed layouts do not imply a live connection to those vendors\./g,
    'Saved layouts support common home health and hospice EMR reports. These are file-based imports, not live EMR connections.'],
  [/Scheduled MatrixCare delivery/g, 'Scheduled EMR report delivery'],
  [/MatrixCare reports can be delivered/g, 'Some EMR reports can be delivered'],
];
const vendors = /\b(HCHB|Homecare Homebase|WellSky|Axxess|MatrixCare|Trella|Definitive Healthcare|Marketware|Aline|WelcomeHome)\b/;
const edits = new Set();
function sanitize(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const [pattern, replacement] of generic) {
      pattern.lastIndex = 0;
      if (pattern.test(out)) { edits.add(`EMR vendors named on the page are written generically: "${replacement}"`); out = out.replace(pattern, replacement); }
    }
    if (vendors.test(out)) throw new Error(`Another product is named and has no generic wording yet: "${out.slice(0, 160)}". Add a rule to \`generic\`.`);
    return out;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  return value;
}

export function extract(home, features) {
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
  let cards = home.slice(home.indexOf('cm-care-settings-grid'));
  cards = cards.slice(0, cards.indexOf('</div></div>'));
  const settingCards = [...cards.matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map(([, name, text]) => ({ name: clean(name), text: clean(text) }));
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
  const count = /<p>(\d+)(?:<!-- -->)?\s*features in/.exec(features);
  return sanitize({
    overview: clean(first(/<p class="cm-hero-description">([\s\S]*?)<\/p>/, home)),
    legend: clean(first(/<p class="cm-features-legend">([\s\S]*?)<\/p>/, features)),
    publishedCount: count ? Number(count[1]) : null,
    pillars, areas, data,
    settings: settingCards.slice(0, 5), managers: settingCards.slice(5),
    // Purchasing and the end of the trial are the fact sheet's (prices come from Intel's catalog); the rest are product answers.
    faq: faq.filter(item => !/^(How do we purchase|What happens when the trial ends)/.test(item.question)),
    caveats,
  });
}

async function main() {
  const [home, features] = await Promise.all([page('/', option('--home')), page('/features', option('--features'))]);
  const body = extract(home, features);
  const total = body.areas.reduce((sum, area) => sum + area.features.length, 0);
  if (body.areas.length < 5 || total < 50 || body.data.length !== 5 || body.pillars.length < 5 || body.settings.length !== 5) {
    throw new Error(`The pages changed shape (areas ${body.areas.length}, features ${total}, data ${body.data.length}, pillars ${body.pillars.length}, settings ${body.settings.length}); update the extractor.`);
  }
  if (body.publishedCount && body.publishedCount !== total) throw new Error(`The features page says ${body.publishedCount} features but ${total} were read.`);
  const catalog = {
    product: 'caremetric-intel',
    sources: { features: `${site}/features`, home: `${site}/` },
    contentSha256: createHash('sha256').update(`${pageText(home)}\n${pageText(features)}`).digest('hex').slice(0, 16),
    edits: [...edits].sort(),
    ...body,
  };
  const current = await readFile(target, 'utf8').then(JSON.parse).catch(() => null);
  const comparable = value => JSON.stringify({ ...value, reviewed: undefined });
  if (args.includes('--check')) {
    if (!current || comparable(current) !== comparable(catalog)) { console.error('Intel\'s published features changed: run npm run refresh:intel-features and review the diff.'); process.exit(1); }
    console.log(`Intel feature catalog is current (${total} features).`);
    return;
  }
  const reviewed = current && comparable(current) === comparable(catalog) ? current.reviewed : new Date().toISOString().slice(0, 10);
  await writeFile(target, `${JSON.stringify({ reviewed, ...catalog }, null, 2)}\n`);
  console.log(`Wrote ${body.areas.length} areas, ${total} features, ${body.data.length} data families and ${body.faq.length} answers.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
