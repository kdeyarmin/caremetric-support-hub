/**
 * Who signs for an agency in the federal NPI registry (NPPES, npiregistry.cms.hhs.gov/api, version 2.1, checked 2026-11-13). Every
 * home health agency and hospice has an organization NPI, and its record names an "authorized official": a person and their title,
 * usually the owner, administrator or chief executive. The registry is public, free and needs no key.
 *
 * - One search per agency: organizations (NPI-2) at the agency's ZIP code with its kind of care, or in its city when the roster has no
 *   ZIP. A record is the agency's only when its practice location is in the agency's state and either its telephone number is the
 *   one CMS lists for the agency, or its name (or a name it does business as) is the agency's name.
 * - Only the official's name and title are kept, with the record's public page as the source. Never a telephone number.
 * - One fixed HTTPS address, no redirects, a bounded answer. Failures carry a code only.
 */
const origin = 'https://npiregistry.cms.hhs.gov';
const maxBytes = 2_000_000;
const failure = (code, transient = false) => Object.assign(new Error('The NPI registry could not be read.'), { code, transient });
const legal = new Set(['inc', 'incorporated', 'llc', 'l', 'c', 'corp', 'corporation', 'co', 'company', 'ltd', 'pc', 'pllc', 'lp', 'llp', 'the', 'of', 'and', 'dba']);
const digits = value => String(value ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const text = (value, max = 200) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** An organization's name as its distinctive words: "Valley Home Health, Inc." and "VALLEY HOME HEALTH INC" read alike. */
export function nameWords(name) {
  return new Set(String(name ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(word => word && !legal.has(word)));
}

// Words nearly every agency's name has, which say nothing about which agency it is.
const generic = new Set(['home', 'homes', 'health', 'healthcare', 'hospice', 'care', 'caring', 'services', 'service', 'agency', 'nursing', 'nurses',
  'nurse', 'visiting', 'palliative', 'homecare', 'private', 'duty', 'medical', 'association', 'center', 'centre', 'group', 'solutions', 'at', 'in', 'a']);

/**
 * Whether two organization names are the same name: every word of the shorter is in the longer, and the shorter has a word of its
 * own (not "home", "health", "hospice" and the like). Callers have already narrowed the records to the agency's ZIP code or city.
 */
export function sameName(a, b) {
  const one = nameWords(a), two = nameWords(b);
  if (!one.size || !two.size) return false;
  const [small, large] = one.size <= two.size ? [one, two] : [two, one];
  return [...small].every(word => large.has(word)) && [...small].some(word => !generic.has(word));
}

/** "JANE A DOE" as "Jane A Doe". */
export function personCase(value) {
  return text(value).toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, before, letter) => `${before}${letter.toUpperCase()}`);
}

async function readJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw failure('npi_response_invalid');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw failure('npi_response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('npi_response_invalid'); }
}

/** The authorized officials of the records that are this agency's: [{ name, title, source, sourceUrl }], at most three. */
export function agencyOfficials(results, agency) {
  const state = String(agency?.state ?? '').toUpperCase();
  const phone = digits(agency?.phone);
  const people = new Map();
  for (const record of Array.isArray(results) ? results : []) {
    const basic = record?.basic ?? {};
    if (record?.enumeration_type !== 'NPI-2' || (basic.status && basic.status !== 'A') || !/^\d{10}$/.test(String(record?.number ?? ''))) continue;
    const location = (Array.isArray(record.addresses) ? record.addresses : []).find(address => address?.address_purpose === 'LOCATION');
    if (!location || String(location.state ?? '').toUpperCase() !== state) continue;
    const names = [basic.organization_name, ...(Array.isArray(record.other_names) ? record.other_names.map(other => other?.organization_name) : [])];
    const byPhone = phone.length === 10 && digits(location.telephone_number) === phone;
    if (!byPhone && !names.some(name => sameName(name, agency?.name))) continue;
    const name = [basic.authorized_official_first_name, basic.authorized_official_middle_name, basic.authorized_official_last_name]
      .map(part => personCase(part)).filter(part => part && part !== '--').join(' ');
    if (!basic.authorized_official_first_name || !basic.authorized_official_last_name || name.length > 200) continue;
    // The same person on two records, once with a middle name, is one person.
    const key = `${personCase(basic.authorized_official_first_name)}|${personCase(basic.authorized_official_last_name)}`.toLowerCase();
    if (!people.has(key)) {
      people.set(key, { name, title: text(basic.authorized_official_title_or_position) || 'Authorized official', source: 'npi_registry',
        sourceUrl: `${origin}/provider-view/${record.number}` });
    }
  }
  return [...people.values()].slice(0, 3);
}

export function npiRegistry({ fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  return {
    configured: true,
    /**
     * The authorized officials the registry lists for one roster agency ({ name, city, state, zip, phone, setting }), or [] when the
     * registry has no record that is surely the agency's.
     */
    async officials(agency, { signal } = {}) {
      const state = String(agency?.state ?? '').toUpperCase();
      const zip = /^\d{5}$/.test(String(agency?.zip ?? '')) ? String(agency.zip) : null;
      const city = text(agency?.city, 100);
      if (!/^[A-Z]{2}$/.test(state) || (!zip && !city) || !text(agency?.name)) return [];
      const query = new URLSearchParams({ version: '2.1', enumeration_type: 'NPI-2', taxonomy_description: agency.setting === 'hospice' ? 'Hospice' : 'Home Health', limit: '200' });
      if (zip) query.set('postal_code', zip); else { query.set('city', city); query.set('state', state); }
      let response;
      try {
        response = await fetchImpl(`${origin}/api/?${query}`, { redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw failure('npi_unavailable', true);
      }
      if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw failure('npi_unavailable', response.status === 429 || response.status >= 500); }
      const answer = await readJson(response);
      if (Array.isArray(answer?.Errors) && answer.Errors.length) return [];
      return agencyOfficials(answer?.results, agency);
    },
  };
}
