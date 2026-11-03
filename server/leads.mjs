import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, transaction, withSession } from './sms-auth.mjs';

/**
 * Website leads (docs/LEAD_INTAKE.md, "CareMetric lead intake, version 1"). CareBase, Intel and Healthcare Advisors
 * forward each lead from their own servers to POST /api/leads, signed with one shared secret per product. The
 * signature over the exact raw body is the only authority: no session, cookie or browser origin ever counts, and a
 * request that carries one is refused like any other authentication failure.
 *
 * The database checks the lead itself (private.lead_intake, run as hub_app_server) and answers once per
 * (source, externalId). This module adds the transport checks, a per-product rate limit, and the contract's exact
 * answers. It never logs a body, a contact detail, a message or a secret: one line per request names only the
 * product, the outcome and the status.
 */
export const leadSources = Object.freeze(['carebase', 'intel', 'advisors']);
export const leadSecretVariables = Object.freeze({ carebase: 'HUB_LEAD_SECRET_CAREBASE', intel: 'HUB_LEAD_SECRET_INTEL', advisors: 'HUB_LEAD_SECRET_ADVISORS' });
export const leadStatuses = Object.freeze(['new', 'contacted', 'qualified', 'won', 'lost', 'spam']);
export const leadFeature = 'support.leads.v1';
export const leadBodyLimit = 16384;
const minimumSecretLength = 32;
const clockSkewSeconds = 300;
const maximumDepth = 32;
const signaturePattern = /^v1=[0-9a-f]{64}$/;
const timestampPattern = /^[0-9]{1,12}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const conversationReference = /^CM-[0-9]{1,18}$/;
// The database returns updated_at to the microsecond; the browser hands it back untouched.
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Each product's secret, or null where it is unset or shorter than 32 characters (which counts as not configured). */
export function leadSecrets(env = process.env) {
  return Object.fromEntries(leadSources.map(source => {
    const value = env[leadSecretVariables[source]];
    return [source, typeof value === 'string' && value.length >= minimumSecretLength ? value : null];
  }));
}

/** `v1=` and the lowercase hex HMAC-SHA256, under the product's secret, of `<timestamp>.` followed by the raw body bytes. */
export function leadSignature(secret, timestamp, body) {
  return 'v1=' + createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

/** Constant-time comparison on equal-length buffers; a header of any other shape fails before it is compared. */
function sameSignature(given, expected) {
  if (typeof given !== 'string' || !signaturePattern.test(given)) return false;
  const left = Buffer.from(given, 'utf8'), right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The raw body, or null when it is larger than the limit. A declared length over the limit is refused unread. */
async function readBody(req, limit) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > limit) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** True when every string and key can be stored as PostgreSQL text (no NUL, no lone surrogate) within a sane depth. */
function storable(value, depth = 0) {
  if (depth > maximumDepth) return false;
  if (typeof value === 'string') return !value.includes('\u0000') && value.isWellFormed();
  if (Array.isArray(value)) return value.every(item => storable(item, depth + 1));
  if (value && typeof value === 'object') return Object.entries(value).every(([key, item]) => storable(key, depth + 1) && storable(item, depth + 1));
  return true;
}

/** A JSON object from a UTF-8 application/json body, or null. The database checks everything the contract says about it. */
function parseLead(contentType, body) {
  if (String(contentType ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return null;
  let lead;
  try { lead = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return null; }
  return lead && typeof lead === 'object' && !Array.isArray(lead) && storable(lead) ? lead : null;
}

/** In-memory, per product: at most `limit` signed requests in any `windowMs`. */
function rateLimiter({ limit, windowMs, now }) {
  const recent = new Map();
  return source => {
    const at = now();
    const kept = (recent.get(source) ?? []).filter(time => at - time < windowMs);
    const allowed = kept.length < limit;
    if (allowed) kept.push(at);
    recent.set(source, kept);
    return allowed;
  };
}

export function sqlLeadStore(pool) {
  return {
    record: (source, lead) => transaction(pool, async db =>
      (await db.query('select private.lead_intake($1, $2::jsonb) as result', [source, JSON.stringify(lead)])).rows[0].result),
  };
}

/**
 * POST /api/leads. `handle(req)` resolves to `{ status, body, headers }`, the contract's answer, and never throws.
 * `enabled` is whether the database declares support.leads.v1 (read once at boot, like the other optional features).
 */
export function leadIntake({ pool, store = sqlLeadStore(pool), secrets = {}, enabled = false, now = () => Date.now(),
  limit = 60, windowMs = 60_000, log = line => console.info(line) }) {
  const allowed = rateLimiter({ limit, windowMs, now });
  const answer = (source, outcome, status, body, headers = {}) => {
    log(`Lead intake: source=${source ?? 'unknown'} outcome=${outcome} status=${status}`);
    return { status, body, headers };
  };
  const unauthorized = source => answer(source, 'unauthorized', 401, { error: 'unauthorized' });

  async function receive(req) {
    if (req.method !== 'POST') return answer(null, 'method_not_allowed', 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    const header = name => (typeof req.headers[name] === 'string' ? req.headers[name] : undefined);
    const source = leadSources.includes(header('x-caremetric-source')) ? header('x-caremetric-source') : null;
    // Server to server only: browser state or a query string is never part of a lead.
    if (!source || req.headers.origin !== undefined || req.headers.cookie !== undefined || new URL(req.url ?? '/', 'http://internal').search) {
      return unauthorized(source);
    }
    const secret = secrets[source];
    if (typeof secret !== 'string' || secret.length < minimumSecretLength) return answer(source, 'not_configured', 503, { error: 'not_configured' });
    const body = await readBody(req, leadBodyLimit);
    if (!body) return answer(source, 'too_large', 413, { error: 'too_large' });
    const timestamp = header('x-caremetric-timestamp');
    if (!timestamp || !timestampPattern.test(timestamp) || Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > clockSkewSeconds
      || !sameSignature(header('x-caremetric-signature'), leadSignature(secret, timestamp, body))) {
      return unauthorized(source);
    }
    if (!allowed(source)) return answer(source, 'rate_limited', 429, { error: 'rate_limited' });
    if (!enabled) return answer(source, 'feature_missing', 503, { error: 'unavailable' });
    const lead = parseLead(req.headers['content-type'], body);
    if (!lead) return answer(source, 'invalid', 400, { error: 'invalid_lead' });
    let result;
    try { result = await store.record(source, lead); }
    catch (error) {
      // The database's own message is never passed on or logged: it is either "Invalid lead." or about the database.
      return error?.code === '22023' ? answer(source, 'invalid', 400, { error: 'invalid_lead' }) : answer(source, 'unavailable', 503, { error: 'unavailable' });
    }
    if (!result || typeof result.id !== 'string' || !uuid.test(result.id) || typeof result.duplicate !== 'boolean'
      || !(result.conversation === null || (typeof result.conversation === 'string' && conversationReference.test(result.conversation)))) {
      return answer(source, 'unavailable', 503, { error: 'unavailable' });
    }
    return answer(source, result.duplicate ? 'duplicate' : 'accepted', result.duplicate ? 200 : 202,
      { id: result.id, duplicate: result.duplicate, conversation: result.conversation });
  }

  return {
    /** Which products have a usable secret; the values never leave this module. */
    configured: () => leadSources.filter(source => typeof secrets[source] === 'string' && secrets[source].length >= minimumSecretLength),
    enabled: () => enabled,
    async handle(req) {
      try { return await receive(req); }
      catch { return answer(null, 'unavailable', 503, { error: 'unavailable' }); }
    },
  };
}

const reviewedErrors = { '22023': 400, '40001': 409, '42501': 403, '28000': 401, P0002: 404 };
function reviewed(error) {
  if (error instanceof HttpError) return error;
  if (error?.code === '22007' || error?.code === '22008') return new HttpError(400, 'Invalid date or time.');
  const status = reviewedErrors[error?.code];
  return status ? new HttpError(status, error.message) : error;
}

/**
 * The owner's lead change: POST /api/admin/leads/status. It runs inside the owner's SMS session and the database
 * authorizes the command session itself, so this adds no authority, only input checks and reviewed error messages
 * (a stale `expectedUpdatedAt` is 409, a lapsed session 401). Reads go through the browser RPC allowlist (list_leads).
 */
export function leadAdmin({ pool, enabled = true, session = (token, work) => withSession(pool, token, work) }) {
  return {
    async status(token, input) {
      if (!enabled) throw new HttpError(503, 'Leads are not available until the database is updated.');
      const keys = Object.keys(input ?? {});
      if (keys.length !== 3 || !['id', 'status', 'expectedUpdatedAt'].every(key => keys.includes(key))) throw new HttpError(400, 'Invalid request.');
      if (typeof input.id !== 'string' || !uuid.test(input.id)) throw new HttpError(400, 'Choose a lead.');
      if (!leadStatuses.includes(input.status)) throw new HttpError(400, 'Choose a valid status.');
      if (typeof input.expectedUpdatedAt !== 'string' || !instant.test(input.expectedUpdatedAt)) throw new HttpError(400, 'Reload the leads and try again.');
      return session(token, async db =>
        (await db.query('select hub.update_lead_status($1, $2, $3) as result', [input.id, input.status, input.expectedUpdatedAt])).rows[0].result)
        .catch(error => { throw reviewed(error); });
    },
  };
}
