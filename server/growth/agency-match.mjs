/**
 * Each web-found prospect's own market report (owner decision 2026-11-15; 20261115233000_growth_roster_match.sql). Every agency the
 * Marketing Manager emails gets a link to its own report on Intel, signed by its CMS certification number (report-link.mjs reads it
 * from the roster record on the opportunity). A prospect found by web search has no CCN, so `growth.match`, every hour, finds it:
 *
 * 1. The database hands out a few CareMetric Intel prospects with no roster record yet, best fit first, within the owner's daily
 *    number (Settings → Customer growth → Most web prospects to match a day).
 * 2. The contact finder reads each one's own website (`listing`: the usual contact pages, robots.txt honoured) for the telephone
 *    numbers and the postal address it publishes. Where the site gives no address, the place comes from the Hub's own evidence on the
 *    prospect: an address in a search snippet or home page summary, else the state of the discovery market it names (where discovery
 *    searched), else the one state it names. A state alone lets Intel match only by telephone number.
 * 3. One signed request to Intel's marketing feed (agency_match) asks which home health or hospice CCN each prospect is: by a number
 *    it publishes that CMS lists for an agency in its state, or by its name and place, and none when in doubt (Intel
 *    server/lib/agencyMatch.ts). A wrong match would send one agency another agency's report, so Intel answers none rather than
 *    guess, and the Hub takes a match only as Intel gives it.
 * 4. A match is saved as the roster saves an agency (roster.mjs rosterRow: its public record as a dated claim, its size as a
 *    research-only line) and attached to the prospect's organization, so rosterAgency finds its CCN and the next draft links its
 *    own report. CareMetric's own agency (ownAgencies) is never attached, nor an agency CMS shows closed.
 *
 * Business telephone numbers are only compared: they go to Intel in the one request and are never stored, logged, put in evidence or
 * shown to a model. Only counts are returned.
 */
import { live } from '../live.mjs';
import { marketedNow, markets } from '../agents/marketing.mjs';
import { discoveryPlaces } from './playbook.mjs';
import { ownAgencies, rosterRow, stateNames, statesNamed } from './roster.mjs';

export const growthRosterMatchFeature = 'platform.agents.growth-roster-match.v1';
/** Prospects matched per run (one feed request), websites read at the same time, and the daily number until the owner saves one. */
export const matchesPerRun = 10;
export const matchSiteConcurrency = 4;
export const matchDailyDefault = 40;
/** Telephone numbers sent per prospect (Intel compares at most six). */
export const matchPhoneLimit = 6;
// The scheduler stops a task after four minutes: no website is started after two.
const startBudgetMs = 120_000;

const words = text => String(text ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const entities = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', ndash: '-', mdash: '-', middot: '·', bull: '•' };

/** A page's visible text: scripts, styles and comments dropped, tags as spaces, common entities decoded. */
export function pageText(html) {
  return String(html ?? '').slice(0, 400_000)
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|address|tr|section|footer|header)\s*>/gi, '\n').replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d{1,6});/g, (_, code) => { const n = Number(code); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, code) => { const n = parseInt(code, 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; })
    .replace(/&([a-z]+);/gi, (match, name) => entities[name.toLowerCase()] ?? match)
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n[\n ]*/g, '\n').trim();
}

const nanp = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?!\d)/g;

/**
 * The telephone numbers a page publishes, as ten digits, in the order a reader meets them: its call links first, then the numbers in
 * its text. A number written after "fax" is left out: it answers no calls.
 */
export function publishedPhones(html) {
  const found = [];
  const add = digits => { if (/^[2-9]\d{2}[2-9]\d{6}$/.test(digits) && !found.includes(digits)) found.push(digits); };
  for (const match of String(html ?? '').slice(0, 400_000).matchAll(/href\s*=\s*["']\s*tel:([^"']{7,40})["']/gi)) {
    const digits = match[1].replace(/\D/g, '');
    add(digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits);
  }
  const text = pageText(html);
  for (const match of text.matchAll(nanp)) {
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (/\b(fax|facsimile)\b[^0-9]*$/i.test(before) || /\bf\s*[:.]\s*$/i.test(before)) continue;
    add(`${match[1]}${match[2]}${match[3]}`);
  }
  return found;
}

// Words that end a street address or introduce one, never part of a city's name.
const streetWords = new Set(['serving', 'serve', 'in', 'near', 'visit', 'call', 'us', 'headquarters', 'hq', 'main', 'mailing', 'st', 'street', 'ave', 'avenue', 'rd', 'road', 'blvd', 'boulevard', 'dr', 'drive', 'ln', 'lane', 'way', 'pike',
  'hwy', 'highway', 'ct', 'court', 'pl', 'place', 'pkwy', 'parkway', 'cir', 'circle', 'ter', 'terrace', 'trl', 'trail', 'sq', 'square',
  'suite', 'ste', 'floor', 'fl', 'unit', 'bldg', 'building', 'plaza', 'box', 'route', 'rte', 'rt', 'center', 'centre', 'tpke', 'turnpike',
  'expy', 'expressway', 'row', 'loop', 'run', 'alley', 'walk', 'hall', 'tower', 'room', 'rm', 'po', 'address', 'office', 'located', 'at']);
const stateByName = Object.entries(stateNames).sort((a, b) => b[1].length - a[1].length);
const stateAlternation = stateByName.map(([, name]) => name.replace(/ /g, '\\s+')).join('|');
const addressTail = new RegExp(`(?:,\\s*|\\s+)([A-Z]{2}|${stateAlternation})\\.?,?\\s+(\\d{5})(?:-\\d{4})?(?!\\d)`, 'g');

/**
 * The postal addresses a text writes ("… Pittsburgh, PA 15213", "Cleveland, Ohio 44113"), as { city, state, zip }, in order. The
 * city is the capitalized words just before the state, after the street (null when they cannot be told apart).
 */
export function placesIn(text) {
  const out = [];
  const source = String(text ?? '').slice(0, 400_000);
  for (const match of source.matchAll(addressTail)) {
    const named = match[1].replace(/\s+/g, ' ');
    const state = Object.hasOwn(stateNames, named) ? named : stateByName.find(([, name]) => name.toLowerCase() === named.toLowerCase())?.[0];
    if (!state) continue;
    const tail = source.slice(Math.max(0, match.index - 60), match.index).split(/[,|•·\n\d#()]/).pop().trim();
    const parts = tail.split(/\s+/).filter(Boolean);
    let start = 0;
    const word = index => parts[index].toLowerCase().replace(/\.$/, '');
    parts.forEach((_, index) => {
      if (!streetWords.has(word(index))) return;
      // "St. Louis": a St. that starts the city (first, or after the street's own last word) is Saint, not Street.
      if (word(index) === 'st' && index === parts.length - 2 && (index === 0 || streetWords.has(word(index - 1)))) return;
      start = index + 1;
    });
    const city = parts.slice(start).slice(-3);
    out.push({ city: city.length && city.every(part => /^[A-Z][A-Za-z.'’-]*$/.test(part)) ? city.join(' ') : null, state, zip: match[2] });
    if (out.length >= 10) break;
  }
  return out;
}

// Intel's discovery markets as places. Its list starts with Pennsylvania, whose two largest cities it names without the state.
const bareMarkets = { pittsburgh: 'PA', philadelphia: 'PA' };
const marketPlaces = discoveryPlaces('caremetric-intel').map(entry => {
  const text = words(entry);
  const named = stateByName.find(([, name]) => text.endsWith(` ${words(name)}`));
  if (named) return { city: text.slice(0, -words(named[1]).length).trim(), state: named[0] };
  return bareMarkets[text] ? { city: text, state: bareMarkets[text] } : null;
}).filter(place => place?.city);

/**
 * Where a prospect is, for matching: its website's own address first; else an address in the Hub's evidence on it (a search snippet,
 * its home page summary); else only the state of the discovery markets the evidence names (the place discovery searched), else the
 * one state the evidence names. A market is where the team searched, not where the agency is, so it gives no city: without an
 * address of its own, a prospect can only be matched by a telephone number it publishes. Null when the evidence names no state, or
 * more than one.
 */
export function matchPlace(sitePlaces, evidence) {
  const own = (sitePlaces ?? []).find(place => place?.state);
  if (own) return { state: own.state, city: own.city ?? null, zip: own.zip ?? null };
  const claims = (evidence ?? []).map(claim => String(claim ?? '')).join('\n');
  const written = placesIn(claims)[0];
  if (written) return { state: written.state, city: written.city, zip: written.zip };
  const page = ` ${words(claims)} `;
  const named = statesNamed(page);
  const seen = marketPlaces.filter(place => page.includes(` ${place.city} `) && (!named.size || named.has(place.state)));
  const states = new Set(seen.map(place => place.state));
  if (states.size === 1) return { state: [...states][0], city: null, zip: null };
  if (!states.size && named.size === 1) return { state: [...named][0], city: null, zip: null };
  return null;
}

/** The name sent to Intel: the organization's name and its home page's title, each a part Intel reads on its own. */
export function matchName(name, title) {
  const parts = [];
  for (const part of [name, title]) {
    const text = String(part ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (text && !parts.some(known => known.toLowerCase() === text.toLowerCase())) parts.push(text);
  }
  return parts.join(' | ').slice(0, 200);
}

const domainPattern = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

/** What Intel is asked about one prospect, or null when nothing places it in a state. */
export function matchCandidate(prospect, listing) {
  const place = matchPlace(listing?.places, prospect.evidence);
  if (!place) return null;
  const name = matchName(prospect.name, listing?.title);
  if (!/[a-z]/i.test(name)) return null;
  // A domain Intel would refuse is left out rather than have one prospect refuse the whole request.
  const domain = domainPattern.test(String(prospect.domain ?? '')) ? prospect.domain : null;
  return {
    key: String(prospect.organizationId), name, domain, state: place.state,
    ...(place.city ? { city: place.city.slice(0, 100) } : {}), ...(place.zip ? { zip: place.zip } : {}),
    phones: (listing?.phones ?? []).filter(phone => /^\d{10}$/.test(phone)).slice(0, matchPhoneLimit),
  };
}

/** A match as the roster row to save, or why it is not taken: Intel's answer, never CareMetric's own agency, never one CMS shows closed. */
export function matchedRow(match, period, now = new Date()) {
  if (!match?.ccn || !match.agency || match.agency.ccn !== match.ccn) return { reason: match?.reason ?? 'not_found' };
  if (!/^\d{4}Q[1-4]$/.test(String(period ?? ''))) return { reason: 'not_loaded' };
  if (ownAgencies.has(match.ccn)) return { reason: 'own_agency' };
  if (!match.agency.state || !match.agency.name) return { reason: 'not_found' };
  const row = rosterRow(match.agency, period, now);
  if (row.excluded) return { reason: 'excluded' };
  return { row };
}

const wholeNumber = (value, least, most, fallback) => (Number.isInteger(value) && value >= least && value <= most ? value : fallback);
const batches = (rows, size) => Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, (index + 1) * size));

export function matchHandlers({ growth, features = null, marketed = null, clock = Date.now }) {
  const has = feature => (features instanceof Set ? features.has(feature) : Array.isArray(features) && features.includes(feature));
  if (!growth || !has(growthRosterMatchFeature)) return {};
  async function match(task, { signal, now = () => new Date() } = {}) {
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    const feed = growth.roster?.feed;
    if (!feed?.configured || typeof feed.agencyMatch !== 'function' || typeof growth.store.matchNext !== 'function') return { result: { skipped: 'feed_not_configured' } };
    if (!growth.contacts?.configured || typeof growth.contacts.listing !== 'function') return { result: { skipped: 'site_reader_not_configured' } };
    if (!markets(await marketedNow(marketed), 'caremetric-intel')) return { result: { skipped: 'not_marketed' } };
    const daily = wholeNumber(live(growth.roster?.matchDaily), 0, 200, matchDailyDefault);
    if (daily === 0) return { result: { skipped: 'daily_number_zero' } };
    const prospects = await growth.store.matchNext(matchesPerRun, daily);
    const counts = { tried: prospects.length, matched: 0, byPhone: 0, byName: 0, unmatched: {} };
    if (!prospects.length) return { result: counts };
    const record = async (prospect, data) => {
      let saved;
      try { saved = await growth.store.matchRecord(prospect.organizationId, data); }
      catch (error) {
        if (!['22023', '23514'].includes(error?.code) || data.outcome !== 'matched') throw error;
        saved = await growth.store.matchRecord(prospect.organizationId, { outcome: 'unmatched', reason: 'invalid_record' });
      }
      if (saved?.matched) { counts.matched++; counts[data.method === 'phone' ? 'byPhone' : 'byName']++; }
      else { const reason = saved?.reason ?? data.reason ?? 'not_found'; counts.unmatched[reason] = (counts.unmatched[reason] ?? 0) + 1; }
    };
    // Each prospect's own website, a few at a time. One the run has no time left for is handed out again in an hour.
    const started = clock();
    const listings = new Map();
    for (const group of batches(prospects, matchSiteConcurrency)) {
      signal?.throwIfAborted();
      if (clock() - started > startBudgetMs) break;
      const read = await Promise.all(group.map(async prospect => {
        try { return await growth.contacts.listing(prospect.domain, { signal }); } catch (error) { if (signal?.aborted) throw error; return null; }
      }));
      group.forEach((prospect, index) => listings.set(prospect.organizationId, read[index]));
    }
    const asked = new Map();
    for (const prospect of prospects) {
      if (!listings.has(prospect.organizationId)) { await record(prospect, { outcome: 'unmatched', reason: 'retry' }); continue; }
      const candidate = matchCandidate(prospect, listings.get(prospect.organizationId));
      if (!candidate) { await record(prospect, { outcome: 'unmatched', reason: 'no_place' }); continue; }
      asked.set(candidate.key, { prospect, candidate });
    }
    if (!asked.size) return { result: counts };
    let answer;
    try { answer = await feed.agencyMatch({ candidates: [...asked.values()].map(item => item.candidate), signal }); }
    catch (error) {
      if (signal?.aborted) throw error;
      for (const { prospect } of asked.values()) await record(prospect, { outcome: 'unmatched', reason: 'retry' });
      if (!error?.transient) throw error;
      return { result: { ...counts, stopped: error?.code ?? 'feed_unavailable' } };
    }
    const answered = new Map(answer.matches.map(item => [item.key, item]));
    for (const [key, { prospect }] of asked) {
      const item = answered.get(key);
      if (!item) { await record(prospect, { outcome: 'unmatched', reason: 'retry' }); continue; }
      const taken = matchedRow(item, answer.period, now());
      if (!taken.row) { await record(prospect, { outcome: 'unmatched', reason: taken.reason }); continue; }
      await record(prospect, { outcome: 'matched', method: item.matched_by === 'phone' ? 'phone' : 'name_place', period: answer.period, row: taken.row });
    }
    return { result: counts };
  }
  return { 'growth.match': match };
}
