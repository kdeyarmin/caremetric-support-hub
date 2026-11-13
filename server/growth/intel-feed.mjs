/**
 * Intel's marketing feed (Intel docs/HUB_MARKETING_FEED.md): the Medicare roster of home health agencies and hospices, and headline
 * county figures, read server to server. Public CMS and Census data only; Intel never sends customer data through it.
 *
 * - One fixed HTTPS address (Intel's production site), no redirects, a bounded response, checked with zod. Unknown fields Intel adds
 *   later are dropped, so a newer Intel never breaks this reader.
 * - Signed exactly as the feed checks: `X-CareMetric-Signature: v1=` and the hex HMAC-SHA256 of `<timestamp>.<raw body>` with the
 *   shared secret (HUB_INTEL_FEED_SECRET here, HUB_MARKETING_FEED_SECRET on Intel), which is the lead-form scheme (`leadSignature`).
 * - Failures carry a code only: never the secret, the request body or Intel's error text.
 */
import { z } from 'zod';
import { leadSignature } from '../leads.mjs';
import { live } from '../live.mjs';

export const intelFeedFeature = 'platform.agents.growth-roster.v1';
export const intelFeedUrl = 'https://www.caremetricintel.com/api/hub/marketing-feed';
export const intelFeedContract = 'caremetric.marketing-feed.v1';
/** The feed allows 60 requests a minute per caller; pages are read at most one a second. */
export const intelFeedPaceMs = 1100;
const maxBytes = 2_000_000;
const validKey = key => typeof key === 'string' && key.length >= 32;
const failure = (code, transient = false) => Object.assign(new Error('Intel\'s marketing feed could not be read.'), { code, transient });

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const signal = z.object({ type: z.enum(['newly_certified', 'change_of_ownership', 'closed']), detected_in: z.string().max(10),
  date, detail: z.string().max(500).nullable() });
const count = z.number().finite().nullable();
const item = z.object({
  ccn: z.string().regex(/^[0-9A-Z]{6,10}$/), name: z.string().max(300).nullable(), setting: z.enum(['home_health', 'hospice']),
  city: z.string().max(200).nullable(), state: z.string().regex(/^[A-Z]{2}$/).nullable(), zip: z.string().regex(/^\d{5}$/).nullable(),
  county_fips: z.string().regex(/^\d{5}$/).nullable(), control_type: z.string().max(200).nullable(), control_type_code: z.string().max(20).nullable(),
  certification_date: date, termination_date: date, change_of_ownership_date: date, signals: z.array(signal).max(10),
  contact: z.object({ address: z.string().max(300).nullable(), phone: z.string().regex(/^\d{10}$/).nullable() }).nullable().optional(),
  quality: z.object({ care_star_rating: z.number().min(1).max(5).nullable(), data_year: z.string().max(10).nullable() }).nullable().optional(),
  volume: z.object({ data_year: z.string().max(10), medicare_patients: count, county_fips: z.string().max(5).nullable(), county_share: count,
    county_rank: count, county_providers: count, state_share: count, state_rank: count, state_providers: count }).nullable().optional(),
});
const rosterSchema = z.object({ contract: z.literal(intelFeedContract), action: z.literal('roster'), period: z.string().regex(/^\d{4}Q[1-4]$/).nullable(),
  source_line: z.string().max(1000), items: z.array(item).max(500), next_cursor: z.string().regex(/^[0-9A-Z]{6,10}$/).nullable() });
const owner = z.object({ name: z.string().min(1).max(200), kind: z.enum(['individual', 'organization']).nullable(), role: z.string().max(200).nullable(),
  percentage: z.number().min(0).max(100).nullable(), data_year: z.string().max(10).nullable() });
const factsSchema = z.object({ contract: z.literal(intelFeedContract), action: z.literal('agency_facts'), source_line: z.string().max(1000),
  agencies: z.array(z.object({ ccn: z.string().regex(/^[0-9A-Z]{6}$/), owners: z.array(owner).max(20),
    hhvbp: z.record(z.string(), z.unknown()).nullable(), hospice_care_index: z.record(z.string(), z.unknown()).nullable() })).max(25) });
const figure = z.object({ key: z.string().max(80), label: z.string().max(200), value: z.number().finite(), unit: z.string().max(40),
  data_year: z.string().max(10).nullable(), period: z.string().max(80).nullable(), dataset: z.string().max(200), source_line: z.string().max(1000),
  short_source: z.string().max(200).optional() });
const releasesSchema = z.object({ contract: z.literal(intelFeedContract), action: z.literal('releases'), source_line: z.string().max(1000),
  releases: z.array(z.object({ dataset: z.string().regex(/^[a-z0-9_]{1,100}$/), title: z.string().min(1).max(300), data_year: z.string().max(10).nullable(),
    period_start: date, period_end: date, published: date, loaded: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).max(25) });
const observancesSchema = z.object({ contract: z.literal(intelFeedContract), action: z.literal('observances'), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  observances: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/), name: z.string().min(1).max(200), category: z.string().max(40), audience: z.string().max(300),
    sponsor: z.string().max(300), start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), idea: z.string().max(1000) })).max(40) });
const countySchema = z.object({ contract: z.literal(intelFeedContract), action: z.literal('county_figures'), source_line: z.string().max(1000),
  counties: z.array(z.object({ county_fips: z.string().regex(/^\d{5}$/), county_name: z.string().max(200), state: z.string().max(2), figures: z.array(figure).max(40) })).max(50),
  not_found: z.array(z.string()).max(50) });

async function readJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > maxBytes) throw failure('feed_response_too_large');
  const reader = response.body?.getReader?.();
  if (!reader) throw failure('feed_response_invalid');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw failure('feed_response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('feed_response_invalid'); }
}

/**
 * `enabled` is a live setting (Settings → Customer growth → Find prospects from the Medicare roster); `key` the process secret.
 * Readiness makes no request.
 */
export function intelFeedReader({ features = null, enabled = false, key = '', fetchImpl = fetch, now = Date.now, timeoutMs = 30_000, url = intelFeedUrl } = {}) {
  const readiness = () => ({ declared: features?.has?.(intelFeedFeature) === true, enabled: live(enabled) === true, signing: validKey(key) });
  const configured = () => Object.values(readiness()).every(Boolean);
  async function call(body, schema, { signal } = {}) {
    if (!configured()) throw failure('feed_not_configured');
    signal?.throwIfAborted();
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(now() / 1000));
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', redirect: 'error', cache: 'no-store', signal: bounded,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CareMetric-Timestamp': timestamp,
          'X-CareMetric-Signature': leadSignature(key, timestamp, raw) }, body: raw });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw failure('feed_unavailable', true);
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      if (response.status === 401 || response.status === 403) throw failure('feed_not_permitted');
      if (response.status === 400) throw failure('feed_request_refused');
      if (response.status === 429) throw failure('feed_rate_limited', true);
      if (response.status === 503 || response.status === 404) throw failure('feed_not_ready', true);
      throw failure('feed_unavailable', true);
    }
    const parsed = schema.safeParse(await readJson(response));
    if (!parsed.success) throw failure('feed_response_invalid');
    return parsed.data;
  }
  return {
    readiness, get configured() { return configured(); }, paceMs: intelFeedPaceMs,
    /** One page of the roster for `states`, with the agencies' public contact, quality and volume details. */
    roster: ({ states, cursor = null, limit = 500, include = ['contact', 'quality', 'volume'], signal } = {}) =>
      call({ action: 'roster', states, ...(cursor ? { cursor } : {}), limit, include }, rosterSchema, { signal }),
    /** Headline figures for up to 50 counties, each with its unit, year and source line. */
    countyFigures: ({ countyFips, signal } = {}) => call({ action: 'county_figures', county_fips: countyFips }, countySchema, { signal }),
    /** The CMS and Census datasets Intel loaded a new release of in the last `sinceDays` days (catalog metadata only). */
    releases: ({ sinceDays = 30, signal } = {}) => call({ action: 'releases', since_days: sinceDays }, releasesSchema, { signal }),
    /** Healthcare observances starting in the next `days` days, from Intel's fixed calendar. */
    observances: ({ days = 45, signal } = {}) => call({ action: 'observances', days }, observancesSchema, { signal }),
    /** Up to 25 agencies' owners (CMS All Owners), HHVBP score and Hospice Care Index, for research only. */
    agencyFacts: ({ ccns, signal } = {}) => call({ action: 'agency_facts', ccns }, factsSchema, { signal }),
  };
}
