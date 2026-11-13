/** Read-only first-party website measurement. Only aggregate anonymous-session counts leave Intel.
 * No browser identifier, path, referrer or contact is requested. The dedicated key is sent only as a purpose-bound HMAC
 * to the fixed Intel HTTPS endpoint. No redirects, provider error text, request body or credential reaches logs.
 */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { live } from '../../live.mjs';

export const visitorMetricsFeature = 'platform.agents.visitor-metrics.v1';
export const visitorMetricsUrl = 'https://www.caremetricintel.com/api/hub/visitor-metrics';
const maxBytes = 16_384;
const period = z.object({ count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), complete: z.boolean() }).strict();
// Sessions that arrived from a link in the Hub's own outreach email, by its campaign tag (an arm code, links.mjs): anonymous counts only.
const campaign = z.object({ campaign: z.string().regex(/^[a-z0-9-]{1,60}$/), sessions: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const responseSchema = z.object({ version: z.literal(1), metric: z.literal('anonymous_sessions'),
  collectionStartedAt: z.iso.datetime({ offset: true }).nullable(), current: period, previous: period, campaigns: z.array(campaign).max(30).optional() }).strict();
const failure = code => Object.assign(new Error('Website session counts could not be read.'), { code });
const validKey = key => typeof key === 'string' && key.length >= 32;

export function visitorMetricsSignature(key, timestamp, body) {
  return createHmac('sha256', key).update(`${timestamp}.visitor-metrics.`).update(body).digest('hex');
}

function requestWindow({ before, since, until }, now) {
  if (![before, since, until].every(value => value instanceof Date && Number.isFinite(value.getTime()))) throw failure('visitor_window_invalid');
  const [start, middle, end] = [before, since, until].map(value => value.getTime());
  // Calendar weeks can contain a daylight-saving change. Avoid subtracting fixed 24-hour days.
  if (!(start < middle && middle < end) || middle - start > 14 * 86_400_000 + 7_200_000
    || end - middle > 14 * 86_400_000 + 7_200_000 || end > now + 60_000) throw failure('visitor_window_invalid');
  return { before: before.toISOString(), since: since.toISOString(), until: until.toISOString() };
}

async function readJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > maxBytes) throw failure('visitor_response_too_large');
  const reader = response.body?.getReader?.();
  if (!reader) throw failure('visitor_response_invalid');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw failure('visitor_response_too_large');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('visitor_response_invalid'); }
  } finally { await reader.cancel().catch(() => {}); }
}

/** Live setting, immutable process secret, no provider request from readiness. */
export function nativeVisitorReader({ features = null, enabled = false, key = '', fetchImpl = fetch, now = Date.now, timeoutMs = 15_000 } = {}) {
  const readiness = () => ({ declared: features?.has?.(visitorMetricsFeature) === true, enabled: live(enabled) === true, signing: validKey(key) });
  const configured = () => Object.values(readiness()).every(value => value === true);
  const result = (state, intel = { state, visitors: null, previous: null }) => ({ state, metric: 'anonymous_sessions',
    products: { carebase: { state: 'not_configured', visitors: null, previous: null }, 'caremetric-intel': intel } });
  async function read({ before, since, until, signal } = {}) {
    if (!configured()) return result('not_configured');
    if (signal?.aborted) throw failure('visitor_aborted');
    const window = requestWindow({ before, since, until }, now());
    // Per-campaign counts are asked for; an Intel that predates them refuses the field (400), and is asked once more without it.
    const bodies = [JSON.stringify({ ...window, campaigns: true }), JSON.stringify(window)];
    const timestamp = String(Math.floor(now() / 1000));
    const timeout = AbortSignal.timeout(timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(failure(signal?.aborted ? 'visitor_aborted' : 'visitor_timeout'));
      bounded.addEventListener('abort', abort, { once: true });
    });
    try {
      const work = async () => {
        const post = raw => fetchImpl(visitorMetricsUrl, { method: 'POST', redirect: 'error', cache: 'no-store', signal: bounded,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CareMetric-Timestamp': timestamp,
            'X-CareMetric-Signature': visitorMetricsSignature(key, timestamp, raw) }, body: raw });
        let response = await post(bodies[0]);
        if (response.status === 400) { await response.body?.cancel?.().catch(() => {}); response = await post(bodies[1]); }
        if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? 'visitor_not_permitted'
          : response.status === 404 || response.status === 503 ? 'visitor_not_ready' : 'visitor_unavailable');
        const parsed = responseSchema.safeParse(await readJson(response));
        if (!parsed.success) throw failure('visitor_response_invalid');
        const answer = parsed.data;
        const coverage = answer.collectionStartedAt === null ? null : Date.parse(answer.collectionStartedAt);
        if (coverage !== null && coverage > now()) throw failure('visitor_response_invalid');
        const count = (value, start) => {
          if (!value.complete) return null;
          if (value.count === null || coverage === null || coverage > start.getTime()) throw failure('visitor_coverage_invalid');
          return value.count;
        };
        const visitors = count(answer.current, since);
        const previous = count(answer.previous, before);
        const state = visitors !== null && previous !== null ? 'read' : visitors !== null || previous !== null ? 'partial' : 'unavailable';
        return result(state, { state, visitors, previous, ...(answer.campaigns && visitors !== null ? { campaigns: answer.campaigns } : {}) });
      };
      return await Promise.race([work(), stopped]);
    } catch (error) {
      if (signal?.aborted) throw failure('visitor_aborted');
      // Failures are operational metadata only. The request may not have reached the product, so no fabricated count is returned.
      const code = /^visitor_[a-z_]+$/.test(error?.code ?? '') ? error.code : 'visitor_unavailable';
      return { ...result('unavailable'), error: code };
    } finally { bounded.removeEventListener('abort', abort); }
  }
  return { readiness, get configured() { return configured(); }, read };
}
