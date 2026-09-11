// Real Hub SMS/PostgreSQL/HTTP boundary; native network data is synthetic.
// This script rejects non-disposable destinations before any database write.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth, sessionCookie, digest } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { job, release, audit } from '../src/admin/testFixtures/operations.ts';
import { operationalReadOperations } from '../supabase/functions/_shared/operationsProtocol.ts';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const owner = randomUUID(), phone = '+12025550911';
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'operations-fixture@test.invalid',false)", [owner]);
await admin.query("insert into private.staff_permissions(user_id,permission,granted_by) values($1,'platform.admin',$1)", [owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)', [owner, phone]);
const provider = { send: async () => randomUUID(), verify: async (_id, _phone, code) => code === '123456' };
const auth = smsAuth({ pool, provider });
let sessionId, sessionTimes, origin, calls = 0, mode = 'normal', lastAuthority;
const caps = delegations({ pool, storageUrl: 'https://storage.test', fetchImpl: async (url, options) => {
  calls++;
  assert.equal(url, 'https://cmcarebase.com/api/platform-admin/read');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(Object.keys(options.headers).sort(), ['Authorization', 'Content-Type']);
  const operation = JSON.parse(options.body);
  const ticket = options.headers.Authorization.slice(7);
  const stored = (await admin.query('select audience,payload,session_id from private.app_delegations where token_hash=$1', [digest(ticket)])).rows[0];
  assert.equal(stored.audience, 'carebase'); assert.equal(stored.session_id, sessionId); assert.deepEqual(stored.payload, operation);
  await assert.rejects(caps.consume(ticket, 'carebase.command'), 'read ticket cannot authorize a command');
  if (mode === 'revoked-before-consume') await admin.query('update private.sms_sessions set revoked_at=now() where id=$1', [sessionId]);
  const introspect = () => fetch(origin + '/api/internal/admin/authorize', { method: 'POST', headers: { Authorization: options.headers.Authorization, 'Content-Type': 'application/json' }, body: '{}' });
  const response = await introspect();
  if (mode === 'revoked-before-consume') { assert.equal(response.status, 401); return Response.json({ error: { code: 'unauthenticated' } }, { status: 401 }); }
  assert.equal(response.status, 200);
  lastAuthority = await response.json();
  assert.equal(lastAuthority.user_id, owner); assert.equal(lastAuthority.method, 'sms'); assert.deepEqual(lastAuthority.operation, operation);
  assert.equal((await introspect()).status, 401, 'a read ticket is single use');
  if (operationalReadOperations.includes(operation.operation)) {
    assert.deepEqual(Object.keys(lastAuthority).sort(), ['assurance_expires_at', 'method', 'operation', 'role', 'session_id', 'session_started_at', 'user_id']);
    assert.equal(lastAuthority.session_id, sessionId);
    assert.equal(Date.parse(lastAuthority.session_started_at), sessionTimes.created_at.getTime(), 'never renew the original sign-in time');
    assert.equal(Date.parse(lastAuthority.assurance_expires_at), Math.min(sessionTimes.expires_at.getTime(), sessionTimes.created_at.getTime() + 8 * 3600000));
  } else assert.deepEqual(Object.keys(lastAuthority).sort(), ['method', 'operation', 'role', 'user_id']);
  if (mode === 'native-denied') return Response.json({ error: { code: 'forbidden', raw: 'PRIVATE_NATIVE_ERROR' } }, { status: 403 });
  if (mode === 'revoked-after-read') await admin.query('update private.sms_sessions set revoked_at=now() where id=$1', [sessionId]);
  if (mode === 'role-revoked-after-read') await admin.query("delete from private.staff_permissions where user_id=$1 and permission='platform.admin'", [owner]);
  if (mode === 'identity-replaced-after-read') await admin.query('update private.sms_identities set identity_version=gen_random_uuid() where user_id=$1', [owner]);
  if (mode === 'authority-aged-after-read') await admin.query("update private.sms_sessions set created_at=now()-interval '8 hours 1 second',expires_at=now()+interval '1 hour' where id=$1", [sessionId]);
  const item = operation.operation === 'operations.jobs.list' ? { ...job, attemptedCount: '9223372036854775807' } : operation.operation === 'operations.releases.list' ? release : audit;
  const data = operation.operation === 'capabilities' ? { apiVersion: 1, operations: operationalReadOperations, sourceRevision: null }
    : { items: mode === 'empty' ? [] : [{ ...item, ...(mode === 'private-field' ? { rawMetadata: 'PRIVATE_NATIVE_METADATA' } : {}) }], total: mode === 'empty' ? 0 : 101, limit: operation.limit, offset: operation.offset };
  return Response.json({ contractVersion: 1, product: 'carebase', operation: operation.operation, generatedAt: new Date().toISOString(), data });
} });
const server = appServer({ auth, gateway: gateway(pool), delegations: caps, origins: ['https://hub.test'] });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const jar = {};
async function call(path, body, headers = {}) {
  const response = await fetch(origin + '/api/' + path, { method: 'POST', headers: { Origin: 'https://hub.test', 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([key, value]) => key + '=' + value).join('; '), ...headers }, body: JSON.stringify(body) });
  for (const value of response.headers.getSetCookie()) { const [pair] = value.split(';'); const index = pair.indexOf('='); jar[pair.slice(0, index)] = pair.slice(index + 1); }
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}
const input = operation => ({ product: 'carebase', operation, limit: 20, offset: 0, search: '' });
async function restore() {
  mode = 'normal';
  await admin.query('update private.sms_sessions set revoked_at=null,created_at=$2,expires_at=$3 where id=$1', [sessionId, sessionTimes.created_at, sessionTimes.expires_at]);
  await admin.query('update private.sms_identities set identity_version=(select identity_version from private.sms_sessions where id=$2) where user_id=$1', [owner, sessionId]);
  await admin.query("insert into private.staff_permissions(user_id,permission,granted_by) values($1,'platform.admin',$1) on conflict do nothing", [owner]);
}
try {
  assert.equal((await call('admin/read', input(operationalReadOperations[0]))).status, 401); assert.equal(calls, 0);
  const started = await call('auth/sms/start', { phone }); assert.equal(started.status, 200);
  assert.equal((await call('auth/sms/verify', { challengeId: started.body.challengeId, code: '123456' })).status, 200);
  ({ id: sessionId, ...sessionTimes } = (await admin.query('select id,created_at,expires_at from private.sms_sessions where token_hash=$1', [digest(jar[sessionCookie])])).rows[0]);
  for (const operation of operationalReadOperations) {
    const result = await call('admin/read', input(operation)); assert.equal(result.status, 200); assert.equal(result.cache, 'no-store'); assert.equal(result.body.data.items.length, 1);
    if (operation === 'operations.jobs.list') assert.equal(result.body.data.items[0].attemptedCount, '9223372036854775807');
  }
  const searched = await call('admin/read', { ...input(operationalReadOperations[2]), search: '  audit_%  ', offset: 20 });
  assert.equal(searched.status, 200); assert.equal(searched.body.data.offset, 20); assert.equal(lastAuthority.operation.search, 'audit_%');
  assert.equal((await call('admin/read', { product: 'carebase', operation: 'capabilities' })).status, 200);
  const beforeInvalid = calls;
  for (const body of [{ ...input(operationalReadOperations[0]), product: 'breathe' }, { ...input(operationalReadOperations[0]), limit: 51 }, { ...input(operationalReadOperations[0]), url: 'https://evil.test' }, { operation: 'operations.jobs.retry' }]) assert.equal((await call('admin/read', body)).status, 400);
  assert.equal((await call('admin/read', input(operationalReadOperations[0]), { Origin: 'https://evil.test' })).status, 403);
  assert.equal(calls, beforeInvalid);
  for (const testMode of ['native-denied', 'private-field', 'revoked-before-consume', 'revoked-after-read', 'role-revoked-after-read', 'identity-replaced-after-read', 'authority-aged-after-read']) {
    mode = testMode;
    const result = await call('admin/read', input(operationalReadOperations[0]));
    assert.ok([401, 403, 503].includes(result.status), testMode + ' must deny: ' + result.status);
    assert.equal(result.body.data, undefined); assert.ok(!JSON.stringify(result.body).includes('PRIVATE_NATIVE')); await restore();
  }
  // Source freshness is checked before dispatch too, even if a session expiry was extended.
  await admin.query("update private.sms_sessions set created_at=now()-interval '8 hours 1 second',expires_at=now()+interval '1 hour' where id=$1", [sessionId]);
  const beforeExpired = calls;
  assert.equal((await call('admin/read', input(operationalReadOperations[0]))).status, 403); assert.equal(calls, beforeExpired); await restore();
  mode = 'empty'; const empty = await call('admin/read', input(operationalReadOperations[2]));
  assert.equal(empty.status, 200); assert.equal(empty.body.data.total, 0); assert.deepEqual(empty.body.data.items, []);
  console.log('Operational reads: real SMS issue/consume, original assurance, read-only audience, exact projection, current-session revocation and pagination passed.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await admin.query('delete from private.sms_challenges where user_id=$1', [owner]);
  await admin.query('delete from private.app_delegations where session_id in (select id from private.sms_sessions where user_id=$1)', [owner]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
