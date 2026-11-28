/**
 * Every Medicare- and Medicaid-certified nursing home in a state, from CMS's Provider Data Catalog (Nursing homes including rehab services,
 * Provider Information, dataset 4pq5-n9py): public, no key. Each row as the state launch keeps it: CCN, name, place, county, ownership,
 * certified beds, whether it sits in a hospital, and its chain (CMS names the chain and how many facilities it has, in any state).
 *
 * Home health agencies and hospices come from Intel's marketing feed instead (growth/intel-feed.mjs `roster`), as for the Medicare roster.
 */
import { displayName } from '../growth/roster.mjs';

export const nursingHomeDataset = '4pq5-n9py';
const endpoint = `https://data.cms.gov/provider-data/api/1/datastore/query/${nursingHomeDataset}/0`;
const pageSize = 500;
const maxPages = 10;
const timeoutMs = 30_000;
const maxBytes = 6_000_000;
export const userAgent = 'CareMetric-Hub/1.0 (+https://help.caremetric.ai)';

const text = (value, max = 300) => { const s = String(value ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };
const whole = value => { const n = Number(String(value ?? '').trim()); return String(value ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };

/** One CMS row as a state launch facility, or null when it has no usable CCN or name. */
export function nursingHomeRow(row, state) {
  const ccn = String(row?.cms_certification_number_ccn ?? '').trim().toUpperCase();
  const name = text(row?.provider_name);
  if (!/^[0-9A-Z]{6}$/.test(ccn) || !name) return null;
  if (state && String(row?.state ?? '').trim().toUpperCase() !== state) return null;
  const zip = String(row?.zip_code ?? '').trim().slice(0, 5);
  return {
    ccn, setting: 'nursing_home', name: displayName(name), city: text(displayName(row?.citytown), 200), zip: /^\d{5}$/.test(zip) ? zip : null,
    county: text(row?.countyparish, 200), ownership: text(row?.ownership_type, 200), beds: whole(row?.number_of_certified_beds),
    inHospital: String(row?.provider_resides_in_hospital ?? '').trim().toUpperCase() === 'Y',
    chainId: text(row?.chain_id, 40), chainName: text(row?.chain_name, 300) ? displayName(text(row.chain_name, 300)) : null,
    chainSize: whole(row?.number_of_facilities_in_chain),
  };
}

/** Every nursing home CMS lists in `state`, a page of 500 at a time. */
export async function nursingHomes({ state, fetchImpl = globalThis.fetch, signal } = {}) {
  if (!/^[A-Z]{2}$/.test(state ?? '')) throw Object.assign(new Error('A state is two letters'), { code: 'state' });
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    signal?.throwIfAborted();
    const url = new URL(endpoint);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(page * pageSize));
    url.searchParams.set('conditions[0][property]', 'state');
    url.searchParams.set('conditions[0][value]', state);
    url.searchParams.set('conditions[0][operator]', '=');
    url.searchParams.set('count', 'true');
    url.searchParams.set('results', 'true');
    url.searchParams.set('schema', 'false');
    url.searchParams.set('keys', 'true');
    let response;
    try {
      // CMS's firewall refuses a request without a user agent (Node's fetch sends none of its own).
      response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { accept: 'application/json', 'user-agent': userAgent },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw Object.assign(new Error('CMS could not be reached'), { code: 'cms_unavailable', retryable: true });
    }
    if (!response.ok) throw Object.assign(new Error(`CMS answered ${response.status}`), { code: 'cms_unavailable', retryable: response.status >= 500 });
    const raw = await response.text();
    if (raw.length > maxBytes) throw Object.assign(new Error('CMS answered too much'), { code: 'cms_invalid' });
    let body;
    try { body = JSON.parse(raw); } catch { throw Object.assign(new Error('CMS answered something else'), { code: 'cms_invalid' }); }
    const results = Array.isArray(body?.results) ? body.results : [];
    for (const row of results) { const kept = nursingHomeRow(row, state); if (kept) rows.push(kept); }
    const total = Number(body?.count);
    if (results.length < pageSize || (Number.isFinite(total) && (page + 1) * pageSize >= total)) break;
  }
  return rows;
}
