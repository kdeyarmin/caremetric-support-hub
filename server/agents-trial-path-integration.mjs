// Stage 4 of the 2026-11-17 team review through the real roles (20261117230000_trial_path.sql): an Intel subscription that is only
// trialing is not a trial until Stripe confirms its card, and then counts once; the trial lands on its opportunity with its end date, an
// extension moves that date, and a counted trial that ends unpaid is recorded as lost (a sign-up that never added its card is not);
// Intel's three milestones are accepted as activity, and nothing else is; the Account Manager's facts carry the card, the activity and
// the county, so a sign-up without a card is due only the card reminder; a customer email refused for the day's cap or the growth
// contact gap waits (only with the feature, and only for those two reasons); only the Hub server may ask; and the gate refuses drift.
// Disposable loopback database only; no model is called, no email is sent and Stripe is never asked.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { growthService } from './growth/service.mjs';
import { growthStore } from './growth/store.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { lifecycleInput, planEmails } from './agents/accounts/lifecycle.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const agents = sqlAgentStore(pool, { fenced: true, trialPath: true });
const before = sqlAgentStore(pool, { fenced: true });
const service = growthService({ store: growthStore(pool), features: new Set(['platform.agents.customer-growth.v1', 'platform.agents.app-growth.v1']) });
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const server = async (fn, args = []) => (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as value`, args)).rows[0].value;
const gate = await readFile(new URL('../supabase/migrations/20261117230100_trial_path_contract.sql', import.meta.url), 'utf8');
const intel = (await row("select id from hub.products where slug='caremetric-intel'")).id;
const appKey = 'cmb_' + 't'.repeat(43);
const keyHash = createHash('sha256').update(appKey).digest('hex');
const tenants = [], tasks = [], actions = [];
const seedAgent = await row("select status, autonomy from private.agents where key='account_manager'");
const seedLive = (await row('select livemode from private.billing_settings'))?.livemode ?? null;
const subOf = label => `sub_trialpath${run}${label}`;

// One Intel customer: a tenant, its live billing contact and a trialing subscription that began now.
async function customer(label) {
  const id = randomUUID(); tenants.push(id);
  await admin.query('insert into hub.tenants (id, slug, name) values ($1, $2, $3)', [id, `trial-path-${run}-${label}`, `Trial Path ${label}`]);
  await admin.query('insert into private.billing_customers (tenant_id, stripe_customer_id, email, livemode, seen_at) values ($1, $2, $3, true, now())',
    [id, `cus_trialpath${run}${label}`, `owner-${label}-${run}@agency.example.org`]);
  await admin.query(`insert into private.billing_subscriptions (stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, livemode, stripe_created, seen_at, trial_start, trial_end)
    values ($1, $2, $3, $4, 'trialing', 'charge_automatically', true, clock_timestamp(), clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '30 days')`,
    [subOf(label), id, `cus_trialpath${run}${label}`, intel]);
  return { id, slug: `trial-path-${run}-${label}` };
}
const queued = async (label, kind) => Number((await row('select count(*) as n from private.growth_billing_outbox where subscription_id=$1 and kind=$2', [subOf(label), kind])).n);
const opportunityOf = tenant => row("select o.* from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where g.tenant_id=$1 and o.product='caremetric-intel'", [tenant]);
const factsOf = async slug => (await server('private.agent_lifecycle_snapshot', [10, slug, 'caremetric-intel', 0])).accounts[0];

try {
  // The facts read live billing only; another test may have left billing in test mode.
  await admin.query('update private.billing_settings set livemode = true');
  // ---- 1. A trial starts with its card ---------------------------------------------------------------------------------------------
  const carded = await customer('carded');
  const abandoned = await customer('abandoned');
  assert.equal(await queued('carded', 'trial_started'), 0, 'only trialing is not yet a trial');
  // As billing.mjs records Stripe's answer, through the server's own function.
  await server('private.billing_trial_card_record', [carded.id, [subOf('carded')], true]);
  assert.equal(await queued('carded', 'trial_started'), 1, 'the card\'s confirmation starts the trial');
  await server('private.billing_trial_card_record', [carded.id, [subOf('carded')], true]);
  assert.equal(await queued('carded', 'trial_started'), 1, 'a later check counts nothing again');
  await server('private.billing_trial_card_record', [abandoned.id, [subOf('abandoned')], false]);
  assert.equal(await queued('abandoned', 'trial_started'), 0, 'a check that finds no card starts nothing');
  await server('private.growth_drain_billing');
  const opened = await opportunityOf(carded.id);
  assert.deepEqual([opened.stage, opened.owner_agent], ['trial', 'account_manager'], 'the trial lands on its opportunity');
  assert.ok(opened.trial_end, 'with its end date');
  assert.equal(await opportunityOf(abandoned.id), undefined, 'a sign-up without a card opens nothing');

  // An extension moves the end date the Sales review reads.
  await admin.query("update private.billing_subscriptions set trial_end = trial_end + interval '14 days' where stripe_subscription_id = $1", [subOf('carded')]);
  const extended = await opportunityOf(carded.id);
  assert.equal(new Date(extended.trial_end).getTime(), new Date((await row('select trial_end from private.billing_subscriptions where stripe_subscription_id=$1', [subOf('carded')])).trial_end).getTime(),
    'an extended trial\'s new end reaches the opportunity');

  // ---- 2. Intel's milestones -------------------------------------------------------------------------------------------------------
  await admin.query('insert into private.billing_app_keys (product_id, key_hash, key_hint) values ($1, $2, $3)', [intel, keyHash, run.slice(0, 4)]);
  const issuer = (await row('select private.billing_issuer($1) as id', [intel])).id;
  const account = '000000000000' + run;
  await admin.query('insert into private.federated_tenants (issuer_id, external_tenant_hash, hub_tenant_id) values ($1, private.support_identity_hash($2), $3)', [issuer, account, carded.id]);
  const milestone = (metric, kind = 'active') => ({ account, eventKey: randomUUID(), kind, occurredAt: new Date().toISOString(), facts: { metric } });
  for (const metric of ['county_chosen', 'agency_saved', 'activated']) {
    assert.equal((await service.appActivity('Bearer ' + appKey, milestone(metric))).replay, false, `${metric} is accepted`);
  }
  await assert.rejects(service.appActivity('Bearer ' + appKey, milestone('county_chosen', 'heartbeat')), error => error.status === 400, 'a milestone is only an active event');
  await assert.rejects(server('private.growth_app_event', [keyHash, milestone('county_chosen', 'first_value')]), error => error.code === '22023', 'the database refuses one on first value');
  await assert.rejects(server('private.growth_app_event', [keyHash, milestone('county_chosen', 'heartbeat')]), error => error.code === '22023', 'and on a heartbeat');
  await assert.rejects(server('private.growth_app_event', [keyHash, milestone('something_else')]), error => error.code === '22023', 'and any other metric');

  // ---- 3. The Account Manager's facts and plan ------------------------------------------------------------------------------------
  const cardedFacts = await factsOf(carded.slug);
  assert.ok(cardedFacts.cardConfirmedAt, 'the card\'s first confirmation');
  assert.ok(cardedFacts.activeAt, 'the last activity');
  assert.equal(cardedFacts.firstValueAt, null);
  assert.equal(cardedFacts.countyChosen, true);
  const abandonedFacts = await factsOf(abandoned.slug);
  assert.equal(abandonedFacts.cardConfirmedAt, null);
  const tomorrow = new Date(Date.now() + 86_400_000);
  assert.deepEqual(planEmails([abandonedFacts], tomorrow, { trialPath: true }).candidates.map(entry => entry.template), ['card_reminder'],
    'a sign-up without a card is due only the card reminder');
  assert.deepEqual(planEmails([cardedFacts], tomorrow, { trialPath: true }).candidates.map(entry => entry.template), ['welcome'],
    'a trial with its card is welcomed');

  // ---- 4. A refused customer email waits ------------------------------------------------------------------------------------------
  await admin.query("update private.agents set status='active', autonomy='act' where key='account_manager'");
  // One task per email (an action is unique to its task).
  const email = async template => {
    const task = (await row("insert into private.agent_tasks (agent_key, kind, request_key, status, attempts, lease_until) values ('account_manager', 'accounts.lifecycle', $1, 'running', 1, now() + interval '10 minutes') returning id", [`trial-path:${run}:${template}`])).id;
    tasks.push(task);
    const input = lifecycleInput(cardedFacts, template);
    const id = (await row(`insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview, input, status)
      values ($1, 'account_manager', 'email.send', 'billing_account', $2, 'Subject: test', $3, 'auto_approved') returning id`, [task, input.tenant, input])).id;
    actions.push(id); return id;
  };
  const begin = async id => {
    await admin.query("update private.agent_actions set status='auto_approved', executing_at=null, not_before=null where id=$1", [id]);
    return (await agents.beginExecution(id)).execution;
  };
  const capped = await email('welcome');
  assert.equal(await agents.deferExecution(capped, await begin(capped), 'email.send', 'daily_limit'), true);
  const waitedCap = await row('select status, not_before from private.agent_actions where id=$1', [capped]);
  const nineTomorrow = (await row("select (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day 9 hours') at time zone 'America/New_York' as t")).t;
  assert.deepEqual([waitedCap.status, new Date(waitedCap.not_before).getTime()], ['auto_approved', new Date(nineTomorrow).getTime()], 'over the cap: 9 AM Eastern tomorrow');
  const gap = await email('midtrial_nudge');
  assert.equal(await agents.deferExecution(gap, await begin(gap), 'email.send', 'frequency_limited'), true);
  const hours = (new Date((await row('select not_before from private.agent_actions where id=$1', [gap])).not_before).getTime() - Date.now()) / 3_600_000;
  assert.ok(hours > 23.9 && hours <= 24.01, `inside the growth contact gap: a day (${hours.toFixed(2)} hours)`);
  const other = await email('value_followup');
  const started = await begin(other);
  assert.equal(await agents.deferExecution(other, started, 'email.send', 'suppressed'), false, 'any other refusal ends it, as before');
  assert.equal(await agents.deferExecution(other, 999, 'email.send', 'daily_limit'), false, 'another start is refused');
  assert.equal(await before.deferExecution?.(other, started, 'email.send', 'daily_limit') ?? false, false, 'never without the feature');

  // ---- 5. The end of a trial -------------------------------------------------------------------------------------------------------
  await admin.query("update private.billing_subscriptions set status='canceled' where stripe_subscription_id = any($1::text[])", [[subOf('carded'), subOf('abandoned')]]);
  assert.equal(await queued('carded', 'churned'), 1, 'a counted trial that ended unpaid is lost');
  assert.equal(await queued('abandoned', 'churned'), 0, 'a sign-up that never added its card is not');
  await server('private.growth_drain_billing');
  assert.equal((await opportunityOf(carded.id)).stage, 'churned', 'and the Sales review stops listing it as a trial');
  assert.ok((await row('select first_confirmed_at from private.growth_trial_cards where stripe_subscription_id=$1', [subOf('carded')])).first_confirmed_at, 'the card outlives the trial');

  // ---- 6. Only the Hub server may ask ---------------------------------------------------------------------------------------------
  const client = await admin.connect();
  try {
    for (const role of ['authenticated', 'anon', 'service_role']) {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      await assert.rejects(client.query('select private.agent_lifecycle_defer($1, 1, $2)', [capped, 'daily_limit']), error => error.code === '42501', `${role} may not defer an email`);
      await client.query('rollback');
    }
  } finally { client.release(); }

  // ---- 7. The gate refuses drift ----------------------------------------------------------------------------------------------------
  const gated = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    await gated.query('begin'); await gated.query(gate); await gated.query(gate); await gated.query('rollback');
    const drifts = [
      'drop trigger growth_trial_card_seen on private.billing_trial_cards',
      'grant select on private.growth_trial_cards to hub_app_server',
      'grant execute on function private.agent_lifecycle_defer(uuid,integer,text) to authenticated',
      'grant execute on function private.agent_lifecycle_json(integer,text,text,integer) to hub_app_server',
      rewrite('private.growth_capture_billing()', "and v_product<>'caremetric-intel' then", 'then'),
      rewrite('private.sales_handoff(uuid,uuid)', "'nurture', 'trial')", "'nurture')"),
      rewrite('private.growth_app_event(text,jsonb)', "'county_chosen',", "'county_picked',"),
      `alter table private.agent_lifecycle_emails drop constraint agent_lifecycle_emails_template_check, add constraint agent_lifecycle_emails_template_check
        check (template in ('welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask', 'cancel_save', 'trial_ended'))`,
    ];
    for (const drift of drifts) {
      await gated.query('begin');
      try {
        await gated.query(drift);
        await assert.rejects(gated.query(gate), error => error.code === '55000', `the gate refuses: ${drift.slice(0, 90)}`);
      } finally { await gated.query('rollback'); }
    }
    console.log(`Trial path integration passed: an Intel trial counted from its card's first confirmation and once, the trial on its opportunity, an extension's end date, a lost trial and none for a sign-up without a card; three milestones accepted and four misuses refused; the facts carry the card, activity and county, so a sign-up without a card is due only the card reminder; a capped email waits until 9 AM Eastern, one inside the contact gap a day, any other refusal ends it and never without the feature; server-only access and ${drifts.length} kinds of gate drift. Stripe was not asked and no email was sent.`);
  } finally { gated.release(); }
} finally {
  await admin.query("update private.agents set status=$1, autonomy=$2 where key='account_manager'", [seedAgent.status, seedAgent.autonomy]);
  await admin.query('update private.billing_settings set livemode = $1', [seedLive]);
  await admin.query('delete from private.billing_app_keys where key_hash=$1', [keyHash]);
  await admin.query("delete from private.audit_events where entity_type='agent_action' and entity_id=any($1::uuid[])", [actions]);
  await admin.query('delete from private.agent_actions where id=any($1::uuid[]) or task_id=any($2::uuid[])', [actions, tasks]);
  await admin.query('delete from private.agent_tasks where id=any($1::uuid[])', [tasks]);
  await admin.query('delete from private.growth_billing_outbox where tenant_id=any($1::uuid[])', [tenants]);
  const orgs = (await admin.query('select id from private.growth_organizations where tenant_id=any($1::uuid[])', [tenants])).rows.map(r => r.id);
  await admin.query('delete from private.growth_messages where opportunity_id in (select id from private.growth_opportunities where organization_id=any($1::uuid[]))', [orgs]);
  await admin.query('delete from private.customer_success_plans where opportunity_id in (select id from private.growth_opportunities where organization_id=any($1::uuid[]))', [orgs]);
  await admin.query('delete from private.customer_activity_events where organization_id=any($1::uuid[])', [orgs]);
  await admin.query('delete from private.growth_opportunities where organization_id=any($1::uuid[])', [orgs]);
  await admin.query("delete from private.audit_events where entity_id=any($1::uuid[])", [orgs]);
  await admin.query('delete from private.growth_organizations where id=any($1::uuid[])', [orgs]);
  await admin.query('delete from private.federated_tenants where hub_tenant_id=any($1::uuid[])', [tenants]);
  await admin.query('delete from private.billing_subscriptions where tenant_id=any($1::uuid[])', [tenants]);
  await admin.query('delete from private.billing_customers where tenant_id=any($1::uuid[])', [tenants]);
  await admin.query('delete from hub.tenants where id=any($1::uuid[])', [tenants]);
  await pool.end(); await admin.end();
}
