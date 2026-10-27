import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpError, withSession, transaction, digest, token } from './sms-auth.mjs';
import { connectionProof, nativeOperation, selfServiceRequest, profilePage, trustedRecordHref } from '../src/self-service/protocol.ts';

export const nativeSelfService = Object.freeze({
  carebase: { endpoint: 'https://xsqobvvreaovwibxwyvv.supabase.co/functions/v1/self-service', origin: 'https://cmcarebase.com' },
  breathe: { endpoint: 'https://cmbreathe.com/resupply-api/self-service', origin: 'https://cmbreathe.com' },
  pennsync: { endpoint: 'https://caremetricai.base44.app/functions/customerSelfService', origin: 'https://caremetricai.base44.app', header: 'X-CareMetric-Hub-Authorization' },
  'caremetric-emr': { endpoint: 'https://ubbtgcaosuebrlwcvihw.supabase.co/functions/v1/customer-self-service', origin: 'https://caremetric.ai' },
  'caremetric-intel': { endpoint: 'https://www.caremetricintel.com/api/self-service', origin: 'https://www.caremetricintel.com' },
});
const sha = value => createHash('sha256').update(value).digest('hex');
const capabilityPattern = /^cms_[A-Za-z0-9_-]{43}$/;
const connectionPattern = /^cmc_[A-Za-z0-9_-]{43}$/;
const result = async (db, text, values = []) => (await db.query(text, values)).rows[0]?.result;
function failure(error) {
  if (error instanceof HttpError) return error;
  if (error?.code === '28000') return new HttpError(401, 'Sign in with a text message to continue.');
  if (error?.code === '42501') return new HttpError(403, 'This action is unavailable or no longer authorized. Reopen self-service from your application.');
  if (error?.code === '23505') return new HttpError(409, 'This identity is already connected. Refresh your account.');
  return new HttpError(503, 'Self-service is temporarily unavailable. Your existing records are retained.');
}
export function selfService({ pool, provider, fetchImpl = fetch, publicOrigin = 'https://support-hub-web-production.up.railway.app' }) {
  const rpc = (session, name, values = []) => withSession(pool, session, db => result(db, `select hub.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`, values));
  async function issue(authorization, input) {
    const parsed = connectionProof.safeParse(input);
    const key = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!/^cmb_[A-Za-z0-9_-]{43}$/.test(key)) throw new HttpError(401, 'Application authentication required.');
    if (!parsed.success) throw new HttpError(400, 'Invalid native account proof.');
    const connectionToken = `cmc_${randomBytes(32).toString('base64url')}`;
    await transaction(pool, async db => {
      const app = await result(db, 'select private.billing_authenticate_app($1) as result', [sha(key)]);
      if (!app || !nativeSelfService[app.slug]) throw new HttpError(401, 'Application authentication required.');
      await db.query('select private.issue_self_service_connection($1,$2::jsonb,$3)', [app.product_id, JSON.stringify(parsed.data), sha(connectionToken)]);
    });
    return { url: `${publicOrigin}/connect#${connectionToken}`, expires_in: 300 };
  }
  async function consume(authorization, app) {
    const capability = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!nativeSelfService[app] || !capabilityPattern.test(capability)) throw new HttpError(401, 'Invalid capability.');
    try { return await transaction(pool, db => result(db, 'select private.consume_self_service_operation($1,$2) as result', [sha(capability), app])); }
    catch (error) { throw failure(error); }
  }
  async function call(session, operationId, confirm = false) {
    const capability = `cms_${randomBytes(32).toString('base64url')}`;
    const command = await rpc(session, 'issue_self_service_operation', [operationId, sha(capability), confirm]);
    const record = state => transaction(pool, db => db.query('select private.record_self_service_result($1,$2)', [operationId, state]));
    try {
    const adapter = nativeSelfService[command.app];
    if (!adapter) throw new HttpError(503, 'This application has no self-service adapter.');
    const response = await fetchImpl(adapter.endpoint, { method: 'POST', headers: { [adapter.header ?? 'Authorization']: `Bearer ${capability}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract_version: 1, app: command.app, operation: command.operation }), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new HttpError(response.status === 403 ? 403 : 503, response.status === 403 ? 'Your application no longer permits this action.' : 'The application could not complete this action. Open it directly or try again.');
    if (!response.body) throw new HttpError(503, 'The application returned no result.');
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 1000000) throw new HttpError(413, 'Narrow the request before retrying.'); chunks.push(chunk.value); } }
    finally { await reader.cancel().catch(() => {}); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(503, 'The application returned an invalid result.'); }
    // A logout or membership change while the native call was running cannot return private data.
    const current = await rpc(session, 'self_service_workspace');
    if (!current.connections.some(connection => connection.id === command.connection_id)) throw new HttpError(403, 'Application access was revoked.');
    if (command.operation.action === 'profile.read') {
      const page = profilePage.parse(data);
      await record('succeeded');
      return { ...page, records: page.records.map(record => ({ ...record, href: trustedRecordHref(record.href, adapter.origin) })) };
    }
    await record('succeeded');
    return data;
    } catch (error) {
      await record(error?.status === 403 ? 'refused' : 'unavailable').catch(() => {});
      throw error;
    }
  }
  async function handle(session, input) {
    const request = selfServiceRequest.safeParse(input);
    if (!request.success) throw new HttpError(400, 'Review the self-service request.');
    try {
      const op = request.data;
      if (op.action === 'workspace') { await refreshAuthority(session); return await rpc(session, 'self_service_workspace'); }
      if (op.action === 'connect') return await rpc(session, 'accept_self_service_connection', [sha(op.token)]);
      if (op.action === 'confirm') return await call(session, op.confirmation_id, true);
      if (op.action === 'native' && op.operation.action === 'recovery.execute') throw new HttpError(400, 'Review and confirm account recovery first.');
      const id = await rpc(session, 'prepare_self_service_operation', [op.connection_id, JSON.stringify(nativeOperation.parse(op.operation)), false]);
      if (op.action === 'prepare') return { confirmation_id: id, operation: op.operation, expires_in: 300 };
      return await call(session, id);
    } catch (error) { throw failure(error); }
  }
  async function refreshAuthority(session) {
    const workspace = await rpc(session, 'self_service_workspace');
    await Promise.all(workspace.connections.map(async connection => {
      let proof = null;
      try {
        const id = await rpc(session, 'prepare_self_service_operation', [connection.id, JSON.stringify({ action: 'scope.read' }), false]);
        proof = connectionProof.parse(await call(session, id));
      } catch { /* A failed source cannot keep granting cached administration authority. */ }
      await withSession(pool, session, async db => {
        await db.query('reset role');
        await db.query('select private.refresh_self_service_scope($1,$2::jsonb)', [connection.id, proof === null ? null : JSON.stringify(proof)]);
      });
    }));
  }
  async function start(input, address) {
    if (!input || Object.keys(input).sort().join(',') !== 'consent,phone,token' || input.consent !== true || !connectionPattern.test(input.token ?? '')
      || typeof input.phone !== 'string' || !/^\+[1-9][0-9]{7,14}$/.test(input.phone)) throw new HttpError(400, 'Enter your mobile number with its country code and agree to a verification text.');
    const browserToken = token(), id = randomUUID();
    try {
      return await transaction(pool, async db => {
        await db.query('select private.start_self_service_challenge($1,$2,$3,$4,$5)', [sha(input.token), input.phone, digest(address), digest(browserToken), id]);
        const providerId = await provider.send(input.phone);
        await db.query('update private.sms_challenges set provider_id=$2 where id=$1', [id, providerId]);
        return { id, browserToken };
      });
    } catch (error) { throw failure(error); }
  }
  async function verify(input, browserToken, previous) {
    if (!input || Object.keys(input).sort().join(',') !== 'challenge_id,code' || !/^[0-9a-f-]{36}$/.test(input.challenge_id ?? '')
      || !/^[0-9]{6}$/.test(input.code ?? '') || !browserToken) throw new HttpError(400, 'Enter the verification code.');
    try {
      const sessionToken = await transaction(pool, async db => {
        const challenge = await result(db, 'select private.inspect_self_service_challenge($1,$2) as result', [input.challenge_id, digest(browserToken)]);
        if (!challenge || !await provider.verify(challenge.provider_id, challenge.phone, input.code)) return null;
        const identity = await result(db, 'select private.complete_self_service_challenge($1,$2) as result', [input.challenge_id, digest(browserToken)]);
        const secret = token(), sessionId = randomUUID();
        await db.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) values($1,$2,$3,$4,now()+interval '8 hours')", [sessionId, digest(secret), identity.user_id, identity.identity_version]);
        if (previous) await db.query('update private.sms_sessions set revoked_at=now() where token_hash=$1', [digest(previous)]);
        await db.query('set local role authenticated');
        await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: identity.user_id, role: 'authenticated', sms_session_id: sessionId, amr: [{ method: 'sms' }] })]);
        await result(db, 'select hub.accept_self_service_connection($1) as result', [identity.token_hash]);
        return secret;
      });
      if (!sessionToken) throw new HttpError(401, 'The code is incorrect, expired, or already used.');
      return sessionToken;
    } catch (error) { throw failure(error); }
  }
  return { issue, consume, handle, start, verify, refreshAuthority,
    authorizeBilling: async (session, connection, facility) => {
      const id = await rpc(session, 'prepare_self_service_operation', [connection, JSON.stringify({ action: 'billing.authorize', facility_id: facility }), false]);
      const authority = await call(session, id);
      if (authority?.authorized !== true || authority.facility_id !== facility) throw new HttpError(403, 'Purchasing authority could not be verified in your application.');
      return authority;
    },
  };
}
