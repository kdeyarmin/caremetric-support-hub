/**
 * Decision-makers at the best prospects (20261113180000_growth_people.sql, 20261113290000_growth_people_finder.sql). `growth.people`,
 * every half hour, for a few businesses the database names (researched or qualified, fit 60 or more or a known CMS record, never yet
 * emailed, not searched for 60 days). The Hub does this itself, with public records and the business's own website and mail server
 * (owner decision 2026-11-13, replacing Apollo):
 *
 * 1. Who leads the business, from three free sources, recorded as people: who CMS lists as owning or managing the agency (Intel's
 *    agency_facts: the All Owners file), who the NPI registry lists as its authorized official (server/growth/npi-registry.mjs), and
 *    who the business's own pages name with a title that decides (the contact finder's `team`, server/growth/team.mjs). An agency
 *    matched to its Medicare record is looked up in the registry where CMS places it; one that is not (most agencies found on the web)
 *    where its own website's postal address places it (`placedAgencies`), and a record is taken only when its telephone number is one
 *    the site publishes or its name is the agency's (review 2026-11-17: 53 strong fits had no person named, the registry never asked).
 *    A business matched to its Medicare record after it was searched, with nobody named, is searched again
 *    (20261117220500_growth_research_people.sql).
 * 2. The one person most worth writing to: the title that decides most, then the person more sources name.
 * 3. That person's work address, as far as the owner allows (Settings → Customer growth → Finding people's addresses):
 *    - "Addresses the business publishes": an address on the business's own domain that its own pages publish and that is one of
 *      the usual shapes of a named person's name (jdoe@ beside Jane Doe). Free.
 *    - "Also guess and check with the business's mail server": otherwise the usual shapes of the chosen person's name, the shape the
 *      business's own addresses follow first, asked of the business's mail server (server/growth/mailbox.mjs), which must refuse a
 *      made-up mailbox and accept the guess. One check a business, reserved in the database under the owner's daily number
 *      (Most address checks a day) before it is made.
 *    - When the mail server gives no clear answer, and the owner has switched it on, a verification service is asked about the
 *      same shapes (address-service.mjs); an address it confirms is recorded as found by the service.
 *    Either way the address is recorded for the owner's review: nothing is sent to it until the owner permits it on the Growth screen.
 *    Once the owner hands named people's email addresses over (the "Named people's email addresses" autonomy step,
 *    20261115200000_autonomy_handover.sql), the database permits such an address on its own instead (it is one the business published or
 *    its mail server confirmed: nothing else ever reaches it), unless a contact at the business opted out or the business said "not
 *    interested" or "not now". Writing to the person is still cold email, under its own step and caps.
 *
 * Never a personal address on another domain, a phone number, or an address the business did not publish or its mail server did not
 * confirm. Only counts are returned.
 */
import { live } from '../live.mjs';
import { marketedNow, markets } from '../agents/marketing.mjs';
import { addressFits, addressGuesses, learnPattern, nameParts, unansweredReason } from './mailbox.mjs';
import { titleRank } from './team.mjs';
import { huntOwners } from './hunter.mjs';

export { titleRank } from './team.mjs';
export const growthPeopleFeature = 'platform.agents.growth-people.v1';
export const growthPeopleFinderFeature = 'platform.agents.growth-people-finder.v1';
export const peopleLookupsPerRun = 4;
/** How far the people step goes for an address: names only, addresses the business publishes, or also guessed and checked ones. */
export const addressModes = Object.freeze(['none', 'published', 'verify']);
// The scheduler stops a task after four minutes: no business is started after two, and no mail server is asked after two and a half.
const startBudgetMs = 120_000;
const checkBudgetMs = 150_000;
const dataUse = 'https://www.caremetricintel.com/data-use';
const sourceOrder = ['website', 'npi_registry', 'cms_owners'];

/** How much a role in the CMS All Owners file decides, lower first. */
export function ownerRank(role) {
  const text = String(role ?? '');
  if (/\b(ownership|partnership|owner)\b/i.test(text)) return 0;
  if (/\bofficer\b/i.test(text)) return 1;
  if (/\b(managerial|managing)\b/i.test(text)) return 2;
  return Math.min(titleRank(text), 5);
}

/** The individuals CMS lists as owning or managing an agency, as people to record. */
export function ownerPeople(facts) {
  return (facts?.owners ?? []).filter(owner => owner.kind === 'individual' && owner.name)
    .map(owner => ({ name: owner.name, title: owner.role || 'Owner', source: 'cms_owners', sourceUrl: dataUse })).slice(0, 8);
}

/**
 * An agency not matched to its Medicare record, placed where its own website's postal address puts it, as the NPI registry is asked
 * about it: with the telephone numbers the site publishes, once for home health and once for hospice (hospice first when its name says
 * so). The site's own address only: a search snippet or a discovery market is not where the agency is. [] without one.
 */
export function placedAgencies(org, listing) {
  const name = String(org?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const place = (Array.isArray(listing?.places) ? listing.places : []).find(item => /^[A-Z]{2}$/.test(String(item?.state ?? '')) && (/^\d{5}$/.test(String(item?.zip ?? '')) || item?.city));
  if (!place || !/[a-z]/i.test(name)) return [];
  const phones = (Array.isArray(listing?.phones) ? listing.phones : []).filter(phone => /^\d{10}$/.test(String(phone))).slice(0, 6);
  const base = { name, state: place.state, city: place.city ?? null, zip: /^\d{5}$/.test(String(place.zip ?? '')) ? place.zip : null, phones };
  return (/hospice/i.test(name) ? ['hospice', 'home_health'] : ['home_health', 'hospice']).map(setting => ({ ...base, setting }));
}

// How much one source's entry for a person decides: the NPI registry's authorized official signs for the agency, whatever the title.
const rankOf = entry => (entry.source === 'cms_owners' ? ownerRank(entry.title) : entry.source === 'npi_registry' ? Math.min(titleRank(entry.title), 3) : titleRank(entry.title));

/**
 * The people the sources name, one per person (the same first and last name from two sources is one person): { name, title, rank,
 * entries }, best first. Names that are not a person's full name are left out; they are still recorded.
 */
export function mergePeople(entries) {
  const people = new Map();
  for (const entry of entries ?? []) {
    const parts = nameParts(entry?.name);
    if (!parts) continue;
    const key = `${parts.first}|${parts.last}`;
    const person = people.get(key) ?? { key, entries: [], rank: Infinity };
    person.entries.push(entry);
    person.rank = Math.min(person.rank, rankOf(entry));
    people.set(key, person);
  }
  return [...people.values()].map(person => {
    // The name and title as the most direct source writes them: the business's own page, then the registry, then CMS.
    const best = [...person.entries].sort((a, b) => sourceOrder.indexOf(a.source) - sourceOrder.indexOf(b.source))[0];
    const sources = new Set(person.entries.map(entry => entry.source)).size;
    return { ...person, name: best.name, title: best.title, entry: best, sources };
  }).sort((a, b) => a.rank - b.rank || b.sources - a.sources || sourceOrder.indexOf(a.entry.source) - sourceOrder.indexOf(b.entry.source));
}

/** The person most worth writing to: one whose title decides, or null. */
export function choosePerson(people) {
  return (people ?? []).find(person => Number.isFinite(person.rank)) ?? null;
}

/** An address the business's own pages publish that belongs to a named person who decides: { person, email, sourceUrl }, or null. */
export function publishedAddress(addresses, people, domain) {
  for (const person of people ?? []) {
    if (!Number.isFinite(person.rank)) continue;
    const found = (addresses ?? []).find(address => addressFits(address.email, person.name, domain));
    if (found) return { person, email: found.email, sourceUrl: found.sourceUrl };
  }
  return null;
}

export function peopleHandlers({ growth, features = null, marketed = null, clock = Date.now }) {
  const has = feature => (features instanceof Set ? features.has(feature) : Array.isArray(features) && features.includes(feature));
  if (!growth || !has(growthPeopleFeature)) return {};
  // Before the finder's migration the database records CMS owners only.
  const finder = has(growthPeopleFinderFeature);
  async function people(task, { signal } = {}) {
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    if (typeof growth.store.peopleCandidates !== 'function') return { result: { skipped: 'not_configured' } };
    const started = clock();
    const feed = growth.roster?.feed;
    const sources = growth.people ?? {};
    const chosenMode = live(sources.mode);
    const mode = finder && addressModes.includes(chosenMode) ? chosenMode : 'none';
    const registry = finder && typeof sources.registry?.officials === 'function' ? sources.registry : null;
    const site = finder && typeof growth.contacts?.team === 'function' ? growth.contacts : null;
    const mailbox = mode === 'verify' && typeof sources.mailbox?.check === 'function' ? sources.mailbox : null;
    // The owners the weekly batch still needs an address for, looked up with Hunter first (hunter.mjs; Settings → Customer growth → Find
    // owners' addresses with Hunter). Its own reserved, capped lookups; nothing else in this run depends on it.
    let hunter = null;
    try { hunter = await huntOwners({ store: growth.store, finder: sources.hunter, feed, features, signal }); }
    catch (error) { if (signal?.aborted) throw error; hunter = { failed: String(error?.code ?? 'hunter_failed').slice(0, 80) }; }
    const withHunter = result => (hunter ? { ...result, hunter } : result);
    if (!feed?.configured && !registry && !site) return { result: withHunter({ skipped: 'no_source' }) };
    const list = await marketedNow(marketed);
    const candidates = (await growth.store.peopleCandidates(peopleLookupsPerRun)).filter(item => markets(list, item.product));
    if (!candidates.length) return { result: withHunter({ searched: 0 }) };
    // The CMS owners of every candidate the roster knows, in one request.
    const ccns = [...new Set(candidates.flatMap(item => item.ccns ?? []))].slice(0, 25);
    const factsByCcn = new Map();
    if (feed?.configured && ccns.length && typeof feed.agencyFacts === 'function') {
      try { for (const agency of (await feed.agencyFacts({ ccns, signal })).agencies) factsByCcn.set(agency.ccn, agency); }
      catch (error) { if (signal?.aborted) throw error; }
    }
    const counts = { searched: 0, people: 0, found: 0, published: 0, verified: 0, permitted: 0, noCredit: 0, unreachable: 0 };
    // Agencies not matched to a Medicare record whose authorized official the registry named, found by their site's address.
    let byPlace = 0;
    // Answers the verification service gave when a mail server would not (address-service.mjs).
    let byService = 0;
    // What the mail servers answered, so the run shows why an agency yielded no address (2026-11-16: 17 checks gave 3 addresses).
    const answers = {};
    // Why the mail server gave no answer, by the checker's reason (mailbox.mjs `unansweredReason`), named as the address check names it.
    const why = {};
    for (const org of candidates) {
      signal?.throwIfAborted();
      if (clock() - started > startBudgetMs) break;
      const owners = (org.ccns ?? []).flatMap(ccn => ownerPeople(factsByCcn.get(ccn)));
      const officials = [];
      const matched = (org.agencies ?? []).length > 0;
      let lookups = registry && matched ? org.agencies.slice(0, 2) : [];
      if (registry && !matched && typeof site?.listing === 'function') {
        try { lookups = placedAgencies(org, await site.listing(org.domain, { signal })); } catch (error) { if (signal?.aborted) throw error; }
      }
      for (const agency of lookups) {
        try { officials.push(...await registry.officials(agency, { signal })); } catch (error) { if (signal?.aborted) throw error; }
        // One placed agency asked about as either kind of care: the first record that is surely its own is enough.
        if (!matched && officials.length) break;
      }
      if (!matched && officials.length) byPlace++;
      let team = { people: [], addresses: [] };
      if (site) {
        try { team = await site.team(org.domain, { signal }); } catch (error) { if (signal?.aborted) throw error; }
      }
      const entries = [...team.people.map(person => ({ name: person.name, title: person.title, source: 'website', sourceUrl: person.sourceUrl })),
        ...officials, ...owners];
      const named = mergePeople(entries);
      const published = mode === 'none' ? null : publishedAddress(team.addresses, named, org.domain);
      const chosen = published?.person ?? choosePerson(named);
      const guesses = !published && chosen && mailbox && mailbox.available?.() !== false && clock() - started <= checkBudgetMs
        ? addressGuesses(chosen.name, org.domain, { learned: learnPattern(team.addresses.map(address => address.email), named) }) : [];
      // The check's credit first: recording marks the business searched for 60 days, so one whose person cannot be checked today is
      // left untouched and comes back once the day's checks do.
      if (guesses.length && !(await growth.store.enrichmentReserve(1))) { counts.noCredit++; break; }
      // The chosen person's entries first, so they are always among the 20 the database records.
      const ordered = chosen ? [...chosen.entries, ...entries.filter(entry => !chosen.entries.includes(entry))] : entries;
      const record = ordered.slice(0, 20);
      const recorded = await growth.store.peopleRecord(org.id, record);
      counts.searched++; counts.people += Array.isArray(recorded) ? recorded.length : 0;
      if (!chosen) continue;
      let found = null, person = chosen;
      if (published) found = { email: published.email, how: 'published', sourceUrl: published.sourceUrl };
      else if (guesses.length) {
        // The chosen person first. When the server refuses every usual shape of their name (they may have left, or use another shape),
        // the next person who decides, for one more reserved check: a catch-all or a server that will not answer confirms nobody.
        let list = guesses;
        for (let attempt = 0; attempt < 2 && list.length; attempt++) {
          if (attempt > 0 && (clock() - started > checkBudgetMs || !(await growth.store.enrichmentReserve(1)))) break;
          let answer;
          try { answer = await mailbox.check(org.domain, list, { signal }); } catch (error) { if (signal?.aborted) throw error; answer = { result: 'unknown' }; }
          const result = ['verified', 'rejected', 'catch_all', 'unreachable'].includes(answer?.result) ? answer.result : 'unknown';
          answers[result] = (answers[result] ?? 0) + 1;
          const reason = unansweredReason(answer);
          if (reason) why[reason] = (why[reason] ?? 0) + 1;
          // Confirmed by the business's mail server, or by the verification service when the server would not say (address-service.mjs).
          if (answer?.via === 'service') byService++;
          if (result === 'verified') { found = { email: answer.email, how: answer?.via === 'service' ? 'service' : 'mail_server', sourceUrl: null }; break; }
          if (result === 'unreachable') counts.unreachable++;
          if (result !== 'rejected') break;
          const next = named.find(other => other !== person && other !== chosen && Number.isFinite(other.rank) && record.includes(other.entry));
          if (!next) break;
          person = next;
          list = addressGuesses(next.name, org.domain, { learned: learnPattern(team.addresses.map(address => address.email), named) });
        }
      }
      const personId = Array.isArray(recorded) ? recorded[record.indexOf(person.entry)]?.id : null;
      if (!found || !personId) continue;
      try {
        const saved = await growth.store.personAddress(personId, found.email, person.name, found.how, found.sourceUrl);
        if (saved?.found) {
          counts.found++; counts[found.how === 'published' ? 'published' : 'verified']++;
          // Permitted on its own under the owner's hand-over; otherwise it waits on the Growth screen.
          if (saved.eligibility === 'permitted') counts.permitted++;
        }
      } catch (error) { if (error?.code !== '22023') throw error; }
    }
    return { result: withHunter({ ...counts, ...(byPlace ? { byPlace } : {}), ...(byService ? { byService } : {}), ...(Object.keys(answers).length ? { answers } : {}), ...(Object.keys(why).length ? { why } : {}) }) };
  }
  return { 'growth.people': people };
}
