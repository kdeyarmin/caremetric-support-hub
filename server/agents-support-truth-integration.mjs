// Stage 5 of the 2026-11-17 team review through the real roles (20261117240000_support_truth.sql): the standard acknowledgment is the
// only thing the new kind admits; trusted and switched on it is sent by the tick's drain without the owner's session, written by the AI
// assistant, and refused once the switch is off, to a machine, a colleague or a moved thread; a lead answered only by an acknowledgment
// still waits for its first reply; the Concierge's snapshot carries the sender's account flags; the watchdog, scorecard and strategist
// facts carry what stage 5 reads; only the Hub server may record an acknowledgment; and the gate refuses drift. Disposable loopback
// database only; the email sender is a fake and nothing leaves the machine.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { communications } from './communications.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { actionExecutor } from './agents/actions.mjs';
import { conciergeExecutors } from './agents/concierge/index.mjs';
import { replyBody } from './agents/concierge/templates.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = sqlAgentStore(pool, { fenced: true });
const run = randomUUID().slice(0, 8);
const aiAssistant = 'a1a00000-a1a0-4000-8000-000000000001';
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const server = async (fn, args = []) => (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as value`, args)).rows[0].value;
const refused = code => error => error?.code === code;
const outbox = [];
const email = { configured: true, send: async (to, subject, content) => { outbox.push({ to, subject, text: content.text }); return { delivery: 'sent', id: `fixture-${outbox.length}` }; } };
const inbox = communications({ pool, delegations: {}, publicOrigin: 'https://hub.test', chatEnabled: true, sms: { configured: false }, email });
const notifier = { send: async () => [{ channel: 'email', delivery: 'sent' }] };
const features = new Set(['platform.agents.concierge.v1', 'platform.agents.concierge-autosend.v1', 'platform.agents.support-truth.v1']);
const actions = actionExecutor({ store, executors: conciergeExecutors({ communications: inbox, store, notifier, features, log: () => {} }), log: () => {} });
const gate = await readFile(new URL('../supabase/migrations/20261117240100_support_truth_contract.sql', import.meta.url), 'utf8');
const seedConcierge = await row("select status, autonomy, config from private.agents where key = 'support_concierge'");
const seedSwitch = await row("select value, changed_at, changed_by from private.hub_settings where key = 'agents.auto_acknowledge'");
const seedLive = (await row('select livemode from private.billing_settings'))?.livemode ?? null;
const made = [], tasks = [], tenants = [], leads = [];
const standard = replyBody('standard', 'email');

let counter = 0;
async function conversation(address = `pat-${run}-${counter + 1}@agency.example`) {
  counter += 1;
  const created = await row(`insert into private.communications(channel, source_system, source_key, status, subject, contact_name, contact_email)
    values ('email', 'hub.email', $1, 'new', 'A question', 'Pat Example', $2) returning id, reference`, [`truth-${run}-${counter}`, address]);
  made.push(created.id);
  const message = await row("insert into private.communication_messages(communication_id, direction, body, delivery) values ($1, 'inbound', 'How do I export the roster?', 'received') returning id", [created.id]);
  return { id: created.id, reference: Number(created.reference), head: message.id };
}
async function task() {
  const id = (await row("insert into private.agent_tasks(agent_key, kind, request_key, status, attempts, lease_until) values ('support_concierge', 'concierge.communication', $1, 'running', 1, now() + interval '10 minutes') returning id", [`truth-${run}-${randomUUID()}`])).id;
  tasks.push(id); return id;
}
const ackInput = (c, over = {}) => ({ communicationId: c.id, reference: c.reference, channel: 'email', route: 'email', basedOnMessageId: c.head,
  body: standard, classification: { category: 'general', phi: false }, template: 'standard', ...over });
const propose = async (c, over = {}) => store.proposeAction({ taskId: await task(), kind: 'communication.acknowledge', targetKind: 'communication', targetId: `CM-${c.reference}`, preview: 'Hello', input: ackInput(c, over) });
const trust = async on => admin.query("update private.agents set status = 'active', autonomy = $1, config = jsonb_set(config, '{auto_approve_kinds}', $2::jsonb) where key = 'support_concierge'",
  [on ? 'act' : 'propose', on ? '["communication.answer", "communication.acknowledge"]' : '[]']);
const switchOn = on => admin.query("update private.hub_settings set value = $1 where key = 'agents.auto_acknowledge'", [on ? 'true' : 'false']);
const result = async id => (await row('select status, result from private.agent_actions where id = $1', [id]));

try {
  // ---- 1. What the kind admits --------------------------------------------------------------------------------------------------
  await trust(true); await switchOn(true);
  const shape = await conversation();
  for (const over of [{ body: 'Hello,\n\nWe will call you tomorrow.' }, { template: 'sales' }, { route: 'sms' }, { classification: { category: 'general', phi: true } },
    { classification: { category: 'general', phi: false, drafted: true } }, { sources: ['x'] }]) {
    await assert.rejects(propose(shape, over), refused('23514'), JSON.stringify(over));
  }

  // ---- 2. Trusted and switched on: sent by the drain with no session, by the AI assistant ------------------------------------------
  const first = await conversation();
  const auto = await propose(first);
  assert.equal(auto.status, 'auto_approved', 'the support answers step hands the acknowledgment over');
  assert.equal((await actions.executeReady()).executed, 1);
  assert.deepEqual(await result(auto.id).then(r => [r.status, r.result.delivery, r.result.author]), ['executed', 'sent', 'ai_assistant']);
  const sent = await row("select author_id, body, delivery, request_key from private.communication_messages where communication_id = $1 and direction = 'outbound'", [first.id]);
  assert.deepEqual([sent.author_id, sent.body, sent.delivery], [aiAssistant, standard, 'sent']);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].subject, `Re: Your message to CareMetric support [CM-${first.reference}]`);

  // ---- 3. Refusals ---------------------------------------------------------------------------------------------------------------
  const machine = await conversation(`noreply-${run}@vendor.example`);
  const toMachine = await propose(machine);
  const moving = await conversation();
  const moved = await propose(moving);
  await admin.query("insert into private.communication_messages(communication_id, direction, body, delivery, created_at) values ($1, 'inbound', 'One more thing', 'received', now() + interval '1 second')", [moving.id]);
  await actions.executeReady();
  assert.deepEqual(await result(toMachine.id).then(r => [r.status, r.result.error]), ['failed', 'not_a_person']);
  assert.deepEqual(await result(moved.id).then(r => [r.status, r.result.error]), ['failed', 'thread_changed']);
  const late = await propose(await conversation());
  assert.equal(late.status, 'auto_approved');
  await switchOn(false);
  await actions.executeReady();
  assert.deepEqual(await result(late.id).then(r => [r.status, r.result.error]), ['failed', 'acknowledge_off'], 'the switch is read when it is sent');
  assert.equal(outbox.length, 1, 'nothing else was sent');

  // ---- 4. An acknowledgment is not an answer ------------------------------------------------------------------------------------
  const lead = (await row(`insert into private.leads (kind, source, external_id, communication_id, status, test, occurred_at, received_at, contact_email)
    values ('contact', 'intel', $1, $2, 'new', false, now() - interval '1 hour', now() - interval '1 hour', $3) returning id`, [`truth-${run}`, first.id, `pat-${run}-2@agency.example`])).id;
  leads.push(lead);
  const waiting = async () => Number((await admin.query('select count(*) as n from private.agent_growth_waiting() where lead_id = $1', [lead])).rows[0].n);
  assert.equal(await waiting(), 1, 'the lead answered only by the acknowledgment still waits');
  await admin.query("insert into private.communication_messages(communication_id, direction, body, delivery, delivery_channel, created_at) values ($1, 'outbound', 'Yes: Reports, then Export.', 'sent', 'email', now() + interval '2 seconds')", [first.id]);
  assert.equal(await waiting(), 0, 'a real answer ends it');

  // ---- 5. The snapshot's account flags --------------------------------------------------------------------------------------------
  await admin.query('update private.billing_settings set livemode = true');
  const tenant = randomUUID(); tenants.push(tenant);
  await admin.query('insert into hub.tenants (id, slug, name) values ($1, $2, $3)', [tenant, `truth-${run}`, 'Truth tenant']);
  await admin.query('insert into private.billing_customers (tenant_id, stripe_customer_id, email, livemode, seen_at) values ($1, $2, $3, true, now())', [tenant, `cus_truth${run}`, `trial-${run}@agency.example`]);
  await admin.query(`insert into private.billing_subscriptions (stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, livemode, stripe_created, seen_at, trial_start, trial_end)
    select $1, $2, $3, id, 'trialing', 'charge_automatically', true, now(), now(), now(), now() + interval '30 days' from hub.products where slug = 'carebase'`, [`sub_truth${run}`, tenant, `cus_truth${run}`]);
  const trialing = await conversation(`trial-${run}@agency.example`);
  const flags = (await store.communicationSnapshot({ id: trialing.id, messages: 0, chars: 100 })).account;
  assert.deepEqual(flags, { trialing: true, paying: false }, 'a trialing customer, as flags only');
  assert.deepEqual((await store.communicationSnapshot({ id: first.id, messages: 0, chars: 100 })).account, { trialing: false, paying: false });

  // ---- 6. The facts stage 5 reads ------------------------------------------------------------------------------------------------
  const watched = await server('private.agent_watchdog_facts');
  assert.ok(watched.agents.every(agent => ['lastTaskAt', 'shortestSeconds', 'tasks14d', 'worked14d', 'skipped14d'].every(key => key in agent)));
  assert.ok('marketingSpendCents' in (await server('private.agent_scorecard_facts', [new Date(Date.now() - 7 * 86_400_000), new Date()])));
  const strategy = await server('private.growth_strategy_facts', [new Date(Date.now() - 7 * 86_400_000), new Date()]);
  assert.ok(['noCard', 'trialsLost'].every(key => key in strategy.conversion));

  // ---- 7. Only the Hub server records an acknowledgment ------------------------------------------------------------------------
  await assert.rejects(admin.query('select private.agent_acknowledge_begin($1, 1, $2)', [auto.id, ['email']]), refused('42501'));

  // ---- 8. The gate refuses drift ----------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    await client.query('begin'); await client.query(gate); await client.query(gate); await client.query('rollback');
    const drifts = [
      'alter table private.agent_actions drop constraint agent_actions_communication_acknowledge_check',
      'grant execute on function private.agent_acknowledge_begin(uuid,integer,text[]) to authenticated',
      'revoke execute on function private.agent_acknowledge_begin(uuid,integer,text[]) from hub_app_server',
      "delete from private.hub_settings where key = 'agents.auto_acknowledge'",
      'grant execute on function private.agent_growth_acknowledgment(uuid) to hub_app_server',
      rewrite('private.agent_acknowledge_begin(uuid,integer,text[])', "'code', 'not_a_person'", "'code', 'reply_refused'"),
      rewrite('private.agent_acknowledge_begin(uuid,integer,text[])', 'agents.auto_acknowledge', 'agents.acknowledge_auto'),
      rewrite('private.agent_growth_waiting()', 'and not private.agent_growth_acknowledgment(a.request_key)', 'and true'),
      rewrite('private.agent_watchdog_facts()', "'lastTaskAt'", "'lastTaskWhen'"),
      `alter table private.agent_strategy_notes drop constraint agent_strategy_notes_constraint_key_check, add constraint agent_strategy_notes_constraint_key_check
        check (constraint_key in ('deliverability', 'supply', 'reach', 'permission', 'volume', 'engagement', 'conversion', 'activation', 'budget', 'approvals', 'none'))`,
    ];
    for (const drift of drifts) {
      await client.query('begin');
      try {
        await client.query(drift);
        await assert.rejects(client.query(gate), refused('55000'), `the gate refuses: ${drift.slice(0, 90)}`);
      } finally { await client.query('rollback'); }
    }
    console.log(`Support truth integration passed: only the standard acknowledgment is admitted (6 refusals); sent by the drain without a session as the AI assistant; refused to a machine, a moved thread and after the switch went off; a lead answered only by it still waits; the snapshot's account flags; the facts stage 5 reads; server-only recording and ${drifts.length} kinds of gate drift. No email left the machine.`);
  } finally { client.release(); }
} finally {
  await admin.query("update private.agents set status=$1, autonomy=$2, config=$3 where key='support_concierge'", [seedConcierge.status, seedConcierge.autonomy, seedConcierge.config]);
  await admin.query("update private.hub_settings set value=$1, changed_at=$2, changed_by=$3 where key='agents.auto_acknowledge'", [seedSwitch.value, seedSwitch.changed_at, seedSwitch.changed_by]);
  await admin.query('update private.billing_settings set livemode = $1', [seedLive]);
  await admin.query('delete from private.leads where id = any($1::uuid[])', [leads]);
  await admin.query("delete from private.audit_events where entity_type = 'agent_action' and entity_id in (select id from private.agent_actions where task_id = any($1::uuid[]))", [tasks]);
  await admin.query('delete from private.agent_actions where task_id = any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_tasks where id = any($1::uuid[])', [tasks]);
  await admin.query("delete from private.audit_events where action = 'communication.reply' and entity_id = any($1::uuid[])", [made]);
  await admin.query('delete from private.communication_messages where communication_id = any($1::uuid[])', [made]);
  await admin.query('delete from private.communications where id = any($1::uuid[])', [made]);
  await admin.query('delete from private.growth_billing_outbox where tenant_id = any($1::uuid[])', [tenants]);
  await admin.query('delete from private.billing_subscriptions where tenant_id = any($1::uuid[])', [tenants]);
  await admin.query('delete from private.billing_customers where tenant_id = any($1::uuid[])', [tenants]);
  await admin.query('delete from hub.tenants where id = any($1::uuid[])', [tenants]);
  await pool.end(); await admin.end();
}
