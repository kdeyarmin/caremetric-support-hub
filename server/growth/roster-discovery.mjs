/**
 * Prospects from the CMS roster: the second discovery source, beside the generic web searches (worker.mjs `discover`).
 *
 * Every Medicare-certified home health agency and hospice is in CMS's Provider of Services file, which Intel serves to the Hub
 * (roster.mjs). Each daily discovery run reads the agencies in Intel's market states (playbook.mjs `rosterPlan`) that CMS shows as
 * newly certified, or as changing owners, in the last 18 months: new agencies and new owners are the ones choosing their software and
 * looking for referral data. A terminated or closed agency is left out. The most recent change comes first.
 *
 * The roster has no website. For up to `rosterSearchLimit` agencies an Eastern day, one search each (the same provider, pacing and
 * time limit as the rest of the run) looks for the agency's own site by its name, city and state. A result is taken only when its
 * domain carries the agency's name, most of the name appears in the domain or the page title, the result talks about care, and the
 * host is never a directory, listing, government or social site (playbook.mjs `operatorHost`). The agency is then recorded as a
 * CareMetric Intel prospect through the usual discovery path, with two pieces of evidence: the public CMS facts, sourced to its
 * Medicare Care Compare page, and the search result from its own site.
 *
 * Every agency searched is remembered in the database (private.growth_roster_searches): one matched to a site is never searched
 * again, and one with no site found is not searched again for 180 days (a new agency often has no website yet). Searches stop early
 * when the run's time is spent, when the search provider fails or reports less than a quarter of its allowance left, and at the day's
 * limit, including searches made by an earlier run the same day. Nothing here can fail the run: a failure ends the roster step and is
 * reported by code beside the counts. Only counts, the CMS quarter and that code are returned, never a name or an address.
 */
import { markets } from '../agents/marketing.mjs';
import { operatorHost, rosterPlan, stateName } from './playbook.mjs';
import { readRoster, rosterPageLimit } from './roster.mjs';

/** The roster lists home health agencies and hospices: Intel's segment (see playbook.mjs `rosterPlan`). */
export const rosterProduct = 'caremetric-intel';
/** Searches for agencies' websites per Eastern day, at most. */
export const rosterSearchLimit = 10;
/** How far back a certification or a change of ownership counts as recent: about 18 months. */
export const rosterSignalDays = 548;
/** Pages of 500 read per roster query each run (two queries: changes of ownership, then new certifications). */
export const rosterPagesPerRead = 4;
/** Roster searches stop when the search provider says less than this share of its allowance is left. */
export const rosterAllowanceReserve = 0.25;

const easternDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const shiftDay = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const pause = (ms, signal) => (ms > 0 ? new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', stop, { once: true });
}) : Promise.resolve());

/** The recent changes CMS records for a facility: none for one that is terminated or closed. */
export function rosterSignals(facility, { since, today }) {
  if (facility.termination_date || (facility.signals ?? []).some(entry => entry.type === 'closed')) return [];
  const recent = date => typeof date === 'string' && date >= since && date <= today;
  return [
    ...(recent(facility.change_of_ownership_date) ? [{ kind: 'change_of_ownership', date: facility.change_of_ownership_date }] : []),
    ...(recent(facility.certification_date) ? [{ kind: 'newly_certified', date: facility.certification_date }] : []),
  ];
}

/** The facilities worth a search, once each, in order: the most recent change first, then the state's place in `states`, then CCN. */
export function rosterChoices(items, { since, today, states }) {
  const rank = new Map(states.map((state, index) => [state, index]));
  const once = new Map();
  for (const item of items) if (rank.has(item.state) && !once.has(item.ccn)) once.set(item.ccn, item);
  return [...once.values()]
    .map(item => ({ item, signals: rosterSignals(item, { since, today }) }))
    .filter(entry => entry.signals.length)
    .map(entry => ({ ...entry, latest: entry.signals.reduce((latest, found) => (found.date > latest ? found.date : latest), '') }))
    .sort((a, b) => b.latest.localeCompare(a.latest) || rank.get(a.item.state) - rank.get(b.item.state) || a.item.ccn.localeCompare(b.item.ccn));
}

const words = text => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// Words that say what kind of company it is, or what it does, rather than which one.
const legalWords = new Set(['inc', 'incorporated', 'llc', 'llp', 'ltd', 'limited', 'corp', 'corporation', 'company', 'pllc', 'plc', 'dba']);
const genericWords = new Set(['the', 'and', 'for', 'home', 'homes', 'health', 'healthcare', 'care', 'cares', 'caring', 'hospice', 'hospices', 'palliative',
  'agency', 'agencies', 'service', 'services', 'svc', 'svcs', 'nursing', 'nurse', 'nurses', 'visiting', 'medical', 'skilled', 'private', 'duty',
  'center', 'centre', 'ctr', 'group', 'network', 'solutions', 'associates', 'association', 'assoc', 'community', 'county', 'north', 'south', 'east',
  'west', 'northern', 'southern', 'eastern', 'western', 'central', 'northeast', 'northwest', 'southeast', 'southwest', 'greater', 'metro', 'area',
  'region', 'regional', 'vna', 'hha', 'end', 'life', 'inhome', 'homecare', 'homehealth', 'staffing', 'provider', 'providers', 'america', 'usa']);

/** The name the agency trades as: the part after "DBA" when CMS lists a legal name and a trading name. */
export function tradingName(name) {
  const parts = String(name ?? '').split(/\b(?:d\s*\/\s*b\s*\/\s*a|d\.b\.a\.?|dba)(?=\W|$)/i);
  const last = parts[parts.length - 1].replace(/^[\s,.:;()-]+|[\s,.:;()-]+$/g, '').trim();
  return last || String(name ?? '').trim();
}
const shouted = new Set(['llc', 'llp', 'pllc', 'vna', 'hha', 'usa', 'ii', 'iii', 'iv']);
const minor = new Set(['of', 'the', 'and', 'at', 'in', 'for', 'by', 'a', 'an', 'on', 'to', 'de', 'la', 'del']);
const titled = text => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase().split(' ').map((word, index) => {
  const bare = word.replace(/[^a-z0-9]/g, '');
  if (shouted.has(bare)) return word.toUpperCase();
  return index > 0 && minor.has(bare) ? word : word.replace(/[a-z]/, letter => letter.toUpperCase());
}).join(' ');
/** CMS lists names in capitals; the prospect gets its trading name in ordinary capitals ("Valley Hospice"). */
export const displayName = name => titled(tradingName(name)).slice(0, 200);

/** The words that tell this agency apart: its name without legal, generic and place words (its city and state). */
export function nameTokens(facility) {
  const place = new Set([...words(facility.city), ...words(facility.state), ...words(stateName(facility.state))]);
  return [...new Set(words(tradingName(facility.name)).filter(word => word.length >= 3 && !legalWords.has(word) && !genericWords.has(word) && !place.has(word)))];
}
/** Whether a site could ever be matched to the name: "Home Health Care of Erie" says nothing a domain could be checked against. */
export const searchable = facility => nameTokens(facility).join('').length >= 4;

// The registrable label of a host: amedisys for pittsburgh.amedisys.com, valleyhospice for valleyhospice.org.
const secondLevel = /\.(?:co|com|org|net)\.[a-z]{2}$|\.[a-z]{2}\.us$/;
export const siteLabel = host => {
  const labels = String(host ?? '').toLowerCase().split('.');
  return (labels[labels.length - (secondLevel.test(String(host ?? '').toLowerCase()) ? 3 : 2)] ?? '').replace(/[^a-z0-9]/g, '');
};
const careWords = /hospice|palliative|home\s?health|home\s?care|in-?\s?home|nursing|caregiv|health\s?care/;

/**
 * Whether a search result is the agency's own website: an https page on the result's own host, a host that is never a directory
 * or listing, a domain that carries the agency's name (one of its distinctive words of four letters or more, or all of them run
 * together), at least half of those words in the domain or the page title, and care words in the host, title or snippet.
 */
export function matchesFacility(facility, row) {
  const host = String(row?.domain ?? '').toLowerCase().replace(/^www\./, '');
  let url;
  try { url = new URL(row?.url); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname.toLowerCase().replace(/^www\./, '') !== host || !operatorHost(host)) return false;
  const core = nameTokens(facility), joined = core.join('');
  if (joined.length < 4) return false;
  const label = siteLabel(host);
  if (!core.some(token => token.length >= 4 && label.includes(token)) && !label.includes(joined)) return false;
  const title = words(row.name).join('');
  if (core.filter(token => label.includes(token) || title.includes(token)).length < Math.ceil(core.length / 2)) return false;
  return careWords.test(`${host} ${row.name ?? ''} ${row.claim ?? ''}`.toLowerCase());
}

/** One search for the agency's own website: its trading name, what it does when the name does not say, its city and state. */
export function facilityQuery(facility) {
  const name = displayName(facility.name).replace(/\b(?:inc|llc|llp|lp|pc|pllc|ltd|corp|co)\b\.?/gi, ' ').replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();
  const kind = facility.setting === 'hospice' ? (/hospice/i.test(name) ? '' : 'hospice') : (/home\s?(?:health|care)/i.test(name) ? '' : 'home health');
  return [name, kind, facility.city ? titled(facility.city) : '', facility.state].filter(Boolean).join(' ').slice(0, 300);
}

/** The facility's public Medicare Care Compare page, the source of the CMS facts. */
export const careCompareUrl = facility => `https://www.medicare.gov/care-compare/details/${facility.setting === 'hospice' ? 'hospice' : 'home-health'}/${facility.ccn}`;

/** The public CMS facts, as evidence. Dates are CMS's own; words separate every number, so no figure reads as an identifier. */
export function rosterClaim(facility, signals, period) {
  const kind = facility.setting === 'hospice' ? 'hospice' : 'home health agency';
  const place = facility.city ? `${titled(facility.city)}, ${facility.state}` : facility.state;
  const certified = signals.find(found => found.kind === 'newly_certified');
  const changed = signals.find(found => found.kind === 'change_of_ownership');
  return [
    `CMS lists ${displayName(facility.name)} (CMS certification number ${facility.ccn}) as a Medicare-certified ${kind} in ${place} in its Provider of Services file${period ? ` for ${period}` : ''}.`,
    ...(certified ? [`Medicare certified it on ${certified.date}.`] : []),
    ...(changed ? [`CMS records a change of ownership on ${changed.date}.`] : []),
    'Its website was matched to this listing by name and place.',
  ].join(' ').slice(0, 4000);
}

/**
 * The roster step of the daily discovery run. Null when the roster is not set up (the feed's secret, Settings → Customer growth →
 * Find prospects in the CMS roster, the search provider and the database's roster memory are all needed) or Intel is not marketed:
 * the run is then exactly what it was without the roster.
 */
export async function rosterDiscovery({ growth, marketed = null, moment = new Date(), signal, pace = 0, spent = () => false }) {
  const feed = growth?.roster, plan = rosterPlan(rosterProduct);
  if (!feed?.configured || !growth.research?.configured || !plan || !markets(marketed, rosterProduct)
    || typeof growth.store?.rosterPending !== 'function' || typeof growth.store?.rosterSearched !== 'function') return null;
  const counts = { facilities: 0, recent: 0, due: 0, searched: 0, matched: 0, recorded: 0 };
  let period = null;
  const done = (stopped = null) => ({ ...(period ? { period } : {}), ...counts, ...(stopped ? { stopped } : {}) });
  const allowanceLow = () => {
    const allowance = growth.research.allowance?.();
    return Boolean(allowance && allowance.left < allowance.limit * rosterAllowanceReserve);
  };
  try {
    if (allowanceLow()) return done('search_allowance');
    const today = easternDay.format(moment), since = shiftDay(today, -rosterSignalDays);
    const items = [];
    for (const filter of [{ chowSince: since }, { certifiedSince: since }]) {
      if (spent()) return done('time');
      const read = await readRoster(feed, { states: plan.states, settings: plan.settings, limit: rosterPageLimit, ...filter }, { maxPages: rosterPagesPerRead, signal, spent });
      period = read.period ?? period;
      items.push(...read.items);
    }
    counts.facilities = new Set(items.map(item => item.ccn)).size;
    const recent = rosterChoices(items, { since, today, states: plan.states });
    counts.recent = recent.length;
    // A name with nothing distinctive in it could never be checked against a domain: no search is spent on it.
    const nameable = recent.filter(entry => searchable(entry.item));
    if (!nameable.length) return done();
    const pending = await growth.store.rosterPending(nameable.map(entry => entry.item.ccn));
    const due = new Set(Array.isArray(pending?.due) ? pending.due : []);
    const allowed = rosterSearchLimit - (Number.isInteger(pending?.searchedToday) ? pending.searchedToday : rosterSearchLimit);
    const queue = nameable.filter(entry => due.has(entry.item.ccn));
    counts.due = queue.length;
    for (const { item, signals } of queue) {
      if (counts.searched >= allowed) break;
      signal?.throwIfAborted();
      if (spent()) return done('time');
      if (allowanceLow()) return done('search_allowance');
      await pause(pace, signal);
      let rows;
      try { rows = await growth.research.search(rosterProduct, { query: facilityQuery(item), signal }); }
      catch (error) { if (signal?.aborted) throw error; return done('search_unavailable'); }
      signal?.throwIfAborted();
      counts.searched++;
      const site = (Array.isArray(rows) ? rows : []).find(row => matchesFacility(item, row));
      if (site) {
        counts.matched++;
        const name = displayName(item.name);
        try {
          const added = await growth.store.discover(rosterProduct, [
            { name, domain: site.domain, url: careCompareUrl(item), claim: rosterClaim(item, signals, period) },
            { name, domain: site.domain, url: String(site.url).slice(0, 2000), claim: String(site.claim).slice(0, 4000) },
          ]);
          // Nothing added: the site belongs to a customer or an internal organization, which is never prospected.
          if (added > 0) counts.recorded++;
        } catch (error) { if (error?.code !== '22023') throw error; }
      }
      await growth.store.rosterSearched(item.ccn, Boolean(site));
    }
    return done();
  } catch (error) {
    if (signal?.aborted) throw error;
    const code = error?.code ?? '';
    return done(/^feed_[a-z_]+$/.test(code) ? code : ['42883', '42P01'].includes(code) ? 'database_not_ready' : 'roster_failed');
  }
}
