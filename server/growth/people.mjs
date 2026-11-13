/**
 * Decision-makers at the best prospects (20261113180000_growth_people.sql). `growth.people`, every half hour, for a few businesses the
 * database names (researched or qualified, fit 60 or more or a known CMS record, never yet emailed, not searched for 60 days):
 *
 * 1. Who CMS lists as owning or managing the agency (Intel's agency_facts: the All Owners file), recorded as people.
 * 2. With the owner's contact-data service on (Settings → Customer growth → Contact-data service), who works there with a deciding
 *    title (a free search), and the one person most worth writing to: a CMS-listed owner's first name first, then the title.
 * 3. One credit, reserved in the database under the owner's daily number, for that person's verified work address on the business's
 *    own domain. It is recorded for the owner's review: nothing is sent to it until the owner permits it on the Growth screen.
 *
 * No personal address, no phone number and no guessed address, ever. Only counts are returned.
 */
import { live } from '../live.mjs';
import { marketedNow, markets } from '../agents/marketing.mjs';

export const growthPeopleFeature = 'platform.agents.growth-people.v1';
export const peopleLookupsPerRun = 4;
const dataUse = 'https://www.caremetricintel.com/data-use';

const ranks = [
  [/\b(owner|founder|co-?founder)\b/i, 0], [/\b(chief executive|ceo|president)\b/i, 1], [/\badministrator\b/i, 2],
  [/\bexecutive director\b/i, 3], [/\b(business development|community liaison|marketing)\b/i, 4], [/\b(director|chief|vp|vice president)\b/i, 5],
];
/** How much a title decides, lower first; Infinity for a title that does not decide. */
export function titleRank(title) {
  const text = String(title ?? '');
  for (const [pattern, rank] of ranks) if (pattern.test(text)) return rank;
  return Infinity;
}

/** The individuals CMS lists as owning or managing an agency, as people to record. */
export function ownerPeople(facts) {
  return (facts?.owners ?? []).filter(owner => owner.kind === 'individual' && owner.name)
    .map(owner => ({ name: owner.name, title: owner.role || 'Owner', source: 'cms_owners', sourceUrl: dataUse })).slice(0, 8);
}

/** The found person most worth writing to: one whose first name a CMS-listed owner shares, else the most deciding title. */
export function choosePerson(found, owners = []) {
  const firsts = new Set(owners.map(owner => String(owner.name ?? '').split(/\s+/)[0].toLowerCase()).filter(Boolean));
  const ranked = (found ?? []).filter(person => Number.isFinite(titleRank(person.title)) || firsts.has(person.firstName.toLowerCase()))
    .map(person => ({ person, rank: firsts.has(person.firstName.toLowerCase()) ? -1 : titleRank(person.title) }))
    .sort((a, b) => a.rank - b.rank);
  return ranked[0]?.person ?? null;
}

export function peopleHandlers({ growth, features = null, marketed = null }) {
  const declared = features instanceof Set ? features.has(growthPeopleFeature) : Array.isArray(features) && features.includes(growthPeopleFeature);
  if (!growth || !declared) return {};
  async function people(task, { signal } = {}) {
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    if (typeof growth.store.peopleCandidates !== 'function') return { result: { skipped: 'not_configured' } };
    const provider = live(growth.people?.provider) ?? null;
    const feed = growth.roster?.feed;
    if (!provider?.configured && !feed?.configured) return { result: { skipped: 'no_source' } };
    const list = await marketedNow(marketed);
    const candidates = (await growth.store.peopleCandidates(peopleLookupsPerRun)).filter(item => markets(list, item.product));
    if (!candidates.length) return { result: { searched: 0 } };
    // The CMS owners of every candidate the roster knows, in one request.
    const ccns = [...new Set(candidates.flatMap(item => item.ccns ?? []))].slice(0, 25);
    const factsByCcn = new Map();
    if (feed?.configured && ccns.length && typeof feed.agencyFacts === 'function') {
      try { for (const agency of (await feed.agencyFacts({ ccns, signal })).agencies) factsByCcn.set(agency.ccn, agency); }
      catch (error) { if (signal?.aborted) throw error; }
    }
    const counts = { searched: 0, people: 0, found: 0, noCredit: 0 };
    for (const org of candidates) {
      signal?.throwIfAborted();
      const owners = (org.ccns ?? []).flatMap(ccn => ownerPeople(factsByCcn.get(ccn)));
      let found = [];
      if (provider?.configured) {
        try { found = await provider.search({ domain: org.domain, signal }); }
        catch (error) { if (signal?.aborted || error?.code === 'people_not_permitted') throw error; found = []; }
      }
      const chosen = provider?.configured ? choosePerson(found, owners) : null;
      // The credit first: recording marks the business searched for 60 days, so one whose person cannot be looked up today is left
      // untouched and comes back once the day's credits do.
      if (chosen && !(await growth.store.enrichmentReserve(1))) { counts.noCredit++; break; }
      const recorded = await growth.store.peopleRecord(org.id, [...owners,
        ...found.map(person => ({ name: [person.firstName, person.lastName].filter(Boolean).join(' ').slice(0, 200), title: person.title, source: 'apollo', providerRef: person.ref }))]);
      counts.searched++; counts.people += Array.isArray(recorded) ? recorded.length : 0;
      if (!chosen) continue;
      let address = null;
      try { address = await provider.enrich({ ref: chosen.ref, domain: org.domain, signal }); }
      catch (error) { if (signal?.aborted) throw error; }
      const personId = (recorded ?? []).find(item => item.source === 'apollo' && item.providerRef === chosen.ref)?.id;
      if (!address || !personId) continue;
      try {
        const saved = await growth.store.enrichedContact(personId, address.email, address.name);
        if (saved?.found) counts.found++;
      } catch (error) { if (error?.code !== '22023') throw error; }
    }
    return { result: counts };
  }
  return { 'growth.people': people };
}
