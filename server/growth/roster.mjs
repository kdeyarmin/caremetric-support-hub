/**
 * The Medicare roster as prospects (supabase/migrations/20261113170500_growth_roster.sql). Pure functions only:
 *
 * - `rosterRow`: one agency from Intel's feed as a target: its public record as a dated claim, its size and market position as a
 *   research-only line (fit and ranking; never quoted to the agency), and a deterministic rank with its reasons;
 * - `resolutionQuery`, `chooseSite`: the web search that finds the agency's own website, and which result is it;
 * - `confirmsSite`: whether the site the contact finder read is that agency's (its CMS telephone number on the site, or its name and
 *   place in the home page, never a page that places it in another state), so a prospect is never an organization that merely
 *   shares a name.
 */
import { operatorHost } from './playbook.mjs';

/** Evidence lines that describe an agency to the team only. Drafts leave them out (draft.mjs), so outreach never quotes them. */
export const researchOnlyPrefix = 'Research only, not for outreach:';
/** Agencies looked up per run, and how many feed pages one run reads. */
export const rosterLookupsPerRun = 4;
export const rosterPagesPerRun = 8;
/** A complete read of the roster is repeated weekly, so evidence stays fresh and new agencies are found. */
export const rosterRefreshMs = 7 * 86_400_000;

const settingLabel = { home_health: 'home health agency', hospice: 'hospice' };
const settingWords = { home_health: ['home health', 'home care', 'homecare'], hospice: ['hospice'] };
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const stateNames = Object.freeze({ AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' });

/** The owner's states setting as distinct two-letter codes the feed knows, in the owner's order. */
export function rosterStates(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map(state => String(state ?? '').trim().toUpperCase()).filter(state => Object.hasOwn(stateNames, state)))].slice(0, 60);
}

const legalWords = new Set(['inc', 'incorporated', 'llc', 'l', 'c', 'lc', 'llp', 'lp', 'ltd', 'corp', 'corporation', 'co', 'company', 'pc', 'pllc',
  'dba', 'the', 'of', 'and', 'at', 'in', 'a']);
// Words every agency of a setting shares: they say nothing about which agency a website is.
const commonWords = new Set(['home', 'health', 'healthcare', 'care', 'hospice', 'services', 'service', 'agency', 'nursing', 'homecare',
  'visiting', 'nurse', 'nurses', 'association', 'center', 'centers', 'group', 'palliative', 'medical', 'community', 'family', 'senior',
  'of', 'quality', 'professional', 'private', 'duty', 'skilled', 'in', 'hha', 'plus', 'america', 'american']);
const words = text => String(text ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/** An uppercase CMS name as people write it ("VALLEY HOSPICE, INC." → "Valley Hospice, Inc."); mixed case is kept. */
export function displayName(name) {
  const text = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text !== text.toUpperCase()) return text;
  return text.toLowerCase().replace(/\b([a-z])/g, letter => letter.toUpperCase()).replace(/\b(Llc|Lp|Llp|Pc|Pllc|Ii|Iii|Iv)\b/g, word => word.toUpperCase());
}

/** The agency's name without its legal form, for a search ("Valley Hospice"). */
export function searchName(name) {
  return words(name).filter(word => !legalWords.has(word) || word === 'of' || word === 'the' || word === 'and')
    .join(' ').replace(/^(the|of|and) /, '').replace(/ (the|of|and)$/, '');
}

/** The words that tell this agency apart: its name without legal forms and words every agency shares. Falls back to all name words. */
export function distinctiveWords(name) {
  const all = words(name).filter(word => !legalWords.has(word));
  const distinct = all.filter(word => !commonWords.has(word) && word.length >= 3);
  return distinct.length ? [...new Set(distinct)] : [...new Set(all.filter(word => word.length >= 3))];
}

const isoDay = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
const longDate = value => { const day = isoDay(value); if (!day) return null; const [y, m, d] = day.split('-').map(Number); return `${months[m - 1]} ${d}, ${y}`; };
const monthsSince = (value, now) => { const day = isoDay(value); if (!day) return Infinity; return (now.getTime() - Date.parse(`${day}T00:00:00Z`)) / (30.44 * 86_400_000); };
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`; };
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Whether CMS shows the agency closed: a termination date on or before today, or a closed signal. */
export function rosterClosed(item, now = new Date()) {
  const ended = isoDay(item?.termination_date);
  if (ended && Date.parse(`${ended}T00:00:00Z`) <= now.getTime()) return true;
  return (item?.signals ?? []).some(signal => signal.type === 'closed');
}

/**
 * How much the team should want this agency, 0 to 100, with the reasons. New agencies (they are building referral sources from
 * scratch) and new owners (they are investing to grow) come first; government agencies and the largest chains, which buy through
 * other channels, come last. A closed agency is excluded.
 */
/** Agencies CareMetric's own people run, by CCN: never prospects (the founder's agency, owner direction 2026-11-15). */
export const ownAgencies = new Set(['398009']);

/**
 * The owner's decision of 2026-11-17 (stage 3 of the AI workforce review, docs/AI_WORKFORCE_REVIEW_2026-11-17.md): reach first the
 * agencies under pressure to win referrals now, and last the agencies that already lead their county. Each weight is small beside a new
 * certification (+25) or a new owner (+20), so the long-standing reasons still lead; these break ties among the rest. The figures behind
 * them are research only: they never reach the claim, an email or the agency (researchOnlyPrefix, draft.mjs's own-standing check).
 */
export const pressureWeights = Object.freeze({
  // A small share (under 5%) of a county with ten or more agencies: it has to win referrals from larger neighbours.
  smallShare: 8, smallShareBelow: 0.05, crowdedCounty: 10,
  // First by patients among three or more agencies in its county: it already has the referral sources, and is the hardest to move.
  countyLeader: -10, leaderAmongAtLeast: 3,
  // A negative HHVBP payment adjustment (Medicare pays it less for its quality scores); a cut of 2% or more counts more.
  hhvbpCut: 8, hhvbpDeepCut: 10, hhvbpDeepCutAtMost: -2,
  // Home health quality of patient care stars: low stars mean pressure from hospitals' referral lists; the top rating, little.
  lowStars: 5, lowStarsAtMost: 2.5, topStars: -3, topStarsAtLeast: 4.5,
  // A Hospice Care Index of 7 or less (of 10): hospitals and physicians can see it, and it is under pressure to show quality.
  lowCareIndex: 5, lowCareIndexAtMost: 7,
});

/**
 * The research-only figures `agency_facts` adds for one agency (its HHVBP payment adjustment and Hospice Care Index), as plain numbers,
 * or an empty object. `facts` is one entry of the feed's `agencies` list.
 */
export function pressureFacts(facts) {
  const hhvbp = facts?.hhvbp && typeof facts.hhvbp === 'object' ? facts.hhvbp : null;
  const index = facts?.hospice_care_index && typeof facts.hospice_care_index === 'object' ? facts.hospice_care_index : null;
  const adjustment = finite(hhvbp?.paymentAdjustmentPct);
  const score = finite(index?.score);
  const year = hhvbp?.paymentYear;
  return {
    ...(adjustment !== null && adjustment >= -100 && adjustment <= 100 ? { hhvbpAdjustmentPct: adjustment } : {}),
    ...(adjustment !== null && (typeof year === 'string' || typeof year === 'number') && /^\d{4}$/.test(String(year)) ? { hhvbpPaymentYear: String(year) } : {}),
    ...(score !== null && score >= 0 && score <= 10 ? { hospiceCareIndex: score } : {}),
  };
}

export function rankTarget(item, now = new Date(), extra = {}) {
  if (ownAgencies.has(String(item?.ccn ?? ''))) return { rank: 0, reasons: ["CareMetric's own agency"], excluded: true };
  if (rosterClosed(item, now)) return { rank: 0, reasons: ['Closed in the CMS roster'], excluded: true };
  let rank = 40;
  const reasons = [];
  if (monthsSince(item.certification_date, now) <= 18) { rank += 25; reasons.push(`Newly certified (${item.certification_date})`); }
  if (monthsSince(item.change_of_ownership_date, now) <= 12) { rank += 20; reasons.push(`Change of ownership (${item.change_of_ownership_date})`); }
  const control = String(item.control_type ?? '').toLowerCase();
  if (control.includes('government')) { rank -= 15; reasons.push('Government-run'); }
  else if (control.includes('proprietary') || control.includes('profit') && !control.includes('non')) { rank += 5; reasons.push('Privately owned'); }
  const patients = finite(item.volume?.medicare_patients);
  if (patients !== null) {
    if (patients < 25) { rank -= 5; reasons.push('Very small Medicare volume'); }
    else if (patients <= 1500) { rank += 10; reasons.push('Independent or regional size'); }
    else if (patients > 5000) { rank -= 10; reasons.push('Very large Medicare volume'); }
  }
  const providers = finite(item.volume?.county_providers);
  if (providers !== null && providers >= 10) { rank += 5; reasons.push('Competitive county'); }
  // Under pressure first (owner decision 2026-11-17, pressureWeights).
  const w = pressureWeights;
  const share = finite(item.volume?.county_share);
  const countyRank = finite(item.volume?.county_rank);
  if (share !== null && providers !== null && share < w.smallShareBelow && providers >= w.crowdedCounty) { rank += w.smallShare; reasons.push('Small share of a crowded county'); }
  if (countyRank === 1 && providers !== null && providers >= w.leaderAmongAtLeast) { rank += w.countyLeader; reasons.push('Leads its county'); }
  const adjustment = finite(extra?.hhvbpAdjustmentPct);
  if (adjustment !== null && adjustment < 0) {
    if (adjustment <= w.hhvbpDeepCutAtMost) { rank += w.hhvbpDeepCut; reasons.push('Medicare pay cut of 2% or more (HHVBP)'); }
    else { rank += w.hhvbpCut; reasons.push('Medicare pay cut (HHVBP)'); }
  }
  const stars = finite(item.quality?.care_star_rating);
  if (stars !== null && stars <= w.lowStarsAtMost) { rank += w.lowStars; reasons.push('Low quality star rating'); }
  else if (stars !== null && stars >= w.topStarsAtLeast) { rank += w.topStars; reasons.push('Top quality star rating'); }
  const careIndex = finite(extra?.hospiceCareIndex);
  if (careIndex !== null && careIndex <= w.lowCareIndexAtMost) { rank += w.lowCareIndex; reasons.push('Low Hospice Care Index'); }
  return { rank: Math.max(0, Math.min(100, Math.round(rank))), reasons: reasons.slice(0, 12), excluded: false };
}

/** The agency's public record, as the team may cite it. */
export function rosterClaim(item, period) {
  const where = [item.city, item.state].filter(Boolean).join(', ');
  const parts = [`CMS Provider of Services file, ${period}: ${displayName(item.name) || `CCN ${item.ccn}`} (CCN ${item.ccn}) is a Medicare-certified ${settingLabel[item.setting]}${where ? ` in ${where}` : ''}`];
  const certified = longDate(item.certification_date);
  if (certified) parts.push(`certified ${certified}`);
  if (item.control_type) parts.push(`ownership type: ${item.control_type}`);
  const changed = longDate(item.change_of_ownership_date);
  if (changed) parts.push(`change of ownership recorded ${changed}`);
  if ((item.signals ?? []).some(signal => signal.type === 'newly_certified')) parts.push(`newly listed by CMS in ${item.signals.find(signal => signal.type === 'newly_certified').detected_in}`);
  return `${parts.join('; ')}.`.slice(0, 1000);
}

/** Size and market position: for fit and ranking only, never quoted to the agency. Null when the feed knows neither. */
export function researchClaim(item) {
  const parts = [];
  const volume = item.volume;
  const patients = finite(volume?.medicare_patients);
  if (patients !== null) parts.push(`CMS post-acute utilization ${volume.data_year}: ${patients} Medicare fee-for-service patients`);
  if (finite(volume?.county_rank) !== null && finite(volume?.county_providers) !== null) parts.push(`${ordinal(volume.county_rank)} of ${volume.county_providers} agencies located in its county by patients`);
  const stars = finite(item.quality?.care_star_rating);
  if (stars !== null) parts.push(`home health quality of patient care rating ${stars} stars${item.quality.data_year ? ` (${item.quality.data_year})` : ''}`);
  return parts.length ? `${researchOnlyPrefix} ${parts.join('; ')}.`.slice(0, 1000) : null;
}

/**
 * One feed item as the row private.growth_roster_upsert saves. `agencyFacts` is the agency's entry from the feed's `agency_facts` answer
 * (HHVBP and Hospice Care Index), when it was read: research and ranking only.
 */
export function rosterRow(item, period, now = new Date(), agencyFacts = null) {
  const extra = pressureFacts(agencyFacts);
  const { rank, reasons, excluded } = rankTarget(item, now, extra);
  const facts = {
    ...(item.contact?.phone ? { phone: item.contact.phone } : {}),
    ...(item.contact?.address ? { address: String(item.contact.address).slice(0, 200) } : {}),
    ...(item.certification_date ? { certified: item.certification_date } : {}),
    ...(item.change_of_ownership_date ? { ownershipChanged: item.change_of_ownership_date } : {}),
    ...(item.control_type ? { control: String(item.control_type).slice(0, 100) } : {}),
    ...(finite(item.quality?.care_star_rating) !== null ? { careStars: item.quality.care_star_rating } : {}),
    ...(finite(item.volume?.medicare_patients) !== null ? { patients: item.volume.medicare_patients } : {}),
    ...(finite(item.volume?.county_rank) !== null ? { countyRank: item.volume.county_rank } : {}),
    ...(finite(item.volume?.county_providers) !== null ? { countyProviders: item.volume.county_providers } : {}),
    // Research only (stage 3, 2026-11-17): what ranks an agency under pressure, kept so the Growth screen and the memo can read it.
    ...(finite(item.volume?.county_share) !== null ? { countyShare: item.volume.county_share } : {}),
    ...(finite(item.volume?.state_share) !== null ? { stateShare: item.volume.state_share } : {}),
    ...(finite(item.volume?.state_rank) !== null ? { stateRank: item.volume.state_rank } : {}),
    ...(finite(item.volume?.state_providers) !== null ? { stateProviders: item.volume.state_providers } : {}),
    ...extra,
  };
  return {
    ccn: item.ccn, name: displayName(item.name).slice(0, 200) || `CCN ${item.ccn}`, setting: item.setting, city: item.city ?? null,
    state: item.state, zip: item.zip ?? null, county_fips: item.county_fips ?? null, facts, claim: rosterClaim(item, period),
    research: researchClaim(item), rank, reasons, excluded,
  };
}

/** The web search that finds the agency's own website: its name, its place, and its setting when the name does not say it. */
export function resolutionQuery(target) {
  const name = searchName(target.name);
  const said = settingWords[target.setting].some(word => name.includes(word));
  return [name, target.city, target.state, said ? '' : settingWords[target.setting][0]].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** A second search when the name search finds no confirmed site (2026-11-16): the agency's CMS telephone number, quoted. Null without one. */
export function phoneQuery(target) {
  const digits = String(target?.facts?.phone ?? '').replace(/\D/g, '');
  return /^\d{10}$/.test(digits) ? `"${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}"` : null;
}

/**
 * The sites a telephone search found worth reading, at most two, best first: an operator's own https site (never a directory), not one
 * that places the result in another state, not one already read; a result whose own words carry the number first. Only a site whose
 * pages show the agency's CMS telephone number is then accepted (worker.mjs `lookUp`, confirmsSite 'phone').
 */
export function phoneCandidates(target, rows, tried = new Set()) {
  const digits = String(target?.facts?.phone ?? '').replace(/\D/g, '');
  const seen = new Map();
  for (const row of rows ?? []) {
    if (!row?.domain || tried.has(row.domain) || !operatorHost(row.domain) || !/^https:\/\//.test(row.url ?? '') || wrongState(target, row)) continue;
    const carries = phonesIn(`${row.name ?? ''} ${row.claim ?? ''}`).has(digits);
    if (!seen.has(row.domain) || (carries && !seen.get(row.domain).carries)) seen.set(row.domain, { domain: row.domain, url: row.url, carries });
  }
  return [...seen.values()].sort((a, b) => Number(b.carries) - Number(a.carries)).slice(0, 2).map(({ domain, url }) => ({ domain, url }));
}

const domainLabel = domain => String(domain ?? '').toLowerCase().replace(/^www\./, '').split('.').slice(0, -1).join('');

/** How strongly one search result looks like the agency's own site (0 to 100), and how much of its name the domain carries. */
export function scoreCandidate(target, row) {
  const distinct = distinctiveWords(target.name);
  const label = domainLabel(row.domain);
  const title = ` ${words(row.name).join(' ')} `;
  const snippet = ` ${words(`${row.name} ${row.claim}`).join(' ')} `;
  const inDomain = distinct.filter(word => label.includes(word)).length / Math.max(distinct.length, 1);
  const inTitle = distinct.filter(word => title.includes(` ${word} `)).length / Math.max(distinct.length, 1);
  const city = target.city && snippet.includes(` ${words(target.city).join(' ')} `);
  const state = snippet.includes(` ${String(target.state ?? '').toLowerCase()} `) || Boolean(stateNames[target.state]) && snippet.includes(` ${words(stateNames[target.state]).join(' ')} `);
  const setting = settingWords[target.setting].some(word => snippet.includes(` ${word} `));
  const score = Math.round(45 * inDomain + 30 * inTitle + (city ? 15 : state ? 7 : 0) + (setting ? 10 : 0));
  return { score, inDomain, inTitle };
}

// Check conflicting location evidence before a high-scoring namesake can win or tie.
function wrongState(target, row) {
  const text = [row.name, row.claim].filter(Boolean).join(' ');
  const city = words(target.city).join(' ');
  const agency = searchName(target.name);
  const normalized = ' ' + words(text).join(' ') + ' ';
  // A state within the agency's name says nothing about the location of this result.
  const locations = agency ? normalized.replaceAll(new RegExp('(?<= )' + agency + '(?= )', 'g'), ' ') : normalized;
  const named = statesNamed(locations);
  // Indiana or Washington may be the target's city. A separate postal address still identifies the state.
  for (const code of named) {
    if (words(stateNames[code]).join(' ') === city) named.delete(code);
  }
  for (const match of text.matchAll(/\b([A-Z]{2})\s+\d{5}\b|,\s*([A-Z]{2})\b(?!-)/g)) {
    const code = match[1] || match[2];
    if (!Object.hasOwn(stateNames, code)) continue;
    // MD, PA, MA and MS after a name can be credentials. Accept them following the target city or before a ZIP.
    if (!match[1] && ['MD', 'PA', 'MA', 'MS'].includes(code)
      && !(city && (' ' + words(text.slice(0, match.index)).join(' ')).endsWith(' ' + city))) continue;
    named.add(code);
  }
  return named.size > 0 && !named.has(target.state);
}

/**
 * The search result that is the agency's own website, or null. The best domain must carry part of the agency's name (in its domain or
 * its page title), score at least 50, and beat a different domain by 10 points, so a common name never picks one of two lookalikes.
 */
export function chooseSite(target, rows) {
  const best = new Map();
  for (const row of rows ?? []) {
    if (!row?.domain || !operatorHost(row.domain) || !/^https:\/\//.test(row.url ?? '')) continue;
    if (wrongState(target, row)) continue;
    const scored = { ...scoreCandidate(target, row), domain: row.domain, url: row.url };
    if (!best.has(row.domain) || best.get(row.domain).score < scored.score) best.set(row.domain, scored);
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));
  const [first, second] = ranked;
  if (!first || first.score < 50 || (first.inDomain === 0 && first.inTitle < 0.5)) return null;
  if (second && first.score - second.score < 10) return null;
  return { domain: first.domain, url: first.url, score: first.score, inDomain: first.inDomain };
}

/** Every ten-digit North American telephone number written in a page (text, tel: links). */
export function phonesIn(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(/(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?!\d)/g)) found.add(`${match[1]}${match[2]}${match[3]}`);
  return found;
}

// State names as page words, longest first, so "West Virginia" is never read as Virginia.
const statePhrases = Object.entries(stateNames).map(([code, name]) => [code, words(name).join(' ')]).sort((a, b) => b[1].length - a[1].length)
  .map(([code, phrase]) => [code, new RegExp(`(?<= )${phrase}(?= )`, 'g')]);
/**
 * The states a page names (`page`: its words, space-separated with a space at each end): in full, or as a two-letter code just before
 * a ZIP code ("PA 19103"). A bare code is never read as a state: IN, OR, ME, OK, HI and OH are ordinary words.
 */
export function statesNamed(page) {
  const found = new Set();
  let rest = page;
  for (const [code, phrase] of statePhrases) {
    const next = rest.replace(phrase, '#');
    if (next !== rest) { found.add(code); rest = next; }
  }
  for (const match of page.matchAll(/ ([a-z]{2}) \d{5}(?= )/g)) {
    const code = match[1].toUpperCase();
    if (Object.hasOwn(stateNames, code)) found.add(code);
  }
  return found;
}

/**
 * Whether the site the contact finder read is the agency's: 'phone' when its CMS telephone number is on the site, 'name' when the home
 * page names it (most of its distinctive words) and its place, or when the domain carries its whole distinctive name and the page says
 * its setting and its place. Its place is its state, or its city on a page that names no other state (a Columbus page that says Ohio
 * is not a Columbus, Georgia agency's; a town named for a state is its city). Null otherwise: the agency stays unresolved rather than risk an email to a lookalike.
 */
export function confirmsSite(target, found, choice = null) {
  if (found?.phoneSeen === true) return 'phone';
  const page = ` ${words(found?.site?.claim).join(' ')} `;
  if (page.trim() === '') return null;
  const distinct = distinctiveWords(target.name);
  const named = distinct.filter(word => page.includes(` ${word} `)).length / Math.max(distinct.length, 1);
  const states = statesNamed(page);
  const own = String(target.state ?? '').toUpperCase();
  const city = words(target.city).join(' ');
  // A town named for a state (Washington, Pennsylvania; Indiana, Pennsylvania) is its own city there, not another state.
  const elsewhere = [...states].some(code => code !== own && words(stateNames[code]).join(' ') !== city);
  const place = states.has(own) || (city !== '' && page.includes(` ${city} `) && !elsewhere);
  const setting = settingWords[target.setting].some(word => page.includes(` ${word} `));
  if (named >= 0.67 && place) return 'name';
  if ((choice?.inDomain ?? 0) >= 1 && named >= 0.5 && setting && place) return 'name';
  return null;
}
