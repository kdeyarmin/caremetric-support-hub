/**
 * Hunter finds the owners' work addresses for the owner's next batches (owner, 2026-11-27: "yes build the hunter connection";
 * 20261127230000_growth_hunter.sql, docs/OWNER_SEQUENCES.md "Finding the owners' addresses with Hunter").
 *
 * The weekly batch needs an owner or administrator with a confirmed address, and the Marketing Manager's people step confirms almost none:
 * most agencies' mail servers refuse the Hub's cloud server. Built by hand, batch 2 found 8 of 10 owners with Hunter's Email Finder, which
 * looks a person up by name and domain and checks the address itself. On each `growth.people` run, while Settings → Customer growth →
 * "Find owners' addresses with Hunter" is on and HUNTER_API_KEY is set, the Marketing Manager asks Hunter about the agencies the batch would
 * take but for an address (the database names them), one person each: the one whose role decides most. Each lookup is reserved first under
 * "Most Hunter lookups a day"; Hunter charges a credit only when it finds an address. An agency is asked about once in 180 days.
 *
 * An address is kept only when it is on the agency's own domain, Hunter's own check calls it valid, its score is 80 or more, and, for a
 * domain that accepts every address, Hunter saw it published somewhere. It is recorded as confirmed for the owner's batches and never
 * permitted for the Marketing Manager's own cold email on its own. Never a guessed address. The key goes in a header, never a URL, a log, an
 * error or a result.
 */
import { live } from '../live.mjs';
import { nameParts } from './mailbox.mjs';
import { mergePeople } from './people.mjs';

export const growthHunterFeature = 'platform.agents.growth-hunter.v1';
/** Lookups asked per `growth.people` run (every half hour), before the daily number. */
export const hunterLookupsPerRun = 2;
/** The least score Hunter gives an address that is kept. */
export const hunterMinScore = 80;
const endpoint = 'https://api.hunter.io/v2/email-finder';
const maxBytes = 100_000;
const timeoutMs = 15_000;
// The roles worth a batch's email: owner (0), CEO or president (1), administrator (2), executive director (3).
const decidingRank = 3;

/**
 * The address Hunter's answer gives for `domain`, or null: on the agency's own domain, called valid by Hunter's own check, scored 80 or
 * more, and, where the domain accepts every address, seen published somewhere.
 */
export function hunterAddress(data, domain) {
  const email = String(data?.email ?? '').trim().toLowerCase();
  const host = String(domain ?? '').trim().toLowerCase();
  if (!email || !host || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 320) return null;
  const at = email.slice(email.lastIndexOf('@') + 1);
  if (at !== host && !at.endsWith(`.${host}`)) return null;
  if (String(data?.verification?.status ?? '').toLowerCase() !== 'valid') return null;
  if (!(Number(data?.score) >= hunterMinScore)) return null;
  if (data?.accept_all === true && !(Array.isArray(data?.sources) && data.sources.length > 0)) return null;
  return email;
}

/** The person to look up: the one whose role decides most, if their role decides and their name is a person's full name; else null. */
export function hunterPerson(people) {
  const merged = mergePeople((people ?? []).filter(person => person?.id && person?.name));
  const chosen = merged.find(person => Number.isFinite(person.rank) && person.rank <= decidingRank && nameParts(person.name));
  return chosen ? { id: chosen.entry.id, name: chosen.name, title: chosen.title } : null;
}

/** Hunter's Email Finder: `find({ name, domain })` answers { result: 'found' | 'not_found' | 'refused' | 'error', email?, score? }. */
export function hunterFinder({ apiKey = '', fetchImpl = globalThis.fetch } = {}) {
  const key = () => String(live(apiKey) ?? '').trim();
  return {
    get configured() { return key().length > 0 && typeof fetchImpl === 'function'; },
    async find({ name, domain, signal } = {}) {
      if (!key()) return { result: 'refused' };
      const url = new URL(endpoint);
      url.searchParams.set('domain', String(domain ?? '').trim().toLowerCase());
      url.searchParams.set('full_name', String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200));
      let response;
      try {
        response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { accept: 'application/json', 'x-api-key': key() },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (signal?.aborted) throw error;
        return { result: 'error' };
      }
      // 401 and 403: the key is wrong or the account is held. 400 and 451: Hunter will not look this person up.
      if ([401, 403].includes(response.status)) return { result: 'refused' };
      if ([400, 404, 451].includes(response.status)) return { result: 'not_found' };
      if (!response.ok) return { result: 'error' };
      const text = await response.text();
      if (text.length > maxBytes) return { result: 'error' };
      let body;
      try { body = JSON.parse(text); } catch { return { result: 'error' }; }
      const email = hunterAddress(body?.data, domain);
      return email ? { result: 'found', email, score: Number(body.data.score) } : { result: 'not_found' };
    },
  };
}

/**
 * One run's lookups: { asked, found, notFound, refused, errors }, or null when Hunter is not in use. Stops at the daily number (the
 * database refuses to reserve), at a refused key, and after `limit` lookups.
 */
export async function huntOwners({ store, finder, features = null, limit = hunterLookupsPerRun, signal } = {}) {
  const declared = features instanceof Set ? features.has(growthHunterFeature) : Array.isArray(features) && features.includes(growthHunterFeature);
  if (!declared || !finder?.configured || typeof store?.hunterNext !== 'function') return null;
  const counts = { asked: 0, found: 0, notFound: 0, refused: 0, errors: 0 };
  const agencies = await store.hunterNext(Math.min(25, limit * 5));
  for (const agency of Array.isArray(agencies) ? agencies : []) {
    if (counts.asked >= limit) break;
    signal?.throwIfAborted();
    const person = hunterPerson(agency.people);
    if (!person || !agency.domain) continue;
    const lookup = await store.hunterBegin(agency.id, person.id);
    if (!lookup) break;
    counts.asked++;
    let result = 'error';
    try {
      const answer = await finder.find({ name: person.name, domain: agency.domain, signal });
      result = answer?.result ?? 'error';
      if (result === 'found') {
        let saved = null;
        try { saved = await store.personAddress(person.id, answer.email, person.name, 'hunter', null); }
        catch (error) { if (error?.code !== '22023') throw error; }
        if (!saved?.found) result = 'not_found';
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      result = 'error';
    }
    await store.hunterFinish(lookup, result);
    counts[result === 'found' ? 'found' : result === 'not_found' ? 'notFound' : result === 'refused' ? 'refused' : 'errors']++;
    if (result === 'refused') break;
  }
  return counts;
}
