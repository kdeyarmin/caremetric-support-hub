// The Social Media Manager's database rules through the actual Hub server role, on disposable local fixtures only: proposing its
// actions, holding a post until its time slot, handing back a post that started early, the open-target read, and the refusals (another
// agent's social action, an automatically approved budget change). Nothing reaches Meta.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
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
const store = sqlAgentStore(pool, { fenced: true, growth: true, social: true });

const run = randomUUID().slice(0, 8);
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const original = await row("select status, autonomy, config from private.agents where key = 'social_manager'");
assert.ok(original, 'The Social Media Manager is seeded');
const tasks = [];
async function runningTask(agent, kind) {
  const created = await row("insert into private.agent_tasks (agent_key, kind, request_key, status, claimed_at, lease_until, attempts) values ($1, $2, $3, 'running', now(), now() + interval '10 minutes', 1) returning id", [agent, kind, `social-it-${run}-${tasks.length}`]);
  tasks.push(created.id);
  return created.id;
}

try {
  await admin.query("update private.agents set status = 'active', autonomy = 'propose', config = jsonb_set(config, '{auto_approve_kinds}', '[]') where key = 'social_manager'");
  const plan = await runningTask('social_manager', 'social.plan');
  const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const post = await store.proposeAction({ taskId: plan, kind: 'social.post', targetKind: 'social_post', targetId: `facebook:${run}:1`, preview: 'A post',
    input: { platform: 'facebook', product: 'carebase', message: 'A post', link: null, imageUrl: null, scheduledFor: later } });
  assert.equal(post.status, 'proposed');
  assert.equal(await store.socialSchedule(post.id, null), true, 'A proposed post is held');
  const held = await row('select not_before from private.agent_actions where id = $1', [post.id]);
  assert.ok(Math.abs(held.not_before.getTime() - Date.parse(later)) < 1000, 'until its time slot');
  assert.ok((await store.socialOpenTargets()).includes(`social.post:facebook:${run}:1`), 'and is an open target');

  // Approved, it does not start before its slot; once started early it is handed back with the same hold.
  await admin.query("update private.agent_actions set status = 'approved', decided_at = now() where id = $1", [post.id]);
  assert.equal(await store.beginExecution(post.id), null, 'An approved post does not start before its time slot');
  await admin.query('update private.agent_actions set not_before = null where id = $1', [post.id]);
  const execution = await store.beginExecution(post.id);
  assert.ok(execution, 'It starts once nothing holds it');
  assert.equal(await store.deferExecution(post.id, execution.execution, 'social.post'), true, 'An early start is handed back');
  const back = await row('select status, not_before from private.agent_actions where id = $1', [post.id]);
  assert.ok(['approved', 'auto_approved'].includes(back.status), 'back to its approved state');
  assert.ok(back.not_before.getTime() > Date.now() + 3_600_000, 'with its hold restored');

  // A budget change is never automatic, even for an agent on Act that lists it.
  await admin.query("update private.agents set autonomy = 'act', config = jsonb_set(config, '{auto_approve_kinds}', '[\"social.ad_budget\", \"social.ad_pause\"]') where key = 'social_manager'");
  const ads = await runningTask('social_manager', 'social.ads');
  await assert.rejects(store.proposeAction({ taskId: ads, kind: 'social.ad_budget', targetKind: 'social_adset', targetId: `${run}`, preview: 'Raise', input: { adsetId: '40', from: 2000, to: 2400 } }),
    error => error.code === '23514', 'An automatically approved budget change is refused');
  const pause = await store.proposeAction({ taskId: ads, kind: 'social.ad_pause', targetKind: 'social_ad', targetId: `5${run.replace(/\D/g, '')}1`, preview: 'Pause', input: { adId: '51' } });
  assert.equal(pause.status, 'auto_approved', 'A handed-over pause is approved automatically');
  assert.equal(await store.socialSchedule(pause.id, null), false, 'Only a post can be held');

  // Another agent cannot propose a social action.
  const brief = await runningTask('chief_of_staff', 'brief.daily');
  await assert.rejects(store.proposeAction({ taskId: brief, kind: 'social.post', targetKind: 'social_post', targetId: `x-${run}`, preview: 'A post', input: {} }), error => error.code === '23514');

  await assert.rejects(admin.query('select private.social_open_targets()'), error => error.code === '42501', 'Only the Hub server reads open targets');
  console.log('Social Media Manager database checks passed.');
} finally {
  await admin.query('delete from private.agent_runs where task_id = any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_actions where task_id = any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_tasks where id = any($1::uuid[])', [tasks]);
  await admin.query("update private.agents set status = $1, autonomy = $2, config = $3 where key = 'social_manager'", [original.status, original.autonomy, original.config]);
  await Promise.all([pool.end(), admin.end()]);
}
