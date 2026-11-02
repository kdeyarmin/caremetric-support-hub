// The AI team control plane through the actual Hub server role, on disposable local
// fixtures only. The server pool logs in as hub_app_server exactly like production: it
// reaches the agent tables only through the private.agent_* operations, and the owner
// reads and decides through hub.* operations behind real SMS sessions. No model is called.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { assertBackendContract } from '../src/lib/backendContract.ts';

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
const api = gateway(pool);
const contractMigration = await readFile(new URL('../supabase/migrations/20261102120100_agent_control_plane_contract.sql', import.meta.url), 'utf8');

const aiAssistant = 'a1a00000-a1a0-4000-8000-000000000001';
const owner = randomUUID(), other = randomUUID(), secondAdmin = randomUUID();
const ownerToken = 'agents-owner-' + randomUUID(), staleToken = 'agents-owner-stale-' + randomUUID(), otherToken = 'agents-other-' + randomUUID();

// A server-role call: select fn($1,...) as r.
const call = async (fn, args = []) => (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r;
// An owner call: the same statement the gateway runs, inside a real SMS session.
const ownerCall = (fn, args = [], token = ownerToken) => withSession(pool, token, async db =>
  (await db.query(`select to_jsonb(${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})) as r`, args)).rows[0].r);
const refused = (code, pattern) => error => { assert.equal(error.code, code, error.message); if (pattern) assert.match(error.message, pattern); return true; };
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await admin.query(sql, params)).rows;
const team = () => ownerCall('hub.get_agent_team');
const agentRow = async key => (await team()).agents.find(agent => agent.key === key);
const setStatus = async (key, status) => ownerCall('hub.set_agent_status', [key, status, (await agentRow(key)).updatedAt]);
const setAutonomy = async (key, autonomy) => ownerCall('hub.set_agent_autonomy', [key, autonomy, (await agentRow(key)).updatedAt]);
// Leaves no unfinished work behind, so the next step's claim sees only its own tasks.
const clearWork = async () => {
  await admin.query("update private.agent_actions set status = 'rejected' where status in ('proposed', 'approved', 'auto_approved', 'executing')");
  await admin.query("update private.agent_tasks set status = 'cancelled', lease_until = null where status in ('queued', 'running', 'awaiting_approval', 'awaiting_session')");
};
const enqueue = (agent, kind, key, extra = {}) => call('private.agent_task_enqueue',
  [agent, kind, key, extra.payload ?? {}, extra.priority ?? 5, extra.dueAt ?? null, extra.sourceKind ?? null, extra.sourceRef ?? null, extra.requiresSession ?? false]);
const claim = (limit = 5) => call('private.agent_task_claim', [limit, 600]);
const claimOne = async (agent, kind, key) => {
  const id = await enqueue(agent, kind, key);
  const [task] = await claim(1);
  assert.equal(task.id, id, 'the claimed task is the one just enqueued');
  return task;
};
const task = id => row('select * from private.agent_tasks where id = $1', [id]);
const action = id => row('select * from private.agent_actions where id = $1', [id]);
const auditFor = (actionName, entityId) => rows('select * from private.audit_events where action = $1 and entity_id = $2 order by id', [actionName, entityId]);
const run = randomUUID().slice(0, 8);

let setAside = [];
const seedAgents = (await admin.query('select key, status, autonomy, daily_budget_cents, updated_at from private.agents')).rows;
const seedSchedules = (await admin.query('select id, next_run_at, last_run_at, last_task_id, enabled from private.agent_schedules')).rows;

try {
  // Fixtures: the owner (platform administrator with a verified SMS identity), a signed-in
  // user without administrator rights, and an administrator whose session is nine hours old.
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'agents-owner@test.invalid',false),($2,'agents-other@test.invalid',false),($3,'agents-second@test.invalid',false)", [owner, other, secondAdmin]);
  // A trigger gives every new user a profile; name the owner's so the audit list can show who acted.
  await admin.query("update hub.profiles set display_name = 'Agents integration owner' where id = $1", [owner]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550701',now()),($2,'+12025550702',now())", [owner, other]);
  for (const [user, sessionToken, age] of [[owner, ownerToken, '0 hours'], [owner, staleToken, '9 hours'], [other, otherToken, '0 hours']]) {
    await admin.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at)
      select $1,$2,user_id,identity_version,now()-$4::interval,now()+interval '1 hour' from private.sms_identities where user_id=$3`,
    [randomUUID(), digest(sessionToken), user, age]);
  }
  // Other scripts leave their administrators behind in the shared test database. The owner contact is
  // defined as "the single active administrator", so set the others aside for this run and restore them after.
  setAside = (await admin.query("update private.staff_permissions set revoked_at = now() where permission = 'platform.admin' and revoked_at is null and user_id <> $1 returning id", [owner])).rows.map(entry => entry.id);
  assert.equal(Number((await row("select count(*) from private.staff_permissions where permission = 'platform.admin' and revoked_at is null")).count), 1,
    'the fixture owner is the only platform administrator');

  // The boundary: no table access for the server role, every operation refuses other session users.
  for (const table of ['agents', 'agent_schedules', 'agent_tasks', 'agent_runs', 'agent_actions', 'owner_notifications']) {
    await assert.rejects(pool.query(`select count(*) from private.${table}`), refused('42501'));
  }
  await assert.rejects(admin.query('select private.agent_task_claim(1, 60)'), refused('42501', /Application server required/));
  await assert.rejects(admin.query('select private.owner_contact()'), refused('42501', /Application server required/));
  await assert.rejects(ownerCall('hub.get_agent_team', [], otherToken), refused('28000', /Current administrator session required/));
  await assert.rejects(ownerCall('hub.decide_agent_action', [randomUUID(), 'approve', null], otherToken), refused('28000'));
  await assert.rejects(withSession(pool, null, db => db.query('select hub.get_agent_team()'), false), refused('42501'));
  assertBackendContract(await api.rpc('get_backend_contract', {}));
  assert.ok((await api.rpc('get_backend_contract', {})).features.includes('platform.agents.v1'));

  // The owner sees the three seeded agents, paused.
  let view = await team();
  assert.deepEqual(view.agents.map(agent => agent.key), ['chief_of_staff', 'platform_engineer', 'support_concierge']);
  assert.ok(view.agents.every(agent => agent.status === 'paused'));
  assert.deepEqual([view.approvalCount, view.awaitingSessionCount], [0, 0]);
  assert.deepEqual((await api.rpc('get_agent_team', {}, ownerToken)).agents.map(agent => agent.key), view.agents.map(agent => agent.key), 'the gateway serves the team view');
  // Changes are not part of the gateway's read allowlist; they only run through the owner routes.
  await assert.rejects(async () => api.rpc('decide_agent_action', { p_action_id: randomUUID(), p_decision: 'approve' }, ownerToken), error => error.status === 400);
  await assert.rejects(async () => api.rpc('set_agent_status', { p_key: 'chief_of_staff' }, ownerToken), error => error.status === 400);

  // Owner changes: optimistic concurrency, validation, audit.
  const before = await agentRow('platform_engineer');
  const activated = await ownerCall('hub.set_agent_status', ['platform_engineer', 'active', before.updatedAt]);
  assert.equal(activated.status, 'active');
  await assert.rejects(ownerCall('hub.set_agent_status', ['platform_engineer', 'paused', before.updatedAt]), refused('40001', /changed/));
  await assert.rejects(ownerCall('hub.set_agent_status', ['platform_engineer', 'sleeping', activated.updatedAt]), refused('22023'));
  await assert.rejects(ownerCall('hub.set_agent_status', ['nobody', 'active', activated.updatedAt]), refused('P0002'));
  const statusAudit = await row("select * from private.audit_events where action = 'agent.status' order by id desc limit 1");
  assert.equal(statusAudit.actor_id, owner);
  assert.deepEqual(statusAudit.metadata, { agent: 'platform_engineer', status: 'active' });
  await assert.rejects(ownerCall('hub.set_agent_status', ['platform_engineer', 'paused', activated.updatedAt], staleToken), refused('28000', /Current administrator session required/),
    'a session older than eight hours can read but not change');
  assert.equal((await ownerCall('hub.get_agent_team', [], staleToken)).agents.length, 3);
  const budgeted = await ownerCall('hub.set_agent_budget', ['platform_engineer', 75, activated.updatedAt]);
  assert.equal(budgeted.dailyBudgetCents, 75);
  await assert.rejects(ownerCall('hub.set_agent_budget', ['platform_engineer', -1, budgeted.updatedAt]), refused('22023'));
  await assert.rejects(ownerCall('hub.set_agent_budget', ['platform_engineer', 100001, budgeted.updatedAt]), refused('22023'));
  const rebudgeted = await ownerCall('hub.set_agent_budget', ['platform_engineer', 50, budgeted.updatedAt]);
  assert.deepEqual((await row("select metadata from private.audit_events where action = 'agent.budget' order by id desc limit 1")).metadata, { agent: 'platform_engineer', from: 75, to: 50 });
  const observing = await ownerCall('hub.set_agent_autonomy', ['platform_engineer', 'observe', rebudgeted.updatedAt]);
  await assert.rejects(ownerCall('hub.set_agent_autonomy', ['platform_engineer', 'root', observing.updatedAt]), refused('22023'));
  assert.equal((await ownerCall('hub.set_agent_autonomy', ['platform_engineer', 'act', observing.updatedAt])).autonomy, 'act');

  // Enqueue is idempotent; a task that needs the owner's session waits for it.
  await clearWork();
  const t1 = await enqueue('platform_engineer', 'probe.sweep', `it:${run}:probe:1`);
  assert.ok(t1);
  assert.equal(await enqueue('platform_engineer', 'probe.sweep', `it:${run}:probe:1`), null, 'the same request key enqueues nothing');
  assert.equal(Number((await row('select count(*) from private.agent_tasks where request_key = $1', [`it:${run}:probe:1`])).count), 1);
  const waiting = await enqueue('support_concierge', 'import.advisors', `it:${run}:import:1`, { requiresSession: true });
  assert.equal((await task(waiting)).status, 'awaiting_session');
  const parkedPaused = await enqueue('chief_of_staff', 'brief.daily', `it:${run}:brief:1`);
  await assert.rejects(call('private.agent_task_claim', [0, 600]), refused('22023'));
  await assert.rejects(call('private.agent_task_claim', [1, 5]), refused('22023'));

  // Claim: only active agents' due, unleased work; settings and budget travel with it.
  const claimed = await claim();
  assert.deepEqual(claimed.map(entry => entry.id), [t1], 'a paused agent and a session task are not handed out');
  assert.equal(claimed[0].attempts, 1);
  assert.deepEqual(claimed[0].agent, { autonomy: 'act', modelTier: 'fast', promptVersion: 'v1', toolAllowlist: ['notify_owner'],
    config: { effort: 'low', auto_approve_kinds: ['incident.open', 'incident.resolve'] } });
  assert.equal(claimed[0].budget.budgetCents, 50);
  assert.equal(claimed[0].budget.remainingCents, 50);
  assert.deepEqual(await claim(), [], 'a leased task is not handed out twice');
  assert.equal(await call('private.agent_task_heartbeat', [t1, 600]), true);
  assert.equal(await call('private.agent_task_finish', [t1, 'done', { checked: 4 }, null, null]), 'done');
  assert.equal(await call('private.agent_task_heartbeat', [t1, 600]), false, 'a finished task cannot be extended');
  assert.equal(await call('private.agent_task_finish', [t1, 'failed', null, 'late', null]), 'done', 'finishing again changes nothing');
  assert.deepEqual((await task(t1)).result, { checked: 4 });
  await assert.rejects(call('private.agent_task_finish', [t1, 'exploded', null, null, null]), refused('22023'));
  await assert.rejects(call('private.agent_task_finish', [randomUUID(), 'done', null, null, null]), refused('P0002'));

  // A lease that runs out is handed out again; five lost leases stop the task.
  await clearWork();
  const t2 = await enqueue('platform_engineer', 'probe.sweep', `it:${run}:lease:1`);
  assert.deepEqual((await claim()).map(entry => entry.id), [t2]);
  await admin.query("update private.agent_tasks set lease_until = now() - interval '1 second' where id = $1", [t2]);
  const [again] = await claim();
  assert.equal(again.id, t2);
  assert.equal(again.attempts, 2, 'a reclaimed task counts the attempt');
  await admin.query("update private.agent_tasks set lease_until = now() - interval '1 second', attempts = 5 where id = $1", [t2]);
  assert.deepEqual(await claim(), []);
  assert.deepEqual([(await task(t2)).status, (await task(t2)).last_error_code], ['failed', 'lease_expired'], 'a poison task cannot block the queue');

  // Retry with backoff: not before it is due; failed after five attempts.
  await clearWork();
  const t3 = await enqueue('platform_engineer', 'probe.sweep', `it:${run}:retry:1`);
  await claim();
  assert.equal(await call('private.agent_task_finish', [t3, 'queued', null, 'provider_outage', new Date(Date.now() + 3600e3).toISOString()]), 'queued');
  assert.deepEqual(await claim(), []);
  await admin.query("update private.agent_tasks set due_at = now() - interval '1 second' where id = $1", [t3]);
  assert.equal((await claim())[0].attempts, 2);
  await admin.query('update private.agent_tasks set attempts = 5 where id = $1', [t3]);
  assert.equal(await call('private.agent_task_finish', [t3, 'queued', null, 'provider_outage', null]), 'failed');

  // Priority order, and a task the owner cancels mid-run is left cancelled.
  await clearWork();
  const low = await enqueue('platform_engineer', 'probe.sweep', `it:${run}:prio:9`, { priority: 9 });
  const high = await enqueue('platform_engineer', 'probe.sweep', `it:${run}:prio:1`, { priority: 1 });
  assert.deepEqual((await claim(1)).map(entry => entry.id), [high]);
  assert.deepEqual((await claim(1)).map(entry => entry.id), [low]);
  assert.equal((await ownerCall('hub.cancel_agent_task', [high])).status, 'cancelled');
  assert.equal(await call('private.agent_task_finish', [high, 'done', null, null, null]), 'cancelled');
  assert.equal(await call('private.agent_task_heartbeat', [high, 600]), false);
  assert.equal((await ownerCall('hub.cancel_agent_task', [high])).status, 'cancelled', 'cancelling twice is harmless');
  await assert.rejects(ownerCall('hub.cancel_agent_task', [randomUUID()]), refused('P0002'));

  // Tasks that wait for the owner's session: listed, claimed once, parked again on a lost lease.
  await clearWork();
  await setStatus('support_concierge', 'active');
  const s1 = await enqueue('support_concierge', 'import.advisors', `it:${run}:session:1`, { requiresSession: true });
  const s2 = await enqueue('chief_of_staff', 'import.advisors', `it:${run}:session:2`, { requiresSession: true });
  assert.deepEqual((await call('private.agent_session_tasks', [10])).map(entry => entry.id), [s1], 'a paused agent\'s session task is not offered');
  assert.deepEqual(await claim(), [], 'the scheduler never claims a session task');
  assert.equal((await call('private.agent_session_task_claim', [s1, 600])).id, s1);
  assert.equal(await call('private.agent_session_task_claim', [s1, 600]), null, 'only one caller gets the task');
  assert.equal(await call('private.agent_session_task_claim', [s2, 600]), null, 'a paused agent\'s task is not claimed');
  await admin.query("update private.agent_tasks set lease_until = now() - interval '1 second' where id = $1", [s1]);
  assert.equal((await call('private.agent_maintenance')).parkedTasks, 1);
  assert.equal((await task(s1)).status, 'awaiting_session');
  await call('private.agent_session_task_claim', [s1, 600]);
  await admin.query("update private.agent_tasks set lease_until = now() - interval '1 second', attempts = 5 where id = $1", [s1]);
  assert.equal((await call('private.agent_maintenance')).failedTasks, 1);
  assert.equal((await task(s1)).status, 'failed');
  const s3 = await enqueue('support_concierge', 'import.advisors', `it:${run}:session:3`, { requiresSession: true });
  await call('private.agent_session_task_claim', [s3, 600]);
  assert.equal(await call('private.agent_task_finish', [s3, 'queued', null, 'bridge_unavailable', null]), 'awaiting_session', 'a session task retries as a session task');

  // Schedules fire for active agents only, once at a time, and stay on their grid.
  await clearWork();
  await setStatus('support_concierge', 'paused');
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '1 minute', enabled = true");
  const fired = await call('private.agent_schedule_fire', [10]);
  assert.equal(fired.length, 1, 'only the active agent\'s schedule fires');
  const probe = await task(fired[0]);
  assert.deepEqual([probe.agent_key, probe.kind, probe.status, probe.source_kind], ['platform_engineer', 'probe.sweep', 'queued', 'schedule']);
  assert.match(probe.request_key, /^schedule:[0-9a-f-]{36}:\d{8}T\d{6}Z$/);
  const probeSchedule = await row("select extract(epoch from next_run_at - now()) as ahead, last_task_id from private.agent_schedules where task_kind = 'probe.sweep'");
  assert.ok(probeSchedule.ahead > 0 && probeSchedule.ahead <= 300, 'the next run is on the grid, in the future');
  assert.equal(probeSchedule.last_task_id, fired[0]);
  assert.equal(Number((await row("select count(*) from private.agent_tasks where agent_key = 'support_concierge' and source_kind = 'schedule'")).count), 0, 'a paused agent\'s schedules do not fire');
  assert.deepEqual(await call('private.agent_schedule_fire', [10]), [], 'nothing is due');
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '1 minute' where task_kind = 'probe.sweep'");
  assert.deepEqual(await call('private.agent_schedule_fire', [10]), [], 'an unfinished task is not stacked under another');
  assert.ok(Number((await row("select extract(epoch from next_run_at - now()) as ahead from private.agent_schedules where task_kind = 'probe.sweep'")).ahead) > 0, 'but the schedule still advances');
  await claim();
  await call('private.agent_task_finish', [fired[0], 'done', null, null, null]);
  // Only the kinds the running server can handle fire; any other schedule stays due and untouched.
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '5 minutes' where task_kind = 'probe.sweep'");
  const waitingSchedule = await row("select next_run_at from private.agent_schedules where task_kind = 'probe.sweep'");
  assert.deepEqual(await call('private.agent_schedule_fire', [10, ['something.else']]), [], 'a kind the server does not handle does not fire');
  assert.deepEqual(await call('private.agent_schedule_fire', [10, []]), [], 'an empty list fires nothing');
  assert.deepEqual((await row("select next_run_at from private.agent_schedules where task_kind = 'probe.sweep'")).next_run_at, waitingSchedule.next_run_at, 'and its schedule is left due');
  // A firing's request key carries the scheduled instant to the second, so a repeated firing of the
  // same instant is a no-op; schedules are at least a minute apart, so the next instant differs.
  await admin.query("update private.agent_schedules set next_run_at = (select (regexp_match(request_key, ':(\\d{8}T\\d{6}Z)$'))[1]::text::timestamptz from private.agent_tasks where id = $1) where task_kind = 'probe.sweep'", [fired[0]]);
  assert.deepEqual(await call('private.agent_schedule_fire', [10]), [], 'the same scheduled instant never enqueues twice');
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '2 minutes' where task_kind = 'probe.sweep'");
  const refired = await call('private.agent_schedule_fire', [10, ['probe.sweep']]);
  assert.equal(refired.length, 1);
  assert.notEqual((await task(refired[0])).request_key, probe.request_key);
  await admin.query("update private.agent_schedules set enabled = false, next_run_at = now() - interval '3 minutes' where task_kind = 'probe.sweep'");
  await call('private.agent_task_finish', [refired[0], 'done', null, null, null]).catch(() => {});
  await clearWork();
  assert.deepEqual(await call('private.agent_schedule_fire', [10]), [], 'a disabled schedule does not fire');
  await assert.rejects(call('private.agent_schedule_fire', [0]), refused('22023'));
  await setStatus('support_concierge', 'active');
  await admin.query("update private.agent_schedules set enabled = true, next_run_at = now() - interval '1 minute' where agent_key = 'support_concierge'");
  const conciergeFired = await call('private.agent_schedule_fire', [10]);
  assert.deepEqual((await rows('select kind, status from private.agent_tasks where id = any($1::uuid[]) order by kind', [conciergeFired])).map(entry => `${entry.kind}:${entry.status}`),
    ['concierge.sweep:queued', 'import.advisors:awaiting_session', 'import.breathe:awaiting_session']);
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '1 minute' where agent_key = 'support_concierge'");
  assert.deepEqual(await call('private.agent_schedule_fire', [10]), [], 'waiting session tasks are not stacked');

  // Run and budget: provenance, clipping, and a day boundary.
  await clearWork();
  await admin.query("update private.agent_schedules set enabled = true");
  const runTask = await claimOne('platform_engineer', 'probe.sweep', `it:${run}:run:1`);
  assert.equal((await call('private.agent_budget', ['platform_engineer'])).spentCents, 0);
  assert.equal(await call('private.agent_budget', ['nobody']), null);
  const runId = await call('private.agent_run_start', [runTask.id, 'claude-haiku-5-5', 'v1']);
  await call('private.agent_run_finish', [runId, 'completed', { rounds: 2, toolCalls: 1, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, cacheWriteTokens: 0, costCents: 12.5 }, 'x'.repeat(5000), null]);
  const finished = await row('select * from private.agent_runs where id = $1', [runId]);
  assert.deepEqual([finished.outcome, finished.rounds, finished.tool_calls, Number(finished.input_tokens), Number(finished.output_tokens), Number(finished.cache_read_tokens), finished.cost_cents],
    ['completed', 2, 1, 1200, 300, 900, '12.5000']);
  assert.equal(finished.summary.length, 2000, 'a long summary is clipped, not rejected');
  assert.ok(finished.finished_at);
  await assert.rejects(call('private.agent_run_finish', [runId, 'completed', {}, null, null]), refused('P0002'), 'a run closes once');
  await assert.rejects(call('private.agent_run_start', [t1, 'claude-haiku-5-5', 'v1']), refused('55000'), 'only a running task starts a run');
  await admin.query("insert into private.agent_runs(task_id,agent_key,model,prompt_version,started_at,finished_at,outcome,cost_cents) values($1,'platform_engineer','claude-haiku-5-5','v1',private.agent_day_start()-interval '1 hour',now(),'completed',30)", [runTask.id]);
  const spent = await call('private.agent_budget', ['platform_engineer']);
  assert.deepEqual([spent.spentCents, spent.remainingCents], [12.5, 37.5], 'yesterday\'s cost does not count against today');
  const secondRun = await call('private.agent_run_start', [runTask.id, 'claude-haiku-5-5', 'v1']);
  await call('private.agent_run_finish', [secondRun, 'budget_exhausted', { costCents: 40 }, 'Stopped at the daily budget.', null]);
  assert.deepEqual([(await call('private.agent_budget', ['platform_engineer'])).remainingCents, (await agentRow('platform_engineer')).spentTodayCents], [0, 52.5]);
  assert.equal((await agentRow('platform_engineer')).lastRun.outcome, 'budget_exhausted');
  await call('private.agent_task_finish', [runTask.id, 'done', null, null, null]);

  // Actions: propose, decide, execute exactly once, audit, settle the task.
  await clearWork();
  const conciergeTask = await claimOne('support_concierge', 'concierge.communication', `it:${run}:concierge:1`);
  const conciergeRun = await call('private.agent_run_start', [conciergeTask.id, 'claude-sonnet-5-5', 'v1']);
  const reply = await call('private.agent_action_propose', [conciergeTask.id, conciergeRun, 'communication.reply', 'communication', 'CM-1001', 'Here is how to export by month.', { body: 'Here is how to export by month.', reference: 1001 }]);
  assert.deepEqual([reply.status, reply.created], ['proposed', true]);
  const replay = await call('private.agent_action_propose', [conciergeTask.id, conciergeRun, 'communication.reply', 'communication', 'CM-1001', 'A different draft.', {}]);
  assert.deepEqual([replay.id, replay.created, replay.requestKey], [reply.id, false, reply.requestKey], 'the same proposal from one task is returned, not duplicated');
  assert.equal((await action(reply.id)).preview, 'Here is how to export by month.');
  await assert.rejects(call('private.agent_action_propose', [conciergeTask.id, randomUUID(), 'communication.note', 'communication', 'CM-1001', 'x', {}]), refused('55000'), 'a run must belong to the task');
  await assert.rejects(call('private.agent_action_propose', [t1, null, 'communication.note', 'communication', 'CM-1001', 'x', {}]), refused('55000'), 'only a running task proposes');
  await assert.rejects(call('private.agent_action_propose', [conciergeTask.id, null, 'wire.money', 'communication', 'CM-1001', 'x', {}]), refused('23514'), 'only the known action kinds exist');
  await setAutonomy('support_concierge', 'observe');
  await assert.rejects(call('private.agent_action_propose', [conciergeTask.id, null, 'communication.note', 'communication', 'CM-1001', 'x', {}]), refused('42501', /observe-only/));
  await setAutonomy('support_concierge', 'propose');
  assert.equal(await call('private.agent_task_finish', [conciergeTask.id, 'awaiting_approval', { classification: 'technical_support' }, null, null]), 'awaiting_approval');
  view = await team();
  assert.equal(view.approvalCount, 1);
  assert.deepEqual([view.approvals[0].id, view.approvals[0].agentName, view.approvals[0].targetId, view.approvals[0].kind], [reply.id, 'Support Concierge', 'CM-1001', 'communication.reply']);
  assert.equal((await ownerCall('hub.list_agent_activity', ['actions', 'support_concierge', 0, 10])).items[0].id, reply.id);
  assert.deepEqual(await call('private.agent_actions_ready', [10]), [], 'a proposal is not ready until the owner approves it');
  assert.equal(await call('private.agent_action_execution', [reply.id]), null, 'an undecided proposal cannot be executed');
  await assert.rejects(ownerCall('hub.decide_agent_action', [reply.id, 'maybe', null]), refused('22023'));
  await assert.rejects(ownerCall('hub.decide_agent_action', [randomUUID(), 'approve', null]), refused('P0002'));
  const approved = await ownerCall('hub.decide_agent_action', [reply.id, 'approve', 'Looks right']);
  assert.deepEqual([approved.status, approved.decided, approved.requestKey], ['approved', true, reply.requestKey]);
  assert.equal((await ownerCall('hub.decide_agent_action', [reply.id, 'reject', null])).decided, false, 'a decision is final');
  assert.equal((await action(reply.id)).status, 'approved');
  assert.deepEqual((await auditFor('agent.action.decided', reply.id)).map(event => [event.actor_id, event.metadata]), [[owner, { agent: 'support_concierge', kind: 'communication.reply', decision: 'approve' }]]);
  assert.deepEqual((await call('private.agent_actions_ready', [10])).map(entry => entry.id), [reply.id]);
  const execution = await call('private.agent_action_execution', [reply.id]);
  assert.deepEqual([execution.kind, execution.input.reference, execution.requestKey, execution.autoApproved], ['communication.reply', 1001, reply.requestKey, false]);
  assert.equal(await call('private.agent_action_execution', [reply.id]), null, 'an approval is executed once');
  await call('private.agent_action_executed', [reply.id, true, { delivery: 'sent' }]);
  assert.deepEqual([(await action(reply.id)).status, (await task(conciergeTask.id)).status], ['executed', 'done'], 'the task finishes when nothing it proposed is open');
  const executedAudit = await auditFor('agent.action.executed', reply.id);
  assert.deepEqual([executedAudit[0].actor_id, executedAudit[0].metadata], [aiAssistant, { agent: 'support_concierge', kind: 'communication.reply', auto: false }]);
  assert.ok(!JSON.stringify(executedAudit[0]).includes('export by month'), 'audit metadata never carries message text');
  await assert.rejects(call('private.agent_action_executed', [reply.id, true, {}]), refused('55000'));

  // Reject, expire and cancel.
  await clearWork();
  const second = await claimOne('support_concierge', 'concierge.communication', `it:${run}:concierge:2`);
  const update = await call('private.agent_action_propose', [second.id, null, 'communication.update', 'communication', 'CM-1002', 'Mark it billing.', { inquiryType: 'billing' }]);
  await call('private.agent_task_finish', [second.id, 'awaiting_approval', null, null, null]);
  const rejected = await ownerCall('hub.decide_agent_action', [update.id, 'reject', 'Not billing']);
  assert.deepEqual([rejected.status, (await action(update.id)).decision_note, (await task(second.id)).status], ['rejected', 'Not billing', 'done']);
  assert.equal(await call('private.agent_action_execution', [update.id]), null, 'a rejected proposal is never executed');
  const third = await claimOne('support_concierge', 'concierge.communication', `it:${run}:concierge:3`);
  const late = await call('private.agent_action_propose', [third.id, null, 'communication.reply', 'communication', 'CM-1003', 'Late reply.', {}]);
  await call('private.agent_task_finish', [third.id, 'awaiting_approval', null, null, null]);
  await admin.query("update private.agent_actions set expires_at = now() - interval '1 minute' where id = $1", [late.id]);
  assert.equal((await team()).approvalCount, 0, 'an expired proposal is no longer offered');
  const expired = await ownerCall('hub.decide_agent_action', [late.id, 'approve', null]);
  assert.deepEqual([expired.status, expired.decided, (await task(third.id)).status], ['expired', false, 'done']);
  const fourth = await claimOne('support_concierge', 'concierge.communication', `it:${run}:concierge:4`);
  const stale = await call('private.agent_action_propose', [fourth.id, null, 'communication.reply', 'communication', 'CM-1004', 'Stale reply.', {}]);
  await call('private.agent_task_finish', [fourth.id, 'awaiting_approval', null, null, null]);
  await admin.query("update private.agent_actions set expires_at = now() - interval '1 minute' where id = $1", [stale.id]);
  assert.equal((await call('private.agent_maintenance')).expiredActions, 1);
  assert.deepEqual([(await action(stale.id)).status, (await task(fourth.id)).status], ['expired', 'done']);
  const fifth = await claimOne('support_concierge', 'concierge.communication', `it:${run}:concierge:5`);
  const cancelled = await call('private.agent_action_propose', [fifth.id, null, 'communication.reply', 'communication', 'CM-1005', 'Never sent.', {}]);
  await call('private.agent_task_finish', [fifth.id, 'awaiting_approval', null, null, null]);
  assert.equal((await ownerCall('hub.cancel_agent_task', [fifth.id])).status, 'cancelled');
  assert.deepEqual([(await action(cancelled.id)).status, (await action(cancelled.id)).decision_note], ['rejected', 'The task was cancelled.']);

  // An agent on "act" carries out only the kinds it is trusted with; the rest wait.
  await clearWork();
  const incidentTask = await claimOne('platform_engineer', 'probe.incident', `it:${run}:incident:1`);
  const incident = await call('private.agent_action_propose', [incidentTask.id, null, 'incident.open', 'probe_target', 'hub', 'Hub health probe failed twice.', { target: 'hub' }]);
  const restart = await call('private.agent_action_propose', [incidentTask.id, null, 'import.run', 'import_source', 'advisors', 'Import now.', {}]);
  assert.deepEqual([incident.status, restart.status], ['auto_approved', 'proposed']);
  await call('private.agent_task_finish', [incidentTask.id, 'awaiting_approval', null, null, null]);
  assert.deepEqual((await call('private.agent_actions_ready', [10])).map(entry => entry.id), [incident.id]);
  assert.equal((await call('private.agent_action_execution', [incident.id])).autoApproved, true);
  await call('private.agent_action_executed', [incident.id, true, {}]);
  assert.deepEqual((await auditFor('agent.action.executed', incident.id)).map(event => event.metadata.auto), [true]);
  assert.equal((await task(incidentTask.id)).status, 'awaiting_approval', 'the task still waits for the proposal the owner has not decided');
  await ownerCall('hub.decide_agent_action', [restart.id, 'reject', null]);
  assert.equal((await task(incidentTask.id)).status, 'done');
  // An execution the server never finished returns to its approved state.
  const interrupted = await claimOne('platform_engineer', 'probe.incident', `it:${run}:incident:2`);
  const resend = await call('private.agent_action_propose', [interrupted.id, null, 'import.run', 'import_source', 'breathe', 'Import again.', {}]);
  await call('private.agent_task_finish', [interrupted.id, 'awaiting_approval', null, null, null]);
  await ownerCall('hub.decide_agent_action', [resend.id, 'approve', null]);
  await call('private.agent_action_execution', [resend.id]);
  assert.equal((await call('private.agent_maintenance')).resetExecutions, 0, 'a fresh execution is left alone');
  await admin.query("update private.agent_actions set executing_at = now() - interval '11 minutes' where id = $1", [resend.id]);
  assert.equal((await call('private.agent_maintenance')).resetExecutions, 1);
  assert.equal((await action(resend.id)).status, 'approved');
  assert.ok(await call('private.agent_action_execution', [resend.id]), 'and can be executed again');
  await call('private.agent_action_executed', [resend.id, false, { error: 'bridge_unavailable' }]);
  assert.deepEqual([(await action(resend.id)).status, (await task(interrupted.id)).status], ['failed', 'done']);
  assert.deepEqual((await auditFor('agent.action.failed', resend.id)).length, 1);

  // Run now: only a task the agent already has on a schedule, and only while it is active.
  await clearWork();
  await setStatus('chief_of_staff', 'paused');
  await assert.rejects(ownerCall('hub.request_agent_task', ['chief_of_staff', 'brief.daily']), refused('55000', /Resume this agent/));
  await assert.rejects(ownerCall('hub.request_agent_task', ['platform_engineer', 'wire.money']), refused('P0002', /no such task/));
  await assert.rejects(ownerCall('hub.request_agent_task', ['nobody', 'probe.sweep']), refused('P0002'));
  const requested = await ownerCall('hub.request_agent_task', ['platform_engineer', 'probe.sweep']);
  const requestedTask = await task(requested.id);
  assert.deepEqual([requested.status, requestedTask.source_kind, requestedTask.priority, requestedTask.requires_session], ['queued', 'owner', 4, false]);
  assert.match(requestedTask.request_key, /^owner:[0-9a-f-]{36}$/);
  assert.equal((await ownerCall('hub.request_agent_task', ['support_concierge', 'import.advisors'])).status, 'awaiting_session');
  assert.equal((await team()).awaitingSessionCount, 1);

  // Owner notifications: recorded before sending, once per channel, retried only after a failure.
  const first = await call('private.agent_notify_begin', ['email', 'warning', 'Hub is down', 'The Hub probe failed twice.', `it:${run}:alert:1`, 'platform_engineer', null]);
  assert.deepEqual([first.duplicate, first.status], [false, 'pending']);
  assert.equal((await call('private.agent_notify_begin', ['email', 'warning', 'Hub is down', 'The Hub probe failed twice.', `it:${run}:alert:1`, 'platform_engineer', null])).duplicate, true, 'an alert is recorded once');
  assert.equal((await call('private.agent_notify_begin', ['sms', 'urgent', 'Hub is down', 'Hub down.', `it:${run}:alert:1`, 'platform_engineer', null])).duplicate, false, 'each channel has its own record');
  await call('private.agent_notify_finish', [first.id, 'failed', null]);
  const retry = await call('private.agent_notify_begin', ['email', 'warning', 'Hub is down', 'The Hub probe failed twice.', `it:${run}:alert:1`, 'platform_engineer', null]);
  assert.deepEqual([retry.duplicate, retry.id], [false, first.id], 'a failed delivery is retried');
  await call('private.agent_notify_finish', [first.id, 'failed', null]);
  assert.equal((await call('private.agent_notify_begin', ['email', 'warning', 'Hub is down', 'x', `it:${run}:alert:1`, null, null])).duplicate, false);
  await call('private.agent_notify_finish', [first.id, 'failed', null]);
  assert.equal((await call('private.agent_notify_begin', ['email', 'warning', 'Hub is down', 'x', `it:${run}:alert:1`, null, null])).duplicate, true, 'retries stop after the third attempt');
  const delivered = await call('private.agent_notify_begin', ['email', 'info', 'S'.repeat(300), 'B'.repeat(5000), `it:${run}:alert:2`, null, null]);
  await call('private.agent_notify_finish', [delivered.id, 'sent', 'SG.fixture']);
  const sent = await row('select * from private.owner_notifications where id = $1', [delivered.id]);
  assert.deepEqual([sent.status, sent.provider_message_id, sent.subject.length, sent.body.length, sent.sent_at !== null], ['sent', 'SG.fixture', 200, 4000, true]);
  // A send the server never settled (it stopped between recording and sending) becomes unknown and is never resent on its own.
  const stuck = await call('private.agent_notify_begin', ['sms', 'urgent', 'Stuck', 'Stuck.', `it:${run}:alert:3`, null, null]);
  assert.equal((await call('private.agent_maintenance')).unsettledNotifications, 0, 'a fresh pending notification is left alone');
  await admin.query("update private.owner_notifications set created_at = now() - interval '16 minutes' where id = $1", [stuck.id]);
  assert.equal((await call('private.agent_maintenance')).unsettledNotifications, 1);
  assert.equal((await row('select status from private.owner_notifications where id = $1', [stuck.id])).status, 'unknown');
  assert.equal((await call('private.agent_notify_begin', ['sms', 'urgent', 'Stuck', 'Stuck.', `it:${run}:alert:3`, null, null])).duplicate, true, 'and it is not sent again');
  await assert.rejects(call('private.agent_notify_finish', [delivered.id, 'sent', null]), refused('P0002'), 'a settled notification is final');
  await assert.rejects(call('private.agent_notify_finish', [randomUUID(), 'sent', null]), refused('P0002'));
  await assert.rejects(call('private.agent_notify_finish', [first.id, 'delivered', null]), refused('22023'));

  // Where to text the owner: exactly one verified administrator, otherwise nobody.
  assert.deepEqual(await call('private.owner_contact'), { phone: '+12025550701' });
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [secondAdmin]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550703',now())", [secondAdmin]);
  assert.equal(await call('private.owner_contact'), null, 'two administrators means no one is guessed');
  await admin.query('update private.sms_identities set revoked_at = now() where user_id = $1', [secondAdmin]);
  assert.deepEqual(await call('private.owner_contact'), { phone: '+12025550701' }, 'a revoked identity does not count');
  await admin.query('update private.sms_identities set verified_at = null where user_id = $1', [owner]);
  assert.equal(await call('private.owner_contact'), null, 'an unverified number is never texted');
  await admin.query('update private.sms_identities set verified_at = now() where user_id = $1', [owner]);

  // The owner's history: runs, tasks, actions, notifications, and the audit log.
  const runs = await ownerCall('hub.list_agent_activity', ['runs', null, 0, 50]);
  assert.ok(runs.total >= 3 && runs.items.length === runs.total);
  assert.ok(runs.items.every((entry, index, all) => index === 0 || all[index - 1].startedAt >= entry.startedAt), 'newest first');
  assert.deepEqual((await ownerCall('hub.list_agent_activity', ['runs', 'support_concierge', 0, 1])).items.map(entry => entry.agentKey), ['support_concierge']);
  assert.equal((await ownerCall('hub.list_agent_activity', ['runs', null, 0, 1])).items.length, 1);
  assert.equal((await ownerCall('hub.list_agent_activity', ['tasks', 'platform_engineer', 0, 5])).items[0].agentKey, 'platform_engineer');
  assert.ok((await ownerCall('hub.list_agent_activity', ['notifications', null, 0, 5])).total >= 3);
  assert.ok((await api.rpc('list_agent_activity', { p_kind: 'actions', p_agent_key: null, p_offset: 0, p_limit: 5 }, ownerToken)).items.length > 0, 'the gateway serves the activity pages');
  for (const bad of [['logs', null, 0, 5], ['runs', null, -1, 5], ['runs', null, 0, 51], ['runs', null, 0, 0], ['runs', 'Not A Key', 0, 5], ['runs', null, 10001, 5]]) {
    await assert.rejects(ownerCall('hub.list_agent_activity', bad), refused('22023'));
  }
  const audit = await ownerCall('hub.list_audit_events', ['agent.', 0, 50]);
  assert.ok(audit.items.length > 5 && audit.items.every(event => event.action.startsWith('agent.')));
  assert.ok(audit.items.every((event, index, all) => index === 0 || all[index - 1].id > event.id), 'newest first');
  assert.ok(audit.items.some(event => event.actorName === 'Agents integration owner'), 'owner actions name the owner');
  assert.ok(audit.items.some(event => event.actorName === 'CareMetric AI Assistant'), 'server actions name the AI assistant');
  assert.deepEqual((await ownerCall('hub.list_audit_events', ['agent.action.', 0, 50])).items.map(event => event.action).filter(name => !name.startsWith('agent.action.')), []);
  assert.equal((await api.rpc('list_audit_events', { p_action_prefix: 'agent.status', p_offset: 0, p_limit: 5 }, ownerToken)).items[0].action, 'agent.status');
  await assert.rejects(ownerCall('hub.list_audit_events', ['Agent;drop', 0, 5]), refused('22023'));
  await assert.rejects(ownerCall('hub.list_audit_events', [null, 0, 99]), refused('22023'));
  await assert.rejects(ownerCall('hub.list_agent_activity', ['runs', null, 0, 5], otherToken), refused('28000'));

  // The deployment gate re-runs cleanly, and refuses to declare the feature once the boundary drifts.
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query(contractMigration);
    await client.query('rollback');
    for (const [sql, message] of [
      ['grant select on private.agent_tasks to hub_app_server', /must remain closed/],
      ['grant update (status) on private.agents to authenticated', /must remain closed/],
      ['alter table private.agent_runs disable row level security', /row level security/],
      ['grant execute on function private.agent_task_claim(integer,integer) to authenticated', /executable by the Hub server only/],
      ['revoke execute on function private.agent_task_claim(integer,integer) from hub_app_server', /executable by the Hub server only/],
      ['alter function private.agent_notify_begin(text,text,text,text,text,text,uuid) security invoker', /security definer/],
      ['grant execute on function private.agent_task_json(uuid) to hub_app_server', /internal to the operations/],
      ['revoke execute on function hub.get_agent_team() from authenticated', /administrator session/],
      ['create or replace function hub.list_audit_events(p_action_prefix text default null, p_offset integer default 0, p_limit integer default 25) returns jsonb language sql security definer set search_path=\'\' as $$ select \'{}\'::jsonb $$', /administrator session/],
      ['create or replace function hub.decide_agent_action(p_action_id uuid, p_decision text, p_note text default null) returns jsonb language sql security definer set search_path=\'\' as $$ select \'{}\'::jsonb $$', /command session/],
      ['grant execute on function hub.cancel_agent_task(uuid) to anon', /command session/],
    ]) {
      await client.query('begin');
      try {
        await client.query(sql);
        await assert.rejects(client.query(contractMigration), rejection => rejection.code === '55000' && message.test(rejection.message), sql);
      } finally { await client.query('rollback'); }
    }
  } finally { client.release(); }
  assertBackendContract(await api.rpc('get_backend_contract', {}));

  console.log('AI team control plane: the closed boundary, owner changes and reads, enqueue, claim, lease recovery, retry, session tasks, schedules, budget, actions and approvals, notifications, the owner contact and the deployment gate all behave through hub_app_server and real sessions.');
} finally {
  await admin.query("delete from private.audit_events where action like 'agent.%' or actor_id in ($1,$2,$3)", [owner, other, secondAdmin]);
  await admin.query('delete from private.agent_actions');
  await admin.query('delete from private.agent_runs');
  await admin.query('delete from private.owner_notifications');
  await admin.query('delete from private.agent_tasks');
  for (const seed of seedAgents) await admin.query('update private.agents set status=$2, autonomy=$3, daily_budget_cents=$4, updated_at=$5 where key=$1', [seed.key, seed.status, seed.autonomy, seed.daily_budget_cents, seed.updated_at]);
  for (const seed of seedSchedules) await admin.query('update private.agent_schedules set next_run_at=$2, last_run_at=$3, last_task_id=$4, enabled=$5 where id=$1', [seed.id, seed.next_run_at, seed.last_run_at, seed.last_task_id, seed.enabled]);
  if (setAside.length) await admin.query('update private.staff_permissions set revoked_at = null where id = any($1::uuid[])', [setAside]);
  await admin.query('delete from private.sms_sessions where user_id in ($1,$2,$3)', [owner, other, secondAdmin]);
  await admin.query('delete from private.sms_identities where user_id in ($1,$2,$3)', [owner, other, secondAdmin]);
  await admin.query('delete from private.staff_permissions where user_id in ($1,$2)', [owner, secondAdmin]);
  await admin.query('delete from auth.users where id in ($1,$2,$3)', [owner, other, secondAdmin]);
  await pool.end();
  await admin.end();
}
