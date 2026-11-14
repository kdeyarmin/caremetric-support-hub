/**
 * Google Analytics 4, read-only, for the Monday scorecard's "Website visitors" row: active users on a product's public website for the
 * reported Monday-to-Sunday week and the week before. It is optional and reads a product only when Settings → Website analytics holds
 * that product's GA4 property ID and the service has HUB_SEARCH_CONSOLE_CREDENTIALS, the same Google service account the SEO Analyst
 * uses for Search Console. That account needs Viewer access in Google Analytics and the Google Analytics Data API turned on in its
 * Google Cloud project (docs/WEBSITE_SESSION_METRICS.md).
 *
 * Signing in is the service-account flow of search-console.mjs (an RS256 JWT exchanged for a token), asking only for the read-only
 * Analytics scope. Every request goes to Google's token endpoint or the Analytics Data API, follows no redirect and gives up after 15
 * seconds. Only aggregate counts are requested: no dimension but the date range, no user, page, referrer or event. Nothing Google sends
 * back in an error is kept; a failure is a fixed code. The key, the assertion and the token never reach a log line, an error or a result.
 *
 * A period Google returns no row for is unknown (null), never zero, and so is a period that began before the first day the property has
 * any data for: a week the tag was installed partway through is not reported as a short week's total.
 */
import { readCredentials, signAssertion, tokenUrl } from '../seo/search-console.mjs';
import { live } from '../../live.mjs';

export const analyticsScope = 'https://www.googleapis.com/auth/analytics.readonly';
export const analyticsDataOrigin = 'https://analyticsdata.googleapis.com';
export const analyticsHosts = Object.freeze([new URL(tokenUrl).host, new URL(analyticsDataOrigin).host]);
export const analyticsProducts = Object.freeze(['carebase', 'caremetric-intel']);
const grantType = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const tokenShape = /^[\x21-\x7e]{16,4096}$/;
const maxBytes = 65_536;
const failure = code => Object.assign(new Error('Google Analytics could not be read.'), { code });

/** A GA4 property as the Settings page holds it: its numeric ID, or `properties/<id>`. Anything else is null. */
export function analyticsProperty(value) {
  const match = /^(?:properties\/)?(\d{4,20})$/.exec(typeof value === 'string' ? value.trim() : '');
  return match ? match[1] : null;
}

const easternDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = moment => easternDate.format(moment);

/**
 * The two inclusive date ranges Google is asked for, in Eastern calendar days (the properties report in New York time): the week from
 * `since` up to `until` and the week from `before` up to `since`. The boundaries are the scorecard's own Eastern midnights.
 */
export function analyticsRanges({ before, since, until }) {
  if (![before, since, until].every(value => value instanceof Date && Number.isFinite(value.getTime()))) throw failure('analytics_window_invalid');
  if (!(before < since && since < until)) throw failure('analytics_window_invalid');
  const lastDay = end => day(new Date(end.getTime() - 1));
  return [
    { name: 'current', startDate: day(since), endDate: lastDay(until) },
    { name: 'previous', startDate: day(before), endDate: lastDay(since) },
  ];
}

async function readText(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > maxBytes) throw failure('analytics_response_too_large');
  const reader = response.body?.getReader?.();
  if (!reader) return typeof response.text === 'function' ? (await response.text()).slice(0, maxBytes) : '';
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw failure('analytics_response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

const statusCode = status => (status === 401 || status === 403 ? 'analytics_not_permitted' : status === 404 ? 'analytics_property_not_found'
  : status === 429 ? 'analytics_rate_limited' : status === 400 ? 'analytics_request_rejected' : 'analytics_unavailable');

// GA4's earliest reportable day: asking from it finds the first day a property has data for.
export const earliestDate = '2015-08-14';

/** The first day (YYYY-MM-DD) a date-ordered runReport answer has a row for, or null when it has none. */
export function firstDay(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw failure('analytics_response_invalid');
  const value = body.rows?.[0]?.dimensionValues?.[0]?.value;
  if (value === undefined) return null;
  const match = typeof value === 'string' ? /^(\d{4})(\d{2})(\d{2})$/.exec(value) : null;
  if (!match) throw failure('analytics_response_invalid');
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Active users per named date range, from a runReport answer. A range without a row is null. */
export function countsOf(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw failure('analytics_response_invalid');
  const counts = { current: null, previous: null };
  if (body.rows === undefined) return counts;
  if (!Array.isArray(body.rows)) throw failure('analytics_response_invalid');
  for (const row of body.rows) {
    const range = row?.dimensionValues?.[0]?.value;
    const value = row?.metricValues?.[0]?.value;
    if (!Object.hasOwn(counts, range) || typeof value !== 'string' || !/^\d{1,15}$/.test(value)) continue;
    counts[range] = Number(value);
  }
  return counts;
}

/**
 * The reader. `properties` maps a scorecard product key to its GA4 property (a Hub setting, read live). `credentials` is the service
 * account key. `read({ before, since, until, signal, products })` resolves to `{ products: { [key]: { state, visitors, previous } } }`
 * for the asked products that have a property; each is read, partial or unavailable, and one failing never stops the others.
 */
export function googleAnalyticsReader({ credentials = '', properties = {}, fetchImpl = fetch, clock = Date.now, timeoutMs = 15_000, log = line => console.warn(line) } = {}) {
  const account = readCredentials(credentials);
  const configuredProperties = () => Object.fromEntries(analyticsProducts
    .map(key => [key, analyticsProperty(live(properties[key]) ?? '')]).filter(([, id]) => id !== null));
  const readiness = () => ({ credentials: account.state === 'ready', properties: Object.keys(configuredProperties()) });
  const configured = () => account.state === 'ready' && Object.keys(configuredProperties()).length > 0;

  async function send(url, init, signal) {
    const limit = AbortSignal.timeout(timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, limit]) : limit;
    let response;
    try { response = await fetchImpl(url, { ...init, redirect: 'error', cache: 'no-store', signal: bounded }); }
    catch { throw failure(signal?.aborted ? 'analytics_aborted' : limit.aborted ? 'analytics_timeout' : 'analytics_unreachable'); }
    let text;
    try { text = await readText(response); }
    catch (error) { if (error?.code === 'analytics_response_too_large') throw error; throw failure(signal?.aborted ? 'analytics_aborted' : 'analytics_unreachable'); }
    return { status: response.status, ok: response.ok, text };
  }

  async function accessToken(signal) {
    const issuedAt = Math.floor(clock() / 1000);
    const body = new URLSearchParams({ grant_type: grantType, assertion: signAssertion(account, { issuedAt, scope: analyticsScope }) }).toString();
    const answer = await send(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body }, signal);
    if (answer.status !== 200) throw failure('analytics_token_refused');
    let token;
    try { token = JSON.parse(answer.text)?.access_token; } catch { throw failure('analytics_token_invalid'); }
    if (typeof token !== 'string' || !tokenShape.test(token)) throw failure('analytics_token_invalid');
    return token;
  }

  async function report(id, request, token, signal) {
    const url = `${analyticsDataOrigin}/v1beta/properties/${id}:runReport`;
    const answer = await send(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request) }, signal);
    if (!answer.ok) throw failure(statusCode(answer.status));
    try { return JSON.parse(answer.text); } catch { throw failure('analytics_response_invalid'); }
  }

  /**
   * The week's counts, kept only for a period the property measured from its first day: the first day Google has any data for is when
   * collection began, so a week the tag was installed partway through (or before it) is unknown, never a short week's count.
   */
  async function readProperty(id, ranges, token, signal) {
    const [counts, first] = await Promise.all([
      report(id, { dateRanges: ranges, metrics: [{ name: 'activeUsers' }], keepEmptyRows: false }, token, signal).then(countsOf),
      report(id, { dateRanges: [{ startDate: earliestDate, endDate: ranges[0].endDate }], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }],
        orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }], limit: 1, keepEmptyRows: false }, token, signal).then(firstDay),
    ]);
    const covered = range => first !== null && first <= range.startDate;
    const byName = Object.fromEntries(ranges.map(range => [range.name, range]));
    return { current: covered(byName.current) ? counts.current : null, previous: covered(byName.previous) ? counts.previous : null };
  }

  async function read({ before, since, until, signal, products = analyticsProducts } = {}) {
    const wanted = Object.entries(configuredProperties()).filter(([key]) => products.includes(key));
    if (account.state !== 'ready' || wanted.length === 0) return { products: {} };
    const ranges = analyticsRanges({ before, since, until });
    const unavailable = code => ({ state: 'unavailable', visitors: null, previous: null, error: code });
    let token;
    try { token = await accessToken(signal); } catch (error) {
      if (signal?.aborted) throw failure('analytics_aborted');
      const code = /^analytics_[a-z_]+$/.test(error?.code ?? '') ? error.code : 'analytics_unavailable';
      log(JSON.stringify({ event: 'hub_scorecard_analytics_failed', code }));
      return { products: Object.fromEntries(wanted.map(([key]) => [key, unavailable(code)])) };
    }
    const entries = await Promise.all(wanted.map(async ([key, id]) => {
      try {
        const counts = await readProperty(id, ranges, token, signal);
        const state = counts.current !== null && counts.previous !== null ? 'read' : counts.current !== null || counts.previous !== null ? 'partial' : 'unavailable';
        return [key, { state, visitors: counts.current, previous: counts.previous }];
      } catch (error) {
        if (signal?.aborted) throw failure('analytics_aborted');
        const code = /^analytics_[a-z_]+$/.test(error?.code ?? '') ? error.code : 'analytics_unavailable';
        // The product and a fixed code only: never the property's answer, the key or the token.
        log(JSON.stringify({ event: 'hub_scorecard_analytics_failed', product: key, code }));
        return [key, unavailable(code)];
      }
    }));
    return { products: Object.fromEntries(entries) };
  }

  return { readiness, get configured() { return configured(); }, read };
}

const configuredStates = new Set(['read', 'partial', 'unavailable']);

/**
 * The scorecard's visitor source: Intel's own anonymous-session measurement (visitors.mjs) for Intel when it is set up, and Google
 * Analytics for every other product with a property (and for Intel when its own measurement is not set up). The answer keeps the shape
 * the scorecard reads (`{ state, metric, products, sources }`); `sources` says which products Google Analytics answered for.
 */
export function websiteVisitors({ native = null, analytics = null } = {}) {
  const readiness = () => native?.readiness?.() ?? {};
  async function read(input = {}) {
    const nativeOn = native?.configured === true;
    const analyticsOn = analytics?.configured === true;
    const products = Object.fromEntries(analyticsProducts.map(key => [key, { state: 'not_configured', visitors: null, previous: null }]));
    const [own, google] = await Promise.all([
      nativeOn ? native.read(input) : null,
      analyticsOn ? analytics.read({ ...input, products: analyticsProducts.filter(key => !(nativeOn && key === 'caremetric-intel')) }) : null,
    ]);
    const sources = {};
    if (own) for (const key of analyticsProducts) if (own.products?.[key] && own.products[key].state !== 'not_configured') products[key] = own.products[key];
    if (google) for (const [key, value] of Object.entries(google.products ?? {})) {
      if (products[key].state !== 'not_configured') continue;
      products[key] = value;
      sources[key] = 'google_analytics';
    }
    const configured = Object.values(products).filter(item => configuredStates.has(item.state));
    const state = configured.length === 0 ? 'not_configured'
      : configured.every(item => item.state === 'read') ? 'read'
        : configured.some(item => item.state === 'read' || item.state === 'partial') ? 'partial' : 'unavailable';
    // Intel's row is labeled anonymous sessions only when Intel's own measurement answered for it.
    const metric = nativeOn && own?.metric ? own.metric : 'visitors';
    return { state, metric, products, ...(Object.keys(sources).length ? { sources } : {}), ...(own?.error ? { error: own.error } : {}) };
  }
  return { readiness, get configured() { return native?.configured === true || analytics?.configured === true; }, read };
}
