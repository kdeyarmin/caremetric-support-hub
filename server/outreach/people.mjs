/**
 * The person a state launch writes to at each facility, and that person's checked work address, as Pennsylvania's were found by hand
 * (docs/STATE_LAUNCHES.md, "Finding the people"):
 *
 * 1. Hunter's Domain Search, asked by the facility's name (a chain's or group's name for its corporate email), answers the business's own
 *    domain and up to ten senior people on it with their addresses. One search credit, and none when Hunter has no address.
 * 2. The domain must be the business's own: an operator's host (never a directory, a page builder or a government site) that carries
 *    most of the facility's distinctive name, or that Hunter files under a name that does.
 * 3. The person: at a facility, the owner, the CEO or president, the administrator, the executive director, or the director of
 *    admissions, marketing or business development; at a chain or group's head office, the officer for marketing, sales, business
 *    development or admissions first, then operations, then the CEO or president.
 * 4. When the domain is known but nobody there decides, one Email Finder search for a name CMS lists: an individual owner of an agency
 *    (Intel's agency_facts) or the authorized official the NPI registry lists for the facility. A credit only when Hunter finds an address.
 * 5. A chain or group whose head office has nobody to write to falls back to its largest building's administrator, as five chains did.
 *
 * An address is kept only on the business's own domain, called valid by Hunter's check with a score of 80 or more, or, for a domain that
 * accepts every address, published somewhere Hunter saw with a score of 90 or more. Never a guessed address. The key goes in a header,
 * never a URL, a log, an error or a result.
 */
import { live } from '../live.mjs';
import { nameParts } from '../growth/mailbox.mjs';
import { ownerRank } from '../growth/people.mjs';
import { titleRank } from '../growth/team.mjs';
import { operatorHost } from '../growth/playbook.mjs';
import { distinctiveWords, searchName } from '../growth/roster.mjs';
import { firstNameOf, hostedSite } from '../growth/sequence-batches.mjs';
import { userAgent } from './cms.mjs';

const domainEndpoint = 'https://api.hunter.io/v2/domain-search';
const finderEndpoint = 'https://api.hunter.io/v2/email-finder';
const npiEndpoint = 'https://npiregistry.cms.hhs.gov/api/';
const timeoutMs = 20_000;
const maxBytes = 400_000;
const words = text => String(text ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const domainLabel = domain => String(domain ?? '').toLowerCase().replace(/^www\./, '').split('.').slice(0, -1).join('');
const onDomain = (email, domain) => { const at = email.slice(email.lastIndexOf('@') + 1); return at === domain || at.endsWith(`.${domain}`); };

/** Whether `domain` is the business's own for `name`: an operator's host carrying most of its distinctive name, or filed under a name that does. */
export function domainFits(name, domain, organization = null) {
  const host = String(domain ?? '').trim().toLowerCase().replace(/^www\./, '');
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) || host.length > 253 || !operatorHost(host) || hostedSite(host)) return false;
  const distinct = distinctiveWords(name);
  if (!distinct.length) return false;
  const label = domainLabel(host);
  const inDomain = distinct.filter(word => label.includes(word)).length / distinct.length;
  if (inDomain >= 0.5) return true;
  const filed = new Set(words(organization));
  return distinct.filter(word => filed.has(word)).length / distinct.length >= 0.67;
}

/** A Hunter address entry's email when it may be written to: see the module's rule. */
export function acceptedEmail(entry, domain) {
  const email = String(entry?.value ?? entry?.email ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 320 || !onDomain(email, domain)) return null;
  const score = Number(entry?.confidence ?? entry?.score);
  const status = String(entry?.verification?.status ?? '').toLowerCase();
  if (status === 'valid' && score >= 80) return email;
  if (status === 'accept_all' && score >= 90 && Array.isArray(entry?.sources) && entry.sources.length > 0) return email;
  return null;
}

// A head office's people: marketing and growth first, then operations, then the chief executive.
const corporateRanks = [
  [/\bchief (marketing|growth|business development|revenue|sales|strategy|strategic|development) officer\b|\b(cmo|cgo|cro)\b/i, 0],
  [/\b(svp|evp|vp|vice president|senior director|director|head)\b.{0,40}\b(marketing|business development|sales|admissions|growth|referral|partnerships|strategic)/i, 1],
  [/\b(coo|chief operating officer)\b|\b(svp|evp|vp|vice president)\b.{0,20}\boperations\b/i, 2],
  [/\b(ceo|chief executive)\b|(?<!vice )\bpresident\b/i, 3],
  [/\b(owner|founder)\b/i, 4],
];
export function corporateRank(title) {
  for (const [pattern, rank] of corporateRanks) if (pattern.test(String(title ?? ''))) return rank;
  return Infinity;
}
/** At a facility: owner, CEO or president, administrator, executive director, then admissions, marketing or business development. */
export function facilityRank(title) {
  const text = String(title ?? '');
  if (/\b(admissions?|intake)\b/i.test(text) && /\b(director|manager|coordinator|liaison)\b/i.test(text)) return 4;
  const rank = titleRank(text);
  return rank <= 4 ? rank : Infinity;
}

/** The best person of Hunter's answer whose role decides and whose address may be written to, or null. */
export function choosePerson(emails, { domain, corporate = false } = {}) {
  const rank = corporate ? corporateRank : facilityRank;
  const ranked = (emails ?? []).map(entry => {
    const email = acceptedEmail(entry, domain);
    const name = [entry?.first_name, entry?.last_name].filter(Boolean).join(' ').trim();
    return { email, name, title: String(entry?.position ?? '').trim().slice(0, 200), rank: rank(entry?.position), score: Number(entry?.confidence) || 0,
      type: entry?.type };
  }).filter(person => person.email && person.type !== 'generic' && nameParts(person.name) && Number.isFinite(person.rank));
  ranked.sort((a, b) => a.rank - b.rank || b.score - a.score);
  return ranked[0] ?? null;
}

async function getJson(fetchImpl, url, headers, signal) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { accept: 'application/json', 'user-agent': userAgent, ...headers },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: 0 };
  }
  if (!response.ok) { await response.body?.cancel?.().catch(() => {}); return { status: response.status }; }
  const text = await response.text();
  if (text.length > maxBytes) return { status: 0 };
  try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: 0 }; }
}

/**
 * Hunter, for a state launch: `company({ name })` is the Domain Search by company name and `person({ name, domain })` the Email Finder.
 * Each answers { result: 'found' | 'not_found' | 'refused' | 'limited' | 'error', charged } with the domain and people, or the address.
 */
export function hunterSearch({ apiKey = '', fetchImpl = globalThis.fetch } = {}) {
  const key = () => String(live(apiKey) ?? '').trim();
  const failed = status => ([401, 403].includes(status) ? 'refused' : status === 429 ? 'limited' : [400, 404, 451].includes(status) ? 'not_found' : 'error');
  return {
    get configured() { return key().length > 0 && typeof fetchImpl === 'function'; },
    async company({ name, signal } = {}) {
      const company = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!key()) return { result: 'refused', charged: 0 };
      if (company.length < 2) return { result: 'not_found', charged: 0 };
      const url = new URL(domainEndpoint);
      url.searchParams.set('company', company);
      url.searchParams.set('limit', '10');
      url.searchParams.set('type', 'personal');
      url.searchParams.set('seniority', 'senior,executive');
      const { status, body } = await getJson(fetchImpl, url, { 'x-api-key': key() }, signal);
      if (!body) return { result: failed(status), charged: 0 };
      const emails = Array.isArray(body?.data?.emails) ? body.data.emails : [];
      const domain = String(body?.data?.domain ?? '').trim().toLowerCase().replace(/^www\./, '');
      if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) return { result: 'not_found', charged: emails.length ? 1 : 0 };
      return { result: 'found', domain, organization: String(body?.data?.organization ?? '').slice(0, 200) || null, emails, charged: emails.length ? 1 : 0 };
    },
    async person({ name, domain, signal } = {}) {
      if (!key()) return { result: 'refused', charged: 0 };
      const url = new URL(finderEndpoint);
      url.searchParams.set('domain', String(domain ?? '').trim().toLowerCase());
      url.searchParams.set('full_name', String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200));
      const { status, body } = await getJson(fetchImpl, url, { 'x-api-key': key() }, signal);
      if (!body) return { result: failed(status), charged: 0 };
      const data = body?.data ?? {};
      const email = acceptedEmail({ value: data.email, confidence: data.score, verification: data.verification, sources: data.sources }, domain);
      return email ? { result: 'found', email, charged: 1 } : { result: 'not_found', charged: data.email ? 1 : 0 };
    },
  };
}

/**
 * The NPI registry's authorized official for a facility (public, no key): { name, title } for the organization of that name in its ZIP
 * code or city, or null. Used only to name the person Hunter's Email Finder looks up.
 */
export function npiOfficials({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async official({ name, state, zip = null, city = null, signal } = {}) {
      const search = searchName(name).split(' ').slice(0, 4).join(' ');
      if (search.length < 3 || !/^[A-Z]{2}$/.test(state ?? '')) return null;
      const url = new URL(npiEndpoint);
      url.searchParams.set('version', '2.1');
      url.searchParams.set('enumeration_type', 'NPI-2');
      url.searchParams.set('organization_name', `${search}*`);
      url.searchParams.set('state', state);
      url.searchParams.set('limit', '20');
      const { body } = await getJson(fetchImpl, url, {}, signal);
      const town = words(city).join(' ');
      for (const result of Array.isArray(body?.results) ? body.results : []) {
        const place = (result?.addresses ?? []).find(address => address?.address_purpose === 'LOCATION') ?? {};
        const sameZip = zip && String(place.postal_code ?? '').slice(0, 5) === zip;
        const sameCity = town && words(place.city).join(' ') === town;
        if (!sameZip && !sameCity) continue;
        const b = result?.basic ?? {};
        const person = [b.authorized_official_first_name, b.authorized_official_last_name].filter(Boolean).join(' ').trim();
        if (!nameParts(person)) continue;
        return { name: person, title: String(b.authorized_official_title_or_position ?? '').trim().slice(0, 200) || null };
      }
      return null;
    },
  };
}

/** A name written all in capitals or all in lower case as people write it ("MARY MCDONALD-SMITH" → "Mary McDonald-Smith"); mixed case is kept. */
export function properName(name) {
  const text = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (text !== text.toUpperCase() && text !== text.toLowerCase()) return text;
  return text.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, gap, letter) => gap + letter.toUpperCase()).replace(/\bMc([a-z])/g, (_, letter) => `Mc${letter.toUpperCase()}`);
}
const found = (domain, person, source, searches) => {
  const name = properName(person.name);
  const parts = name.split(' ');
  return { status: 'found', domain, email: person.email, personName: name, firstName: firstNameOf(name), lastName: parts.length > 1 ? parts.at(-1) : null,
    title: person.title || null, source, searches };
};

/**
 * Looks one facility's person up: { status: 'found', domain, email, personName, firstName, lastName, title, source, searches } or
 * { status: 'not_found', note, searches }. Throws { code: 'hunter_refused' | 'hunter_limited' } when Hunter refuses the key or the rate.
 * `owners`: the agency's CMS owners (Intel's agency_facts); `npi`: npiOfficials(); `budget()`: the searches the launch may still use.
 */
export async function findPerson(target, { hunter, npi = null, owners = [], state, budget = () => Infinity, signal } = {}) {
  let searches = 0;
  const stop = answer => {
    if (answer.result === 'refused') throw Object.assign(new Error('Hunter refused the key'), { code: 'hunter_refused' });
    if (answer.result === 'limited') throw Object.assign(new Error('Hunter asked to slow down'), { code: 'hunter_limited', retryable: true });
  };
  const corporate = target.segment === 'chain' || target.segment === 'regional';
  const attempts = corporate && target.chainName ? [{ name: target.chainName, corporate: true }, { name: target.name, corporate: false }] : [{ name: target.name, corporate: false }];
  let note = 'no_domain';
  for (const attempt of attempts) {
    if (budget() - searches < 1) return { status: 'not_found', note: 'search_limit', searches };
    signal?.throwIfAborted();
    const answer = await hunter.company({ name: attempt.name, signal });
    stop(answer); searches += answer.charged ?? 0;
    if (answer.result !== 'found') continue;
    if (!domainFits(attempt.name, answer.domain, answer.organization)) { note = 'domain_mismatch'; continue; }
    const person = choosePerson(answer.emails, { domain: answer.domain, corporate: attempt.corporate });
    if (person) return found(answer.domain, person, 'hunter_domain', searches);
    note = 'no_person';
    if (attempt.corporate) continue;
    // One name CMS lists, looked up by name on the domain Hunter confirmed.
    const named = (owners ?? []).filter(owner => owner?.kind === 'individual' && nameParts(owner.name) && ownerRank(owner.role) <= 2)
      .sort((a, b) => ownerRank(a.role) - ownerRank(b.role)).map(owner => ({ name: owner.name, title: owner.role || 'Owner' }));
    if (!named.length && npi) {
      try {
        const official = await npi.official({ name: target.name, state, zip: target.zip, city: target.city, signal });
        if (official) named.push(official);
      } catch (error) { if (signal?.aborted) throw error; }
    }
    const candidate = named[0];
    if (candidate && budget() - searches >= 1) {
      const lookup = await hunter.person({ name: candidate.name, domain: answer.domain, signal });
      stop(lookup); searches += lookup.charged ?? 0;
      if (lookup.result === 'found') return found(answer.domain, { ...candidate, email: lookup.email }, 'hunter_finder', searches);
    }
  }
  return { status: 'not_found', note, searches };
}
