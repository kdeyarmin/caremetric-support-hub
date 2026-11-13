/**
 * Intel's marketing feed, action `roster` (Intel's docs/HUB_MARKETING_FEED.md): the Medicare-certified home health agencies and
 * hospices in CMS's newest Provider of Services quarter, with their certification, change-of-ownership and termination dates. Public
 * CMS data only, read server to server.
 *
 * Every request is signed with the secret Intel and the Hub share (HUB_INTEL_MARKETING_FEED_SECRET here, HUB_MARKETING_FEED_SECRET on
 * Intel; at least 32 characters, or it counts as not set): `X-CareMetric-Timestamp` is the Unix time in whole seconds, and
 * `X-CareMetric-Signature` is `v1=` and the lowercase hex HMAC-SHA256 of `<timestamp>.<body>`, over exactly the bytes sent. The
 * address is Intel's own site from the fact sheet, never one a caller supplies; redirects are refused. A failure carries a fixed
 * message and a code (`feed_*`): never the secret, the request or anything Intel answered beyond its error code.
 */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { live } from '../live.mjs';
import { products as productFacts } from '../agents/content/facts.mjs';

export const marketingFeedContract = 'caremetric.marketing-feed.v1';
export const marketingFeedUrl = `${new URL(productFacts.intel.site).origin}/api/hub/marketing-feed`;
/** The most facilities Intel returns on one page. */
export const rosterPageLimit = 500;
// About 300 bytes a facility: a full page is well under this.
const maxBytes = 1_000_000;
// Intel's own error codes (its "Errors" table); anything else is reported as `feed_unavailable`.
const intelErrors = new Set(['invalid_request', 'invalid_signature', 'expired_timestamp', 'too_large', 'not_configured', 'timeout', 'not_ready', 'internal']);
const validSecret = secret => typeof secret === 'string' && secret.length >= 32;
const failure = (code, transient = false) => Object.assign(new Error('The CMS roster could not be read.'), { code, transient });

/** `v1=` and the hex HMAC-SHA256 of `<timestamp>.<body>`, keyed with the shared secret. */
export function marketingFeedSignature(secret, timestamp, body) {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().transform(value => value ?? null);
const facilitySchema = z.object({
  ccn: z.string().regex(/^[0-9A-Z]{6}$/),
  name: z.string().trim().min(1).max(300),
  setting: z.enum(['home_health', 'hospice']),
  city: z.string().trim().max(100).nullish().transform(value => value || null),
  state: z.string().regex(/^[A-Z]{2}$/),
  certification_date: day,
  termination_date: day,
  change_of_ownership_date: day,
  signals: z.array(z.object({ type: z.string().max(40), date: day.optional() })).max(10).nullish().transform(value => value ?? []),
});
const pageSchema = z.object({
  contract: z.literal(marketingFeedContract), action: z.literal('roster'), period: z.string().regex(/^\d{4}Q[1-4]$/).nullable(),
  items: z.array(z.unknown()).max(rosterPageLimit), next_cursor: z.string().min(1).max(40).nullable(),
});

async function readBody(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > limit) throw failure('feed_response_too_large');
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw failure('feed_response_too_large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Intel's error code from a refusal (`{ "error": "..." }`), when it is one of its documented codes. Nothing else is read. */
async function refusal(response) {
  try { const code = JSON.parse(await readBody(response, 4_096))?.error; return intelErrors.has(code) ? code : null; } catch { return null; }
}

/**
 * The client. `enabled` is the owner's switch (Settings → Customer growth → Find prospects in the CMS roster), read on every use;
 * `secret` is the shared signing secret. `configured` is both. One call reads one page.
 */
export function marketingFeed({ secret = '', enabled = true, fetchImpl = fetch, now = Date.now, timeoutMs = 12_000 } = {}) {
  const readiness = () => ({ enabled: live(enabled) === true, signing: validSecret(secret) });
  const configured = () => { const state = readiness(); return state.enabled && state.signing; };
  /**
   * One page of the roster: `{ period, items, nextCursor, skipped }`. `items` are the facilities that pass the contract's shape;
   * `skipped` counts the ones that did not. The filters are the feed's own (`certified_since`, `chow_since` as YYYY-MM-DD).
   */
  async function roster({ states, settings = null, certifiedSince = null, chowSince = null, cursor = null, limit = rosterPageLimit, signal } = {}) {
    if (!configured()) throw failure('feed_off');
    signal?.throwIfAborted();
    const body = JSON.stringify({ action: 'roster', states, ...(settings ? { settings } : {}), ...(certifiedSince ? { certified_since: certifiedSince } : {}),
      ...(chowSince ? { chow_since: chowSince } : {}), ...(cursor ? { cursor } : {}), limit });
    const timestamp = String(Math.floor(now() / 1000));
    const timeout = AbortSignal.timeout(timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(marketingFeedUrl, { method: 'POST', redirect: 'error', cache: 'no-store', signal: bounded, body,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CareMetric-Timestamp': timestamp,
          'X-CareMetric-Signature': marketingFeedSignature(secret, timestamp, body) } });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw failure(timeout.aborted ? 'feed_timeout' : 'feed_unavailable', true);
    }
    if (!response.ok) {
      const code = response.status === 429 ? 'rate_limited' : await refusal(response);
      throw failure(code ? `feed_${code}` : 'feed_unavailable', response.status === 429 || response.status >= 500);
    }
    let text;
    try { text = await readBody(response, maxBytes); } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw /^feed_/.test(error?.code ?? '') ? error : failure(timeout.aborted ? 'feed_timeout' : 'feed_unavailable', true);
    }
    let page;
    try { page = pageSchema.parse(JSON.parse(text)); } catch { throw failure('feed_response_invalid'); }
    const items = [];
    let skipped = 0;
    for (const raw of page.items) {
      const parsed = facilitySchema.safeParse(raw);
      if (parsed.success) items.push(parsed.data); else skipped++;
    }
    return { period: page.period, items, nextCursor: page.next_cursor, skipped };
  }
  return { readiness, get configured() { return configured(); }, roster };
}

/**
 * Every page of one roster query, in CCN order, up to `maxPages` pages, stopping early once `spent()` says the run's time is up.
 * `complete` says whether the last page was reached. A cursor that does not move on ends the read.
 */
export async function readRoster(feed, query, { maxPages = 4, signal, spent = () => false } = {}) {
  const items = [];
  let period = null, cursor = null, pages = 0, skipped = 0, complete = false;
  while (pages < maxPages) {
    signal?.throwIfAborted();
    if (spent()) break;
    const page = await feed.roster({ ...query, cursor, signal });
    pages++;
    period = page.period ?? period;
    skipped += page.skipped;
    items.push(...page.items);
    if (!page.nextCursor) { complete = true; break; }
    if (page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  return { period, items, pages, skipped, complete };
}
