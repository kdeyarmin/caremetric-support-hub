/**
 * The contact-data service the Marketing Manager may use to find a decision-maker's work address (owner decision 2026-11-13). One
 * provider today: Apollo (docs.apollo.io, checked 2026-11-13):
 *
 * - People search, POST /api/v1/mixed_people/api_search, parameters in the query string: people at a business's domain with the titles
 *   and seniorities that decide (an owner, administrator, executive director, director of business development or community liaison).
 *   It costs no credits and returns no address: an id, a first name, an obfuscated last name and a title.
 * - People enrichment, POST /api/v1/people/match?id=…: the chosen person's work address and its status. One credit; personal addresses
 *   and phone numbers are never asked for (reveal_personal_emails and reveal_phone_number stay false). Only a "verified" address on the
 *   business's own domain is kept (the database checks the domain again).
 *
 * The key is a Railway secret (HUB_APOLLO_API_KEY), sent only in Apollo's x-api-key header to its fixed address; no redirects, bounded
 * answers, and failures carry a code only.
 */
const origin = 'https://api.apollo.io';
const maxBytes = 1_000_000;
const failure = (code, transient = false) => Object.assign(new Error('The contact-data service could not be read.'), { code, transient });

/** Who decides at a home health agency, a hospice or a care home, best first. */
export const decisionTitles = Object.freeze(['Owner', 'Administrator', 'Executive Director', 'Chief Executive Officer', 'President',
  'Director of Business Development', 'Business Development Director', 'Director of Marketing', 'Community Liaison', 'Director of Operations']);
export const decisionSeniorities = Object.freeze(['owner', 'founder', 'c_suite', 'director']);

async function readJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw failure('people_response_invalid');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw failure('people_response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('people_response_invalid'); }
}

const text = (value, max = 200) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

export function apolloPeople({ apiKey = '', fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const configured = typeof apiKey === 'string' && apiKey.length >= 10;
  async function post(path, params, signal) {
    if (!configured) throw failure('people_not_configured');
    const query = new URLSearchParams();
    for (const [key, value] of params) query.append(key, String(value));
    let response;
    try {
      response = await fetchImpl(`${origin}${path}?${query}`, { method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw failure('people_unavailable', true);
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      if (response.status === 401 || response.status === 403) throw failure('people_not_permitted');
      if (response.status === 422 || response.status === 400) throw failure('people_request_refused');
      throw failure(response.status === 429 ? 'people_rate_limited' : 'people_unavailable', true);
    }
    return readJson(response);
  }
  return {
    configured, provider: 'apollo',
    /** People at `domain` with deciding titles: { ref, firstName, lastName (partial), title }. No credits. */
    async search({ domain, signal } = {}) {
      const params = [['q_organization_domains_list[]', domain], ...decisionTitles.map(title => ['person_titles[]', title]),
        ...decisionSeniorities.map(level => ['person_seniorities[]', level]), ['page', 1], ['per_page', 10]];
      const answer = await post('/api/v1/mixed_people/api_search', params, signal);
      return (Array.isArray(answer?.people) ? answer.people : []).slice(0, 10).flatMap(person => {
        const ref = typeof person?.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(person.id) ? person.id : null;
        const firstName = text(person?.first_name, 80);
        if (!ref || !firstName) return [];
        return [{ ref, firstName, lastName: text(person?.last_name ?? person?.last_name_obfuscated, 80), title: text(person?.title) }];
      });
    },
    /** One person's work address, when Apollo has a verified one: { email, name, title } or null. One credit. */
    async enrich({ ref, domain, signal } = {}) {
      const answer = await post('/api/v1/people/match', [['id', ref], ['domain', domain], ['reveal_personal_emails', 'false'], ['reveal_phone_number', 'false']], signal);
      const person = answer?.person;
      const email = typeof person?.email === 'string' ? person.email.trim().toLowerCase() : '';
      if (!email || person?.email_status !== 'verified') return null;
      const name = text(person?.name) || [text(person?.first_name, 80), text(person?.last_name, 80)].filter(Boolean).join(' ');
      return { email, name, title: text(person?.title) };
    },
  };
}

/** The provider the owner chose (Settings → Customer growth → Contact-data service), or null. */
export function peopleProvider(choice, { apolloKey = '', fetchImpl = fetch } = {}) {
  return choice === 'apollo' ? apolloPeople({ apiKey: apolloKey, fetchImpl }) : null;
}
