// Autonomy steps through the real roles: the owner's session starts, holds and hands over work; the Hub server's hourly task switches
// a step whose supervised week has ended. Disposable loopback database only; no email is sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { autonomyFeature, autonomyHandlers } from './agents/tasks/autonomy.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = sqlAgentStore(pool, { fenced: true });
const owner = randomUUID(), token = `autonomy-${randomUUID()}`, staleToken = `autonomy-stale-${randomUUID()}`, run = randomUUID().slice(0, 8);
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const ownerCall = (fn, values, session = token) => withSession(pool, session, async db => (await db.query(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(',')}) as r`, values)).rows[0].r);
const step = async category => (await ownerCall('hub.get_agent_autonomy', [])).find(item => item.category === category);
const agent = key => row('select autonomy, config from private.agents where key = $1', [key]);
const refused = code => error => error?.code === code;
const seedSteps = (await admin.query('select * from private.agent_autonomy_steps')).rows;
const seedAgents = (await admin.query("select key, autonomy, config from private.agents where key in ('account_manager', 'support_concierge', 'content_marketer')")).rows;
const auditFloor = (await row('select coalesce(max(id), 0) as id from private.audit_events')).id;

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `autonomy-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550972',now())", [owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at) select $1,$2,user_id,identity_version,now()-interval '9 hours',now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(staleToken), owner]);
  await admin.query("update private.agents set autonomy='observe', config=config || '{\"auto_send_templates\": []}'::jsonb where key='account_manager'");

  // The server role cannot read or change steps through the owner's operations, nor the table.
  await assert.rejects(pool.query('select * from private.agent_autonomy_steps'), refused('42501'));
  await assert.rejects(pool.query('select hub.get_agent_autonomy()'), error => ['28000', '42501'].includes(error?.code));

  // The owner sees four steps, all off; each is ready exactly when its code (its feature) is on the Hub. Offers are given a feature that is
  // never declared, so this test has a step without code whatever else is merged.
  await admin.query("update private.agent_autonomy_steps set requires_feature = 'platform.agents.never-declared.v1' where category = 'offers'");
  const declared = new Set((await row('select hub.get_backend_contract() as c')).c.features);
  const steps = await ownerCall('hub.get_agent_autonomy', []);
  assert.deepEqual(steps.map(item => [item.category, item.status]), [['account_emails', 'off'], ['articles', 'off'], ['offers', 'off'], ['support_answers', 'off']]);
  for (const item of steps) assert.equal(item.ready, item.category !== 'offers' && declared.has(seedSteps.find(seed => seed.category === item.category).requires_feature), item.category);
  assert.equal(steps.find(item => item.category === 'account_emails').ready, true);

  // A supervised week: the Account Manager moves up to propose, nothing sends on its own, and a stale screen or stale session is refused.
  const off = await step('account_emails');
  await assert.rejects(ownerCall('hub.set_agent_autonomy_step', ['account_emails', 'supervise', off.changedAt], staleToken), refused('28000'), 'an old session can read but not change');
  const supervised = await ownerCall('hub.set_agent_autonomy_step', ['account_emails', 'supervise', off.changedAt]);
  assert.equal(supervised.status, 'supervised');
  assert.ok(Date.parse(supervised.automaticAt) - Date.parse(supervised.supervisedSince) === 7 * 86400000, 'the week is seven days');
  await assert.rejects(ownerCall('hub.set_agent_autonomy_step', ['account_emails', 'hold', off.changedAt]), refused('40001'), 'a stale screen is refused');
  assert.deepEqual(await agent('account_manager').then(a => [a.autonomy, a.config.auto_send_templates]), ['propose', []]);
  assert.equal((await row('select actor_id, metadata from private.audit_events where action = $1 and id > $2 order by id desc limit 1', ['agent.autonomy_step', auditFloor])).actor_id, owner);

  // The hourly task: nothing is due yet.
  let refuse = false;
  const notifier = { send: async message => { sent.push(message); return [{ channel: 'email', delivery: refuse ? 'failed' : 'sent' }]; } };
  const sent = [];
  const handler = autonomyHandlers({ store, notifier, publicOrigin: 'https://hub.test', features: new Set([autonomyFeature]), log: () => {} })['autonomy.graduate'];
  const task = { id: randomUUID(), agentKey: 'chief_of_staff', kind: 'autonomy.graduate', sourceKind: 'schedule' };
  assert.deepEqual((await handler(task)).result, { graduated: [], waiting: [], announced: [], reminded: [], delivery: [] });

  // Within a day of the end: one reminder. After the end: the switch, once, with one email.
  await admin.query("update private.agent_autonomy_steps set automatic_at = now() + interval '3 hours' where category = 'account_emails'");
  assert.deepEqual((await handler(task)).result.reminded, ['account_emails']);
  assert.match(sent.at(-1).subject, /^Account emails: on their own from /);
  await admin.query("update private.agent_autonomy_steps set supervised_since = now() - interval '8 days', automatic_at = now() - interval '1 minute' where category = 'account_emails'");
  // A supervised step whose code is missing waits past its date.
  const offers = await step('offers');
  await ownerCall('hub.set_agent_autonomy_step', ['offers', 'supervise', offers.changedAt]);
  await admin.query("update private.agent_autonomy_steps set supervised_since = now() - interval '8 days', automatic_at = now() - interval '1 minute' where category = 'offers'");
  const graduated = (await handler(task)).result;
  assert.deepEqual([graduated.graduated, graduated.waiting], [['account_emails'], ['offers:code_missing']]);
  assert.equal(sent.at(-1).subject, 'Account emails: now on their own');
  assert.deepEqual(await agent('account_manager').then(a => [a.autonomy, a.config.auto_send_templates]), ['act', ['setup_nudge', 'testimonial_ask', 'trial_checkin', 'welcome']]);
  assert.equal((await step('account_emails')).status, 'automatic');
  assert.equal((await row("select announce_pending from private.agent_autonomy_steps where category = 'account_emails'")).announce_pending, false, 'the owner was told, and that is recorded');
  assert.equal((await step('offers')).status, 'supervised');
  assert.deepEqual(await store.autonomyGraduate('account_emails').then(result => [result.graduated, result.reason]), [false, 'not_due'], 'a switched step is not switched again');
  assert.equal((await row("select count(*)::integer as n from private.audit_events where action = 'agent.autonomy_step' and metadata ->> 'source' = 'schedule' and id > $1", [auditFloor])).n, 1);

  // The owner takes it back: the four templates come off the list, and only those.
  await admin.query("update private.agents set config = jsonb_set(config, '{auto_approve_kinds}', '[\"growth.message\"]') where key = 'account_manager'");
  const automatic = await step('account_emails');
  const held = await ownerCall('hub.set_agent_autonomy_step', ['account_emails', 'hold', automatic.changedAt]);
  assert.equal(held.status, 'held');
  assert.deepEqual(await agent('account_manager').then(a => [a.config.auto_send_templates, a.config.auto_approve_kinds]), [[], ['growth.message']]);
  // Making it automatic early needs its code; account emails have it, offers (here) do not.
  const early = await ownerCall('hub.set_agent_autonomy_step', ['account_emails', 'automatic', held.changedAt]);
  assert.equal(early.status, 'automatic');
  await assert.rejects(ownerCall('hub.set_agent_autonomy_step', ['offers', 'automatic', (await step('offers')).changedAt]), refused('55000'));
  await assert.rejects(ownerCall('hub.set_agent_autonomy_step', ['account_emails', 'always', early.changedAt]), refused('22023'));
  await assert.rejects(ownerCall('hub.set_agent_autonomy_step', ['nothing', 'hold', early.changedAt]), refused('P0002'));

  // The deployment gate declares the feature again as it is, and refuses it when anything it checks has drifted.
  const gate = await readFile(new URL('../supabase/migrations/20261104220100_agent_autonomy_contract.sql', import.meta.url), 'utf8');
  const client = await admin.connect();
  try {
    await client.query('begin'); await client.query(gate); await client.query('rollback');
    for (const drift of [
      'grant select on private.agent_autonomy_steps to authenticated',
      'revoke execute on function private.agent_autonomy_graduate(text) from hub_app_server',
      'grant execute on function private.agent_autonomy_apply(text,text,uuid,text) to hub_app_server',
      'grant execute on function private.agent_autonomy_due() to authenticated',
      'alter function private.agent_autonomy_due() reset search_path',
      'grant execute on function hub.set_agent_autonomy_step(text,text,timestamptz) to anon',
      "delete from private.agent_autonomy_steps where category = 'offers'",
      "delete from private.agent_schedules where task_kind = 'autonomy.graduate'",
      "update private.agent_schedules set every_seconds = 86400 where task_kind = 'autonomy.graduate'",
      'revoke execute on function private.agent_autonomy_announced(text,timestamptz) from hub_app_server',
      'alter table private.agent_autonomy_steps disable row level security',
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  // A switch whose email is refused stays done, stays pending announcement, fails the task so it is retried, and is announced next time.
  await admin.query("update private.agent_autonomy_steps set status = 'supervised', supervised_since = now() - interval '8 days', automatic_at = now() - interval '1 minute' where category = 'account_emails'");
  refuse = true;
  await assert.rejects(handler(task), error => error?.code === 'notification_failed' && error.transient === true);
  assert.deepEqual(await row("select status, announce_pending from private.agent_autonomy_steps where category = 'account_emails'").then(r => [r.status, r.announce_pending]), ['automatic', true]);
  refuse = false;
  const retried = (await handler(task)).result;
  assert.deepEqual([retried.graduated, retried.announced], [[], ['account_emails']]);
  assert.equal((await row("select announce_pending from private.agent_autonomy_steps where category = 'account_emails'")).announce_pending, false);

  // Nothing the owner sees or the emails say carries more than the kind of work and its dates.
  for (const message of sent) assert.doesNotMatch(`${message.subject} ${message.body}`, /@|\+1\d{10}/);
  console.log('Autonomy integration passed: closed table and owner-only changes, stale screen and session refusals, supervised week, one reminder, one switch, code-missing wait, hold that keeps other trust, early hand-over. No email sent.');
} finally {
  for (const s of seedSteps) await admin.query('update private.agent_autonomy_steps set status=$2, supervised_since=$3, automatic_at=$4, changed_at=$5, changed_by=$6, requires_feature=$7, announce_pending=$8 where category=$1', [s.category, s.status, s.supervised_since, s.automatic_at, s.changed_at, s.changed_by, s.requires_feature, s.announce_pending]);
  for (const a of seedAgents) await admin.query('update private.agents set autonomy=$2, config=$3 where key=$1', [a.key, a.autonomy, a.config]);
  await admin.query("delete from private.audit_events where id > $1 and action = 'agent.autonomy_step'", [auditFloor]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
