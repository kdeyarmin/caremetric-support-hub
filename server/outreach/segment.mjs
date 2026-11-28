/**
 * Which campaign each facility of a state belongs in, and which are left out, by the rules Pennsylvania was built with by hand on
 * 2026-11-27 and 28 (docs/STATE_LAUNCHES.md, "Who gets which email"):
 *
 * Nursing homes (CMS):
 * - in a hospital, or run by a government: left out (they buy through their hospital or the state);
 * - in the owner's local counties (Settings → Customer growth → Your local counties): the local email, signed without "Dr.";
 * - a chain of 20 or more facilities: one corporate email for the chain (chains), sent to its leadership, and its other buildings left out;
 * - a group of 2 to 19 facilities: one email to the group's leadership (regional groups), its other buildings left out;
 * - every other nursing home: the administrator email (skilled nursing).
 * Home health agencies and hospices (Intel's feed):
 * - closed, or the owner's own: not listed;
 * - in Cambria County (the owner's home county, where his own agencies compete), a national chain, or run by a government: left out;
 * - two agencies of the same name (a home health agency and its hospice) are one business: the second is left out;
 * - every other one: the owners email (home health and hospice).
 */
import { displayName, ownAgencies, rosterClosed, searchName } from '../growth/roster.mjs';

/** Cambria County: the owner's home county. Its agencies compete with his own and are never written to (as the owner's batches). */
export const homeCounty = '42021';
/** The owner's local counties by default: Cambria and the seven around it, whose nursing homes refer to him and know him. */
export const defaultLocalCounties = Object.freeze(['42021', '42033', '42027', '42013', '42009', '42111', '42129', '42063']);
export const chainMinimum = 20;
// National home health and hospice chains: they buy centrally and were held in Pennsylvania (Bayada, Amedisys, Gentiva and the like).
const nationalChains = /\b(bayada|amedisys|enhabit|gentiva|kindred at home|lhc group|aveanna|vitas|compassus|accentcare|elara caring|help at home|addus|brightspring|centerwell|encompass health|heartland (home health|hospice)|southerncare|pruitthealth|traditions health|intrepid usa|optum)\b/i;

/** A county's name as the copy writes it before "County": no "County" or "Parish" of its own. */
export const countyWord = name => String(name ?? '').replace(/\s+/g, ' ').trim().replace(/\s+(county|parish|borough|census area|municipality)$/i, '') || null;
const countyKey = name => String(countyWord(name) ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** County name → FIPS within the state, from Intel's counties ([{ county_fips, county_name }]). */
export function countyIndex(counties) {
  const byName = new Map(); const byFips = new Map();
  for (const county of counties ?? []) {
    if (!/^\d{5}$/.test(county?.county_fips ?? '')) continue;
    byFips.set(county.county_fips, countyWord(county.county_name));
    byName.set(countyKey(county.county_name), county.county_fips);
  }
  return { fips: name => byName.get(countyKey(name)) ?? null, name: fips => byFips.get(fips) ?? null };
}

// CMS writes "Government - County", "Government - State" and the like for both kinds of provider.
const government = ownership => /\bgovernment\b/i.test(String(ownership ?? ''));

/**
 * The launch's facilities as rows for private.state_launch_add_targets: { ccn, setting, name, city, zip, county, countyFips, ownership,
 * size, chainId, chainName, chainSize, segment, hold }. `hold` names why a facility is left out; null for one to look a person up for.
 */
export function launchTargets({ nursingHomes = [], agencies = [], counties = [], localCounties = defaultLocalCounties, now = new Date() } = {}) {
  const index = countyIndex(counties);
  const local = new Set(localCounties ?? []);
  const rows = [];

  // Nursing homes, chains and groups first so each chain's representative is its largest building outside the owner's local counties.
  const homes = (nursingHomes ?? []).filter(home => home?.ccn).map(home => {
    const countyFips = index.fips(home.county);
    return { ...home, countyFips, county: countyWord(home.county) };
  }).sort((a, b) => (b.beds ?? 0) - (a.beds ?? 0) || a.name.localeCompare(b.name));
  const represented = new Set();
  for (const home of homes) {
    const row = { ccn: home.ccn, setting: 'nursing_home', name: home.name, city: home.city, zip: home.zip, county: home.county, countyFips: home.countyFips,
      ownership: home.ownership, size: home.beds, chainId: home.chainId, chainName: home.chainName, chainSize: home.chainSize, segment: 'snf', hold: null };
    const size = Number(home.chainSize ?? 0);
    const group = home.chainId && size >= 2 ? (size >= chainMinimum ? 'chain' : 'regional') : null;
    if (home.inHospital) row.hold = 'hospital_based';
    else if (government(home.ownership)) row.hold = 'government';
    else if (home.countyFips && local.has(home.countyFips)) row.segment = 'local';
    else if (group) {
      row.segment = group;
      if (represented.has(home.chainId)) row.hold = group === 'chain' ? 'same_chain' : 'same_group';
      else represented.add(home.chainId);
    }
    rows.push(row);
  }

  // Home health agencies and hospices: the most Medicare patients first, so a business's larger agency is the one written to.
  const names = new Set();
  const list = (agencies ?? []).filter(item => item?.ccn && !rosterClosed(item, now) && !ownAgencies.has(item.ccn))
    .sort((a, b) => (b.volume?.medicare_patients ?? -1) - (a.volume?.medicare_patients ?? -1) || String(a.name).localeCompare(String(b.name)));
  for (const item of list) {
    const name = displayName(String(item.name ?? '').trim());
    if (!name) continue;
    const fips = item.county_fips ?? item.volume?.county_fips ?? null;
    const row = { ccn: item.ccn, setting: item.setting === 'hospice' ? 'hospice' : 'home_health', name, city: item.city ?? null, zip: item.zip ?? null,
      county: index.name(fips), countyFips: fips, ownership: item.control_type ?? null, size: item.volume?.medicare_patients ?? null,
      chainId: null, chainName: null, chainSize: null, segment: 'agency', hold: null };
    const key = searchName(name);
    if (fips === homeCounty) row.hold = 'home_area';
    else if (nationalChains.test(name)) row.hold = 'national_chain';
    else if (government(item.control_type)) row.hold = 'government';
    else if (names.has(key)) row.hold = 'same_name';
    names.add(key);
    rows.push(row);
  }
  return rows;
}
