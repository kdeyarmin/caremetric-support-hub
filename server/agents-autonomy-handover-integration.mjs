// The owner's 2026-11-15 hand-over through the real roles (20261115200000_autonomy_handover.sql): the four steps ship held; a named
// person's address the agency published or its mail server confirmed is permitted on its own only while "Named people's email addresses"
// is automatic, never past an opt-out or a "not interested", and an unsubscribed one is still refused; the Monday memo is used on its own
// only while "Learning memo" is automatic, audited as the owner's choice; a campaign or founder post is approved automatically only while
// its step is automatic, re-checked when carried out, and a founder post handed back to wait for its slot keeps its approval; live
// campaigns reserve their share of the owner's monthly number (lowered to what is left and to the daily limit, in their own month only);
// and the gate refuses drift. Disposable loopback database only; nothing is sent, posted or spent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';
import { sqlAgentStore } from './agents/store.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const growth = growthStore(pool);
const agents = sqlAgentStore(pool, { fenced: true, growth: true, social: true, handover: true });
const run = randomUUID().slice(0, 8);
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261115200100_autonomy_handover_contract.sql', import.meta.url), 'utf8');
const categories = ['named_contacts', 'learning_memo', 'ad_campaigns', 'founder_posts'];
const started = new Date();
const seedSteps = (await admin.query('select * from private.agent_autonomy_steps where category = any($1)', [categories])).rows;
const seedAgents = (await admin.query("select key, status, autonomy, config from private.agents where key in ('marketing_manager', 'social_manager')")).rows;
const seedMemoRows = (await admin.query('select id, status, decided_at from private.growth_learning_memos')).rows;
const seedMemos = seedMemoRows.map(item => item.id);
const owner = randomUUID();
const seedSettings = (await admin.query("select key, value from private.hub_settings where key in ('ads.monthly_budget_cents', 'social.max_daily_budget_cents')")).rows;
const orgs = [], tasks = [], suppressed = [];
const step = (category, action) => admin.query('select private.agent_autonomy_apply($1, $2, null, $3)', [category, action, 'handover-integration']);
const easternMonth = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).format(date).slice(0, 7);
async function runningTask(agent, kind) {
  const created = await row("insert into private.agent_tasks (agent_key, kind, request_key, status, claimed_at, lease_until, attempts) values ($1, $2, $3, 'running', now(), now() + interval '10 minutes', 1) returning id",
    [agent, kind, `handover-it-${run}-${tasks.length}`]);
  tasks.push(created.id);
  return created.id;
}
async function prospect(label) {
  const domain = `${label}-${run}.example.org`;
  await growth.discover('caremetric-intel', [{ name: `Synthetic ${label}`, domain, url: `https://${domain}/`, claim: 'A Medicare-certified hospice.' }]);
  const org = (await row('select id from private.growth_organizations where domain = $1', [domain])).id;
  orgs.push(org);
  const [person] = await growth.peopleRecord(org, [{ name: 'Jane Doe', title: 'Administrator', source: 'website', sourceUrl: `https://${domain}/team` }]);
  return { org, domain, person: person.id };
}

try {
  // ---- 1. The steps ship held ------------------------------------------------------------------------------------------------------
  assert.deepEqual(seedSteps.map(item => [item.category, item.status]).sort(), categories.map(category => [category, 'held']).sort(), 'The four steps ship held');
  await admin.query('insert into auth.users (id, email, is_anonymous) values ($1, $2, false)', [owner, `handover-owner-${run}@test.invalid`]);
  await admin.query("update private.agents set status = 'active', autonomy = 'propose', config = jsonb_set(config, '{auto_approve_kinds}', '[]') where key in ('marketing_manager', 'social_manager')");

  // ---- 2. Named people's email addresses -----------------------------------------------------------------------------------------
  const before = await prospect('handover-before');
  const waiting = await growth.personAddress(before.person, `jane.doe@${before.domain}`, 'Jane Doe', 'mail_server', null);
  assert.equal(waiting.eligibility, 'review', 'Held, a confirmed address waits for the owner');
  await step('named_contacts', 'automatic');
  assert.deepEqual(await row("select autonomy, config -> 'auto_approve_kinds' as kinds from private.agents where key = 'marketing_manager'"), { autonomy: 'act', kinds: ['growth.named_contact'] });
  const handed = await prospect('handover-on');
  const permitted = await growth.personAddress(handed.person, `jdoe@${handed.domain}`, 'Jane Doe', 'published', `https://www.${handed.domain}/team`);
  assert.equal(permitted.eligibility, 'permitted', 'Handed over, a published address is permitted on its own');
  const contact = await row('select eligibility, version, source_kind from private.growth_contacts where id = $1', [permitted.contactId]);
  assert.deepEqual([contact.eligibility, contact.source_kind, contact.version > 1], ['permitted', 'enriched', true], 'as the owner\'s Permit does');
  assert.ok((await admin.query('select contact_id from private.growth_opportunities where organization_id = $1', [handed.org])).rows.every(item => item.contact_id === permitted.contactId),
    'and it becomes the contact of the business\'s opportunities');
  assert.equal((await row("select metadata ->> 'approval' as approval from private.audit_events where action = 'growth.person_permitted' and entity_id = $1", [handed.org])).approval, 'automatic');
  const optedOut = await prospect('handover-optout');
  await admin.query("insert into private.growth_contacts (organization_id, email, eligibility, verified_at) values ($1, $2, 'opted_out', now())", [optedOut.org, `office@${optedOut.domain}`]);
  assert.equal((await growth.personAddress(optedOut.person, `jane@${optedOut.domain}`, 'Jane Doe', 'mail_server', null)).eligibility, 'review', 'An opt-out at the business still wins');
  const declined = await prospect('handover-declined');
  await admin.query("insert into private.customer_activity_events (product, organization_id, event_key, kind, occurred_at) values ('caremetric-intel', $1, $2, 'negative_reply', now())", [declined.org, `handover-${run}`]);
  assert.equal((await growth.personAddress(declined.person, `jane@${declined.domain}`, 'Jane Doe', 'mail_server', null)).eligibility, 'review', 'So does "not interested"');
  const unsubscribed = await prospect('handover-unsub');
  suppressed.push(digest(`jane@${unsubscribed.domain}`));
  await admin.query('insert into private.email_suppressions (email_hash) values ($1)', [suppressed[0]]);
  assert.deepEqual(await growth.personAddress(unsubscribed.person, `jane@${unsubscribed.domain}`, 'Jane Doe', 'mail_server', null), { found: false, reason: 'suppressed' });
  await assert.rejects(growth.personAddress(unsubscribed.person, `guess@${unsubscribed.domain}`, 'Jane Doe', 'guessed', null), refused('22023'), 'An unconfirmed guess is never recorded');
  await admin.query("update private.agents set status = 'paused' where key = 'marketing_manager'");
  const paused = await prospect('handover-paused');
  assert.equal((await growth.personAddress(paused.person, `jane@${paused.domain}`, 'Jane Doe', 'mail_server', null)).eligibility, 'review', 'Paused, the agent permits nothing');
  await admin.query("update private.agents set status = 'active' where key = 'marketing_manager'");
  await step('named_contacts', 'hold');

  // ---- 3. The learning memo ---------------------------------------------------------------------------------------------------------
  const proposed = await growth.learningPropose('carebase', `Held memo ${run}.`, { sent: 1 });
  assert.deepEqual([proposed.proposed, proposed.activated], [true, false], 'Held, a memo is proposed for the owner');
  assert.equal(await growth.learningActive('carebase').then(memo => memo?.memo === `Held memo ${run}.`), false);
  await step('learning_memo', 'automatic');
  const same = await growth.learningPropose('carebase', `Held memo ${run}.`, { sent: 1 });
  assert.deepEqual([same.reason, same.activated], ['unchanged', true], 'Handed over, the waiting proposal is used rather than written again');
  const used = await growth.learningPropose('carebase', `Used memo ${run}.`, { sent: 2 });
  assert.deepEqual([used.proposed, used.activated], [true, true], 'Handed over, a new memo is used at once');
  assert.deepEqual(await growth.learningActive('carebase'), { version: used.version, memo: `Used memo ${run}.` });
  assert.equal((await row('select status from private.growth_learning_memos where product = $1 and memo = $2', ['carebase', `Held memo ${run}.`])).status, 'retired', 'The earlier memo retires');
  assert.equal((await row("select count(*)::int as n from private.audit_events where action = 'growth.memo_activated' and metadata ->> 'approval' = 'automatic' and metadata ->> 'version' = $1", [String(used.version)])).n, 1);
  await step('learning_memo', 'hold');

  // ---- 4. Founder posts and campaigns: approved automatically only while their step is automatic ------------------------------------
  const plan = await runningTask('social_manager', 'social.plan');
  await admin.query("update private.agents set autonomy = 'act', config = jsonb_set(config, '{auto_approve_kinds}', '[\"social.founder_post\"]') where key = 'social_manager'");
  const day = `2099-${String(1 + (parseInt(run.slice(0, 2), 16) % 12)).padStart(2, '0')}-${String(1 + (parseInt(run.slice(2, 4), 16) % 28)).padStart(2, '0')}`;
  await assert.rejects(agents.proposeAction({ taskId: plan, kind: 'social.founder_post', targetKind: 'social_item', targetId: `founder:${day}:1`, preview: 'A post', input: {} }), refused('23514'),
    'Trusted by hand while the step is held, a founder post is still refused an automatic approval');
  await admin.query("update private.agents set autonomy = 'propose', config = jsonb_set(config, '{auto_approve_kinds}', '[]') where key = 'social_manager'");
  await step('founder_posts', 'automatic');
  const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const post = await agents.proposeAction({ taskId: plan, kind: 'social.founder_post', targetKind: 'social_item', targetId: `founder:${day}:2`, preview: 'A post',
    input: { product: 'caremetric-intel', message: 'A post', scheduledFor: later } });
  assert.equal(post.status, 'auto_approved', 'Handed over, a founder post is approved automatically');
  const execution = await agents.beginExecution(post.id);
  assert.equal(await agents.actionTrusted(post.id, execution.execution), true, 'and is still trusted when carried out');
  assert.equal(await agents.actionTrusted(post.id, execution.execution + 1), false, 'by its own execution only');
  assert.equal(await agents.deferExecution(post.id, execution.execution, 'social.founder_post'), true, 'Started early, it is handed back');
  assert.equal((await row('select status from private.agent_actions where id = $1', [post.id])).status, 'auto_approved', 'keeping its automatic approval');
  await admin.query('update private.agent_actions set not_before = null where id = $1', [post.id]);
  const again = await agents.beginExecution(post.id);
  await step('founder_posts', 'hold');
  assert.equal(await agents.actionTrusted(post.id, again.execution), false, 'Held since, it is no longer trusted to go out');

  // ---- 5. Live campaigns reserve their share of the month ---------------------------------------------------------------------------
  await admin.query("insert into private.hub_settings (key, kind) values ('ads.monthly_budget_cents', 'number'), ('social.max_daily_budget_cents', 'number') on conflict (key) do nothing");
  await admin.query("update private.hub_settings set value = '30000' where key = 'ads.monthly_budget_cents'");
  await admin.query("update private.hub_settings set value = '800' where key = 'social.max_daily_budget_cents'");
  const month = easternMonth(new Date());
  const ads = await runningTask('social_manager', 'ads.plan');
  const ownerApproved = await agents.proposeAction({ taskId: ads, kind: 'social.campaign_create', targetKind: 'social_item', targetId: `linkedin:carebase:${month}`, preview: 'A campaign', input: {} });
  assert.equal(ownerApproved.status, 'proposed', 'Held, a campaign waits for the owner');
  await step('ad_campaigns', 'automatic');
  const campaign = async (target, kind = 'social.campaign_create') => {
    const action = await agents.proposeAction({ taskId: ads, kind, targetKind: 'social_item', targetId: target, preview: 'A campaign', input: {} });
    assert.equal(action.status, 'auto_approved', `Handed over, ${target} is approved automatically`);
    return { id: action.id, execution: (await agents.beginExecution(action.id)).execution };
  };
  // The owner's numbers: $300 a month for new campaigns, $8 a day for any ad set.
  const first = await campaign(`meta:caremetric-intel:${month}`);
  assert.equal(await agents.actionTrusted(first.id, first.execution), true);
  const reserved = await agents.adsLaunchReserve(first.id, first.execution, 1000, 500, 10);
  assert.deepEqual([reserved.reserved, reserved.dailyBudgetCents, reserved.committedCents], [true, 800, 8000], 'Lowered to the daily ad-set limit');
  assert.equal((await agents.adsLaunchReserve(first.id, first.execution, 1000, 500, 10)).already, true, 'Asking again returns the same reservation');
  const second = await campaign(`google:caremetric-intel:${month}`, 'social.google_campaign');
  assert.deepEqual(await agents.adsLaunchReserve(second.id, second.execution, 1000, 500, 25).then(r => [r.dailyBudgetCents, r.usedCents]), [800, 28000]);
  const third = await campaign(`meta:carebase:${month}`);
  const refusedShare = await agents.adsLaunchReserve(third.id, third.execution, 1000, 500, 10);
  assert.deepEqual([refusedShare.reserved, refusedShare.reason, refusedShare.remainingCents], [false, 'monthly_budget_used', 2000], 'Never past the month\'s number');
  assert.equal(await agents.adsLaunchRelease(second.id, second.execution), true, 'A campaign not launched gives its share back');
  assert.equal((await agents.adsLaunchReserve(third.id, third.execution, 1000, 500, 10)).dailyBudgetCents, 800, 'which the next one can use');
  await assert.rejects(pool.query('select * from private.ads_launch_reservations'), refused('42501'), 'The reservations are closed to the server role');
  const old = await campaign('meta:caremetric-intel:2020-01');
  assert.equal((await agents.adsLaunchReserve(old.id, old.execution, 1000, 500, 10)).reason, 'month_over', 'Only in its own month');
  await admin.query("update private.agent_actions set status = 'approved', decided_at = now(), decided_by = $2 where id = $1", [ownerApproved.id, owner]);
  const mine = await agents.beginExecution(ownerApproved.id);
  assert.equal((await agents.adsLaunchReserve(ownerApproved.id, mine.execution, 1000, 500, 10)).reason, 'owner_approved', 'The owner\'s approval is never launched live here');
  await step('ad_campaigns', 'hold');
  const heldCampaign = await row("select id, executions from private.agent_actions where task_id = $1 and target_id = $2", [ads, `google:caremetric-intel:${month}`]);
  assert.equal((await agents.adsLaunchReserve(heldCampaign.id, heldCampaign.executions, 1000, 500, 10)).reason, 'approval_required', 'Held again, nothing more is reserved');
  assert.equal(await agents.actionTrusted(first.id, first.execution), false, 'and nothing approved automatically is still trusted');

  // ---- 6. The gate refuses drift --------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    for (const drift of [
      'grant execute on function private.ads_launch_reserve(uuid,integer,integer,integer,integer) to authenticated',
      'grant select on private.ads_launch_reservations to hub_app_server',
      'drop trigger agent_actions_handover_guard on private.agent_actions',
      "update private.agent_autonomy_steps set changes = '[{\"agent\": \"social_manager\", \"config_key\": \"auto_approve_kinds\", \"values\": [\"social.ad_budget\"]}]' where category = 'ad_campaigns'",
      rewrite('private.growth_person_address(uuid,text,text,text,text)', "c.eligibility = 'opted_out'", 'false'),
      rewrite('private.ads_launch_reserve(uuid,integer,integer,integer,integer)', "private.ads_setting_cents('social.max_daily_budget_cents')", 'null'),
      rewrite('private.social_schedule(uuid,integer)', "case when decided_by is null then 'auto_approved' else 'approved' end", "'approved'"),
      rewrite('private.agent_action_trusted(uuid,integer)', "v_agent.autonomy = 'act'", 'true'),
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Hand-over integration passed: the four steps ship held; named people\'s addresses, the learning memo, campaigns and founder posts go on their own only while their step is automatic and are re-checked when carried out; opt-outs, unsubscribes and unconfirmed guesses still win; live campaigns stay within the month\'s number and the daily limit; and the gate refuses drift. Nothing was sent, posted or spent.');
} finally {
  if (tasks.length) {
    await admin.query("delete from private.audit_events where entity_id in (select id from private.agent_actions where task_id = any($1::uuid[]))", [tasks]);
    await admin.query('delete from private.agent_actions where task_id = any($1::uuid[])', [tasks]);
    await admin.query('delete from private.agent_tasks where id = any($1::uuid[])', [tasks]);
  }
  for (const org of orgs) {
    await admin.query('delete from private.customer_activity_events where organization_id = $1', [org]);
    await admin.query('update private.growth_people set contact_id = null where organization_id = $1', [org]);
    await admin.query('delete from private.growth_people where organization_id = $1', [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in (select id from private.growth_opportunities where organization_id = $1)', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id = $1', [org]);
    await admin.query('delete from private.growth_contacts where organization_id = $1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id = $1", [org]);
    await admin.query('delete from private.growth_organizations where id = $1', [org]);
  }
  await admin.query('delete from private.email_suppressions where email_hash = any($1::text[])', [suppressed]);
  await admin.query('delete from private.growth_learning_memos where not (id = any($1::uuid[]))', [seedMemos]);
  for (const m of seedMemoRows) await admin.query('update private.growth_learning_memos set status = $2, decided_at = $3 where id = $1', [m.id, m.status, m.decided_at]);
  await admin.query("delete from private.audit_events where action = 'growth.memo_activated' and created_at >= $1 and metadata ->> 'approval' = 'automatic'", [started]);
  await admin.query("delete from private.audit_events where action = 'agent.autonomy_step' and metadata ->> 'source' = 'handover-integration'");
  for (const s of seedSteps) await admin.query('update private.agent_autonomy_steps set status = $2, supervised_since = $3, automatic_at = $4, announce_pending = $5, changed_at = $6, changed_by = $7, changes = $8 where category = $1',
    [s.category, s.status, s.supervised_since, s.automatic_at, s.announce_pending, s.changed_at, s.changed_by, JSON.stringify(s.changes)]);
  for (const a of seedAgents) await admin.query('update private.agents set status = $2, autonomy = $3, config = $4 where key = $1', [a.key, a.status, a.autonomy, a.config]);
  for (const key of ['ads.monthly_budget_cents', 'social.max_daily_budget_cents']) {
    const seed = seedSettings.find(item => item.key === key);
    await admin.query('update private.hub_settings set value = $2 where key = $1', [key, seed?.value == null ? null : JSON.stringify(seed.value)]);
  }
  await admin.query('delete from auth.users where id = $1', [owner]);
  await pool.end(); await admin.end();
}
