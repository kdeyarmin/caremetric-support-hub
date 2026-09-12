// Disposable Hub PostgreSQL + real SMS cookies, delegation consumption and HTTP.
// The remote native ledger is a deterministic transport fixture. Native CI owns
// the actual configuration writer, lock, rollback, audit and concurrency tests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth, sessionCookie, digest } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { configurationAction, sameConfigurationTarget } from '../supabase/functions/_shared/operationalConfiguration.ts';

const local = new URL(process.env.HUB_TEST_DATABASE_URL);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: local.href });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(local); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href }), owner = randomUUID(), phone = '+12025550831';
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'configuration-sms-owner@test.invalid',false)", [owner]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)', [owner, phone]);

const domain = 'operations.config.v1', target = { kind: 'release', featureKey: 'fixture.safe-rollout' };
const impact = { kind: 'feature', definitionActive: true, organizationName: null, globalKillSwitchActive: false,
  organizationKillSwitchCount: '2', retainedCohortCount: '3', retainedMembershipCount: '9007199254740995', nextBoundaryAt: null };
const context = { target, displayName: 'Fixture safe rollout', configurationRevision: 'a'.repeat(64),
  state: { configured: true, rolloutMode: 'cohort', isEnabled: true, owner: 'Legacy owner', expiresAt: null, changeReason: 'Retained legacy note\n'.repeat(800) }, impact };
const commands = new Map(); let calls = 0, writes = 0, nativeRevoked = false, revokeAfterWrite = false, tamper = false;
const auth = smsAuth({ pool, provider: { send: async () => randomUUID(), verify: async (_id, _phone, code) => code === '123456' } });
const caps = delegations({ pool, storageUrl: 'https://storage.test', fetchImpl: async (url, options) => {
  calls++; assert.equal(url, 'https://cmcarebase.com/api/platform-admin/configuration');
  assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(options.headers).sort(), ['Authorization', 'Content-Type']);
  const operation = JSON.parse(options.body), ticket = options.headers.Authorization.slice(7);
  // A wrong audience cannot consume a valid command ticket or grant learning.
  await assert.rejects(caps.consume(ticket, 'carebase.learning'), /Invalid authorization/);
  const actor = await caps.consume(ticket, 'carebase.command');
  assert.equal(actor.user_id, owner); assert.equal(actor.method, 'sms'); assert.equal(actor.aal, undefined);
  assert.equal(actor.operation.domain, domain); assert.deepEqual(actor.operation, operation);
  assert.ok(Date.parse(actor.session_started_at) <= Date.now());
  assert.ok(Date.parse(actor.assurance_expires_at) > Date.now());
  await assert.rejects(caps.consume(ticket, 'carebase.command'), /Invalid authorization/);
  if (nativeRevoked) return Response.json({ error: { code: 'forbidden', privateDetail: 'must not leak' } }, { status: 403 });
  if (operation.operation === 'context') {
    if (operation.target.kind === 'job') return Response.json({ target: operation.target, displayName: 'Externally scheduled job', configurationRevision: 'b'.repeat(64),
      state: { enabled: false, reason: null }, impact: { kind: 'job', isActive: true, executionKind: 'external', killSwitchCanStop: false } });
    return Response.json(tamper ? { ...context, configurationRevision: 'broken' } : context);
  }
  if (operation.operation === 'commands') return Response.json({ items: [...commands.values()].filter(row => row.owner === actor.user_id && sameConfigurationTarget(row.preview.target, operation.target))
    .slice(operation.offset, operation.offset + 20).map(row => ({ commandId: row.preview.commandId, expectedDigest: row.preview.previewDigest,
      expiresAt: row.preview.expiresAt, appliedAt: row.result?.appliedAt ?? null })), nextOffset: null });
  if (operation.operation === 'preview') {
    let row = commands.get(operation.requestId);
    if (row) {
      if (row.owner !== actor.user_id || row.session !== actor.session_id || JSON.stringify(row.operation) !== JSON.stringify(operation)) return Response.json({ error: { code: 'conflict' } }, { status: 409 });
      return Response.json(row.preview);
    }
    if (operation.configurationRevision !== context.configurationRevision || !sameConfigurationTarget(operation.target, target)) return Response.json({ error: { code: 'conflict' } }, { status: 409 });
    row = { owner: actor.user_id, session: actor.session_id, operation: structuredClone(operation), result: null,
      preview: { commandId: randomUUID(), target, action: configurationAction(target), reason: operation.reason,
        configurationRevision: context.configurationRevision, previewDigest: digest(JSON.stringify(operation)), expiresAt: new Date(Date.now() + 300_000).toISOString(),
        before: structuredClone(context.state), after: { configured: true, ...operation.parameters, changeReason: operation.reason }, impact } };
    commands.set(operation.requestId, row); return Response.json(row.preview);
  }
  const row = [...commands.values()].find(entry => entry.preview.commandId === operation.commandId);
  if (!row || row.owner !== actor.user_id || row.preview.previewDigest !== operation.expectedDigest) return Response.json({ error: { code: 'conflict' } }, { status: 409 });
  if (operation.operation === 'status') return Response.json({ preview: row.preview, result: row.result,
    canApplyThisSession: row.result === null && row.session === actor.session_id && Date.parse(row.preview.expiresAt) > Date.now() });
  assert.equal(operation.operation, 'apply');
  if (row.session !== actor.session_id) return Response.json({ error: { code: 'forbidden' } }, { status: 403 });
  if (row.result) return Response.json({ ...row.result, replayed: true });
  if (row.preview.configurationRevision !== context.configurationRevision) return Response.json({ error: { code: 'conflict' } }, { status: 409 });
  context.state = structuredClone(row.preview.after); context.configurationRevision = digest(JSON.stringify(context.state));
  row.result = { commandId: row.preview.commandId, target, action: row.preview.action, configurationRevision: context.configurationRevision,
    appliedAt: new Date().toISOString(), replayed: false, state: structuredClone(context.state) }; writes++;
  if (revokeAfterWrite) await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1', [owner]);
  return Response.json(row.result);
} });
const server = appServer({ auth, gateway: gateway(pool), delegations: caps, origins: ['https://hub.test'] });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, jar = {};
async function call(path, body, headers = {}) {
  const response = await fetch(origin + '/api/' + path, { method: 'POST', headers: { Origin: 'https://hub.test', 'Content-Type': 'application/json',
    Cookie: Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; '), ...headers }, body: JSON.stringify(body) });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const value of response.headers.getSetCookie()) { const [pair] = value.split(';'), index = pair.indexOf('='); jar[pair.slice(0, index)] = pair.slice(index + 1); }
  return { status: response.status, body: await response.json() };
}
const run = body => call('admin/configuration', body), contextOp = { domain, operation: 'context', target };
async function login() {
  const challenge = await call('auth/sms/start', { phone }); assert.equal(challenge.status, 200);
  assert.equal((await call('auth/sms/verify', { challengeId: challenge.body.challengeId, code: '123456' })).status, 200);
  assert.match(jar[sessionCookie], /^[A-Za-z0-9_-]{43}$/);
}
try {
  assert.equal((await run(contextOp)).status, 401); await login();
  assert.equal((await call('admin/configuration', contextOp, { Origin: 'https://evil.test' })).status, 403);
  const initial = await run(contextOp); assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.impact.retainedMembershipCount, '9007199254740995'); assert.ok(initial.body.state.changeReason.length > 12000);
  const job = await run({ domain, operation: 'context', target: { kind: 'job', jobKey: 'fixture.external' } });
  assert.equal(job.status, 200); assert.equal(job.body.impact.killSwitchCanStop, false);
  const beforeInvalid = calls;
  for (const operation of [{ operation: 'context', target }, { ...contextOp, actor: owner }, { ...contextOp, domain: 'course.provider.v1' },
    { domain, operation: 'commands', target, offset: -1 }, { domain, operation: 'preview', requestId: randomUUID(), target,
      configurationRevision: context.configurationRevision, parameters: { rolloutMode: 'cohort', isEnabled: true, owner: 'Operator', expiresAt: null }, reason: 'Review current cohort' }]) {
    assert.equal((await run(operation)).status, 400);
  }
  assert.equal(calls, beforeInvalid);
  const previewOp = { domain, operation: 'preview', requestId: randomUUID(), target, configurationRevision: context.configurationRevision,
    parameters: { rolloutMode: 'global', isEnabled: true, owner: 'Reviewed operator', expiresAt: null }, reason: 'Explicit global rollout review' };
  const preview = await run(previewOp); assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual((await run(previewOp)).body, preview.body); assert.equal(commands.size, 1); assert.equal(writes, 0);
  assert.equal((await run({ ...previewOp, reason: 'Changed reason with old identity' })).status, 409); assert.equal(commands.size, 1);
  const apply = { domain, operation: 'apply', commandId: preview.body.commandId, expectedDigest: preview.body.previewDigest }, status = { ...apply, operation: 'status' };
  const beforeWrongRoute = calls;
  assert.equal((await call('admin/authoring', apply)).status, 400); assert.equal((await call('admin/command', apply)).status, 400);
  assert.equal(calls, beforeWrongRoute);
  revokeAfterWrite = true; const uncertain = await run(apply); assert.ok([401, 403].includes(uncertain.status), JSON.stringify(uncertain)); assert.equal(writes, 1);
  assert.equal(JSON.stringify(uncertain.body).includes('privateDetail'), false);
  revokeAfterWrite = false; await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1', [owner]);
  const recovered = await run(status); assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.result.commandId, apply.commandId); assert.equal(recovered.body.result.replayed, false); assert.equal(recovered.body.canApplyThisSession, false);
  assert.equal((await run(apply)).body.replayed, true); assert.equal(writes, 1);
  const page = await run({ domain, operation: 'commands', target, offset: 0 }); assert.equal(page.status, 200); assert.equal(page.body.items[0].commandId, apply.commandId);
  nativeRevoked = true; const nativeDenied = await run(status); assert.equal(nativeDenied.status, 403); assert.equal(JSON.stringify(nativeDenied.body).includes('privateDetail'), false); nativeRevoked = false;
  tamper = true; assert.equal((await run(contextOp)).status, 503); tamper = false;
  const pending = await run({ ...previewOp, requestId: randomUUID(), configurationRevision: context.configurationRevision,
    parameters: { rolloutMode: 'off', isEnabled: false, owner: 'Reviewed operator', expiresAt: null } }); assert.equal(pending.status, 200, JSON.stringify(pending.body));
  const pendingStatus = { domain, operation: 'status', commandId: pending.body.commandId, expectedDigest: pending.body.previewDigest };
  assert.equal((await run(pendingStatus)).body.canApplyThisSession, true);
  const oldToken = jar[sessionCookie];
  await admin.query("update private.sms_challenges set created_at=now()-interval '61 seconds' where phone_hash=$1", [digest(phone)]);
  await login(); assert.notEqual(jar[sessionCookie], oldToken);
  const readOnly = await run(pendingStatus); assert.equal(readOnly.status, 200, JSON.stringify(readOnly.body));
  assert.equal(readOnly.body.canApplyThisSession, false); assert.equal(readOnly.body.result, null);
  assert.equal((await run({ ...pendingStatus, operation: 'apply' })).status, 403); assert.equal(writes, 1);
  assert.equal((await run(status)).body.result.commandId, apply.commandId);
  const listAgain = await run({ domain, operation: 'commands', target, offset: 0 }); assert.equal(listAgain.body.items.length, 2);
  // Retained session-cookie validity never extends the original eight-hour command window.
  await admin.query("update private.sms_sessions set created_at=now()-interval '9 hours' where token_hash=$1", [digest(jar[sessionCookie])]);
  const beforeExpired = calls, expired = await run(contextOp); assert.ok([401, 403].includes(expired.status)); assert.equal(calls, beforeExpired);
  await admin.query('update private.sms_identities set revoked_at=now() where user_id=$1', [owner]);
  assert.equal((await run(status)).status, 401); assert.equal(writes, 1);
  console.log('Configuration PostgreSQL/SMS/HTTP passed: exact one-use domain/audience, preserved cohort impact, native capability truth, durable preview identity, uncertain-write recovery, new-session observation, expiry and current authority, one native write.');
} finally { await new Promise(resolve => server.close(resolve)); await pool.end(); await admin.end(); }
