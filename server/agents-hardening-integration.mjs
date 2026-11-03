// The AI team hardening through the actual Hub server role and a real owner session, on disposable local fixtures only. The server
// pool logs in as hub_app_server exactly like production. Each section is a way the control plane used to misbehave, and fails on the
// code this migration replaced: a superseded worker finishing a reclaimed task, an approved action surviving its task's cancellation,
// a proposal slipping in behind a cancellation, two owner commands waiting on each other, the housekeeping sweep holding a proposal while
// it waits for the task a decision holds, a retried alert marked unknown at once, a session task ignoring its backoff (in the list and in the
// claim), a waiting task's schedule firing a second one, replies hiding an incident record, a reset
// execution settled by its first starter, a relapse judged by the wrong failure, and a brief that counted the wrong incidents and
// alerts. The last section runs the deployment gate against drift, including a function whose search_path was reset.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { sqlAgentStore } from './agents/store.mjs';

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
const gate = await readFile(new URL('../supabase/migrations/20261102180100_agent_hardening_contract.sql', import.meta.url), 'utf8');
const store = sqlAgentStore(pool, { fenced: true });

const run = randomUUID().slice(0, 8);
const owner = randomUUID();
const ownerToken = `hardening-owner-${randomUUID()}`;
const ownerPhone = `+1202555${String(1000 + Math.floor(Math.random() * 9000))}`;
const minute = 60_000;

const call = async (fn, args = []) => (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r;
const refused = (code, pattern) => error => { assert.equal(error.code, code, error.message); if (pattern) assert.match(error.message, pattern); return true; };
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await admin.query(sql, params)).rows;
const ownerCall = (fn, args = [], token = ownerToken) => withSession(pool, token, async db =>
  (await db.query(`select to_jsonb(${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})) as r`, args)).rows[0].r);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const seedAgents = (await admin.query('select key, status, autonomy, daily_budget_cents, config, updated_at from private.agents')).rows;
const seedSchedules = (await admin.query('select id, next_run_at, last_run_at, last_task_id, enabled from private.agent_schedules')).rows;
let setAside = [];
const key = name => `hardening:${run}:${name}`;
const taskStatus = async id => (await row('select status, attempts, lease_until, due_at, last_error_code from private.agent_tasks where id = $1', [id]));
const actionRow = async id => (await row('select status, decided_by, decision_note, executions from private.agent_actions where id = $1', [id]));

// A task already claimed by a worker, without going through the claim (for scenarios that need a known state).
const runningTask = async (name, { agent = 'support_concierge', kind = 'concierge.communication', attempts = 1, requiresSession = false } = {}) =>
  (await row(`insert into private.agent_tasks (agent_key, kind, request_key, status, attempts, claimed_at, lease_until, requires_session)
    values ($1, $2, $3, 'running', $4, now(), now() + interval '10 minutes', $5) returning id`, [agent, kind, key(name), attempts, requiresSession])).id;
const propose = (taskId, kind, target, preview = 'Preview') => call('private.agent_action_propose', [taskId, null, kind, 'communication', target, preview, {}]);

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `hardening-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, ownerPhone]);
  await admin.query("insert into hub.profiles(id,display_name) values($1,'Hardening integration owner') on conflict (id) do update set display_name=excluded.display_name", [owner]);
  await admin.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at)
    select $1,$2,user_id,identity_version,now(),now()+interval '1 hour' from private.sms_identities where user_id=$3`, [randomUUID(), digest(ownerToken), owner]);
  setAside = (await admin.query("update private.staff_permissions set revoked_at = now() where permission = 'platform.admin' and revoked_at is null and user_id <> $1 returning id", [owner])).rows.map(entry => entry.id);
  await admin.query('delete from private.agent_actions');
  await admin.query('delete from private.agent_runs');
  await admin.query('delete from private.agent_tasks');
  await admin.query("update private.agents set status = 'active', autonomy = 'propose' where key in ('support_concierge', 'platform_engineer')");

  // ---- The boundary: every new operation is the Hub server's alone ----------------------------------------------------------------
  const operations = [
    ['private.agent_task_heartbeat', [randomUUID(), 600, 1]],
    ['private.agent_task_finish', [randomUUID(), 'done', null, null, null, 1]],
    ['private.agent_actions_ready', [10, null, null]],
    ['private.agent_action_executed', [randomUUID(), true, null, 1]],
    ['private.agent_action_release', [randomUUID(), 1]],
  ];
  for (const [fn, args] of operations) {
    const text = `select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})`;
    await assert.rejects(admin.query(text, args), refused('42501', /Application server required/), `${fn} refuses other session users`);
    for (const role of ['anon', 'authenticated']) {
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query(`set local role ${role}`);
        await assert.rejects(client.query(text, args), refused('42501'), `${role} cannot call ${fn}`);
      } finally { await client.query('rollback'); client.release(); }
    }
  }
  assert.ok((await admin.query('select hub.get_backend_contract() as c')).rows[0].c.features.includes('platform.agents.hardening.v1'), 'the feature is declared');

  // ---- A superseded worker can neither extend nor finish the task another worker reclaimed ------------------------------------------
  {
    const id = (await row(`insert into private.agent_tasks (agent_key, kind, request_key, status, due_at) values ('platform_engineer', 'probe.sweep', $1, 'queued', now()) returning id`, [key('fence')])).id;
    let claimed = (await store.claim(10, 600)).find(task => task.id === id);
    assert.equal(claimed.attempts, 1);
    assert.equal(await store.heartbeat(id, 600, 1), true, 'the current attempt can extend its lease');
    assert.equal(await store.heartbeat(id, 600, 2), false, 'an attempt the task was never claimed under cannot');
    assert.equal(await call('private.agent_task_heartbeat', [id, 600]), true, 'the earlier two-argument form still extends (unfenced)');
    await admin.query("update private.agent_tasks set lease_until = now() - interval '1 minute' where id = $1", [id]);
    claimed = (await store.claim(10, 600)).find(task => task.id === id);
    assert.equal(claimed.attempts, 2, 'a task whose lease ran out is handed out again under the next attempt');
    const lease = (await taskStatus(id)).lease_until;
    assert.equal(await store.heartbeat(id, 3600, 1), false, 'the superseded attempt cannot extend the reclaimed task');
    assert.equal((await taskStatus(id)).lease_until.getTime(), lease.getTime(), 'and the lease did not move');
    assert.equal(await store.finish(id, 'done', { result: { late: true }, attempt: 1 }), 'running', 'the superseded attempt cannot finish it: the current status comes back');
    const unchanged = await taskStatus(id);
    assert.deepEqual([unchanged.status, unchanged.attempts], ['running', 2]);
    assert.equal(await store.finish(id, 'failed', { errorCode: 'late', attempt: 1 }), 'running');
    assert.equal(await store.finish(id, 'done', { result: { fresh: true }, attempt: 2 }), 'done', 'the current attempt finishes it');
    assert.equal((await row('select result from private.agent_tasks where id = $1', [id])).result.fresh, true);
    assert.equal(await call('private.agent_task_finish', [id, 'failed', null, 'late', null]), 'done', 'a finished task stays finished (the earlier five-argument form)');
    const earlier = await runningTask('fence-old-shape', { agent: 'platform_engineer', kind: 'probe.sweep' });
    assert.equal(await call('private.agent_task_finish', [earlier, 'done', { ok: true }, null, null]), 'done', 'the earlier form still finishes a task, unfenced');
  }

  // ---- A session task asked to retry waits for its backoff; one waiting only for a session is offered at once ----------------------
  {
    const id = (await call('private.agent_task_enqueue', ['support_concierge', 'import.advisors', key('session'), {}, 5, null, 'owner', null, true]));
    assert.ok(id);
    assert.ok((await call('private.agent_session_task_claim', [id, 600])), 'the task is claimed under the owner\'s session');
    const later = new Date(Date.now() + 60 * minute);
    assert.equal(await store.finish(id, 'queued', { errorCode: 'bridge_unavailable', retryAt: later, attempt: 1 }), 'awaiting_session');
    const waiting = await taskStatus(id);
    assert.ok(Math.abs(waiting.due_at.getTime() - later.getTime()) < 5_000, 'it is not due until its retry time');
    assert.ok(!(await call('private.agent_session_tasks', [50])).some(item => item.id === id), 'so it is not offered yet');
    assert.equal(await call('private.agent_session_task_claim', [id, 600]), null, 'and a press that listed it earlier cannot claim it before then');
    assert.equal((await taskStatus(id)).status, 'awaiting_session', 'the refused claim changed nothing');
    await admin.query('update private.agent_tasks set due_at = now() where id = $1', [id]);
    assert.ok((await call('private.agent_session_tasks', [50])).some(item => item.id === id), 'and it is offered once the backoff has passed');
    assert.ok(await call('private.agent_session_task_claim', [id, 600]));
    assert.equal(await store.finish(id, 'awaiting_session', { errorCode: 'session_required', attempt: 2 }), 'awaiting_session');
    assert.ok((await call('private.agent_session_tasks', [50])).some(item => item.id === id), 'a task that only needs the owner to sign in is offered at once');
    await admin.query('delete from private.agent_tasks where id = $1', [id]);
  }

  // ---- A schedule does not fire a second task beside one still waiting for the owner's approval -------------------------------------
  {
    const schedule = await row("select id from private.agent_schedules where agent_key = 'platform_engineer' and task_kind = 'probe.sweep'");
    // Each firing is keyed by the second it was due, so the three due times differ.
    const due = seconds => admin.query('update private.agent_schedules set next_run_at = now() - make_interval(secs => $2) where id = $1', [schedule.id, seconds]);
    await admin.query("delete from private.agent_tasks where agent_key = 'platform_engineer' and kind = 'probe.sweep' and source_kind = 'schedule'");
    await due(30);
    const [first] = await call('private.agent_schedule_fire', [10, ['probe.sweep']]);
    assert.ok(first, 'the schedule fires when nothing of its kind is unfinished');
    await admin.query("update private.agent_tasks set status = 'awaiting_approval' where id = $1", [first]);
    await due(20);
    assert.deepEqual(await call('private.agent_schedule_fire', [10, ['probe.sweep']]), [], 'a task waiting for approval is unfinished, so the schedule skips');
    await admin.query("update private.agent_tasks set status = 'done' where id = $1", [first]);
    await due(10);
    assert.equal((await call('private.agent_schedule_fire', [10, ['probe.sweep']])).length, 1, 'once it is done the schedule fires again');
    await admin.query("delete from private.agent_tasks where agent_key = 'platform_engineer' and kind = 'probe.sweep' and source_kind = 'schedule'");
  }

  // ---- Cancelling a task rejects what was approved but not started; an action mid-send is left alone ------------------------------------
  {
    const doomed = await runningTask('cancel');
    const reply = await propose(doomed, 'communication.reply', 'CM-H1');
    const note = await propose(doomed, 'communication.note', 'CM-H2');
    const auto = await propose(doomed, 'communication.update', 'CM-H3');
    assert.deepEqual([reply.status, note.status, auto.status], ['proposed', 'proposed', 'proposed']);
    assert.equal((await ownerCall('hub.decide_agent_action', [reply.id, 'approve'])).status, 'approved');
    await admin.query("update private.agent_actions set status = 'auto_approved' where id = $1", [auto.id]);
    assert.deepEqual((await call('private.agent_actions_ready', [50])).map(item => item.id).sort(), [reply.id, auto.id].sort(), 'the approved and auto-approved actions are ready');
    assert.equal((await ownerCall('hub.cancel_agent_task', [doomed])).status, 'cancelled');
    for (const id of [reply.id, note.id, auto.id]) {
      const after = await actionRow(id);
      assert.deepEqual([after.status, after.decision_note, after.decided_by], ['rejected', 'The task was cancelled.', owner], `action ${id} was rejected with the task`);
    }
    assert.deepEqual(await call('private.agent_actions_ready', [50]), [], 'nothing from the cancelled task is ready');
    assert.equal(await call('private.agent_action_execution', [reply.id]), null, 'and nothing from it can be started');
    // Belt and braces: even an action somehow approved after the cancellation is neither ready nor startable while its task is cancelled.
    await admin.query("update private.agent_actions set status = 'approved' where id = $1", [reply.id]);
    assert.deepEqual(await call('private.agent_actions_ready', [50]), []);
    assert.equal(await call('private.agent_action_execution', [reply.id]), null);

    const midSend = await runningTask('cancel-mid-send');
    const sending = await propose(midSend, 'communication.reply', 'CM-H4');
    await ownerCall('hub.decide_agent_action', [sending.id, 'approve']);
    const started = await call('private.agent_action_execution', [sending.id]);
    assert.equal((await ownerCall('hub.cancel_agent_task', [midSend])).status, 'cancelled');
    assert.equal((await actionRow(sending.id)).status, 'executing', 'an action already being carried out is not touched: it may be mid-send');
    await call('private.agent_action_executed', [sending.id, true, { delivery: 'sent' }, started.execution]);
    assert.equal((await actionRow(sending.id)).status, 'executed', 'its own report settles it');
  }

  // ---- A proposal cannot slip in behind a cancellation ------------------------------------------------------------------------------
  {
    const id = await runningTask('race');
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query("update private.agent_tasks set status = 'cancelled', finished_at = now() where id = $1", [id]);
      let settled = false;
      const proposing = propose(id, 'communication.reply', 'CM-H5').then(value => { settled = true; return value; }, error => { settled = true; throw error; });
      // The expectation is attached before the commit: the refusal can arrive before the commit's own answer, and a rejection
      // nobody was listening for yet would end the process (and skip its teardown) instead of being checked.
      const refusal = assert.rejects(proposing, refused('55000', /Only a running task can propose/), 'and is refused once the task is cancelled');
      await sleep(400);
      assert.equal(settled, false, 'the proposal waits for the cancellation that is in flight');
      await holder.query('commit');
      await refusal;
    } finally { await holder.query('rollback').catch(() => {}); holder.release(); }
    assert.equal((await row('select count(*)::int as n from private.agent_actions where target_id = $1', ['CM-H5'])).n, 0, 'no action was left behind');
  }

  // ---- Deciding and cancelling take the task's lock first, so they cannot wait on each other -----------------------------------------
  {
    // The task waits for the owner's decision, which is where the two commands meet: rejecting the last open proposal settles the task.
    const id = await runningTask('order');
    const action = await propose(id, 'communication.reply', 'CM-H6');
    await admin.query("update private.agent_tasks set status = 'awaiting_approval' where id = $1", [id]);
    const holder = await admin.connect();
    try {
      // A cancellation in flight holds the task. The owner's rejection must queue behind it WITHOUT taking the action first.
      await holder.query('begin');
      await holder.query('select 1 from private.agent_tasks where id = $1 for update', [id]);
      const deciding = ownerCall('hub.decide_agent_action', [action.id, 'reject']);
      await sleep(400);
      await holder.query('set local lock_timeout = \'1500ms\'');
      await holder.query('select 1 from private.agent_actions where id = $1 for update', [action.id]);
      await holder.query('commit');
      assert.equal((await deciding).status, 'rejected', 'the rejection completes once the task is free');
    } finally { await holder.query('rollback').catch(() => {}); holder.release(); }
    const first = await runningTask('order-2');
    const second = await propose(first, 'communication.reply', 'CM-H7');
    await admin.query("update private.agent_tasks set status = 'awaiting_approval' where id = $1", [first]);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => (index % 2 === 0
      ? ownerCall('hub.cancel_agent_task', [first]) : ownerCall('hub.decide_agent_action', [second.id, 'reject']))));
    assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason.code), [], 'no deadlock between cancelling and deciding');
  }

  // ---- The housekeeping sweep takes the task's lock before the proposals it expires ------------------------------------------------
  {
    // Expiring a task's last open proposal settles the task, so the sweep and the owner's decision on that proposal meet on the same two rows.
    const id = await runningTask('sweep-order');
    const action = await propose(id, 'communication.reply', 'CM-H8');
    await admin.query("update private.agent_tasks set status = 'awaiting_approval' where id = $1", [id]);
    await admin.query("update private.agent_actions set expires_at = now() - interval '1 minute' where id = $1", [action.id]);
    const holder = await admin.connect();
    try {
      // A decision in flight holds the task. The sweep must queue behind it WITHOUT having taken the proposal first, or the decision's own
      // wait for the proposal would be a deadlock: the database aborts one of the two (40P01) and the sweep or the owner's command fails.
      await holder.query('begin');
      await holder.query('select 1 from private.agent_tasks where id = $1 for update', [id]);
      const sweeping = call('private.agent_maintenance');
      await sleep(400);
      await holder.query('set local lock_timeout = \'1500ms\'');
      await holder.query('select 1 from private.agent_actions where id = $1 for update', [action.id]);
      await holder.query('commit');
      const swept = await sweeping;
      assert.equal(swept.expiredActions, 1, 'the sweep completes once the task is free, and expires the proposal');
      assert.equal(swept.settledTasks, 1, 'and settles the task whose last proposal it expired');
    } finally { await holder.query('rollback').catch(() => {}); holder.release(); }
    assert.equal((await actionRow(action.id)).status, 'expired');
    assert.equal((await taskStatus(id)).status, 'done');
    // A proposal the owner decides while the sweep waits is not expired afterwards.
    const decided = await runningTask('sweep-decided');
    const open = await propose(decided, 'communication.reply', 'CM-H9');
    await admin.query("update private.agent_tasks set status = 'awaiting_approval' where id = $1", [decided]);
    await admin.query("update private.agent_actions set expires_at = now() - interval '1 minute' where id = $1", [open.id]);
    const waiter = await admin.connect();
    try {
      await waiter.query('begin');
      await waiter.query('select 1 from private.agent_tasks where id = $1 for update', [decided]);
      const sweeping = call('private.agent_maintenance');
      await sleep(400);
      await waiter.query("update private.agent_actions set status = 'approved', decided_by = $2, decided_at = now(), updated_at = now() where id = $1", [open.id, owner]);
      await waiter.query('commit');
      const swept = await sweeping;
      assert.equal(swept.expiredActions, 0, 'a proposal decided while the sweep waited is no longer proposed, so it is not expired');
    } finally { await waiter.query('rollback').catch(() => {}); waiter.release(); }
    assert.equal((await actionRow(open.id)).status, 'approved');
    assert.equal((await taskStatus(decided)).status, 'awaiting_approval', 'and its task is still waiting');
    // Leave nothing approved behind for the sections that count ready actions.
    await admin.query('delete from private.agent_actions where task_id = any($1::uuid[])', [[id, decided]]);
    await admin.query('delete from private.agent_tasks where id = any($1::uuid[])', [[id, decided]]);
  }

  // ---- A retried alert is not unsettled the moment it starts ------------------------------------------------------------------------
  {
    const begun = await call('private.agent_notify_begin', ['sms', 'urgent', 'Retry', 'Retry.', key('retry'), 'platform_engineer', null]);
    await call('private.agent_notify_finish', [begun.id, 'failed', null]);
    await admin.query("update private.owner_notifications set created_at = now() - interval '20 minutes', attempted_at = now() - interval '20 minutes' where id = $1", [begun.id]);
    const retry = await call('private.agent_notify_begin', ['sms', 'urgent', 'Retry', 'Retry.', key('retry'), 'platform_engineer', null]);
    assert.deepEqual([retry.duplicate, retry.id, retry.status], [false, begun.id, 'pending']);
    const attempt = await row('select attempted_at, created_at from private.owner_notifications where id = $1', [begun.id]);
    assert.ok(Date.now() - attempt.attempted_at.getTime() < 30_000 && Date.now() - attempt.created_at.getTime() > 19 * minute, 'the retry has its own start time');
    await call('private.agent_maintenance');
    assert.equal((await row('select status from private.owner_notifications where id = $1', [begun.id])).status, 'pending', 'the sweep leaves a fresh retry alone');
    await call('private.agent_notify_finish', [begun.id, 'sent', 'SM1']);
    assert.equal((await row('select status from private.owner_notifications where id = $1', [begun.id])).status, 'sent', 'and the retry can still be settled');
    const abandoned = await call('private.agent_notify_begin', ['email', 'info', 'Abandoned', 'Abandoned.', key('abandoned'), null, null]);
    await admin.query("update private.owner_notifications set attempted_at = now() - interval '16 minutes' where id = $1", [abandoned.id]);
    await call('private.agent_maintenance');
    assert.equal((await row('select status from private.owner_notifications where id = $1', [abandoned.id])).status, 'unknown', 'an attempt nobody settled for fifteen minutes still becomes unknown');
  }

  // ---- The ready list is narrowed by kind before it is limited, so replies cannot hide an incident record ---------------------------------
  {
    const id = await runningTask('drain');
    const replies = [];
    for (const [index, target] of ['CM-D1', 'CM-D2', 'CM-D3'].entries()) {
      const reply = await propose(id, 'communication.reply', target);
      replies.push(reply.id);
      await admin.query("update private.agent_actions set status = 'approved', created_at = now() - make_interval(mins => $2) where id = $1", [reply.id, 30 - index]);
    }
    const incident = await call('private.agent_action_propose', [id, null, 'incident.open', 'probe_target', 'drain:1', 'Opened', {}]);
    await admin.query("update private.agent_actions set status = 'approved' where id = $1", [incident.id]);
    assert.deepEqual((await call('private.agent_actions_ready', [2])).map(item => item.id), replies.slice(0, 2), 'the earlier form takes the two oldest, which are replies');
    assert.deepEqual((await store.readyActions(2, { excludeKinds: ['communication.reply'] })).map(item => item.id), [incident.id], 'excluding the session kinds reaches the incident record');
    assert.deepEqual((await store.readyActions(10, { kinds: ['communication.reply'] })).map(item => item.id), replies, 'asking for the session kinds lists only them, oldest first');
    assert.equal((await store.readyActions(10, { kinds: [] })).length, 0, 'an empty list of kinds names none');
    assert.equal((await store.readyActions(10, { excludeKinds: [] })).length, 4, 'an empty exclusion removes none');
    await assert.rejects(call('private.agent_actions_ready', [51, null, null]), refused('22023'));
    await admin.query("update private.agent_actions set status = 'rejected' where task_id = $1", [id]);
  }

  // ---- A reset execution cannot be settled by its first starter; one that never began can be handed back -------------------------------
  {
    const id = await runningTask('exec');
    const action = await propose(id, 'communication.reply', 'CM-E1');
    await ownerCall('hub.decide_agent_action', [action.id, 'approve']);
    const first = await store.beginExecution(action.id);
    assert.equal(first.execution, 1);
    assert.equal(await store.beginExecution(action.id), null, 'one caller starts an approval');
    await admin.query("update private.agent_actions set executing_at = now() - interval '11 minutes' where id = $1", [action.id]);
    await call('private.agent_maintenance');
    assert.equal((await actionRow(action.id)).status, 'approved', 'the sweep resets an execution nobody finished');
    const second = await store.beginExecution(action.id);
    assert.equal(second.execution, 2, 'and the next start has the next number');
    await assert.rejects(store.completeExecution(action.id, false, { error: 'late' }, first.execution), refused('55000', /not being carried out/), 'the first starter cannot settle the second');
    assert.equal((await actionRow(action.id)).status, 'executing');
    assert.equal(await store.releaseExecution(action.id, first.execution), false, 'nor hand it back');
    assert.equal(await store.releaseExecution(action.id, second.execution), true, 'the current start can hand it back when it never began its work');
    assert.deepEqual([(await actionRow(action.id)).status], ['approved']);
    const third = await store.beginExecution(action.id);
    assert.equal(third.execution, 3);
    await store.completeExecution(action.id, true, { delivery: 'sent' }, third.execution);
    assert.equal((await actionRow(action.id)).status, 'executed');
    assert.equal(await store.releaseExecution(action.id, third.execution), false, 'a settled action cannot be handed back');
    // An auto-approved action returns to auto_approved, never to a human approval it never had.
    const autoTask = await runningTask('exec-auto');
    const auto = await call('private.agent_action_propose', [autoTask, null, 'incident.open', 'probe_target', 'exec:1', 'Opened', {}]);
    await admin.query("update private.agent_actions set status = 'auto_approved' where id = $1", [auto.id]);
    const started = await store.beginExecution(auto.id);
    assert.equal(await store.releaseExecution(auto.id, started.execution), true);
    assert.equal((await actionRow(auto.id)).status, 'auto_approved');
    const wrapped = await store.beginExecution(auto.id);
    await call('private.agent_action_executed', [auto.id, true, {}]);
    assert.equal((await actionRow(auto.id)).status, 'executed', `the earlier three-argument form still settles (execution ${wrapped.execution})`);
  }

  // ---- A relapse is flapping when it began within half an hour of the last recovery --------------------------------------------------
  {
    const target = `hardening_${run}`;
    const record = ok => call('private.agent_probe_record', [target, ok, ok ? 200 : 503, 20, ok ? null : 'status', 2, 'platform_engineer']);
    const incidentOf = async number => (await row("select payload from private.agent_tasks where request_key = $1", [`probe.incident:${target}:${number}`])).payload;
    await record(false);
    assert.equal((await record(false)).transition, 'down');
    assert.equal((await incidentOf(1)).flapping, false, 'a first incident is not flapping');
    assert.equal((await record(true)).transition, 'recovered');
    // The product recovered 30 minutes and a second ago; the relapse began 5 minutes ago and its second failed check is now.
    await record(false);
    await admin.query("update private.agent_probe_state set last_recovered_at = now() - interval '30 minutes 1 second', failing_since = now() - interval '5 minutes' where target_key = $1", [target]);
    assert.equal((await record(false)).transition, 'down');
    assert.equal((await incidentOf(2)).flapping, true, 'the relapse began 25 minutes after the recovery, so it is flapping even though its second check came later');
    assert.equal((await record(true)).transition, 'recovered');
    await record(false);
    await admin.query("update private.agent_probe_state set last_recovered_at = now() - interval '2 hours', failing_since = now() - interval '5 minutes' where target_key = $1", [target]);
    assert.equal((await record(false)).transition, 'down');
    assert.equal((await incidentOf(3)).flapping, false, 'a relapse long after the recovery is a new incident');
    await admin.query("delete from private.agent_tasks where request_key like $1", [`probe.%:${target}:%`]);
    await admin.query('delete from private.agent_probe_state where target_key = $1', [target]);
  }

  // ---- The brief counts incidents from the probe tasks and judges an alert by every channel of it ------------------------------------
  {
    const before = await call('private.agent_brief_facts');
    const yesterday = new Date(before.yesterdayStart).getTime() + 10 * 3_600_000;
    const at = offsetMs => new Date(yesterday + offsetMs).toISOString();
    await admin.query(`insert into private.agent_tasks (agent_key, kind, request_key, status, source_kind, created_at) values
      ('platform_engineer', 'probe.incident', $1, 'cancelled', 'probe', $4), ('platform_engineer', 'probe.incident', $2, 'cancelled', 'probe', $4),
      ('platform_engineer', 'probe.recovery', $3, 'cancelled', 'probe', $4), ('platform_engineer', 'probe.incident', $5, 'cancelled', 'probe', now())`,
    [key('inc1'), key('inc2'), key('rec1'), at(0), key('inc-today')]);
    const afterIncidents = await call('private.agent_brief_facts');
    assert.deepEqual([afterIncidents.yesterday.incidentsOpened - before.yesterday.incidentsOpened, afterIncidents.yesterday.incidentsClosed - before.yesterday.incidentsClosed], [2, 1],
      'incidents are counted from the probe tasks created yesterday, with no action recorded for any of them');
    await admin.query(`insert into private.owner_notifications (dedupe_key, channel, severity, subject, body, status, created_at, attempted_at) values
      ($1, 'sms', 'urgent', 'Lost', 'Lost', 'suppressed', now() - interval '1 hour', now() - interval '1 hour'),
      ($1, 'email', 'urgent', 'Lost', 'Lost', 'failed', now() - interval '1 hour', now() - interval '1 hour'),
      ($2, 'sms', 'urgent', 'Reached earlier', 'Reached', 'sent', now() - interval '2 days', now() - interval '2 days'),
      ($2, 'email', 'urgent', 'Reached earlier', 'Reached', 'failed', now() - interval '1 hour', now() - interval '1 hour'),
      ($3, 'sms', 'urgent', 'Reached later', 'Reached', 'suppressed', now() - interval '1 hour', now() - interval '1 hour'),
      ($3, 'email', 'warning', 'Reached later', 'Reached', 'sent', now() - interval '30 minutes', now() - interval '30 minutes')`, [key('lost'), key('reached-earlier'), key('reached-later')]);
    const afterAlerts = await call('private.agent_brief_facts');
    assert.equal(afterAlerts.undeliveredAlerts - before.undeliveredAlerts, 1,
      'only the alert no channel of which was sent is undelivered: a sent row outside the day, or a later warning that went out, counts as delivery');
  }

  // ---- The deployment gate fails closed ---------------------------------------------------------------------------------------------
  {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(gate);
      await client.query('rollback');
      for (const [sql, message] of [
        ['alter function private.agent_task_finish(uuid,text,jsonb,text,timestamp with time zone,integer) reset search_path', /pinned search path/],
        ['alter function private.agent_task_claim(integer,integer) reset search_path', /pinned search path/],
        ['alter function private.agent_brief_facts() reset search_path', /pinned search path/],
        ['alter function private.agent_probe_record(text,boolean,integer,integer,text,integer,text) reset search_path', /pinned search path/],
        ['alter function private.agent_day_start() reset search_path', /pinned search path/],
        ['alter function hub.decide_agent_action(uuid,text,text) reset search_path', /command session/],
        ['alter function hub.get_agent_team() reset search_path', /administrator session/],
        ['alter function private.agent_action_release(uuid,integer) security invoker', /pinned search path/],
        ['grant execute on function private.agent_action_release(uuid,integer) to authenticated', /executable by the Hub server only/],
        ['revoke execute on function private.agent_actions_ready(integer,text[],text[]) from hub_app_server', /executable by the Hub server only/],
        ['drop function private.agent_task_heartbeat(uuid,integer,integer)', /executable by the Hub server only/],
        ['grant execute on function private.agent_task_json(uuid) to hub_app_server', /internal to the operations/],
        ['grant select on private.agent_probe_state to hub_app_server', /must remain closed/],
        ['grant update (executions) on private.agent_actions to authenticated', /must remain closed/],
        ['alter table private.agent_runs disable row level security', /row level security/],
        ['alter table private.agent_actions drop column executions', /hardening columns must exist/],
        ['revoke execute on function hub.cancel_agent_task(uuid) from authenticated', /command session/],
      ]) {
        await client.query('begin');
        try {
          await client.query(sql);
          await assert.rejects(client.query(gate), rejection => rejection.code === '55000' && message.test(rejection.message), sql);
        } finally { await client.query('rollback'); }
      }
    } finally { client.release(); }
  }

  console.log('AI team hardening: fenced heartbeat and finish, cancellation that rejects approved actions, proposals that wait for a cancellation, one lock order, retried alerts with their own clock, session backoff, schedules that skip a task awaiting approval, kind-filtered ready lists, numbered executions with release, relapse timing, the brief\'s incident and alert counts, and a deployment gate that fails closed all behave through hub_app_server and a real session.');
} finally {
  const problems = [];
  const attempt = async (sql, params = []) => { try { await admin.query(sql, params); } catch (error) { problems.push(`${error.message} [${sql.slice(0, 70)}]`); } };
  await attempt("delete from private.audit_events where action like 'agent.%' or actor_id = $1", [owner]);
  await attempt('delete from private.agent_actions');
  await attempt('delete from private.agent_runs');
  await attempt("delete from private.owner_notifications where dedupe_key like $1", [`hardening:${run}:%`]);
  await attempt('delete from private.agent_tasks');
  await attempt("delete from private.agent_probe_state where target_key like 'hardening_%'");
  for (const seed of seedAgents) await attempt('update private.agents set status=$2, autonomy=$3, daily_budget_cents=$4, config=$5, updated_at=$6 where key=$1', [seed.key, seed.status, seed.autonomy, seed.daily_budget_cents, seed.config, seed.updated_at]);
  for (const seed of seedSchedules) await attempt('update private.agent_schedules set next_run_at=$2, last_run_at=$3, last_task_id=$4, enabled=$5 where id=$1', [seed.id, seed.next_run_at, seed.last_run_at, seed.last_task_id, seed.enabled]);
  if (setAside.length) await attempt('update private.staff_permissions set revoked_at = null where id = any($1::uuid[])', [setAside]);
  await attempt('delete from private.sms_sessions where user_id = $1', [owner]);
  await attempt('delete from private.sms_identities where user_id = $1', [owner]);
  await attempt('delete from private.staff_permissions where user_id = $1', [owner]);
  await attempt('delete from hub.profiles where id = $1', [owner]);
  await attempt('delete from auth.users where id = $1', [owner]);
  await pool.end();
  await admin.end();
  if (problems.length) { console.error(`Teardown problems: ${problems.join(' | ')}`); process.exitCode = 1; }
}
