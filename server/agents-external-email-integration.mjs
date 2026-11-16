// Exercise owner-requested external email against the disposable local Supabase stack.
// No mail provider is involved. The real SMS authorization, restricted server role, owner
// decision, execution fencing and ledger decide which message a fake sender could receive.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { agentTeam } from './agents/index.mjs';
import { testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1');
assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl);
appUrl.username = 'hub_app_server';
appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const gate = await readFile(new URL('../supabase/migrations/20261104230057_agent_external_email_contract.sql', import.meta.url), 'utf8');
const run = randomUUID().slice(0, 8);
const owners = [randomUUID(), randomUUID()];
const customer = randomUUID();
const users = [...owners, customer];
const userPhones = [phones.owner, phones.secondOwner, phones.customer];
const tokens = users.map(() => `external-email-${randomUUID()}`);
const ownerToken = tokens[0];
const actions = new Set();
const tasks = [];
const captured = [];
const teamLogs = [];
const base = {
  to: `external.canary.${run}@example.test`,
  subject: `Exact subject ${run} — unchanged  `,
  body: `Dear support team,\n\nExact body ${run}: <b>plain text</b>\r\n\tKeep these spaces.  \n`,
};
const seedChief = (await admin.query("select status, autonomy, config, updated_at from private.agents where key = 'chief_of_staff'")).rows[0];
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const call = async (fn, args = []) => (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r;
const ownerCall = (fn, args = [], token = ownerToken) => withSession(pool, token, async db =>
  (await db.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r);
const refused = (code, pattern) => error => {
  assert.equal(error.code, code, error.message);
  if (pattern) assert.match(error.message, pattern);
  return true;
};
const request = async (message = base, requestKey = randomUUID(), token = ownerToken) => {
  const result = await ownerCall('hub.request_agent_email', [message.to, message.subject, message.body, requestKey], token);
  actions.add(result.id);
  return result;
};
const approve = id => ownerCall('hub.decide_agent_action', [id, 'approve', null]);
const execute = id => call('private.agent_action_execution', [id]);
const ready = (recover = false, limit = 50) => call('private.agent_external_email_ready', [limit, recover]);
const begin = (id, execution, claim = true) => call('private.agent_external_email_begin_send', [id, execution, claim]);
const finish = (id, execution, delivery, providerId = null) => call('private.agent_external_email_finish_send', [id, execution, delivery, providerId]);
const settle = (id, execution, ok, result) => call('private.agent_action_executed', [id, ok, result, execution]);
const emailRow = id => row('select * from private.agent_external_emails where action_id = $1', [id]);
const makeExecution = async () => {
  const action = await request();
  await approve(action.id);
  return execute(action.id);
};
const recoverExecution = async id => {
  await admin.query("update private.agent_actions set executing_at = now() - interval '11 minutes' where id = $1", [id]);
  assert.ok((await ready(true)).some(action => action.id === id));
  return execute(id);
};
async function waitForAction(id, status) {
  const deadline = Date.now() + 5000;
  do {
    const action = await row('select status,result from private.agent_actions where id=$1', [id]);
    if (action.status === status) return action;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(`External email action did not settle as ${status}`);
}
async function asRole(role, operation) {
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    await operation(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

try {
  for (const [index, user] of users.entries()) {
    await admin.query('insert into auth.users(id,email,is_anonymous) values ($1,$2,false)', [user, `external-email-${index}-${run}@test.invalid`]);
    await admin.query("insert into hub.profiles(id,display_name) values ($1,'External email integration fixture') on conflict (id) do nothing", [user]);
    await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values ($1,$2,now())', [user, userPhones[index]]);
    await admin.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at)
      select $1,$2,user_id,identity_version,now(),now()+interval '1 hour' from private.sms_identities where user_id=$3`,
    [randomUUID(), digest(tokens[index]), user]);
  }
  for (const owner of owners) await admin.query("insert into private.staff_permissions(user_id,permission) values ($1,'platform.admin')", [owner]);

  // Only a current owner SMS command can request an email. Neither service credentials,
  // a normal authenticated customer, a spoofed JWT, nor a stale command session can do so.
  const requestArgs = [base.to, base.subject, base.body, randomUUID()];
  await assert.rejects(admin.query('select hub.request_agent_email($1,$2,$3,$4)', requestArgs), refused('28000'));
  await assert.rejects(ownerCall('hub.request_agent_email', requestArgs, null), error => error.status === 401);
  await assert.rejects(ownerCall('hub.request_agent_email', requestArgs, tokens[2]), refused('28000'));
  for (const role of ['anon', 'service_role']) {
    await asRole(role, client => assert.rejects(client.query('select hub.request_agent_email($1,$2,$3,$4)', requestArgs), refused('42501')));
  }
  await asRole('authenticated', async client => {
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owners[0], role: 'authenticated', amr: [{ method: 'sms' }] })]);
    await assert.rejects(client.query('select hub.request_agent_email($1,$2,$3,$4)', requestArgs), refused('28000'));
  });
  await admin.query("update private.sms_sessions set created_at = now() - interval '9 hours' where user_id = $1", [owners[0]]);
  await assert.rejects(ownerCall('hub.request_agent_email', requestArgs), refused('28000'));
  await admin.query('update private.sms_sessions set created_at = now() where user_id = $1', [owners[0]]);
  await admin.query("update private.staff_permissions set revoked_at = now() where user_id = $1 and permission = 'platform.admin'", [owners[0]]);
  await assert.rejects(ownerCall('hub.request_agent_email', requestArgs), refused('28000'));
  await admin.query("update private.staff_permissions set revoked_at = null where user_id = $1 and permission = 'platform.admin'", [owners[0]]);

  // Payloads and the attempt ledger are never directly accessible, even to the server.
  // Server-only operations also refuse a database administrator impersonating a caller.
  const serverOperations = [
    ['private.agent_external_email_ready', [10, false]],
    ['private.agent_external_email_ready', [10, true]],
    ['private.agent_external_email_begin_send', [randomUUID(), 1, true]],
    ['private.agent_external_email_finish_send', [randomUUID(), 1, 'sent', null]],
  ];
  for (const [fn, args] of serverOperations) {
    const sql = `select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})`;
    await assert.rejects(admin.query(sql, args), refused('42501', /Application server required/));
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await asRole(role, client => assert.rejects(client.query(sql, args), refused('42501')));
    }
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await asRole(role, client => assert.rejects(client.query('select * from private.agent_external_emails'), refused('42501')));
  }
  await assert.rejects(pool.query('select * from private.agent_external_emails'), refused('42501'));
  await assert.rejects(pool.query('select private.agent_external_email_valid($1,$2,$3)', [base.to, base.subject, base.body]), refused('42501'));
  assert.ok((await ownerCall('hub.get_backend_contract')).features.includes('platform.agents.external-email.v1'));

  // Validation refuses injection, multiple recipients, blank content and oversize input.
  // It preserves legitimate Unicode, CR/LF, tabs and trailing whitespace without rewriting.
  const invalid = [
    { ...base, to: 'one@example.test,two@example.test' },
    { ...base, to: 'Name <one@example.test>' },
    { ...base, to: ' one@example.test' },
    { ...base, to: 'one@example.test\r\nBcc:other@example.test' },
    { ...base, to: `${'a'.repeat(309)}@example.test` },
    { ...base, subject: 'Subject\nBcc: other@example.test' },
    { ...base, subject: '\t' },
    { ...base, subject: 's'.repeat(201) },
    { ...base, body: ' \r\n\t' },
    { ...base, body: 'bad\u0001control' },
    { ...base, body: 'bad\u007fcontrol' },
    { ...base, body: 'b'.repeat(5001) },
  ];
  for (const value of invalid) await assert.rejects(request(value), refused('22023'));
  await assert.rejects(request(base, null), refused('22023'));
  const unicode = await request({ ...base, subject: '🟢'.repeat(200), body: '🟢'.repeat(5000) });
  assert.equal((await emailRow(unicode.id)).body, '🟢'.repeat(5000));

  // A lost response or simultaneous tabs create one durable proposal for the same key.
  // The opaque key alone never authorizes a different message or a different owner.
  const key = randomUUID();
  const requested = await Promise.all(Array.from({ length: 8 }, () => request(base, key)));
  assert.equal(new Set(requested.map(result => result.id)).size, 1);
  assert.equal(requested.filter(result => result.created).length, 1);
  const action = requested[0];
  assert.equal(action.kind, 'email.external');
  assert.equal(action.status, 'proposed');
  assert.equal(action.requestKey, key);
  assert.equal((await row('select count(*)::integer as n from private.agent_external_emails where request_key = $1', [key])).n, 1);
  assert.equal((await row("select count(*)::integer as n from private.audit_events where entity_id = $1 and action = 'agent.email.requested'", [action.id])).n, 1);
  for (const changed of [{ ...base, to: 'different@example.test' }, { ...base, subject: 'Different' }, { ...base, body: 'Different' }]) {
    await assert.rejects(request(changed, key), refused('40001'));
  }
  await assert.rejects(request(base, key, tokens[1]), refused('40001'));
  const preview = `To: ${base.to}\nSubject: ${base.subject}\n\n${base.body}`;
  assert.equal((await ownerCall('hub.get_agent_team')).approvals.find(item => item.id === action.id).preview, preview);
  const actionRecord = await row('select input, target_id, preview from private.agent_actions where id = $1', [action.id]);
  assert.deepEqual(actionRecord.input, { requestKey: key });
  assert.equal(actionRecord.target_id, key);
  assert.equal(actionRecord.preview, preview);
  assert.equal(await execute(action.id), null, 'an undecided proposal cannot execute');
  await assert.rejects(begin(action.id, 1), refused('55000'));

  // Neither Act nor a misconfigured auto-approve list can originate or approve this kind.
  await admin.query("update private.agents set status = 'active', autonomy = 'act', config = config || '{\"auto_approve_kinds\":[\"email.external\"]}'::jsonb where key = 'chief_of_staff'");
  const running = (await row(`insert into private.agent_tasks(agent_key,kind,request_key,status,attempts,claimed_at,lease_until)
    values ('chief_of_staff','brief.daily',$1,'running',1,now(),now()+interval '10 minutes') returning id`, [`external-email:${run}`])).id;
  tasks.push(running);
  await assert.rejects(call('private.agent_action_propose', [running, null, 'email.external', 'external_email', key, preview, { requestKey: key }]), refused('42501', /explicit owner request/));
  assert.equal((await request()).status, 'proposed');
  await assert.rejects(admin.query("update private.agent_actions set status = 'auto_approved' where id = $1", [action.id]), refused('23514'));
  await assert.rejects(admin.query('update private.agent_actions set task_id = $1 where id = $2', [running, action.id]), refused('23514'));
  await assert.rejects(admin.query("update private.agent_actions set input = input || '{\"to\":\"another@example.test\"}'::jsonb where id = $1", [action.id]), refused('23514'));

  // The owner's manual workflow still works while the Chief is paused and observe-only.
  await admin.query("update private.agents set status = 'paused', autonomy = 'observe' where key = 'chief_of_staff'");
  const decisions = await Promise.all([approve(action.id), approve(action.id)]);
  assert.equal(decisions.filter(result => result.decided).length, 1);
  const executions = await Promise.all([execute(action.id), execute(action.id)]);
  const execution = executions.find(Boolean);
  assert.equal(executions.filter(Boolean).length, 1);
  assert.equal(execution.execution, 1);
  assert.equal(execution.autoApproved, false);
  assert.deepEqual(execution.input, { requestKey: key });
  assert.deepEqual(await begin(action.id, 1, false), { state: 'unrecorded' });
  assert.equal((await emailRow(action.id)).status, 'requested');
  await assert.rejects(begin(action.id, null), refused('22023'));
  await assert.rejects(begin(action.id, 2), refused('55000'));
  await admin.query("update private.agent_actions set preview = 'A changed preview' where id = $1", [action.id]);
  await assert.rejects(begin(action.id, 1), refused('55000', /does not match/));
  await admin.query('update private.agent_actions set preview = $1 where id = $2', [preview, action.id]);

  // The send is recorded before its message leaves the DB, even with concurrent callers.
  const claims = await Promise.all(Array.from({ length: 8 }, () => begin(action.id, 1)));
  assert.equal(claims.filter(result => result.state === 'ready').length, 1);
  assert.equal(claims.filter(result => result.state === 'recorded' && result.status === 'sending').length, 7);
  const claim = claims.find(result => result.state === 'ready');
  assert.deepEqual(claim, { state: 'ready', ...base });
  assert.equal((await emailRow(action.id)).status, 'sending');
  captured.push(claim);
  for (const result of claims.filter(value => value.state === 'recorded')) {
    assert.equal(result.to, undefined);
    assert.equal(result.body, undefined);
  }
  assert.equal(await finish(action.id, 2, 'sent', 'provider-stale'), false);
  await assert.rejects(finish(action.id, 1, 'delivered'), refused('22023'));
  await assert.rejects(finish(action.id, 1, 'failed', 'must-not-be-recorded'), refused('22023'));
  assert.equal(await finish(action.id, 1, 'sent', 'provider-accepted'), true);
  assert.equal(await finish(action.id, 1, 'failed'), false, 'a later outcome cannot replace provider acceptance');
  await settle(action.id, 1, true, { outcome: 'accepted', providerMessageId: 'provider-accepted' });
  assert.equal((await request(base, key)).status, 'executed');
  assert.equal((await request(base, key)).created, false);
  assert.equal(captured.length, 1);

  // An expired or rejected request never reaches send-time lookup.
  const rejected = await request();
  await ownerCall('hub.decide_agent_action', [rejected.id, 'reject', null]);
  assert.equal(await execute(rejected.id), null);
  await assert.rejects(begin(rejected.id, 1), refused('55000'));
  const expired = await request();
  await admin.query("update private.agent_actions set expires_at = now() - interval '1 second' where id = $1", [expired.id]);
  assert.equal((await approve(expired.id)).status, 'expired');
  assert.equal(await execute(expired.id), null);

  // With no scheduler tick or general maintenance, the owner's manual recovery path finds
  // an approval committed just before a restart. It never starts unrelated approved work,
  // recovers another kind's stale execution or changes an autonomous task.
  for (const limit of [0, 51, null]) await assert.rejects(ready(false, limit), refused('22023'));
  await assert.rejects(ready(null), refused('22023'));
  const unrelated = [];
  for (const status of ['approved', 'executing']) {
    const other = (await row(`insert into private.agent_actions(agent_key,kind,target_kind,target_id,preview,status,decided_by,decided_at,executions,executing_at)
      values ('platform_engineer','incident.open','probe_target','hub','External-email isolation fixture',$1,$2,now(),1,now()-interval '11 minutes') returning id`,
    [status, owners[0]])).id;
    actions.add(other);
    unrelated.push(other);
  }
  const otherBefore = (await admin.query('select id,status,executions,executing_at,updated_at from private.agent_actions where id=any($1::uuid[]) order by id', [unrelated])).rows;
  const taskBefore = await row('select status,attempts,lease_until from private.agent_tasks where id=$1', [running]);
  const parked = await request();
  await approve(parked.id);
  assert.ok((await ready()).some(item => item.id === parked.id));
  assert.equal((await emailRow(parked.id)).status, 'requested');
  assert.ok((await ready(true)).some(item => item.id === parked.id));
  const parkedStarts = (await Promise.all([execute(parked.id), execute(parked.id)])).filter(Boolean);
  assert.equal(parkedStarts.length, 1, 'two owner recovery requests still start one execution');
  const parkedExecution = parkedStarts[0];
  assert.equal((await begin(parked.id, parkedExecution.execution)).state, 'ready');
  assert.equal(await finish(parked.id, parkedExecution.execution, 'sent', 'manual-recovery-provider'), true);
  await settle(parked.id, parkedExecution.execution, true, { outcome: 'accepted' });

  // A read lists a stale external execution without resetting it, and neither a read nor
  // a recovery may take over a worker inside the ten-minute lease. After the lease expires,
  // concurrent recovery leaves exactly one new execution and the earlier attempt unknown.
  const leased = await makeExecution();
  assert.equal((await begin(leased.id, leased.execution)).state, 'ready');
  await admin.query("update private.agent_actions set executing_at=now()-interval '9 minutes' where id=$1", [leased.id]);
  assert.ok(!(await ready()).some(item => item.id === leased.id));
  assert.ok(!(await ready(true)).some(item => item.id === leased.id));
  assert.deepEqual(await row('select status,executions from private.agent_actions where id=$1', [leased.id]), { status: 'executing', executions: leased.execution });
  await admin.query("update private.agent_actions set executing_at=now()-interval '11 minutes' where id=$1", [leased.id]);
  assert.ok((await ready()).some(item => item.id === leased.id));
  assert.equal((await row('select status from private.agent_actions where id=$1', [leased.id])).status, 'executing', 'overview does not mutate a stale execution');
  const recovered = await Promise.all([ready(true), ready(true)]);
  assert.ok(recovered.flat().some(item => item.id === leased.id));
  const reclaimed = (await Promise.all([execute(leased.id), execute(leased.id)])).filter(Boolean);
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].execution, leased.execution + 1);
  assert.equal(await finish(leased.id, leased.execution, 'sent', 'superseded-provider'), false);
  assert.deepEqual(await begin(leased.id, reclaimed[0].execution, false), { state: 'recorded', status: 'unknown', providerMessageId: null });
  assert.equal((await begin(leased.id, reclaimed[0].execution)).state, 'recorded');
  await settle(leased.id, reclaimed[0].execution, false, { error: 'external_email_unconfirmed' });

  // If the original worker is committing its completion, recovery skips its row lock.
  // Once that completion commits, the finished action stays finished instead of reopening.
  const completing = await makeExecution();
  await begin(completing.id, completing.execution);
  await admin.query("update private.agent_actions set executing_at=now()-interval '11 minutes' where id=$1", [completing.id]);
  const completionClient = await pool.connect();
  try {
    await completionClient.query('begin');
    assert.equal((await completionClient.query('select private.agent_external_email_finish_send($1,$2,$3,$4) as r',
      [completing.id, completing.execution, 'sent', 'completion-race-provider'])).rows[0].r, true);
    assert.ok(!(await ready(true)).some(item => item.id === completing.id), 'recovery skips a completion holding the action lock');
    await completionClient.query('select private.agent_action_executed($1,$2,$3,$4)', [completing.id, true, { outcome: 'accepted' }, completing.execution]);
    await completionClient.query('commit');
  } finally {
    await completionClient.query('rollback');
    completionClient.release();
  }
  const remaining = await ready(true);
  for (const id of [action.id, unicode.id, rejected.id, expired.id, leased.id, completing.id, ...unrelated]) {
    assert.ok(!remaining.some(item => item.id === id), 'only eligible approved external emails can be recovered');
  }
  assert.deepEqual((await admin.query('select id,status,executions,executing_at,updated_at from private.agent_actions where id=any($1::uuid[]) order by id', [unrelated])).rows, otherBefore);
  assert.deepEqual(await row('select status,attempts,lease_until from private.agent_tasks where id=$1', [running]), taskBefore);

  // Exercise the actual owner route, action executor and SQL store with the scheduler
  // disabled. The fake sender captures one exact message; neither a model, a remote
  // integration nor general scheduled work is invoked by the manual recovery command.
  const manualSends = [];
  const disabledTeam = agentTeam({
    pool, enabled: false, features: new Set(['platform.agents.hardening.v1', 'platform.agents.external-email.v1']),
    publicOrigin: 'https://hub.test', log: line => teamLogs.push(line),
    fetchImpl: async () => { assert.fail('Manual email recovery must not invoke remote scheduled work'); },
    email: { configured: true, send: async (to, subject, body) => {
      manualSends.push({ to, subject, body });
      return { delivery: 'sent', id: 'owner-manual-provider' };
    } },
  });
  assert.equal(disabledTeam.active(), false);
  const apiDraft = await disabledTeam.admin.email(ownerToken, { ...base, requestKey: randomUUID() });
  actions.add(apiDraft.id);
  await approve(apiDraft.id); // Simulate a restart after approval commits but before the executor is called.
  const waitingView = await disabledTeam.admin.overview(ownerToken);
  assert.equal(waitingView.services.enabled, false);
  assert.ok(waitingView.waitingActions > 0);
  await assert.rejects(disabledTeam.admin.waiting(tokens[2]), error => error.status === 401);
  assert.equal(manualSends.length, 0, 'a non-owner cannot trigger approved email recovery');
  assert.deepEqual(await disabledTeam.admin.waiting(ownerToken), { started: 0, actions: 1 });
  assert.equal((await waitForAction(apiDraft.id, 'executed')).result.outcome, 'accepted');
  assert.deepEqual(manualSends, [base]);

  const apiCrash = await makeExecution();
  await begin(apiCrash.id, apiCrash.execution);
  await admin.query("update private.agent_actions set executing_at=now()-interval '11 minutes' where id=$1", [apiCrash.id]);
  assert.ok((await disabledTeam.admin.overview(ownerToken)).waitingActions > 0);
  assert.equal((await row('select status from private.agent_actions where id=$1', [apiCrash.id])).status, 'executing');
  assert.deepEqual(await disabledTeam.admin.waiting(ownerToken), { started: 0, actions: 1 });
  assert.equal((await waitForAction(apiCrash.id, 'failed')).result.error, 'external_email_unconfirmed');
  assert.equal((await emailRow(apiCrash.id)).status, 'unknown');
  assert.equal(manualSends.length, 1, 'uncertain earlier sends are settled without a second provider call');
  assert.deepEqual((await admin.query('select id,status,executions,executing_at,updated_at from private.agent_actions where id=any($1::uuid[]) order by id', [unrelated])).rows, otherBefore);
  assert.deepEqual(await row('select status,attempts,lease_until from private.agent_tasks where id=$1', [running]), taskBefore);

  // Losing the worker before it claims a send is safe to resume. Losing it after claiming
  // is unknown, not permission to send again. The stale worker cannot settle the new lease.
  const unclaimed = await makeExecution();
  assert.equal((await begin(unclaimed.id, unclaimed.execution, false)).state, 'unrecorded');
  const unclaimedNext = await recoverExecution(unclaimed.id);
  assert.equal(unclaimedNext.execution, unclaimed.execution + 1);
  assert.equal((await begin(unclaimed.id, unclaimedNext.execution)).state, 'ready');
  await finish(unclaimed.id, unclaimedNext.execution, 'failed');
  await settle(unclaimed.id, unclaimedNext.execution, false, { error: 'external_email_refused' });

  const crash = await makeExecution();
  assert.equal((await begin(crash.id, crash.execution)).state, 'ready');
  const crashNext = await recoverExecution(crash.id);
  assert.equal(crashNext.execution, crash.execution + 1);
  assert.deepEqual(await begin(crash.id, crashNext.execution, false), { state: 'recorded', status: 'unknown', providerMessageId: null });
  assert.equal((await emailRow(crash.id)).status, 'unknown');
  assert.equal((await begin(crash.id, crashNext.execution)).status, 'unknown');
  assert.equal(await finish(crash.id, crash.execution, 'sent', 'stale-provider'), false);
  assert.equal(await finish(crash.id, crashNext.execution, 'sent', 'wrong-attempt'), false);
  await assert.rejects(begin(crash.id, crash.execution), refused('55000'));
  await settle(crash.id, crashNext.execution, false, { error: 'external_email_unconfirmed' });

  // A provider result survives an action-completion crash, for accepted, refused and
  // uncertain outcomes alike. Recovery never returns a recipient or a fresh send claim.
  for (const delivery of ['sent', 'failed', 'unknown']) {
    const first = await makeExecution();
    await begin(first.id, first.execution);
    const provider = delivery === 'sent' ? `provider-${run}` : null;
    assert.equal(await finish(first.id, first.execution, delivery, provider), true);
    const next = await recoverExecution(first.id);
    assert.deepEqual(await begin(first.id, next.execution, false), { state: 'recorded', status: delivery, providerMessageId: provider });
    assert.equal((await begin(first.id, next.execution)).state, 'recorded');
    assert.equal(await finish(first.id, next.execution, 'sent', 'second-attempt'), false);
    await settle(first.id, next.execution, delivery === 'sent', delivery === 'sent' ? { outcome: 'accepted' } : { error: 'external_email_unconfirmed' });
  }

  // Exact text is available only to the owner preview and the one send claim. Audit
  // metadata and generic execution input carry identities/outcomes, never the message.
  const audits = (await admin.query('select action,metadata from private.audit_events where entity_id = any($1::uuid[])', [[...actions]])).rows;
  const auditText = JSON.stringify(audits);
  for (const value of [base.to, base.subject, `Exact body ${run}`]) assert.ok(!auditText.includes(value));
  assert.ok(audits.some(value => value.action === 'agent.email.requested'));
  assert.ok(audits.some(value => value.action === 'agent.action.decided'));
  assert.ok(audits.some(value => value.action === 'agent.email.outcome'));
  assert.ok(audits.some(value => value.action === 'agent.action.executed'));
  const briefFacts = JSON.stringify(await call('private.agent_brief_facts'));
  for (const value of [base.to, base.subject, `Exact body ${run}`]) assert.ok(!briefFacts.includes(value), 'team facts must not expose external email content');
  for (const value of [base.to, base.subject, `Exact body ${run}`]) assert.ok(!JSON.stringify(teamLogs).includes(value), 'recovery logs must not expose message content');

  // The declaration refuses capability drift, including a null/reset search_path,
  // leaked column privilege, missing dedupe, missing RLS and a weakened action boundary.
  await admin.query(gate);
  const drift = [
    'alter table private.agent_external_emails disable row level security',
    'grant select(recipient) on private.agent_external_emails to authenticated',
    'grant execute on function private.agent_external_email_begin_send(uuid,integer,boolean) to service_role',
    'alter function private.agent_external_email_ready(integer,boolean) reset search_path',
    'alter function private.agent_external_email_finish_send(uuid,integer,text,text) reset search_path',
    'alter function hub.request_agent_email(text,text,text,uuid) reset search_path',
    'grant execute on function hub.request_agent_email(text,text,text,uuid) to anon',
    'grant execute on function private.agent_external_email_valid(text,text,text) to hub_app_server',
    'alter table private.agent_external_emails drop constraint agent_external_emails_request_key_key',
    'alter table private.agent_actions drop constraint agent_actions_external_email_check',
  ];
  for (const sql of drift) {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await assert.rejects(client.query(gate), refused('55000'), sql);
    } finally {
      await client.query('rollback');
      client.release();
    }
  }
  await admin.query(gate);
  console.log('Owner-directed external email integration passed: owner SMS approval, exact preview, concurrent dedupe, once-only attempts, fenced recovery and private capability gate.');
} finally {
  await admin.query('delete from private.audit_events where entity_id = any($1::uuid[]) or actor_id = any($2::uuid[])', [[...actions], users]);
  await admin.query('delete from private.agent_actions where id = any($1::uuid[]) or task_id = any($2::uuid[])', [[...actions], tasks]);
  await admin.query('delete from private.agent_tasks where id = any($1::uuid[])', [tasks]);
  await admin.query("update private.agents set status=$1,autonomy=$2,config=$3,updated_at=$4 where key='chief_of_staff'", [seedChief.status, seedChief.autonomy, seedChief.config, seedChief.updated_at]);
  await admin.query('delete from private.sms_sessions where user_id = any($1::uuid[])', [users]);
  await admin.query('delete from private.sms_identities where user_id = any($1::uuid[])', [users]);
  await admin.query('delete from private.staff_permissions where user_id = any($1::uuid[])', [users]);
  await admin.query('delete from hub.profiles where id = any($1::uuid[])', [users]);
  await admin.query('delete from auth.users where id = any($1::uuid[])', [users]);
  await pool.end();
  await admin.end();
}
