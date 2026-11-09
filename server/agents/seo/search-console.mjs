/**
 * Google Search Console, read-only, for the SEO Analyst's weekly report. It is optional: the Hub reads it only when the service
 * has HUB_SEARCH_CONSOLE_CREDENTIALS (a Google service account's JSON key) and the properties to read (Settings → Search; the old HUB_SEARCH_CONSOLE_SITES variable until it is copied in).
 * Without them the report runs from the crawl alone and says how to connect it.
 *
 * Signing in is the service-account flow, done here with node:crypto and no Google library: a JWT signed with the account's
 * private key (RS256) is exchanged at Google's token endpoint for an access token with the read-only Search Console scope. The
 * token is kept in memory until shortly before it expires and is never written anywhere.
 *
 * Every request goes to one of two pinned hosts (the token endpoint and the Search Console API; the key file's own token_uri is
 * ignored), follows no redirect, gives up after 15 seconds and is tried once more after a timeout, a dropped connection, a
 * rate limit or a server error. Nothing Google sends back in an error is kept: a failure is a fixed code and an HTTP status. The
 * key, the signed assertion and the access token never reach a log line, an error, a result or the report.
 */
import { createPrivateKey, sign } from 'node:crypto';

export const tokenUrl = 'https://oauth2.googleapis.com/token';
export const apiOrigin = 'https://searchconsole.googleapis.com';
export const readScope = 'https://www.googleapis.com/auth/webmasters.readonly';
export const searchConsoleHosts = Object.freeze([new URL(tokenUrl).host, new URL(apiOrigin).host]);
export const defaults = Object.freeze({ timeoutMs: 15_000, retryDelayMs: 1_000, rowLimit: 250, maxBytes: 4_000_000, maxProperties: 10, lagDays: 3, days: 28 });

const grantType = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const serviceAccountEmail = /^[a-z0-9][a-z0-9._-]{0,99}@[a-z0-9][a-z0-9.-]{0,199}\.[a-z]{2,}$/i;
const domainProperty = /^sc-domain:((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/i;
// A token is opaque, but it goes into a header: printable ASCII only, and a sane length.
const tokenShape = /^[\x21-\x7e]{16,4096}$/;
const present = value => typeof value === 'string' && value.trim().length > 0;

/** An error that carries only a fixed code and, when Google answered, its HTTP status. */
export const searchConsoleError = (code, status = null) => Object.assign(new Error('Search Console could not be read.'), { code, status });

/**
 * The service account in HUB_SEARCH_CONSOLE_CREDENTIALS: the JSON key file as Google downloads it (or the same text in base64).
 * `{ state: 'missing' }`, `{ state: 'invalid' }` or `{ state: 'ready', clientEmail, keyId, privateKey }`, where `privateKey` is a
 * KeyObject (it prints and serializes without its key material). Nothing about a key that does not parse is reported.
 */
export function readCredentials(raw) {
  if (!present(raw)) return { state: 'missing' };
  const text = raw.trim();
  let data;
  try { data = JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8')); } catch { return { state: 'invalid' }; }
  if (data === null || typeof data !== 'object' || data.type !== 'service_account') return { state: 'invalid' };
  if (typeof data.client_email !== 'string' || !serviceAccountEmail.test(data.client_email) || typeof data.private_key !== 'string') return { state: 'invalid' };
  let privateKey;
  try { privateKey = createPrivateKey({ key: data.private_key, format: 'pem' }); } catch { return { state: 'invalid' }; }
  if (privateKey.asymmetricKeyType !== 'rsa') return { state: 'invalid' };
  const keyId = typeof data.private_key_id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(data.private_key_id) ? data.private_key_id : null;
  return { state: 'ready', clientEmail: data.client_email.toLowerCase(), keyId, privateKey };
}

/**
 * The Search Console properties (Settings → Search), separated by commas or spaces, written as Search Console names them: a domain
 * property (sc-domain:cmcarebase.com) or an address prefix (https://www.caremetricintel.com/). Anything else is counted and left
 * out. At most ten are read.
 *
 * An address prefix is kept exactly as written, apart from the slash a bare host always has (https://example.com is
 * https://example.com/). The API names a property "as defined in Search Console" and Google's help asks for the prefix "including
 * the final / mark", but nothing says Search Console refuses one without it, so a slash is never added to a path: a prefix written
 * differently from Search Console's is answered as unknown or not permitted, and the report says how to write it.
 */
export function readProperties(raw, { limit = defaults.maxProperties } = {}) {
  const found = [];
  let invalid = 0;
  for (const item of String(raw ?? '').split(/[\s,]+/).filter(Boolean)) {
    const domain = domainProperty.exec(item);
    if (domain) { found.push(`sc-domain:${domain[1].toLowerCase()}`); continue; }
    let url = null;
    try { url = new URL(item); } catch { /* counted below */ }
    if (url && (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !url.search && !url.hash && item.includes('://')) {
      found.push(url.href);
      continue;
    }
    invalid += 1;
  }
  const properties = [...new Set(found)];
  return { properties: properties.slice(0, limit), invalid: invalid + Math.max(properties.length - limit, 0) };
}

const base64url = value => Buffer.from(value).toString('base64url');

/**
 * The signed assertion for the token exchange (RFC 7523): an RS256 JWT from the service account, for Google's token endpoint,
 * asking for `scope`, valid for an hour from `issuedAt` (seconds since the epoch).
 */
export function signAssertion({ clientEmail, keyId = null, privateKey }, { issuedAt, scope = readScope, audience = tokenUrl, lifetimeSeconds = 3600 }) {
  const header = { alg: 'RS256', typ: 'JWT', ...(keyId ? { kid: keyId } : {}) };
  const claims = { iss: clientEmail, scope, aud: audience, iat: issuedAt, exp: issuedAt + lifetimeSeconds };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

/** The answer's body as text, at most `maxBytes`; a longer one is refused rather than cut, because a cut JSON body cannot be read. */
async function readText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw searchConsoleError('response_too_large', response.status);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One request with its own 15 second limit (for the answer and its body). Never throws: `{ status, text }` when Google answered,
 * or `{ status: 0, failure }` where failure is timeout, network or aborted (the caller's own signal).
 */
async function attempt(fetchImpl, url, init, { signal, timeoutMs, maxBytes }) {
  const limit = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, limit]) : limit;
  const stopped = () => ({ status: 0, failure: signal?.aborted ? 'aborted' : limit.aborted ? 'timeout' : 'network' });
  // The limit holds even against a transport that ignores its signal: the answer and its body each race it.
  const aborted = new Promise((_, reject) => {
    if (combined.aborted) reject(combined.reason);
    else combined.addEventListener('abort', () => reject(combined.reason), { once: true });
  });
  aborted.catch(() => {});
  let response;
  try {
    response = await Promise.race([fetchImpl(url, { ...init, redirect: 'error', cache: 'no-store', signal: combined }), aborted]);
  } catch { return stopped(); }
  try {
    return { status: response.status, text: await Promise.race([readText(response, maxBytes), aborted]) };
  } catch (error) {
    if (error?.code === 'response_too_large') return { status: 0, failure: 'too_large' };
    await response.body?.cancel().catch(() => {});
    return stopped();
  }
}

// Worth one more try: nothing answered in time, the connection dropped, a rate limit or a server error. Never the caller's own stop.
const retryable = result => (result.status === 0 ? result.failure === 'timeout' || result.failure === 'network'
  : result.status === 408 || result.status === 429 || result.status >= 500);

/** What a failed request means, as one of the codes the report explains. */
function failureCode(result, kind) {
  if (result.status === 0) return result.failure === 'aborted' ? 'aborted' : result.failure === 'too_large' ? 'response_invalid' : `${kind}_unreachable`;
  if (result.status === 429) return 'rate_limited';
  if (result.status === 408 || result.status >= 500) return `${kind}_unavailable`;
  if (kind === 'token') return 'token_refused';
  if (result.status === 401) return 'token_refused';
  if (result.status === 403) return 'not_permitted';
  if (result.status === 404) return 'property_not_found';
  return 'request_rejected';
}

const isCount = value => Number.isFinite(value) && value >= 0;
const field = (row, name) => (isCount(row?.[name]) ? row[name] : 0);

/** The rows of a searchAnalytics.query answer, checked: [{ keys, clicks, impressions, ctr, position }]. */
function rowsOf(body, dimensions, rowLimit) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw searchConsoleError('response_invalid');
  if (body.rows === undefined) return [];
  if (!Array.isArray(body.rows)) throw searchConsoleError('response_invalid');
  return body.rows.slice(0, rowLimit).flatMap(row => {
    const keys = Array.isArray(row?.keys) ? row.keys : [];
    if (keys.length !== dimensions || keys.some(key => typeof key !== 'string')) return [];
    return [{ keys: keys.map(key => key.slice(0, 2048)), clicks: field(row, 'clicks'), impressions: field(row, 'impressions'), ctr: field(row, 'ctr'), position: field(row, 'position') }];
  });
}

const pacificDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });

/**
 * The two windows the report compares, in Search Console's own day (Pacific time): the last `days` days that have final data
 * (the newest `lagDays` days are left out, because Google is still adding to them) and the `days` days before those.
 */
export function windows(moment, { lagDays = defaults.lagDays, days = defaults.days } = {}) {
  const [year, month, day] = pacificDate.format(moment).split('-').map(Number);
  const date = back => new Date(Date.UTC(year, month - 1, day - back)).toISOString().slice(0, 10);
  return {
    current: { startDate: date(lagDays + days - 1), endDate: date(lagDays) },
    previous: { startDate: date(lagDays + 2 * days - 1), endDate: date(lagDays + days) },
  };
}

/**
 * The Search Console reader the weekly task uses. `state` is ready, not_configured (neither variable is set),
 * credentials_missing, credentials_invalid or no_properties; only a ready reader makes requests.
 *
 * `read({ signal, now })` resolves to `{ window, properties: [{ property, ok: true, totals: { current, previous }, queries, pages,
 * pairs } | { property, ok: false, code, status }] }`. A property that cannot be read does not stop the others, and nothing is
 * thrown except when the caller's own signal stops the work.
 */
export function searchConsoleReader({
  credentials: rawCredentials, sites: rawSites, fetchImpl = fetch, log = line => console.warn(line), clock = () => Date.now(),
  sleep = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }), limits = {},
} = {}) {
  const config = { ...defaults, ...limits };
  const credentials = readCredentials(rawCredentials);
  const { properties, invalid } = readProperties(rawSites, { limit: config.maxProperties });
  const state = !present(rawCredentials) && !present(rawSites) ? 'not_configured'
    : credentials.state === 'missing' ? 'credentials_missing'
      : credentials.state === 'invalid' ? 'credentials_invalid'
        : properties.length === 0 ? 'no_properties' : 'ready';
  const options = { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes };

  let cached = null;
  let pending = null;

  async function exchange(signal) {
    const issuedAt = Math.floor(clock() / 1000);
    const body = new URLSearchParams({ grant_type: grantType, assertion: signAssertion(credentials, { issuedAt }) }).toString();
    const init = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body };
    let result = await attempt(fetchImpl, tokenUrl, init, { signal, ...options });
    if (retryable(result) && !signal?.aborted) {
      await sleep(config.retryDelayMs);
      result = await attempt(fetchImpl, tokenUrl, init, { signal, ...options });
    }
    if (result.status !== 200) throw searchConsoleError(failureCode(result, 'token'), result.status || null);
    let answer;
    try { answer = JSON.parse(result.text); } catch { throw searchConsoleError('token_invalid', 200); }
    if (typeof answer?.access_token !== 'string' || !tokenShape.test(answer.access_token)) throw searchConsoleError('token_invalid', 200);
    const seconds = Number.isFinite(answer.expires_in) && answer.expires_in > 0 ? Math.min(answer.expires_in, 3600) : 3600;
    // Counted from before the request, and given up a minute early, so a cached token is never used after Google stops taking it.
    cached = { token: answer.access_token, until: issuedAt * 1000 + (seconds - 60) * 1000 };
    return cached.token;
  }

  /** An access token: the cached one while it lasts, else one exchange shared by every request that needs it at the same time. */
  async function accessToken(signal) {
    if (cached && clock() < cached.until) return cached.token;
    pending ??= exchange(signal).finally(() => { pending = null; });
    return pending;
  }

  /** One searchAnalytics.query call for one property. Resolves to its rows; rejects with a coded error. */
  async function query(property, request, signal) {
    const url = `${apiOrigin}/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
    const send = async () => attempt(fetchImpl, url, {
      method: 'POST', body: JSON.stringify(request),
      headers: { authorization: `Bearer ${await accessToken(signal)}`, 'content-type': 'application/json', accept: 'application/json' },
    }, { signal, ...options });
    let result = await send();
    if (result.status === 401) {
      // The token was refused (revoked, or the clock is off): one fresh token, once.
      cached = null;
      result = await send();
    } else if (retryable(result) && !signal?.aborted) {
      await sleep(config.retryDelayMs);
      result = await send();
    }
    if (result.status !== 200) throw searchConsoleError(failureCode(result, 'api'), result.status || null);
    let body;
    try { body = JSON.parse(result.text); } catch { throw searchConsoleError('response_invalid', 200); }
    return rowsOf(body, request.dimensions?.length ?? 0, config.rowLimit);
  }

  async function readProperty(property, window, signal) {
    const ask = (period, dimensions) => query(property, {
      startDate: window[period].startDate, endDate: window[period].endDate, type: 'web', dataState: 'final',
      ...(dimensions.length ? { dimensions, rowLimit: config.rowLimit } : {}),
    }, signal);
    const total = rows => ({ clicks: rows[0]?.clicks ?? 0, impressions: rows[0]?.impressions ?? 0, ctr: rows[0]?.ctr ?? 0, position: rows[0]?.position ?? 0 });
    try {
      const [current, previous, queries, pages, pairs] = await Promise.all([
        ask('current', []), ask('previous', []), ask('current', ['query']), ask('current', ['page']), ask('current', ['query', 'page']),
      ]);
      return { property, ok: true, totals: { current: total(current), previous: total(previous) }, queries, pages, pairs };
    } catch (error) {
      if (signal?.aborted) throw searchConsoleError('aborted');
      const code = typeof error?.code === 'string' && /^[a-z_]{1,40}$/.test(error.code) ? error.code : 'search_console_error';
      const status = Number.isInteger(error?.status) ? error.status : null;
      // The property is the owner's own setting; the code and status are fixed. Never the answer, the key or the token.
      log(JSON.stringify({ event: 'hub_seo_search_console_failed', property, code, status }));
      return { property, ok: false, code, status };
    }
  }

  async function read({ signal, now = new Date() } = {}) {
    if (state !== 'ready') throw searchConsoleError(state);
    const window = windows(now, config);
    return { window, properties: await Promise.all(properties.map(property => readProperty(property, window, signal))) };
  }

  /**
   * Clicks and impressions only, for the Chief of Staff's Monday scorecard: the last `days` days with final data against the `days` days
   * before, per property. Two requests a property; a property that cannot be read is `{ property, ok: false, code, status }`.
   */
  async function totals({ signal, now = new Date(), days = 7 } = {}) {
    if (state !== 'ready') throw searchConsoleError(state);
    const window = windows(now, { lagDays: config.lagDays, days });
    const total = rows => ({ clicks: rows[0]?.clicks ?? 0, impressions: rows[0]?.impressions ?? 0 });
    return {
      window,
      properties: await Promise.all(properties.map(async property => {
        const ask = period => query(property, { startDate: window[period].startDate, endDate: window[period].endDate, type: 'web', dataState: 'final' }, signal);
        try {
          const [current, previous] = await Promise.all([ask('current'), ask('previous')]);
          return { property, ok: true, current: total(current), previous: total(previous) };
        } catch (error) {
          if (signal?.aborted) throw searchConsoleError('aborted');
          const code = typeof error?.code === 'string' && /^[a-z_]{1,40}$/.test(error.code) ? error.code : 'search_console_error';
          const status = Number.isInteger(error?.status) ? error.status : null;
          log(JSON.stringify({ event: 'hub_seo_search_console_failed', property, code, status }));
          return { property, ok: false, code, status };
        }
      })),
    };
  }

  return { state, configured: state === 'ready', properties, invalidProperties: invalid, account: credentials.state === 'ready' ? credentials.clientEmail : null, read, totals };
}
