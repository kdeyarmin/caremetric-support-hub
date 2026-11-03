/**
 * What the weekly report makes of Search Console's figures. Pure: the same figures always give the same insights.
 *
 * - Each property's clicks, impressions, click-through rate and average position, against the 28 days before, with its top
 *   searches and top pages.
 * - Striking distance: searches where a site sits just off the first page (average position 8 to 20) and is seen often enough
 *   to matter. Moving those up is the cheapest win there is.
 * - Seen often, rarely clicked: first-page pages clicked less than half as often as a result in their position usually is,
 *   whose title and description are worth rewriting.
 * - Competing: searches for which pages on two of the company's own hosts both appear (cmcarebase.com and home.cmcarebase.com,
 *   say), so the two split what one page would earn.
 *
 * A search someone typed is shown only when it does not look personal: one that holds an email address, or a phone number or
 * another long run of digits, is left out of the report and away from the model.
 */
import { addressKey, clip, pageLimit } from './audit.mjs';

export const thresholds = Object.freeze({
  top: 5, strikingFrom: 8, strikingTo: 20, strikingImpressions: 20, lowCtrImpressions: 100, lowCtrPosition: 10, lowCtrShare: 0.5, competingImpressions: 10,
});

// The share of searchers who click a result in each first-page position, roughly as published click-through studies report it.
export const typicalCtr = Object.freeze([0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.03, 0.025]);
export const typicalFor = position => typicalCtr[Math.min(Math.max(Math.round(position), 1), typicalCtr.length) - 1];

export const queryLimit = 80;
const personal = /@|\d(?:[\s().-]?\d){6,}/;

/**
 * A search with control and markup characters taken out and its spacing tidied, whole, or null when it should not appear at all.
 * Searches are told apart by this: two long searches that begin the same are still two searches.
 */
export function sanitizeQuery(raw) {
  const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return !text || personal.test(text) ? null : text;
}

/** A search as the report and the prompt show it, cut to `queryLimit` characters. Only what is shown is cut. */
export function cleanQuery(raw) {
  const text = sanitizeQuery(raw);
  return text === null ? null : clip(text, queryLimit);
}

/** A page address Search Console reported, or null when it is not an http(s) address. */
export function cleanPage(raw) {
  try {
    const url = new URL(String(raw ?? ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

const hostOf = address => { try { return new URL(address).host.toLowerCase(); } catch { return ''; } };
// Searches sort by their whole text (`key`), pages by their address, so the order never depends on how a label was cut.
const byName = (a, b) => (a.key ?? a.page).localeCompare(b.key ?? b.page);
const byClicks = (a, b) => b.clicks - a.clicks || b.impressions - a.impressions || byName(a, b);
const byImpressions = (a, b) => b.impressions - a.impressions || b.clicks - a.clicks || byName(a, b);
const metrics = row => ({ clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position });
const percentChange = (now, before) => (before > 0 ? (now - before) / before : null);
/** A search row: `key` is the whole search in lower case, what rows are matched and grouped by; `query` is its label. */
const searchRow = (raw, fields) => {
  const text = sanitizeQuery(raw);
  return text === null ? null : { key: text.toLowerCase(), query: clip(text, queryLimit), ...fields };
};
const withoutKey = ({ key: _key, ...row }) => row;
/** The rows with a key not seen before, in order: the first of each wins, and nothing is added up. */
const firstOf = (rows, keyOf) => {
  const seen = new Set();
  return rows.filter(row => { const key = keyOf(row); if (seen.has(key)) return false; seen.add(key); return true; });
};

/**
 * `read` is what searchConsoleReader().read() returned; `owners` are the company's hosts (the sites and their other addresses).
 * Returns { window, sites, striking, lowCtr, competing, failures, queriesFor(url) }: at most five of each list, worst or largest
 * first, and `queriesFor` gives the top searches that show one page (for the rewrite suggestions).
 */
export function searchInsights(read, { owners = [], limits = {} } = {}) {
  const config = { ...thresholds, ...limits };
  const ownerHosts = new Set(owners.map(host => String(host).toLowerCase()));
  const readable = (read?.properties ?? []).filter(entry => entry.ok);
  const failures = (read?.properties ?? []).filter(entry => !entry.ok).map(entry => ({ property: entry.property, code: entry.code, status: entry.status ?? null }));

  const sites = [];
  const striking = [];
  const lowCtr = [];
  const pairs = new Map();
  for (const entry of readable) {
    const { current, previous } = entry.totals;
    const queries = entry.queries.map(row => searchRow(row.keys[0], metrics(row))).filter(Boolean);
    const pages = entry.pages.map(row => ({ page: cleanPage(row.keys[0]), ...metrics(row) })).filter(row => row.page);
    const ownPairs = entry.pairs.map(row => {
      const page = cleanPage(row.keys[1]);
      return page ? searchRow(row.keys[0], { page, ...metrics(row) }) : null;
    }).filter(Boolean);
    // The same search and page can come from two properties (a domain property and an address prefix inside it): counted once.
    for (const row of ownPairs) { const key = `${row.key}\n${addressKey(row.page)}`; if (!pairs.has(key)) pairs.set(key, { ...row, property: entry.property }); }
    const bestPage = key => ownPairs.filter(row => row.key === key).sort(byImpressions)[0]?.page ?? null;

    sites.push({
      property: entry.property, totals: { current, previous },
      change: {
        clicks: percentChange(current.clicks, previous.clicks), impressions: percentChange(current.impressions, previous.impressions),
        ctr: previous.impressions > 0 && current.impressions > 0 ? current.ctr - previous.ctr : null,
        position: previous.position > 0 && current.position > 0 ? current.position - previous.position : null,
      },
      topQueries: [...queries].sort(byClicks).slice(0, config.top).map(withoutKey),
      topPages: [...pages].sort(byClicks).slice(0, config.top),
    });
    for (const row of queries) {
      if (row.position >= config.strikingFrom && row.position <= config.strikingTo && row.impressions >= config.strikingImpressions) striking.push({ property: entry.property, ...row, page: bestPage(row.key) });
    }
    for (const row of pages) {
      if (row.impressions < config.lowCtrImpressions || !(row.position > 0) || row.position > config.lowCtrPosition) continue;
      const typical = typicalFor(row.position);
      if (row.ctr < typical * config.lowCtrShare) lowCtr.push({ property: entry.property, ...row, typical });
    }
  }

  // Competing: one search, pages on two or more of the company's own hosts. Each host is represented by its most-seen page.
  const bySearch = new Map();
  for (const row of pairs.values()) {
    const host = hostOf(row.page);
    if (!ownerHosts.has(host)) continue;
    const hosts = bySearch.get(row.key) ?? new Map();
    const best = hosts.get(host);
    if (!best || byImpressions(row, best) < 0) hosts.set(host, row);
    bySearch.set(row.key, hosts);
  }
  const competing = [...bySearch.entries()].filter(([, hosts]) => hosts.size > 1).map(([key, hosts]) => {
    const rows = [...hosts.entries()].map(([host, row]) => ({ host, page: row.page, clicks: row.clicks, impressions: row.impressions, position: row.position })).sort(byImpressions);
    return { key, query: [...hosts.values()][0].query, impressions: rows.reduce((sum, row) => sum + row.impressions, 0), clicks: rows.reduce((sum, row) => sum + row.clicks, 0), hosts: rows };
  }).filter(entry => entry.impressions >= config.competingImpressions).sort(byImpressions).slice(0, config.top).map(withoutKey);

  const pageQueries = new Map();
  for (const row of pairs.values()) {
    const key = addressKey(row.page);
    pageQueries.set(key, [...(pageQueries.get(key) ?? []), row]);
  }

  // Overlapping properties (a domain property and an address prefix inside it) report the same rows. Each row is listed once, with the
  // figures of the first property in HUB_SEARCH_CONSOLE_SITES that reported it (never a sum of the two), before a list is cut to five.
  return {
    window: read?.window ?? null,
    sites, failures, competing,
    striking: firstOf(striking, row => `${row.key}\n${row.page ? addressKey(row.page) : ''}`).sort(byImpressions).slice(0, config.top).map(withoutKey),
    lowCtr: firstOf(lowCtr, row => addressKey(row.page)).sort(byImpressions).slice(0, config.top),
    /** The searches that show a page most often, at most five, as labels, for the rewrite suggestions. */
    queriesFor: url => [...(pageQueries.get(addressKey(url)) ?? [])].sort(byImpressions).slice(0, config.top).map(row => row.query),
  };
}

/** A page address as the report shows it: the address itself, cut to the length every finding uses. */
export const shownPage = url => clip(url, pageLimit);
