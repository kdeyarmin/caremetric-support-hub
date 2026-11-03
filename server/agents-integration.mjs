// The AI team control plane through the actual Hub server role, on disposable local
// fixtures only. The server pool logs in as hub_app_server exactly like production: it
// reaches the agent tables only through the private.agent_* operations, and the owner
// reads and decides through hub.* operations behind real SMS sessions. No model is called.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, HttpError, withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { assertBackendContract } from '../src/lib/backendContract.ts';
import { agentTeam } from './agents/index.mjs';
import { outboundHosts as seoOutboundHosts } from './agents/seo/sites.mjs';
// The Team screen's own schemas: what the real database returns must be exactly what the screen accepts.
import { activitySchemas, agentSchema, auditSchema, decisionSchema, overviewSchema, taskResultSchema } from '../src/admin/teamProtocol.ts';

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
const probesMigration = await readFile(new URL('../supabase/migrations/20261102130100_agent_probes_contract.sql', import.meta.url), 'utf8');
const briefMigration = await readFile(new URL('../supabase/migrations/20261102140100_agent_brief_contract.sql', import.meta.url), 'utf8');
const seoMigration = await readFile(new URL('../supabase/migrations/20261102150100_agent_seo_contract.sql', import.meta.url), 'utf8');

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
const team = async () => overviewSchema.shape.team.parse(await ownerCall('hub.get_agent_team'));
const agentRow = async key => (await team()).agents.find(agent => agent.key === key);
const setStatus = async (key, status) => agentSchema.parse(await ownerCall('hub.set_agent_status', [key, status, (await agentRow(key)).updatedAt]));
const setAutonomy = async (key, autonomy) => agentSchema.parse(await ownerCall('hub.set_agent_autonomy', [key, autonomy, (await agentRow(key)).updatedAt]));
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
  assert.ok((await api.rpc('get_backend_contract', {})).features.includes('platform.agents.probes.v1'));
  assert.ok((await api.rpc('get_backend_contract', {})).features.includes('platform.agents.brief.v1'));
  assert.ok((await api.rpc('get_backend_contract', {})).features.includes('platform.agents.seo.v1'));
  assert.ok((await api.rpc('get_backend_contract', {})).features.includes('platform.agents.concierge.v1'));
  assert.ok((await api.rpc('get_backend_contract', {})).features.includes('platform.agents.accounts.v1'));
  assert.ok((await api.rpc('get_backend_contract', {})).features.includes('platform.agents.growth.v1'));
  assert.ok((await api.rpc('get_backend_contract', {})).features.includes('platform.agents.lifecycle.v1'));
  assert.ok((await api.rpc('get_backend_contract', {})).features.includes('platform.agents.content.v1'));

  // The owner sees the seeded agents, paused.
  let view = await team();
  assert.deepEqual(view.agents.map(agent => agent.key), ['account_manager', 'chief_of_staff', 'content_marketer', 'growth_manager', 'marketing_manager', 'platform_engineer', 'seo_analyst', 'support_concierge']);
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
  assert.equal((await ownerCall('hub.get_agent_team', [], staleToken)).agents.length, 8);
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
  // The on-call agent's lead form check (platform.agents.growth.v1) is exercised in agents-growth-integration.mjs: keep it out of the way.
  await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day' where task_kind = 'probe.forms'");
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
  await admin.query("update private.owner_notifications set created_at = now() - interval '16 minutes', attempted_at = now() - interval '16 minutes' where id = $1", [stuck.id]);
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

  {
    // The server side, through the real store: the scheduler runs only what it can handle, a handler's alert reaches the
    // owner once, retries back off, an approval is carried out exactly once, and the owner's routes work in a real session.
    await clearWork();
    for (const [key, status] of [['platform_engineer', 'active'], ['support_concierge', 'active'], ['chief_of_staff', 'active']]) {
      if ((await agentRow(key)).status !== status) await setStatus(key, status);
    }
    await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day', enabled = true");
    const sent = { sms: [], email: [] };
    const logs = [];
    const handled = [];
    let probeFails = true;
    const team2 = agentTeam({
      pool, enabled: true, ownerEmail: 'owner@example.test', publicOrigin: 'https://hub.test', log: line => logs.push(line),
      sms: { configured: true, send: async (to, body) => { sent.sms.push([to, body]); return { delivery: 'sent', id: 'SM' + '0'.repeat(32) }; } },
      email: { configured: true, send: async (to, subject, content) => { sent.email.push([to, subject, content]); return { delivery: 'sent', id: 'fixture-message' }; } },
      handlers: ({ store, notifier }) => ({
        'probe.sweep': async current => {
          handled.push(current.id);
          if (probeFails) { probeFails = false; throw Object.assign(new Error('The probe could not reach a product.'), { transient: true }); }
          await notifier.send({ severity: 'urgent', subject: 'Hub is down', body: 'The Hub probe failed twice.', dedupeKey: `it:${run}:team:down`, agentKey: current.agentKey, taskId: current.id });
          return { result: { checked: 1 } };
        },
        'probe.incident': async current => {
          await store.proposeAction({ taskId: current.id, kind: 'incident.open', targetKind: 'probe_target', targetId: 'hub', preview: 'Hub health probe failed twice.', input: { target: 'hub' } });
          return { status: 'awaiting_approval' };
        },
        'concierge.communication': async current => {
          const proposal = await store.proposeAction({ taskId: current.id, kind: 'communication.reply', targetKind: 'communication', targetId: current.payload.reference, preview: 'Here is how to export by month.', input: { body: 'Here is how to export by month.' } });
          return { status: 'awaiting_approval', result: { proposed: proposal.id } };
        },
      }),
      executors: () => ({ 'communication.reply': async execution => { executed.push(execution); return { delivery: 'sent' }; } }),
    });
    const executed = [];
    const settle = async (id, status, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if ((await task(id)).status === status) return task(id); await new Promise(resolve => setTimeout(resolve, 25)); }
      assert.fail(`task ${id} never reached ${status}`);
    };
    assert.deepEqual(team2.scheduler.kinds().sort(), ['brief.daily', 'concierge.communication', 'probe.incident', 'probe.recovery', 'probe.sweep', 'seo.weekly'], 'the shipped handlers are registered beside the caller\'s');

    // A due schedule becomes a task and runs; a schedule for a kind with no handler stays due and untouched.
    // A firing's key carries its scheduled instant to the second, so give this firing an instant no earlier section used.
    await admin.query("update private.agent_schedules set next_run_at = now() - interval '9 minutes' where task_kind in ('probe.sweep', 'concierge.sweep')");
    const unhandledDue = await row("select next_run_at from private.agent_schedules where task_kind = 'concierge.sweep'");
    const tickStarted = (await row('select clock_timestamp() as at')).at;
    let tick = await team2.tick();
    assert.deepEqual([tick.skipped, tick.fired, tick.claimed], [false, 1, 1], `only the handled kind fires (${logs.join(' | ') || 'no log lines'})`);
    assert.deepEqual((await row("select next_run_at from private.agent_schedules where task_kind = 'concierge.sweep'")).next_run_at, unhandledDue.next_run_at, 'a kind with no handler is left due');
    assert.equal(Number((await row("select count(*) from private.agent_tasks where kind = 'concierge.sweep' and created_at >= $1", [tickStarted])).count), 0, 'and no task is created for it');

    // The first probe fails transiently: the task waits out a backoff and keeps its place, with no alert yet.
    const probeTask = (await rows("select * from private.agent_tasks where kind = 'probe.sweep' order by created_at desc limit 1"))[0];
    assert.deepEqual([probeTask.status, probeTask.attempts, probeTask.last_error_code], ['queued', 1, 'provider_outage']);
    const waitMinutes = (await row('select extract(epoch from due_at - now()) / 60 as minutes from private.agent_tasks where id = $1', [probeTask.id])).minutes;
    assert.ok(waitMinutes > 4 && waitMinutes <= 5, 'the first retry waits five minutes');
    assert.deepEqual([sent.sms.length, sent.email.length], [0, 0]);
    const failure = JSON.parse(logs.find(line => JSON.parse(line).event === 'hub_agent_task_error'));
    assert.deepEqual([failure.code, failure.transient, failure.attempts], ['provider_outage', true, 1]);
    assert.ok(!logs.join().includes('could not reach a product'), 'a log line never carries the error message');
    tick = await team2.tick();
    assert.deepEqual([tick.fired, tick.claimed], [0, 0], 'a backed-off task is not claimed early');

    // When the retry is due the probe succeeds and the owner is told once, by text and by email.
    await admin.query("update private.agent_tasks set due_at = now() - interval '1 second' where id = $1", [probeTask.id]);
    tick = await team2.tick();
    assert.equal(tick.claimed, 1);
    const done = await task(probeTask.id);
    assert.deepEqual([done.status, done.attempts, done.result], ['done', 2, { checked: 1 }]);
    assert.deepEqual(sent.sms, [['+12025550701', 'CareMetric: Hub is down. The Hub probe failed twice.']]);
    assert.equal(sent.email.length, 1);
    assert.deepEqual([sent.email[0][0], sent.email[0][1]], ['owner@example.test', 'Hub is down']);
    assert.match(sent.email[0][2].html, /Needs your attention/);
    assert.deepEqual((await rows('select channel, status, agent_key from private.owner_notifications where dedupe_key = $1 order by channel', [`it:${run}:team:down`])).map(entry => [entry.channel, entry.status, entry.agent_key]),
      [['email', 'sent', 'platform_engineer'], ['sms', 'sent', 'platform_engineer']]);
    assert.deepEqual((await team2.notifier.send({ severity: 'urgent', subject: 'Hub is down', body: 'The Hub probe failed twice.', dedupeKey: `it:${run}:team:down` })).map(entry => entry.delivery), ['duplicate', 'duplicate']);
    assert.deepEqual([sent.sms.length, sent.email.length], [1, 1], 'a repeated alert is never sent twice');

    // An agent on "act" is trusted with incident records: the same tick that runs the task carries them out.
    const incident = await enqueue('platform_engineer', 'probe.incident', `it:${run}:server:incident`);
    tick = await team2.tick();
    assert.deepEqual([tick.claimed, tick.executedActions], [1, 1], 'an auto-approved action is drained in the same tick');
    const incidentAction = (await rows("select * from private.agent_actions where task_id = $1", [incident]))[0];
    assert.deepEqual([incidentAction.status, incidentAction.result, (await task(incident)).status], ['executed', { recorded: true }, 'done']);

    // The owner approves a proposal; it is carried out through the executor exactly once, whatever happens next.
    const draft = await enqueue('support_concierge', 'concierge.communication', `it:${run}:server:concierge`, { payload: { reference: 'CM-2001' } });
    await team2.tick();
    const proposed = (await rows('select * from private.agent_actions where task_id = $1', [draft]))[0];
    assert.deepEqual([proposed.status, (await task(draft)).status], ['proposed', 'awaiting_approval']);
    const overview = overviewSchema.parse(await team2.admin.overview(ownerToken, {}));
    assert.deepEqual(overview.services, { enabled: true, handlers: ['brief.daily', 'concierge.communication', 'probe.incident', 'probe.recovery', 'probe.sweep', 'seo.weekly'], sms: true, email: true, ownerEmail: true, ai: false, customerTextToAi: false });
    assert.equal(overview.team.approvals[0].id, proposed.id);
    const decision = decisionSchema.parse(await team2.admin.decide(ownerToken, { actionId: proposed.id, decision: 'approve', note: 'Send it' }));
    assert.deepEqual(decision, { id: proposed.id, kind: 'communication.reply', status: 'executed', decided: true });
    assert.deepEqual(executed.map(entry => [entry.requestKey, entry.input, entry.autoApproved]), [[proposed.request_key, { body: 'Here is how to export by month.' }, false]]);
    assert.deepEqual([(await action(proposed.id)).status, (await action(proposed.id)).result, (await task(draft)).status], ['executed', { delivery: 'sent' }, 'done']);
    assert.equal((await team2.admin.decide(ownerToken, { actionId: proposed.id, decision: 'approve' })).decided, false);
    assert.equal(executed.length, 1, 'deciding again carries nothing out again');
    // A rejection, and an action no executor knows, are recorded rather than lost.
    const declined = await enqueue('support_concierge', 'concierge.communication', `it:${run}:server:declined`, { payload: { reference: 'CM-2002' } });
    await team2.tick();
    const declinedAction = (await rows('select * from private.agent_actions where task_id = $1', [declined]))[0];
    assert.equal((await team2.admin.decide(ownerToken, { actionId: declinedAction.id, decision: 'reject' })).status, 'rejected');
    assert.equal(executed.length, 1, 'a rejection is never carried out');
    await admin.query("update private.agent_actions set kind = 'import.run' where id = $1", [(await rows('select id from private.agent_actions where task_id = $1', [incident]))[0].id]);
    const orphan = await enqueue('platform_engineer', 'probe.incident', `it:${run}:server:orphan`);
    await team2.tick();
    await admin.query("update private.agent_actions set kind = 'import.run' where task_id = $1", [orphan]);
    const orphanAction = (await rows('select id, status from private.agent_actions where task_id = $1', [orphan]))[0];
    assert.equal(orphanAction.status, 'executed', 'the incident record was auto-approved and drained before the kind was changed');

    // The owner's routes: changes need the current version, and map the database's reviewed errors to statuses.
    const status = await agentRow('platform_engineer');
    await assert.rejects(team2.admin.status(ownerToken, { key: 'platform_engineer', status: 'paused', expectedUpdatedAt: '2020-01-01T00:00:00.000000+00:00' }), error => error.status === 409 && /changed/.test(error.message));
    assert.equal((await team2.admin.status(ownerToken, { key: 'platform_engineer', status: 'paused', expectedUpdatedAt: status.updatedAt })).status, 'paused');
    await assert.rejects(team2.admin.run(ownerToken, { agentKey: 'platform_engineer', taskKind: 'probe.sweep' }), error => error.status === 409 && /Resume this agent/.test(error.message));
    await team2.admin.status(ownerToken, { key: 'platform_engineer', status: 'active', expectedUpdatedAt: (await agentRow('platform_engineer')).updatedAt });
    probeFails = false;
    const requested = taskResultSchema.parse(await team2.admin.run(ownerToken, { agentKey: 'platform_engineer', taskKind: 'probe.sweep' }));
    assert.equal((await settle(requested.id, 'done')).source_kind, 'owner', '"Run now" starts without waiting for the next tick');
    await assert.rejects(team2.admin.overview(otherToken, {}), error => error.status === 401, 'a session without administrator rights is refused');
    await assert.rejects(team2.admin.cancel(ownerToken, { taskId: randomUUID() }), error => error.status === 404);
    await assert.rejects(team2.admin.status(staleToken, { key: 'platform_engineer', status: 'paused', expectedUpdatedAt: (await agentRow('platform_engineer')).updatedAt }), error => error.status === 401);
    assert.ok(!logs.join().includes('Here is how to export'), 'a reply draft never reaches a log line');
    await clearWork();

  }

  // The owner's history: runs, tasks, actions, notifications, and the audit log.
  for (const kind of ['runs', 'tasks', 'actions', 'notifications']) {
    const page = activitySchemas[kind].parse(await ownerCall('hub.list_agent_activity', [kind, null, 0, 50]));
    assert.ok(page.total > 0, `the ${kind} history has rows for the screen to show`);
  }
  assert.ok(auditSchema.parse(await ownerCall('hub.list_audit_events', [null, 0, 50])).items.length > 0);
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

  {
    // The on-call agent end to end: the real store and scheduler, the handlers the server ships with, and a scripted network.
    await clearWork();
    await admin.query('delete from private.agent_probe_state');
    for (const [key, status] of [['platform_engineer', 'active'], ['support_concierge', 'paused'], ['chief_of_staff', 'paused']]) {
      if ((await agentRow(key)).status !== status) await setStatus(key, status);
    }
    if ((await agentRow('platform_engineer')).autonomy !== 'act') await setAutonomy('platform_engineer', 'act');
    await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day', enabled = true");
    const sent = { sms: [], email: [] };
    const probeLogs = [];
    const network = new Map();
    const fetchImpl = async url => {
      const behaviour = network.get(url) ?? 200;
      if (behaviour === 'down') throw new TypeError('fetch failed');
      return new Response('ok', { status: behaviour });
    };
    const probes = agentTeam({
      pool, enabled: true, ownerEmail: 'owner@example.test', publicOrigin: 'https://hub.test', fetchImpl, log: line => probeLogs.push(line),
      sms: { configured: true, send: async (to, body) => { sent.sms.push([to, body]); return { delivery: 'sent', id: 'SM' + '1'.repeat(32) }; } },
      email: { configured: true, send: async (to, subject, content) => { sent.email.push([to, subject, content]); return { delivery: 'sent', id: 'fixture-probe-message' }; } },
    });
    assert.deepEqual(probes.scheduler.kinds(), ['brief.daily', 'probe.incident', 'probe.recovery', 'probe.sweep', 'seo.weekly']);
    const carebase = 'https://cmcarebase.com/health';
    let sweeps = 0;
    const sweep = async () => {
      const queued = await enqueue('platform_engineer', 'probe.sweep', `it:${run}:on-call:${sweeps++}`);
      assert.ok(queued, 'a new sweep is queued');
      const result = await probes.tick();
      if (result.claimed !== 1) assert.fail(`the sweep is claimed and run (${JSON.stringify(result)} ${probeLogs.join(' | ')})`);
      return result;
    };
    const state = key => row('select * from private.agent_probe_state where target_key = $1', [key]);
    const count = async sql => Number((await row(sql)).count);

    // Healthy: every product is recorded as up and nobody is told anything.
    let tick = await sweep();
    assert.equal(tick.claimed, 1);
    assert.deepEqual((await rows('select target_key, state, consecutive_failures from private.agent_probe_state order by target_key')).map(entry => [entry.target_key, entry.state, entry.consecutive_failures]),
      [['advisors', 'up', 0], ['carebase', 'up', 0], ['hub', 'up', 0], ['intel', 'up', 0]]);
    assert.deepEqual([sent.sms.length, sent.email.length], [0, 0]);
    assert.equal(await count("select count(*) from private.agent_tasks where request_key like 'probe.incident:%' or request_key like 'probe.recovery:%'"), 0);

    // One failed check is a blip: the state stays up, nobody is told, and the sweep's run shows what it saw.
    network.set(carebase, 503);
    await sweep();
    let current = await state('carebase');
    assert.deepEqual([current.state, current.consecutive_failures, current.last_status_code, current.last_failure], ['up', 1, 503, 'status']);
    assert.equal(await count("select count(*) from private.agent_tasks where request_key like 'probe.incident:%'"), 0);
    const blip = await row("select * from private.agent_runs where agent_key = 'platform_engineer' and summary like '%CareBase returned 503%' order by started_at desc limit 1");
    assert.deepEqual([blip.model, blip.outcome, Number(blip.cost_cents), blip.error_code], ['none', 'completed', 0, null]);
    assert.deepEqual([sent.sms.length, sent.email.length], [0, 0]);

    // The second failure in a row opens one incident. The next tick tells the owner by text and email and records it.
    await sweep();
    current = await state('carebase');
    assert.deepEqual([current.state, current.incident_seq], ['down', 1]);
    const incidentTask = await row("select * from private.agent_tasks where request_key = 'probe.incident:carebase:1'");
    assert.deepEqual([incidentTask.request_key, incidentTask.priority, incidentTask.source_kind, incidentTask.agent_key], ['probe.incident:carebase:1', 1, 'probe', 'platform_engineer']);
    assert.equal(incidentTask.payload.flapping, false);
    tick = await probes.tick();
    assert.deepEqual([tick.claimed, tick.executedActions], [1, 1]);
    assert.deepEqual(sent.sms, [['+12025550701', 'CareMetric: CareBase is down. CareBase has not passed 2 health checks in a row. The last check answered with status 503.']]);
    assert.equal(sent.email[0][1], 'CareBase is down');
    assert.match(sent.email[0][2].text, /Nothing has been restarted or changed/);
    const opened = await row("select * from private.agent_actions where kind = 'incident.open' and target_id = 'carebase:1'");
    assert.deepEqual([opened.status, opened.target_kind, opened.result], ['executed', 'probe_target', { recorded: true }]);
    assert.equal((await auditFor('agent.action.executed', opened.id)).length, 1);
    assert.equal((await task(incidentTask.id)).status, 'done');

    // Still down: no second incident and no second alert, however long it lasts.
    await sweep();
    await probes.tick();
    assert.deepEqual([await count("select count(*) from private.agent_tasks where request_key like 'probe.incident:carebase:%'"), sent.sms.length, sent.email.length], [1, 1, 1]);
    assert.equal((await state('carebase')).consecutive_failures, 3);

    // The first healthy check closes it: one recovery note by email only, and the record is closed.
    network.delete(carebase);
    await sweep();
    current = await state('carebase');
    assert.deepEqual([current.state, current.consecutive_failures, current.failing_since], ['up', 0, null]);
    tick = await probes.tick();
    assert.deepEqual([tick.claimed, tick.executedActions], [1, 1]);
    assert.equal(sent.sms.length, 1, 'a recovery never texts');
    assert.equal(sent.email[1][1], 'CareBase is answering again');
    assert.match(sent.email[1][2].text, /about \d+ minutes? earlier/);
    assert.equal((await row("select status from private.agent_actions where kind = 'incident.resolve' and target_id = 'carebase:1'")).status, 'executed');

    // A relapse within half an hour is flagged and sent by email only, so it cannot wake the owner twice.
    network.set(carebase, 500);
    await sweep();
    await sweep();
    assert.equal((await state('carebase')).incident_seq, 2);
    assert.equal((await row("select payload from private.agent_tasks where request_key = 'probe.incident:carebase:2'")).payload.flapping, true);
    await probes.tick();
    assert.equal(sent.sms.length, 1, 'a relapse does not text');
    network.delete(carebase);
    await sweep();
    await probes.tick();
    assert.deepEqual(sent.email.map(message => message[1]), ['CareBase is down', 'CareBase is answering again', 'CareBase is unstable again', 'CareBase is answering again']);

    // Two sweeps reporting at the same moment (a restart, a second replica) open one incident, not two.
    const record = (target, status, failure) => call('private.agent_probe_record', [target, false, status, 20, failure, 2, 'platform_engineer']);
    const both = await Promise.all([record('advisors', 500, 'status'), record('advisors', 500, 'status')]);
    assert.deepEqual(both.map(result => result.transition).sort(), ['down', 'none']);
    assert.equal(await count("select count(*) from private.agent_tasks where request_key like 'probe.incident:advisors:%'"), 1);

    // An observe-only agent still tells the owner about an incident, but proposes no action.
    await setAutonomy('platform_engineer', 'observe');
    tick = await probes.tick();
    assert.deepEqual([tick.claimed, tick.executedActions], [1, 0]);
    assert.equal(sent.sms.length, 2);
    assert.match(sent.sms[1][1], /^CareMetric: Healthcare Advisors is down\./);
    assert.equal(await count("select count(*) from private.agent_actions where target_id = 'advisors:1'"), 0, 'an observe-only agent proposes nothing');
    assert.equal((await row("select result from private.agent_tasks where request_key = 'probe.incident:advisors:1'")).result.action, 'observe_only');
    await setAutonomy('platform_engineer', 'act');

    // An alert that waited more than an hour for the agent goes by email only, and says it is late.
    await record('intel', 0, 'timeout');
    await record('intel', 0, 'timeout');
    await admin.query("update private.agent_tasks set payload = jsonb_set(payload, '{since}', to_jsonb($1::text)) where request_key = 'probe.incident:intel:1'", [new Date(Date.now() - 3 * 3_600_000).toISOString()]);
    await probes.tick();
    assert.equal(sent.sms.length, 2, 'a late alert never texts');
    assert.equal(sent.email.at(-1)[1], 'CareMetric Intel was down');
    assert.match(sent.email.at(-1)[2].text, /reached you late/);

    // A paused agent hands out nothing, so a queued alert waits for the owner to resume it.
    await record('hub', 0, 'timeout');
    await record('hub', 0, 'timeout');
    await setStatus('platform_engineer', 'paused');
    tick = await probes.tick();
    assert.equal(tick.claimed, 0);
    assert.equal((await row("select status from private.agent_tasks where request_key = 'probe.incident:hub:1'")).status, 'queued');
    await setStatus('platform_engineer', 'active');
    tick = await probes.tick();
    assert.equal(tick.claimed, 1);
    assert.equal(sent.sms.length, 3);

    // The database accepts only a fixed vocabulary, never page content, and only from the Hub server.
    for (const [args, code] of [
      [['Bad Key', true, 200, 10, null, 2, 'platform_engineer'], '22023'],
      [['hub', true, 200, 10, 'status', 2, 'platform_engineer'], '22023'],
      [['hub', false, 503, 10, null, 2, 'platform_engineer'], '22023'],
      [['hub', false, 503, 10, 'The page said <html>', 2, 'platform_engineer'], '22023'],
      [['hub', false, 1000, 10, 'status', 2, 'platform_engineer'], '22023'],
      [['hub', false, 503, -1, 'status', 2, 'platform_engineer'], '22023'],
      [['hub', false, 503, 10, 'status', 0, 'platform_engineer'], '22023'],
      [['hub', false, 503, 10, 'status', 11, 'platform_engineer'], '22023'],
      [['hub', false, 503, 10, 'status', 2, 'no_such_agent'], 'P0002'],
    ]) await assert.rejects(call('private.agent_probe_record', args), refused(code), JSON.stringify(args));
    await assert.rejects(admin.query('select private.agent_probe_record($1, $2, $3, $4)', ['hub', true, 200, 1]), refused('42501', /Application server required/));
    await assert.rejects(pool.query('select count(*) from private.agent_probe_state'), refused('42501'));

    // The owner's screen accepts what the on-call agent leaves behind.
    for (const kind of ['runs', 'tasks', 'actions', 'notifications']) {
      const page = activitySchemas[kind].parse(await ownerCall('hub.list_agent_activity', [kind, 'platform_engineer', 0, 25]));
      assert.ok(page.items.length > 0, `the owner sees the on-call agent's ${kind}`);
    }
    await team();
    await clearWork();
    await admin.query('delete from private.agent_probe_state');
  }

  {
    // The Chief of Staff's morning brief: the facts it reads, the email it writes, and that it is sent once a day.
    await clearWork();
    await admin.query('delete from private.agent_probe_state');
    await admin.query('delete from private.owner_notifications');
    const before = await call('private.agent_brief_facts');
    assert.deepEqual(Object.keys(before).sort(), ['agents', 'approvals', 'awaitingSession', 'billing', 'failedTasks', 'generatedAt', 'incidents', 'todayStart', 'undeliveredAlerts', 'yesterday', 'yesterdayStart']);
    assert.equal(before.approvals.count, 0);
    assert.deepEqual([before.awaitingSession, before.incidents.length, before.undeliveredAlerts], [0, 0, 0]);
    await assert.rejects(admin.query('select private.agent_brief_facts()'), refused('42501', /Application server required/));

    // The previous Eastern day is a whole day, midnight to midnight, whatever the clocks did.
    const span = (new Date(before.todayStart) - new Date(before.yesterdayStart)) / 3_600_000;
    assert.ok([23, 24, 25].includes(span), `yesterday is one Eastern day (${span} hours)`);
    assert.equal((await row("select (($1::timestamptz at time zone 'America/New_York')::time)::text as local", [before.yesterdayStart])).local, '00:00:00');

    // Fixtures: work waiting for the owner, an incident, failures, alerts that went nowhere, yesterday's activity and subscriptions.
    const yesterday = new Date(before.yesterdayStart).getTime() + 10 * 3_600_000;
    const at = offsetMs => new Date(yesterday + offsetMs).toISOString();
    await admin.query(`insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, status, created_at)
      values ('support_concierge', 'communication.reply', 'communication', 'CM-BRIEF-1', 'A private customer sentence', 'proposed', now() - interval '3 days'),
             ('support_concierge', 'communication.note', 'communication', 'CM-BRIEF-2', 'Another private sentence', 'proposed', now() - interval '1 hour')`);
    for (const index of [1, 2]) {
      await admin.query("insert into private.agent_tasks (agent_key, kind, request_key, requires_session, status) values ('support_concierge', 'import.advisors', $1, true, 'awaiting_session')", [`it:${run}:brief:wait:${index}`]);
    }
    // One failure today (inside the last 24 hours, outside yesterday) and one more than a day old (before yesterday began), at any hour.
    await admin.query("insert into private.agent_tasks (agent_key, kind, request_key, status, finished_at) values ('chief_of_staff', 'brief.daily', $1, 'failed', now()), ('chief_of_staff', 'brief.daily', $2, 'failed', $3)",
      [`it:${run}:brief:failed:new`, `it:${run}:brief:failed:old`, new Date(new Date(before.yesterdayStart).getTime() - 2 * 3_600_000).toISOString()]);
    await call('private.agent_probe_record', ['carebase', false, 503, 10, 'status', 2, 'platform_engineer']);
    await call('private.agent_probe_record', ['carebase', false, 503, 10, 'status', 2, 'platform_engineer']);
    await admin.query(`insert into private.owner_notifications (dedupe_key, channel, severity, subject, body, status) values
      ($1, 'sms', 'urgent', 'Lost', 'Lost', 'suppressed'), ($1, 'email', 'urgent', 'Lost', 'Lost', 'failed'),
      ($2, 'sms', 'urgent', 'Reached', 'Reached', 'suppressed'), ($2, 'email', 'urgent', 'Reached', 'Reached', 'sent'),
      ($3, 'email', 'info', 'Not urgent', 'Not urgent', 'failed')`, [`it:${run}:brief:lost`, `it:${run}:brief:reached`, `it:${run}:brief:info`]);
    // Yesterday's activity: two runs (one stopped at its budget), tasks, and actions carried out.
    const [doneTask] = (await admin.query("insert into private.agent_tasks (agent_key, kind, request_key, status, finished_at) values ('platform_engineer', 'probe.sweep', $1, 'done', $2), ('platform_engineer', 'probe.sweep', $3, 'done', $2), ('platform_engineer', 'probe.sweep', $4, 'done', $2), ('platform_engineer', 'probe.sweep', $5, 'failed', $2), ('platform_engineer', 'probe.sweep', $6, 'done', now()) returning id",
      [`it:${run}:brief:d1`, at(0), `it:${run}:brief:d2`, `it:${run}:brief:d3`, `it:${run}:brief:f1`, `it:${run}:brief:today`])).rows;
    await admin.query(`insert into private.agent_runs (task_id, agent_key, model, prompt_version, started_at, finished_at, outcome, cost_cents) values
      ($1, 'platform_engineer', 'none', 'probe.1', $2, $2, 'completed', 12.5),
      ($1, 'support_concierge', 'claude-sonnet-5-5', 'v1', $2, $2, 'budget_exhausted', 40),
      ($1, 'platform_engineer', 'none', 'probe.1', now(), now(), 'completed', 99)`, [doneTask.id, at(0)]);
    await admin.query(`insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, status, executed_at) values
      ('platform_engineer', 'incident.open', 'probe_target', 'carebase:7', 'Opened', 'executed', $1),
      ('platform_engineer', 'incident.resolve', 'probe_target', 'carebase:7', 'Closed', 'executed', $1),
      ('support_concierge', 'communication.note', 'communication', 'CM-BRIEF-3', 'Noted', 'executed', $1),
      ('support_concierge', 'communication.note', 'communication', 'CM-BRIEF-4', 'Noted today', 'executed', now())`, [at(3_600_000)]);
    // Incidents are counted from the probe tasks created when they began and closed (an observe-only agent records no actions), by the day of that transition.
    await admin.query(`insert into private.agent_tasks (agent_key, kind, request_key, status, source_kind, created_at) values
      ('platform_engineer', 'probe.incident', $1, 'cancelled', 'probe', $4), ('platform_engineer', 'probe.recovery', $2, 'cancelled', 'probe', $4),
      ('platform_engineer', 'probe.incident', $3, 'cancelled', 'probe', now())`, [`it:${run}:brief:inc:1`, `it:${run}:brief:rec:1`, `it:${run}:brief:inc:today`, at(3_600_000)]);
    const tenant = randomUUID();
    await admin.query("insert into hub.tenants (id, slug, name, status) values ($1, $2, 'Brief fixture tenant', 'active')", [tenant, `brief-${run}`]);
    await admin.query("insert into private.billing_customers (tenant_id, stripe_customer_id, livemode, seen_at) values ($1, $2, true, now())", [tenant, `cus_brief${run}`]);
    for (const [suffix, status, trialEnd, livemode] of [
      ['a', 'past_due', null, true], ['b', 'unpaid', null, true], ['c', 'past_due', null, false], ['d', 'active', null, true],
      ['e', 'trialing', "now() + interval '3 days'", true], ['f', 'trialing', "now() + interval '30 days'", true], ['g', 'trialing', "now() - interval '1 day'", true],
    ]) {
      await admin.query(`insert into private.billing_subscriptions (stripe_subscription_id, tenant_id, stripe_customer_id, status, collection_method, livemode, stripe_created, seen_at, trial_end)
        values ($1, $2, $3, $4, 'charge_automatically', $5, now(), now(), ${trialEnd ?? 'null'})`, [`sub_brief${run}${suffix}`, tenant, `cus_brief${run}`, status, livemode]);
    }

    const facts = await call('private.agent_brief_facts');
    assert.equal(facts.approvals.count, 2);
    assert.ok(Math.abs(Date.now() - new Date(facts.approvals.oldestAt) - 3 * 86_400_000) < 60_000, 'the oldest approval is the three-day-old one');
    // Yesterday's failed fixture is inside the rolling 24 hours only until this time yesterday, so what is expected depends on the hour.
    const yesterdayStillCounts = Date.now() - yesterday < 24 * 3_600_000 ? 1 : 0;
    assert.deepEqual([facts.awaitingSession, facts.failedTasks, facts.undeliveredAlerts], [2, before.failedTasks + 1 + yesterdayStillCounts, 1],
      'failures from the last 24 hours count, older ones do not');
    assert.deepEqual(facts.incidents.map(incident => [incident.target, incident.failures]), [['carebase', 2]]);
    assert.ok(Math.abs(Date.now() - new Date(facts.incidents[0].since)) < 60_000);
    assert.deepEqual({ ...facts.yesterday, spendCents: Number(facts.yesterday.spendCents) },
      { runs: before.yesterday.runs + 2, tasksDone: before.yesterday.tasksDone + 3, tasksFailed: before.yesterday.tasksFailed + 1, actionsExecuted: before.yesterday.actionsExecuted + 3,
        incidentsOpened: before.yesterday.incidentsOpened + 1, incidentsClosed: before.yesterday.incidentsClosed + 1, spendCents: Number(before.yesterday.spendCents) + 52.5 });
    const agentFacts = Object.fromEntries(facts.agents.map(agent => [agent.key, agent]));
    const agentBefore = Object.fromEntries(before.agents.map(agent => [agent.key, agent]));
    assert.deepEqual([agentFacts.support_concierge.hitBudget, Number(agentFacts.support_concierge.spentCents)], [true, Number(agentBefore.support_concierge.spentCents) + 40]);
    assert.deepEqual([agentFacts.platform_engineer.hitBudget, Number(agentFacts.platform_engineer.spentCents)], [agentBefore.platform_engineer.hitBudget, Number(agentBefore.platform_engineer.spentCents) + 12.5]);
    assert.deepEqual(facts.billing, { pastDue: before.billing.pastDue + 2, trialsEnding: before.billing.trialsEnding + 1 }, 'only live subscriptions are counted, and only trials ending within a week');
    assert.doesNotMatch(JSON.stringify(facts), /private customer|Another private|@/, 'the facts hold counts and times, never message text or addresses');

    // The brief itself, through the real scheduler: due at 07:00, written from those facts, emailed once.
    const mail = { sms: [], email: [] };
    const briefTeam = agentTeam({
      pool, enabled: true, ownerEmail: 'owner@example.test', publicOrigin: 'https://hub.test', log: () => {},
      sms: { configured: false, send: async () => { mail.sms.push(true); return { delivery: 'sent', id: 'x' }; } },
      email: { configured: true, send: async (to, subject, content) => { mail.email.push([to, subject, content]); return { delivery: 'sent', id: 'fixture-brief' }; } },
    });
    assert.ok(briefTeam.scheduler.kinds().includes('brief.daily'));
    for (const [key, status] of [['chief_of_staff', 'active'], ['platform_engineer', 'paused'], ['support_concierge', 'paused']]) if ((await agentRow(key)).status !== status) await setStatus(key, status);
    await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day', enabled = true");
    await admin.query("update private.agent_schedules set next_run_at = now() - interval '2 minutes' where task_kind = 'brief.daily'");
    let tick = await briefTeam.tick();
    assert.deepEqual([tick.fired, tick.claimed], [1, 1]);
    assert.equal(mail.email.length, 1);
    assert.deepEqual([mail.email[0][0], mail.sms.length], ['owner@example.test', 0], 'the brief goes by email, never by text');
    assert.match(mail.email[0][1], /^CareMetric brief for \w{3}, \w{3} \d{1,2}: \d+ things need you$/);
    assert.match(mail.email[0][2].text, /Waiting for your approval: 2 \(oldest 3 days\)/);
    assert.match(mail.email[0][2].text, /CareBase is down: since /);
    assert.match(mail.email[0][2].text, /Subscriptions past due: \d+/);
    assert.match(mail.email[0][2].text, /Text alerts are not set up/);
    assert.doesNotMatch(mail.email[0][2].text + mail.email[0][2].html, /private customer|Another private/, 'the brief never quotes a message');
    const delivered = await row("select * from private.owner_notifications where dedupe_key like 'brief:%' order by created_at desc limit 1");
    assert.match(delivered.dedupe_key, /^brief:\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual([delivered.channel, delivered.severity, delivered.status, delivered.agent_key], ['email', 'warning', 'sent', 'chief_of_staff']);
    const briefRun = await row("select * from private.agent_runs where agent_key = 'chief_of_staff' order by started_at desc limit 1");
    assert.deepEqual([briefRun.model, briefRun.outcome, Number(briefRun.cost_cents)], ['none', 'completed', 0]);
    assert.match(briefRun.summary, /^Sent the morning brief: \d+ things need you this morning\.$/);

    // A retry of the same day's brief sends nothing more, and still counts as delivered.
    await enqueue('chief_of_staff', 'brief.daily', `it:${run}:brief:retry`, { sourceKind: 'schedule' });
    tick = await briefTeam.tick();
    assert.equal(tick.claimed, 1);
    assert.equal(mail.email.length, 1, 'the scheduled brief is sent once a day');
    assert.equal((await row("select outcome from private.agent_runs where agent_key = 'chief_of_staff' order by started_at desc limit 1")).outcome, 'completed');

    // A brief the owner asks for ("Run now") is sent every time.
    const requested = await ownerCall('hub.request_agent_task', ['chief_of_staff', 'brief.daily']);
    tick = await briefTeam.tick();
    assert.equal(tick.claimed, 1);
    assert.equal((await task(requested.id)).status, 'done');
    assert.equal(mail.email.length, 2);
    assert.equal(mail.email[1][1], mail.email[0][1]);

    // The owner's screen shows the brief's task, run and alert.
    for (const kind of ['runs', 'tasks', 'notifications']) {
      const page = activitySchemas[kind].parse(await ownerCall('hub.list_agent_activity', [kind, 'chief_of_staff', 0, 25]));
      assert.ok(page.items.length > 0, `the owner sees the brief's ${kind}`);
    }

    await admin.query('delete from private.billing_subscriptions where tenant_id = $1', [tenant]);
    await admin.query('delete from private.billing_customers where tenant_id = $1', [tenant]);
    await admin.query('delete from hub.tenants where id = $1', [tenant]);
    await clearWork();
    await admin.query('delete from private.agent_probe_state');
  }

  {
    // The SEO Analyst end to end: the real scheduler and database, the shipped handler, a scripted network for the
    // five sites (the Framer home page already redirects to CareBase). The weekday is pinned, so this behaves the same
    // on any day it runs. No Search Console variable and no model key are set, so the report says how to connect Search
    // Console and has no suggestions.
    await clearWork();
    await admin.query('delete from private.owner_notifications');
    for (const [key, status] of [['seo_analyst', 'active'], ['chief_of_staff', 'paused'], ['platform_engineer', 'paused'], ['support_concierge', 'paused']]) {
      if ((await agentRow(key)).status !== status) await setStatus(key, status);
    }
    const seoAgent = await agentRow('seo_analyst');
    assert.deepEqual([seoAgent.autonomy, seoAgent.modelTier, seoAgent.dailyBudgetCents], ['observe', 'fast', 50], 'the SEO Analyst is observe-only');
    const requested = [];
    const homePage = (origin, extra = '') => `<!doctype html><html lang="en"><head><title>${new URL(origin).host} | Compliance training made simple</title>
      <meta name="description" content="Keep every home compliant with training, tracking and survey readiness, all in one clear place."><meta name="viewport" content="width=device-width">
      <link rel="canonical" href="${origin}/">${extra}<meta property="og:title" content="t"><meta property="og:description" content="d"><meta property="og:image" content="${origin}/i.png"><meta name="twitter:card" content="summary">
      <script type="application/ld+json">{"@type":"Organization"}</script></head><body><h1>Welcome</h1><p>${Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')}</p></body></html>`;
    const primary = { 'caremetricadvisors.com': 'https://caremetricadvisors.com', 'cmcarebase.com': 'https://cmcarebase.com', 'www.caremetricintel.com': 'https://www.caremetricintel.com', 'help.caremetric.ai': 'https://help.caremetric.ai' };
    const variants = { 'www.caremetricadvisors.com': 'https://caremetricadvisors.com', 'caremetrictrain.com': 'https://cmcarebase.com', 'caremetricintel.com': 'https://www.caremetricintel.com' };
    const network = async url => {
      const parsed = new URL(url);
      requested.push(parsed.host);
      const answer = (body, status = 200, type = 'text/html; charset=utf-8', location) => new Response(status === 301 ? null : body, { status, headers: { 'content-type': type, ...(location ? { location } : {}) } });
      if (parsed.protocol === 'http:') return answer('', 301, 'text/plain', `https://${parsed.host}/`);
      if (variants[parsed.host]) return answer('', 301, 'text/plain', `${variants[parsed.host]}/`);
      if (parsed.host === 'home.cmcarebase.com') return answer('', 301, 'text/plain', 'https://cmcarebase.com/');
      const origin = primary[parsed.host];
      if (!origin) return answer('not a known host', 404, 'text/plain');
      if (parsed.pathname === '/robots.txt') return answer(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, 200, 'text/plain');
      if (parsed.pathname === '/sitemap.xml') return answer(`<urlset><url><loc>${origin}/</loc></url></urlset>`, 200, 'application/xml');
      if (parsed.pathname === '/') return answer(homePage(origin, parsed.host === 'caremetricadvisors.com' ? '<meta name="robots" content="noindex">' : ''));
      return answer('missing', 404, 'text/plain');
    };
    const mail = { email: [] };
    const clock = { value: new Date('2026-11-03T12:00:00Z') };
    const seoTeam = agentTeam({
      pool, enabled: true, features: new Set(['platform.agents.customer-growth.v1','platform.agents.hardening.v1']), ownerEmail: 'owner@example.test', publicOrigin: 'https://hub.test', fetchImpl: network, log: () => {}, now: () => clock.value,
      sms: { configured: false, send: async () => ({ delivery: 'sent', id: 'x' }) },
      email: { configured: true, send: async (to, subject, content) => { mail.email.push([to, subject, content]); return { delivery: 'sent', id: 'fixture-seo' }; } },
    });
    assert.ok(seoTeam.scheduler.kinds().includes('seo.weekly'));
    await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day', enabled = true");

    // A missed Monday catches up on Tuesday and records one audit for the Eastern week.
    await admin.query("update private.agent_schedules set next_run_at = now() - interval '2 minutes' where task_kind = 'seo.weekly'");
    let tick = await seoTeam.tick();
    assert.deepEqual([tick.fired, tick.claimed], [1, 1]);
    const firstAudit = await row("select * from private.agent_tasks where agent_key = 'seo_analyst' order by created_at desc limit 1");
    assert.deepEqual([firstAudit.kind, firstAudit.source_kind, firstAudit.status], ['seo.weekly', 'schedule', 'done']);
    assert.deepEqual(firstAudit.result.delivery, ['email:sent']);
    assert.equal(mail.email.length, 1);
    assert.equal(mail.email[0][0], 'owner@example.test');
    assert.equal(mail.email[0][1], 'Weekly SEO report: 1 thing to fix across 5 sites, 1 urgent');
    assert.match(mail.email[0][2].text, /Urgent: A page tells search engines not to index it/);
    assert.match(mail.email[0][2].text, /Healthcare Advisors: score 85 of 100/);
    assert.match(mail.email[0][2].text, /CareBase: score 100 of 100, 1 page checked\.\n\nNothing to fix\./);
    assert.match(mail.email[0][2].text, /CareBase home \(Framer\): redirects to https:\/\/cmcarebase\.com, so search engines see one site\./);
    assert.equal(mail.email[0][2].text.match(/Search Console is not connected/g)?.length, 1, 'the report says once how to connect Search Console');
    assert.doesNotMatch(mail.email[0][2].text, /Suggested titles/, 'without a model key there are no suggestions');
    assert.deepEqual([...new Set(requested)].sort(), ['caremetrictrain.com', 'caremetricintel.com', 'cmcarebase.com', 'caremetricadvisors.com', 'www.caremetricadvisors.com', 'www.caremetricintel.com', 'help.caremetric.ai', 'home.cmcarebase.com'].sort(), 'only the five sites and their other addresses are ever contacted');
    assert.ok([...new Set(requested)].every(host => seoOutboundHosts.includes(host)), 'every host is on the analyst\'s allowlist');
    const delivered = await row("select * from private.owner_notifications where dedupe_key like 'seo:%' order by created_at desc limit 1");
    assert.deepEqual([delivered.dedupe_key, delivered.channel, delivered.severity, delivered.status, delivered.agent_key], ['seo:2026-11-02', 'email', 'warning', 'sent', 'seo_analyst']);
    const seoRun = await row("select * from private.agent_runs where agent_key = 'seo_analyst' order by started_at desc limit 1");
    assert.deepEqual([seoRun.model, seoRun.outcome, Number(seoRun.cost_cents)], ['none', 'completed', 0]);
    assert.equal(seoRun.summary, 'Sent the SEO report: 1 problem could keep pages out of search results.');
    const finished = firstAudit;
    assert.deepEqual(finished.result.sites.map(site => [site.key, site.score, site.checked]), [['advisors', 85, 1], ['carebase', 100, 1], ['intel', 100, 1], ['help', 100, 1], ['carebase_home', 100, 0]]);
    assert.deepEqual(finished.result.sites[0].top, [{ code: 'noindex', severity: 'high', count: 1, page: '/' }]);
    assert.equal(finished.result.sites[4].redirectsTo, 'https://cmcarebase.com');
    assert.deepEqual(finished.result.search, { state: 'not_configured' });
    assert.equal(finished.result.duplicates, undefined, 'one CareBase home page, so nothing competes');
    assert.ok(JSON.stringify(finished.result).length < 8000);

    // The same Monday's report is sent once, however often the task is retried; one the owner asks for is sent every time.
    const requestsBefore = requested.length;
    await enqueue('seo_analyst', 'seo.weekly', `it:${run}:seo:retry`, { sourceKind: 'schedule' });
    tick = await seoTeam.tick();
    assert.equal(tick.claimed, 1);
    assert.equal(mail.email.length, 1, 'the weekly report is sent once');
    assert.equal(requested.length, requestsBefore, 'a confirmed weekly report skips the repeated crawl');
    clock.value = new Date('2026-11-04T12:00:00Z');
    const asked = await ownerCall('hub.request_agent_task', ['seo_analyst', 'seo.weekly']);
    tick = await seoTeam.tick();
    assert.equal(tick.claimed, 1);
    assert.equal((await task(asked.id)).status, 'done');
    assert.equal(mail.email.length, 2, 'Run now sends a report on any day');

    // The owner's screen shows what the analyst leaves behind.
    for (const kind of ['runs', 'tasks', 'notifications']) {
      const page = activitySchemas[kind].parse(await ownerCall('hub.list_agent_activity', [kind, 'seo_analyst', 0, 25]));
      assert.ok(page.items.length > 0, `the owner sees the analyst's ${kind}`);
    }
    await clearWork();

    // Suggested titles are paid for once per report, judged by the real alert table. The help center's title is too short, so a model is
    // asked about it. The owner's own report that Monday morning and the scheduled report are two reports and each pays once (the
    // scheduled key is the start of the owner's, and the count tells them apart); a retry of the delivered scheduled report, on a server
    // that has no copy of the suggestions in memory, does not pay again and sends nothing again.
    await admin.query('delete from private.owner_notifications');
    const shortHelp = async url => (url === 'https://help.caremetric.ai/'
      ? new Response(homePage('https://help.caremetric.ai').replace(/<title>[^<]*<\/title>/, '<title>Help</title>'), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      : network(url));
    const paidFor = [];
    const rewriter = { configured: true, run: async runTask => {
      paidFor.push(runTask.id);
      return { outcome: 'completed', output: { suggestions: [{ page: 'p1', title: 'Help Center for CareMetric Products | CareMetric', description: 'Answers and step by step guides for CareMetric products, written for the questions customers ask most often.' }] } };
    } };
    const withModel = () => agentTeam({
      pool, enabled: true, ownerEmail: 'owner@example.test', publicOrigin: 'https://hub.test', fetchImpl: shortHelp, log: () => {}, now: () => clock.value, model: rewriter,
      sms: { configured: false, send: async () => ({ delivery: 'sent', id: 'x' }) },
      email: { configured: true, send: async (to, subject, content) => { mail.email.push([to, subject, content]); return { delivery: 'sent', id: 'fixture-seo-paid' }; } },
    });
    clock.value = new Date('2026-11-02T11:00:00Z');
    const early = await ownerCall('hub.request_agent_task', ['seo_analyst', 'seo.weekly']);
    await withModel().tick();
    assert.equal((await task(early.id)).status, 'done');
    assert.equal(paidFor.length, 1, 'the owner\'s own report pays for its suggestions');
    assert.match(mail.email.at(-1)[2].text, /New title/);
    await enqueue('seo_analyst', 'seo.weekly', `it:${run}:seo:paid`, { sourceKind: 'schedule' });
    await withModel().tick();
    assert.equal(paidFor.length, 2, 'the scheduled report is another report: the owner\'s report that morning is not taken for it');
    const sentBefore = mail.email.length;
    await enqueue('seo_analyst', 'seo.weekly', `it:${run}:seo:paid-retry`, { sourceKind: 'schedule' });
    await withModel().tick();
    assert.equal(paidFor.length, 2, 'a retry of a delivered report does not pay again');
    assert.equal(mail.email.length, sentBefore, 'and sends nothing again');
    const retried = await row('select result from private.agent_tasks where request_key = $1', [`it:${run}:seo:paid-retry`]);
    assert.deepEqual(retried.result.suggestions, { state: 'already_sent', offered: 0, kept: 0, dropped: 0 });
    await clearWork();
  }

  {
    // Work that needs the owner's session, through the real store: an import waits until the owner asks for it, then runs
    // with the owner's session; the route starts it only for a current administrator session and answers at once.
    await clearWork();
    if ((await agentRow('support_concierge')).status !== 'active') await setStatus('support_concierge', 'active');
    await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day', enabled = true");
    const reads = [];
    const logs = [];
    let behavior = async (_token, input) => ({ source: input.source, read: 3, created: 2, skipped: 1, nextOffset: null });
    const sessionTeam = agentTeam({
      pool, enabled: true, publicOrigin: 'https://hub.test', log: line => logs.push(line),
      sms: { configured: false, send: async () => ({ delivery: 'sent', id: 'x' }) }, email: { configured: false, send: async () => ({ delivery: 'sent', id: 'x' }) },
      communications: { sync: async (token, input) => { reads.push([token, input]); return behavior(token, input); } },
    });
    assert.ok(['import.advisors', 'import.breathe'].every(kind => sessionTeam.scheduler.kinds().includes(kind)), 'the imports are registered once the inbox service exists');
    const reached = async (id, statuses, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { const current = await task(id); if (statuses.includes(current.status)) return current; await new Promise(resolve => setTimeout(resolve, 25)); }
      assert.fail(`task ${id} never reached ${statuses.join(' or ')}`);
    };

    // The schedule makes a waiting task, and the tick never runs it or reads another application.
    await admin.query("update private.agent_schedules set next_run_at = now() - interval '3 minutes' where task_kind = 'import.advisors'");
    const tick = await sessionTeam.tick();
    assert.deepEqual([tick.fired, tick.claimed], [1, 0], 'the schedule fires and the tick claims nothing');
    const waiting = await row("select * from private.agent_tasks where kind = 'import.advisors' order by created_at desc limit 1");
    assert.deepEqual([waiting.status, waiting.requires_session, waiting.source_kind, waiting.attempts], ['awaiting_session', true, 'schedule', 0]);
    assert.equal(reads.length, 0, 'nothing is read without the owner');

    // A lapsed session, or someone who is not the administrator, claims nothing.
    await assert.rejects(sessionTeam.admin.waiting(staleToken, {}), error => error.status === 401, 'a session older than eight hours is refused');
    await assert.rejects(sessionTeam.admin.waiting(otherToken, {}), error => error.status === 401, 'a user who is not the administrator is refused');
    await assert.rejects(sessionTeam.admin.waiting(undefined, {}), error => error.status === 401);
    const breatheBefore = Number((await row("select count(*) from private.agent_tasks where kind = 'import.breathe'")).count);
    await assert.rejects(sessionTeam.admin.run(staleToken, { agentKey: 'support_concierge', taskKind: 'import.breathe' }), error => error.status === 401);
    assert.deepEqual([(await task(waiting.id)).status, reads.length], ['awaiting_session', 0], 'the waiting task was not claimed');
    assert.equal(Number((await row("select count(*) from private.agent_tasks where kind = 'import.breathe'")).count), breatheBefore, 'a refused Run now creates no task');

    // The owner's session starts it. The answer comes at once and the import finishes in the background.
    assert.deepEqual(await sessionTeam.admin.waiting(ownerToken, {}), { started: 1, actions: 0 });
    const finished = await reached(waiting.id, ['done']);
    assert.deepEqual(finished.result, { source: 'advisors.web', read: 3, created: 2, skipped: 1, calls: 1, complete: true, nextOffset: null });
    assert.deepEqual([finished.attempts, finished.last_error_code], [1, null]);
    assert.deepEqual(reads, [[ownerToken, { source: 'advisors.web', offset: 0 }]]);
    assert.deepEqual(await sessionTeam.admin.waiting(ownerToken, {}), { started: 0, actions: 0 }, 'a second press finds nothing left');

    // The session is borrowed, never kept: no table, log line or alert holds it.
    const everything = JSON.stringify([
      await rows('select to_jsonb(t) as r from private.agent_tasks t'), await rows('select to_jsonb(r) as r from private.agent_runs r'),
      await rows('select to_jsonb(a) as r from private.agent_actions a'), await rows('select to_jsonb(n) as r from private.owner_notifications n'),
      await rows("select metadata from private.audit_events where action like 'agent.%'"), logs,
    ]);
    assert.ok(!everything.includes(ownerToken), 'the owner\'s session token is stored and logged nowhere');

    // Run now on an import starts it immediately for a current session (the other import, not yet waiting, is created and run).
    const asked = await sessionTeam.admin.run(ownerToken, { agentKey: 'support_concierge', taskKind: 'import.breathe' });
    assert.equal(asked.status, 'running');
    assert.equal((await reached(asked.id, ['done'])).result.source, 'breathe.phone');
    assert.deepEqual(reads.at(-1), [ownerToken, { source: 'breathe.phone', offset: 0 }]);

    // A lapsed session mid-run parks the task for the next press; a bridge that is off finishes quietly; an outage waits as a session task.
    const parked = await enqueue('support_concierge', 'import.advisors', `it:${run}:session:parked`, { requiresSession: true });
    behavior = async () => { throw new HttpError(401, 'Sign in with an SMS code to continue.'); };
    assert.deepEqual(await sessionTeam.admin.waiting(ownerToken, {}), { started: 1, actions: 0 });
    const lapsed = await reached(parked, ['awaiting_session']);
    assert.deepEqual([lapsed.last_error_code, lapsed.attempts], ['session_required', 1]);
    behavior = async () => { throw new HttpError(503, 'This application has not connected its administrator session.', 'unconfigured'); };
    assert.deepEqual(await sessionTeam.admin.waiting(ownerToken, {}), { started: 1, actions: 0 });
    const off = await reached(parked, ['done']);
    assert.deepEqual([off.result.skipped, off.attempts], ['not_connected', 2]);
    const outage = await enqueue('support_concierge', 'import.breathe', `it:${run}:session:outage`, { requiresSession: true });
    behavior = async () => { throw new HttpError(503, 'Administrator connection is unavailable.', 'upstream'); };
    assert.deepEqual(await sessionTeam.admin.waiting(ownerToken, {}), { started: 1, actions: 0 });
    const waited = await reached(outage, ['awaiting_session']);
    assert.deepEqual([waited.last_error_code, waited.requires_session], ['bridge_unavailable', true]);

    // A session task asked to retry waits for its backoff like any other task, so pressing again at once finds nothing; once the backoff has passed it is offered again.
    assert.deepEqual(await sessionTeam.admin.waiting(ownerToken, {}), { started: 0, actions: 0 });
    await admin.query('update private.agent_tasks set due_at = now() where id = $1', [outage]);

    // Two presses at once claim a task once.
    behavior = async (_token, input) => ({ source: input.source, read: 0, created: 0, skipped: 0, nextOffset: null });
    const readsBefore = reads.length;
    const presses = await Promise.all([sessionTeam.admin.waiting(ownerToken, {}), sessionTeam.admin.waiting(ownerToken, {})]);
    assert.equal(presses[0].started + presses[1].started, 1, 'the database hands the task to one caller');
    await reached(outage, ['done']);
    assert.equal(reads.length - readsBefore, 1, 'and the import ran once');

    // A paused agent's waiting task is not offered or run.
    await setStatus('support_concierge', 'paused');
    const idle = await enqueue('support_concierge', 'import.advisors', `it:${run}:session:paused`, { requiresSession: true });
    assert.deepEqual(await sessionTeam.admin.waiting(ownerToken, {}), { started: 0, actions: 0 });
    assert.equal((await task(idle)).status, 'awaiting_session');
    await clearWork();
  }

  // The deployment gate re-runs cleanly, and refuses to declare the feature once the boundary drifts.
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query(contractMigration);
    await client.query('rollback');
    await client.query('begin');
    await client.query(probesMigration);
    await client.query('rollback');
    await client.query('begin');
    await client.query(briefMigration);
    await client.query('rollback');
    await client.query('begin');
    await client.query(seoMigration);
    await client.query('rollback');
    for (const [sql, message] of [
      ["delete from private.agent_schedules where agent_key = 'seo_analyst'", /weekly schedule must exist/],
      ["delete from private.owner_notifications where agent_key = 'seo_analyst'; delete from private.agent_actions where agent_key = 'seo_analyst'; delete from private.agent_runs where agent_key = 'seo_analyst'; delete from private.agent_tasks where agent_key = 'seo_analyst'; delete from private.agent_schedules where agent_key = 'seo_analyst'; delete from private.agents where key = 'seo_analyst'", /agent must exist/],
    ]) {
      await client.query('begin');
      try {
        await client.query(sql);
        await assert.rejects(client.query(seoMigration), rejection => rejection.code === '55000' && message.test(rejection.message), sql);
      } finally { await client.query('rollback'); }
    }
    for (const [sql, message] of [
      ['grant execute on function private.agent_brief_facts() to authenticated', /executable by the Hub server only/],
      ['revoke execute on function private.agent_brief_facts() from hub_app_server', /executable by the Hub server only/],
      ['alter function private.agent_brief_facts() security invoker', /security definer/],
    ]) {
      await client.query('begin');
      try {
        await client.query(sql);
        await assert.rejects(client.query(briefMigration), rejection => rejection.code === '55000' && message.test(rejection.message), sql);
      } finally { await client.query('rollback'); }
    }
    for (const [sql, message] of [
      ['grant select on private.agent_probe_state to hub_app_server', /must remain closed/],
      ['grant update (state) on private.agent_probe_state to authenticated', /must remain closed/],
      ['alter table private.agent_probe_state disable row level security', /row level security/],
      ['grant execute on function private.agent_probe_record(text,boolean,integer,integer,text,integer,text) to authenticated', /executable by the Hub server only/],
      ['revoke execute on function private.agent_probe_record(text,boolean,integer,integer,text,integer,text) from hub_app_server', /executable by the Hub server only/],
      ['alter function private.agent_probe_record(text,boolean,integer,integer,text,integer,text) security invoker', /security definer/],
    ]) {
      await client.query('begin');
      try {
        await client.query(sql);
        await assert.rejects(client.query(probesMigration), rejection => rejection.code === '55000' && message.test(rejection.message), sql);
      } finally { await client.query('rollback'); }
    }
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

  console.log('AI team control plane: the closed boundary, owner changes and reads, enqueue, claim, lease recovery, retry, session tasks, schedules, budget, actions and approvals, notifications, the owner contact, the on-call agent health probes with their incidents and recoveries, the morning brief, the weekly SEO report, the session-bound imports the owner runs, and the deployment gates all behave through hub_app_server and real sessions.');
} finally {
  await admin.query("delete from private.audit_events where action like 'agent.%' or actor_id in ($1,$2,$3)", [owner, other, secondAdmin]);
  await admin.query('delete from private.agent_actions');
  await admin.query('delete from private.agent_probe_state');
  await admin.query("delete from private.billing_subscriptions where stripe_subscription_id like $1", [`sub_brief${run}%`]);
  await admin.query('delete from private.billing_customers where stripe_customer_id = $1', [`cus_brief${run}`]);
  await admin.query('delete from hub.tenants where slug = $1', [`brief-${run}`]);
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
