// The Account Manager's customer emails through the actual Hub server role, on disposable local fixtures only. The server pool logs
// in as hub_app_server exactly like production: the daily run reads the trials and new paying accounts through the one server-only
// facts operation, proposes through the real store and task queue, the owner approves through a real SMS session, and the executor
// asks the database for the one address at send time and records the send before a fake mail sender is called. Nothing is sent to
// anyone: the mail sender only records. The fixtures are invented accounts whose billing addresses are canaries: each may appear in
// the fake sender's captured message and nowhere else (no agent table, ledger, audit event, log line or alert).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { bulkEmail } from './bulk-email.mjs';
import { agentTeam } from './agents/index.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { lifecycleHandlers } from './agents/tasks/lifecycle.mjs';
import { lifecycleInput, lifecyclePreview, parseLifecycleInput, unsubscribeLabel, wordingHash } from './agents/accounts/lifecycle.mjs';
import { approvalTitle, decisionSchema, overviewSchema } from '../src/admin/teamProtocol.ts';
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
const api = gateway(pool);
const gate = await readFile(new URL('../supabase/migrations/20261103140100_agent_lifecycle_contract.sql', import.meta.url), 'utf8');

const run = randomUUID().slice(0, 8);
const prefix = `lc-it-${run}`;
const owner = randomUUID();
const ownerToken = `lifecycle-owner-${randomUUID()}`;
const ownerPhone = phones.owner;
const origin = 'https://hub.test';
const postal = `CareMetric Test Office ${run}, 100 Example Street, Altoona, PA 16601`;
const booking = 'https://cal.example.com/caremetric-test';
const canary = key => `canary.${key}.${run}@example.test`;
const contactName = `Canary Contact ${run}`;
const day = 86_400_000;

const call = async (fn, args = []) => (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r;
const refused = (code, pattern) => error => { assert.equal(error.code, code, error.message); if (pattern) assert.match(error.message, pattern); return true; };
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await admin.query(sql, params)).rows;
const ownerCall = (fn, args = [], token = ownerToken) => withSession(pool, token, async db =>
  (await db.query(`select to_jsonb(${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})) as r`, args)).rows[0].r);
const hashOf = address => createHash('sha256').update(address.trim().toLowerCase()).digest('hex');

const tenants = [];
const slugs = {};
// One invented account: the tenant, its live (or test-mode) billing contact, its subscriptions, paid invoices and usage reports.
async function makeAccount(key, { email = canary(key), livemode = true, subscriptions = [], usage = [] } = {}) {
  const slug = `${prefix}-${key}`;
  const tenant = (await row('insert into hub.tenants(slug, name) values ($1, $2) returning id', [slug, `Lifecycle ${key} ${run}`])).id;
  tenants.push(tenant);
  slugs[key] = slug;
  const customer = `cus_lc${run}${key}`;
  await admin.query('insert into private.billing_customers(tenant_id, stripe_customer_id, email, name, livemode, seen_at) values ($1, $2, $3, $4, $5, now())',
    [tenant, customer, email, contactName, livemode]);
  for (const [index, subscription] of subscriptions.entries()) {
    const id = `sub_lc${run}${key}${index}`;
    await admin.query(`insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, cancel_at_period_end,
        trial_start, trial_end, livemode, stripe_created, seen_at)
      select $1::text, $2::uuid, $3::text, p.id, $4::text, 'charge_automatically', $5::boolean, now() - $6::float * interval '1 day', now() + $7::float * interval '1 day', $8::boolean,
        now() - $6::float * interval '1 day', now() from hub.products p where p.slug = $9::text`,
    [id, tenant, customer, subscription.status ?? 'trialing', subscription.cancelling ?? false, subscription.started ?? 1, subscription.ends ?? 29, livemode, subscription.product ?? 'carebase']);
    // Stripe's confirmation of an Intel trial's card, recorded as billing.mjs records it (the card reminder reads it; since 2026-11-23 the trial counts from its start).
    if (subscription.card) await admin.query('insert into private.billing_trial_cards(stripe_subscription_id, tenant_id) values ($1, $2)', [id, tenant]);
    if (subscription.paid !== undefined) {
      await admin.query(`insert into private.billing_invoices(stripe_invoice_id, tenant_id, stripe_customer_id, stripe_subscription_id, status, currency, total, subtotal, amount_due,
          amount_paid, amount_remaining, livemode, stripe_created, seen_at)
        values ($1, $2, $3, $4, 'paid', 'usd', 4900, 4900, 4900, 4900, 0, $5, now() - $6::float * interval '1 day', now())`, [`in_lc${run}${key}${index}`, tenant, customer, id, livemode, subscription.paid]);
    }
  }
  for (const product of usage) {
    await admin.query(`insert into private.billing_usage_reports(product_id, tenant_id, metric, quantity, request_key, outcome, reported_at)
      select p.id, $1::uuid, 'facility', 1, gen_random_uuid(), 'updated', now() - interval '1 day' from hub.products p where p.slug = $2::text`, [tenant, product]);
  }
  return tenant;
}
// Children before parents: the billing tables restrict deleting a tenant.
async function removeAccounts(list) {
  if (list.length === 0) return;
  for (const sql of [
    'delete from private.billing_usage_reports where tenant_id = any($1::uuid[])',
    'delete from private.billing_invoices where tenant_id = any($1::uuid[])',
    'delete from private.billing_subscription_items where stripe_subscription_id in (select stripe_subscription_id from private.billing_subscriptions where tenant_id = any($1::uuid[]))',
    'delete from private.billing_subscriptions where tenant_id = any($1::uuid[])',
    'delete from private.billing_customers where tenant_id = any($1::uuid[])',
    'delete from hub.tenant_products where tenant_id = any($1::uuid[])',
    'delete from hub.tenants where id = any($1::uuid[])',
  ]) await admin.query(sql, [list]);
}

const seedAgents = (await admin.query('select key, status, autonomy, daily_budget_cents, config, updated_at from private.agents')).rows;
const seedSchedules = (await admin.query('select id, next_run_at, last_run_at, last_task_id, enabled from private.agent_schedules')).rows;
const seedBilling = await row('select livemode, stripe_account_id, verified_at, updated_at from private.billing_settings');
let setAside = [];
const sent = [];
const outcomes = [];
const ownerMail = [];
const texts = [];
const logs = [];
const tokens = [];

try {
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'lifecycle-owner@test.invalid',false)", [owner]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, ownerPhone]);
  await admin.query("insert into hub.profiles(id,display_name) values($1,'Lifecycle integration owner') on conflict (id) do update set display_name=excluded.display_name", [owner]);
  await admin.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at)
    select $1,$2,user_id,identity_version,now(),now()+interval '1 hour' from private.sms_identities where user_id=$3`, [randomUUID(), digest(ownerToken), owner]);
  setAside = (await admin.query("update private.staff_permissions set revoked_at = now() where permission = 'platform.admin' and revoked_at is null and user_id <> $1 returning id", [owner])).rows.map(entry => entry.id);

  // ---- The boundary: the Hub server reaches the facts, the address and the ledger only through its operations -----------------------
  for (const sql of ['select private.agent_lifecycle_snapshot(10)', `select private.agent_lifecycle_begin_send('${randomUUID()}', 1, '${'a'.repeat(64)}')`,
    `select private.agent_lifecycle_finish_send('${randomUUID()}', 'sent', null)`]) {
    await assert.rejects(admin.query(sql), refused('42501', /Application server required/), sql);
    for (const role of ['anon', 'authenticated']) {
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query(`set local role ${role}`);
        await assert.rejects(client.query(sql), refused('42501'), `${role}: ${sql}`);
      } finally { await client.query('rollback'); client.release(); }
    }
  }
  await assert.rejects(pool.query('select private.agent_lifecycle_json(10, null, null, 0)'), refused('42501'), 'the helper is not callable, even by the server role');
  await assert.rejects(pool.query('select count(*) from private.agent_lifecycle_emails'), refused('42501'), 'the server role has no direct access to the ledger');
  for (const limit of [0, 501, -1, null]) await assert.rejects(call('private.agent_lifecycle_snapshot', [limit, null, null]), refused('22023', /Choose a limit between 1 and 500/), `limit ${limit}`);
  for (const offset of [-1, 10001, null]) await assert.rejects(call('private.agent_lifecycle_snapshot', [10, null, null, offset]), refused('22023', /Choose an offset between 0 and 10000/), `offset ${offset}`);
  for (const [tenant, product] of [['Not A Slug', null], [null, 'care base'], ["x'; drop table", null]]) {
    await assert.rejects(call('private.agent_lifecycle_snapshot', [10, tenant, product]), refused('22023', /by their keys/));
  }
  await assert.rejects(call('private.agent_lifecycle_begin_send', [randomUUID(), 1, 'not-a-hash']), refused('22023', /unsubscribe link/));
  await assert.rejects(call('private.agent_lifecycle_begin_send', [randomUUID(), 1, 'a'.repeat(64)]), refused('P0002', /Unknown customer email/));
  for (const delivery of ['delivered', null]) await assert.rejects(call('private.agent_lifecycle_finish_send', [randomUUID(), delivery, null]), refused('22023', /Invalid delivery outcome/));
  assert.equal(await call('private.agent_lifecycle_finish_send', [randomUUID(), 'sent', null]), false, 'an outcome for no recorded send changes nothing');
  const features = (await api.rpc('get_backend_contract', {})).features;
  assert.ok(features.includes('platform.agents.lifecycle.v1'), 'the feature is declared');

  // ---- Fixtures --------------------------------------------------------------------------------------------------------------------
  await admin.query('update private.billing_settings set livemode = true');
  await makeAccount('welcome', { subscriptions: [{ started: 1 }] });
  await makeAccount('intel', { email: canary('welcome'), subscriptions: [{ product: 'caremetric-intel', started: 0.5, ends: 13.5, card: true }] });
  await makeAccount('setup', { subscriptions: [{ started: 4, ends: 26 }] });
  await makeAccount('active', { subscriptions: [{ started: 4, ends: 26 }], usage: ['carebase'] });
  await makeAccount('checkin', { subscriptions: [{ started: 25, ends: 4 }] });
  await makeAccount('testimonial', { subscriptions: [{ status: 'active', started: 80, ends: -50, paid: 50 }] });
  await makeAccount('noemail', { email: '', subscriptions: [{ started: 1 }] });
  await makeAccount('unsubscribed', { subscriptions: [{ started: 1 }] });
  await admin.query('insert into private.email_suppressions(email_hash) values ($1)', [hashOf(canary('unsubscribed'))]);
  await makeAccount('testmode', { livemode: false, subscriptions: [{ started: 1 }] });
  await makeAccount('cancelling', { subscriptions: [{ started: 1, cancelling: true }] });
  await makeAccount('refused', { subscriptions: [{ started: 1 }] });
  await makeAccount('silent', { subscriptions: [{ started: 1 }] });
  await makeAccount('crash', { subscriptions: [{ started: 1 }] });
  await makeAccount('replay', { subscriptions: [{ started: 1 }] });
  await makeAccount('twice', { subscriptions: [{ started: 1 }, { product: 'caremetric-intel', started: 1.5, ends: 12.5, card: true }] });
  const mine = list => list.filter(entry => entry.tenant.startsWith(prefix));

  // What the facts say: never an address, a contact name or a Stripe identifier.
  const facts = await call('private.agent_lifecycle_snapshot', [500, null, null]);
  assert.equal(facts.mode, 'live');
  const ours = mine(facts.accounts);
  assert.deepEqual(ours.map(entry => `${entry.tenant.slice(prefix.length + 1)}:${entry.product}`).sort(), [
    'active:carebase', 'checkin:carebase', 'crash:carebase', 'intel:caremetric-intel', 'noemail:carebase', 'refused:carebase', 'replay:carebase', 'setup:carebase',
    'silent:carebase', 'testimonial:carebase', 'twice:carebase', 'twice:caremetric-intel', 'unsubscribed:carebase', 'welcome:carebase', 'cancelling:carebase',
  ].sort(), 'the live trials and the new paying account, not the test-mode one');
  const serialized = JSON.stringify(facts);
  for (const secret of [canary(''), contactName, `cus_lc${run}`, `sub_lc${run}`, `in_lc${run}`]) assert.ok(!serialized.includes(secret), `the facts never carry ${secret}`);
  const byKey = Object.fromEntries(ours.map(entry => [`${entry.tenant.slice(prefix.length + 1)}:${entry.product}`, entry]));
  assert.deepEqual([byKey['noemail:carebase'].hasEmail, byKey['unsubscribed:carebase'].suppressed, byKey['cancelling:carebase'].cancelling, byKey['active:carebase'].hasUsage],
    [false, true, true, true]);
  assert.equal(await call('private.agent_lifecycle_snapshot', [1, slugs.twice, 'caremetric-intel']).then(view => view.accounts.length), 1);

  // ---- The team ----------------------------------------------------------------------------------------------------------------------
  await admin.query("update private.agents set status = 'active', autonomy = 'observe' where key = 'account_manager'");
  await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day', enabled = true");
  const customerMail = { configured: true, send: async message => { sent.push(message); return outcomes.shift() ?? { delivery: 'sent', id: `lc-msg-${sent.length}` }; } };
  // A booking link handed in as before is never used: CareMetric does no personal demos with anyone (owner decision 2026-11-09).
  const customerEmail = { mail: customerMail, postalAddress: postal, bookingUrl: booking };
  const teamFor = (options = {}) => agentTeam({
    pool, enabled: true, ownerEmail: 'owner@example.test', publicOrigin: origin, log: line => logs.push(line), features: new Set(features),
    sms: { configured: true, send: async (to, body) => { texts.push([to, body]); return { delivery: 'sent', id: 'SM1' }; } },
    email: { configured: true, send: async (to, subject, content) => { ownerMail.push({ to, subject, content }); return { delivery: 'sent', id: 'owner-1' }; } },
    lifecycle: customerEmail, ...options,
  });
  const team = teamFor();
  assert.ok(team.scheduler.kinds().includes('accounts.lifecycle'), 'registered once the database declares the feature');
  const bare = teamFor({ features: new Set(features.filter(feature => feature !== 'platform.agents.lifecycle.v1')) });
  assert.ok(!bare.scheduler.kinds().includes('accounts.lifecycle'), 'a server whose database lacks the feature does not run it');
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '1 minute' where task_kind = 'accounts.lifecycle'");
  assert.equal((await bare.tick()).fired, 0, 'and its schedule stays due instead of failing');
  assert.equal((await row("select next_run_at < now() as due from private.agent_schedules where task_kind = 'accounts.lifecycle'")).due, true);

  let minutes = 2;
  const fire = async (who = team) => {
    minutes += 1;
    await admin.query("update private.agent_schedules set next_run_at = now() - make_interval(mins => $1::int) where task_kind = 'accounts.lifecycle'", [minutes]);
    const tick = await who.tick();
    assert.deepEqual([tick.fired, tick.claimed], [1, 1], 'the schedule fires the run');
    return row("select * from private.agent_tasks where kind = 'accounts.lifecycle' order by created_at desc, id limit 1");
  };
  const lastRun = () => row("select * from private.agent_runs where agent_key = 'account_manager' order by started_at desc limit 1");
  const emailActions = async () => (await rows("select * from private.agent_actions where kind = 'email.send' and target_id like $1 order by created_at, id", [`${prefix}-%`]));
  const actionFor = async (key, product = 'carebase') => row("select * from private.agent_actions where kind = 'email.send' and input ->> 'periodKey' like $1", [`account:%:${slugs[key]}:${product}`]);
  const ledgerFor = actionId => row('select * from private.agent_lifecycle_emails where action_id = $1', [actionId]);
  const approve = async (key, product = 'carebase', who = team) => decisionSchema.parse(await who.admin.decide(ownerToken, { actionId: (await actionFor(key, product)).id, decision: 'approve' }));

  // Observe: nothing is proposed, and the run says what would have been.
  const observed = await fire();
  assert.equal(observed.status, 'done');
  assert.deepEqual([observed.result.outcome, observed.result.proposed, observed.result.noAddress, observed.result.suppressed], ['observe_only', 0, 1, 1]);
  assert.ok(observed.result.due >= 10);
  assert.equal((await emailActions()).length, 0, 'an observe-only agent proposes nothing');
  assert.match((await lastRun()).summary, /^Observe only: \d+ customer emails would be proposed \(\d+ welcome, 1 setup help, 1 trial check-in, 1 testimonial request\)\. Nothing was proposed\./);

  // Propose, but the Hub cannot send customer email yet: nothing is proposed, and the run says what is missing.
  await admin.query("update private.agents set autonomy = 'propose' where key = 'account_manager'");
  const unready = await fire(teamFor({ lifecycle: { mail: customerMail, postalAddress: '', bookingUrl: booking } }));
  assert.deepEqual([unready.result.outcome, unready.result.missing], ['not_configured', ['postal_address']]);
  assert.equal((await emailActions()).length, 0);
  assert.deepEqual([(await lastRun()).outcome, (await lastRun()).error_code], ['failed', 'not_configured']);

  // Propose: each due email once, with its exact text, finishing at once so the next run is never held back.
  const proposedRun = await fire();
  assert.equal(proposedRun.status, 'done', 'the run finishes once it has proposed');
  assert.deepEqual([proposedRun.result.outcome, proposedRun.result.proposed, proposedRun.result.autoApproved], ['proposed', 10, 0]);
  assert.deepEqual(proposedRun.result.byTemplate, { card_reminder: 0, welcome: 7, setup_nudge: 1, midtrial_nudge: 0, value_followup: 0, trial_checkin: 1, testimonial_ask: 1 });
  assert.equal(proposedRun.result.deferred, 1, 'the second product of one account waits for the next run');
  let actions = await emailActions();
  // The account with two trials gets the newer one's welcome first (the facts come newest first).
  assert.deepEqual(actions.map(action => `${action.target_id.slice(prefix.length + 1)}:${action.input.product}:${action.input.template}`).sort(), [
    'checkin:carebase:trial_checkin', 'crash:carebase:welcome', 'intel:caremetric-intel:welcome', 'refused:carebase:welcome', 'replay:carebase:welcome',
    'setup:carebase:setup_nudge', 'silent:carebase:welcome', 'testimonial:carebase:testimonial_ask', 'twice:carebase:welcome', 'welcome:carebase:welcome',
  ].sort(), 'the right template for each account, and one email per account');
  for (const action of actions) {
    assert.deepEqual([action.status, action.target_kind, action.agent_key, action.task_id, action.decided_by], ['proposed', 'billing_account', 'account_manager', proposedRun.id, null]);
    assert.deepEqual(parseLifecycleInput(action.input), action.input, 'the input is exactly the whitelisted facts');
    assert.equal(action.input.textHash, wordingHash(action.input));
    assert.equal(action.preview, lifecyclePreview(action.input, { postalAddress: postal }), 'the preview is the exact email');
    assert.equal(action.input.tenantName, `Lifecycle ${action.target_id.slice(prefix.length + 1)} ${run}`);
    // No customer address: the only ones are CareMetric's own, in the theme's footer.
    assert.ok(!JSON.stringify([action.input, action.preview]).replace(/\bsupport@caremetric\.ai\b/g, '').includes('@'), 'no address in what the owner approves');
  }
  const welcomeAction = await actionFor('welcome');
  // The subject, then the headline of the branded email, then the greeting.
  assert.ok(welcomeAction.preview.startsWith('Subject: Welcome to CareMetric CareBase: your first three steps\n\nWelcome to CareMetric CareBase\n\nHello,'));
  assert.ok(!welcomeAction.preview.includes(booking) && !/pick a time/i.test(welcomeAction.preview), 'no booking link and no time to meet');
  assert.equal(welcomeAction.input.bookingUrl, null, 'the stored facts hold no booking link');
  assert.ok(welcomeAction.preview.includes(`${unsubscribeLabel}: a personal link is added when the email is sent\n${postal}`));
  assert.equal((await lastRun()).summary, 'Proposed 10 customer emails (7 welcome, 1 setup help, 1 trial check-in, 1 testimonial request) for your approval. Skipped 1 account with no billing email. Skipped 1 account that unsubscribed. 1 more waits for the next run.');

  // The owner's screen reads them, and the card names the account and the subject.
  const overview = overviewSchema.shape.team.parse(await ownerCall('hub.get_agent_team'));
  const card = overview.approvals.find(approval => approval.id === welcomeAction.id);
  assert.equal(approvalTitle(card), `Email to ${slugs.welcome}: Welcome to CareMetric CareBase: your first three steps`);

  // The next run proposes only the email that waited, and never one that was proposed before.
  const second = await fire();
  assert.deepEqual([second.result.outcome, second.result.proposed, second.result.byTemplate.welcome], ['proposed', 1, 1]);
  const waited = await actionFor('twice', 'caremetric-intel');
  assert.ok(waited && waited.task_id === second.id);
  const third = await fire();
  assert.deepEqual([third.result.outcome, third.result.proposed], ['nothing_due', 0]);
  const asked = await ownerCall('hub.request_agent_task', ['account_manager', 'accounts.lifecycle']);
  assert.equal((await team.tick()).claimed, 1);
  assert.equal((await row('select result ->> \'outcome\' as outcome from private.agent_tasks where id = $1', [asked.id])).outcome, 'nothing_due', 'Run now proposes nothing twice either');
  assert.equal((await emailActions()).length, 11);
  assert.equal(decisionSchema.parse(await team.admin.decide(ownerToken, { actionId: waited.id, decision: 'reject' })).status, 'rejected');

  // ---- Approval sends it once, from the one address, with a working one-click unsubscribe -----------------------------------------
  const welcomeDecision = await approve('welcome');
  assert.deepEqual([welcomeDecision.status, welcomeDecision.decided, welcomeDecision.error], ['executed', true, undefined]);
  assert.equal(sent.length, 1);
  const [message] = sent;
  assert.equal(message.to, canary('welcome'), 'the database handed over the one address of that account');
  assert.equal(message.subject, 'Welcome to CareMetric CareBase: your first three steps');
  const token = new RegExp(`^${origin}/api/email/unsubscribe/([0-9a-f]{64})$`).exec(message.unsubscribeUrl)[1];
  tokens.push(token);
  assert.equal(`Subject: ${message.subject}\n\n${message.text}`, welcomeAction.preview.replace('a personal link is added when the email is sent', message.unsubscribeUrl), 'what went out is what was approved');
  assert.ok(message.html.includes(`href="${message.unsubscribeUrl}"`) && message.html.includes(postal));
  const welcomeDone = await row('select * from private.agent_actions where id = $1', [welcomeAction.id]);
  assert.deepEqual([welcomeDone.status, welcomeDone.result], ['executed', { outcome: 'sent', template: 'welcome' }]);
  const welcomeLedger = await ledgerFor(welcomeAction.id);
  assert.deepEqual([welcomeLedger.status, welcomeLedger.period_key, welcomeLedger.template, welcomeLedger.email_hash, welcomeLedger.unsubscribe_hash, welcomeLedger.provider_message_id],
    ['sent', welcomeAction.input.periodKey, 'welcome', hashOf(canary('welcome')), digest(token), 'lc-msg-1']);
  assert.deepEqual((await row("select metadata from private.audit_events where action = 'agent.action.executed' and entity_id = $1", [welcomeAction.id])).metadata,
    { agent: 'account_manager', kind: 'email.send', auto: false });
  assert.equal(decisionSchema.parse(await team.admin.decide(ownerToken, { actionId: welcomeAction.id, decision: 'approve' })).decided, false, 'an email is approved once');
  assert.equal(sent.length, 1);

  // The link opens the existing unsubscribe page, which changes nothing until it is confirmed, and then suppresses the address for
  // every kind of CareMetric email.
  const page = bulkEmail({ pool, publicOrigin: origin, mail: null }).unsubscribePage;
  assert.match(await page(token, false), /Unsubscribe from CareMetric check-in emails[\s\S]*<button type="submit">Unsubscribe<\/button>/);
  assert.equal(Number((await row('select count(*) from private.email_suppressions where email_hash = $1', [hashOf(canary('welcome'))])).count), 0, 'looking changes nothing');
  assert.match(await page(token, true), /You are unsubscribed/);
  assert.match(await page(token, true), /You are unsubscribed/);
  assert.equal(Number((await row('select count(*) from private.email_suppressions where email_hash = $1', [hashOf(canary('welcome'))])).count), 1);
  assert.deepEqual((await rows("select metadata from private.audit_events where action = 'agent.email.unsubscribe' and entity_id = $1", [welcomeAction.id])).map(entry => entry.metadata),
    [{ template: 'welcome' }], 'the unsubscribe is audited once, without the address');
  assert.match(await page('f'.repeat(64), true), /Link not recognized/);

  // The same address on another account is now refused at send time.
  const intelDecision = await approve('intel', 'caremetric-intel');
  assert.deepEqual([intelDecision.status, intelDecision.error], ['failed', 'suppressed']);
  assert.equal(sent.length, 1);
  assert.equal(await ledgerFor((await actionFor('intel', 'caremetric-intel')).id), undefined, 'a refused email records no send');

  // The account changed since the email was proposed: nothing is sent.
  await admin.query("update private.billing_subscriptions set status = 'canceled', canceled_at = now(), ended_at = now() where tenant_id = (select id from hub.tenants where slug = $1)", [slugs.checkin]);
  assert.deepEqual([(await approve('checkin')).status, (await row('select result from private.agent_actions where id = $1', [(await actionFor('checkin')).id])).result], ['failed', { error: 'no_longer_applies' }]);
  // The billing address went away since: nothing is sent.
  await admin.query("update private.billing_customers set email = '' where tenant_id = (select id from hub.tenants where slug = $1)", [slugs.setup]);
  assert.equal((await approve('setup')).error, 'no_address');
  assert.equal(sent.length, 1);

  // SendGrid refuses one and does not answer another: each is recorded as such and never sent again.
  outcomes.push({ delivery: 'failed', id: null });
  assert.equal((await approve('refused')).error, 'delivery_failed');
  outcomes.push({ delivery: 'unknown', id: null });
  assert.equal((await approve('silent')).error, 'email_unconfirmed');
  assert.equal(sent.length, 3);
  assert.deepEqual([(await ledgerFor((await actionFor('refused')).id)).status, (await ledgerFor((await actionFor('silent')).id)).status], ['failed', 'unknown']);

  // A server that stops after recording the send and before it is sent: the sweep hands the action back, and the next attempt settles
  // it from its record as unconfirmed instead of sending it.
  const crashAction = await actionFor('crash');
  await ownerCall('hub.decide_agent_action', [crashAction.id, 'approve', null]);
  const started = await team.store.beginExecution(crashAction.id);
  const peek = await call('private.agent_lifecycle_begin_send', [crashAction.id, started.execution, null]);
  assert.deepEqual(peek, { state: 'unrecorded' }, 'a look changes nothing');
  const begun = await call('private.agent_lifecycle_begin_send', [crashAction.id, started.execution, digest(randomUUID())]);
  assert.equal(begun.state, 'ready');
  assert.equal(begun.to, canary('crash'), 'the address goes to the server role, for this account only');
  await assert.rejects(call('private.agent_lifecycle_begin_send', [crashAction.id, started.execution + 1, digest(randomUUID())]), refused('55000', /not being sent/), 'only the execution carrying it out asks');
  await admin.query("update private.agent_actions set executing_at = now() - interval '11 minutes' where id = $1", [crashAction.id]);
  assert.ok((await call('private.agent_maintenance')).resetExecutions >= 1);
  assert.deepEqual(await team.actions.executeOne(crashAction.id, { kind: 'email.send' }), { executed: false, failed: true, skipped: false, error: 'email_unconfirmed' });
  assert.equal(sent.length, 3, 'nothing was sent twice');

  // A send that went out, whose action could not be settled: the replay finds the record and reports it sent, without sending again.
  const flaky = sqlAgentStore(pool, { fenced: features.includes('platform.agents.hardening.v1') });
  const settle = flaky.completeExecution;
  let broken = true;
  flaky.completeExecution = async (...args) => { if (broken) { broken = false; throw new Error('the database went away'); } return settle(...args); };
  const replayAction = await actionFor('replay');
  assert.equal((await approve('replay', 'carebase', teamFor({ store: flaky }))).status, 'approved', 'the approval stands; its outcome was not recorded');
  assert.equal(sent.length, 4);
  assert.equal((await row('select status from private.agent_actions where id = $1', [replayAction.id])).status, 'executing');
  await admin.query("update private.agent_actions set executing_at = now() - interval '11 minutes' where id = $1", [replayAction.id]);
  await call('private.agent_maintenance');
  assert.deepEqual(await team.actions.executeReady(), { executed: 1, failed: 0, waiting: 0 });
  assert.deepEqual((await row('select status, result from private.agent_actions where id = $1', [replayAction.id])), { status: 'executed', result: { outcome: 'sent', template: 'welcome', replay: true } });
  assert.equal(sent.length, 4, 'the email went out once');

  // ---- The cap: at most 20 customer emails a day, across every account ----------------------------------------------------------------
  const counted = Number((await row("select count(*) from private.agent_lifecycle_emails where created_at >= private.agent_day_start() and status in ('sending', 'sent', 'unknown')")).count);
  assert.ok(counted >= 4 && counted < 20);
  const filler = [];
  for (let index = 0; index < 20 - counted; index += 1) {
    const input = lifecycleInput({ tenant: `${prefix}-cap${index}`, tenantName: 'Cap', product: 'carebase', productName: 'CareMetric CareBase' }, 'welcome');
    const id = (await row(`insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
      values ('account_manager', 'email.send', 'billing_account', $1, 'Subject: Cap', $2, 'executed') returning id`, [input.tenant, input])).id;
    filler.push(id);
    await admin.query("insert into private.agent_lifecycle_emails (action_id, period_key, template, email_hash, unsubscribe_hash, status, finished_at) values ($1, $2, 'welcome', $3, $4, 'sent', now())",
      [id, input.periodKey, 'e'.repeat(64), digest(randomUUID())]);
  }
  // With the trial path (platform.agents.trial-path.v1) an email over the cap is not refused for good: it waits for 9 AM Eastern tomorrow.
  const capped = await approve('testimonial');
  assert.deepEqual([capped.status, capped.error ?? null], ['approved', null], 'an email over the cap waits instead of failing');
  const waitingCap = await row('select status, not_before from private.agent_actions where id = $1', [(await actionFor('testimonial')).id]);
  assert.equal(waitingCap.status, 'approved');
  assert.equal(new Date(waitingCap.not_before).getTime(),
    new Date((await row("select (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day 9 hours') at time zone 'America/New_York' as t")).t).getTime());
  assert.equal(sent.length, 4);
  await admin.query('delete from private.agent_actions where id = any($1::uuid[])', [filler]);

  // ---- Act: only the templates the owner listed go out on their own; listing the kind never does it ----------------------------------
  await makeAccount('autowelcome', { subscriptions: [{ started: 0.2 }] });
  await makeAccount('autosetup', { subscriptions: [{ started: 5, ends: 25 }] });
  await admin.query(`update private.agents set autonomy = 'act', config = config || '{"auto_send_templates": ["welcome"], "auto_approve_kinds": ["email.send"]}'::jsonb
    where key = 'account_manager'`);
  const acted = await fire();
  assert.deepEqual([acted.result.proposed, acted.result.autoApproved], [2, 1]);
  assert.ok((await lastRun()).summary.startsWith('Proposed 2 customer emails (1 welcome, 1 setup help); 1 approved on its own, by the templates you listed.'));
  const autoWelcome = await row('select * from private.agent_actions where id = $1', [(await actionFor('autowelcome')).id]);
  assert.deepEqual([autoWelcome.status, autoWelcome.decided_by, autoWelcome.result], ['executed', null, { outcome: 'sent', template: 'welcome' }], 'the listed template went out in the same tick');
  assert.equal(sent.at(-1).to, canary('autowelcome'));
  assert.equal(sent.length, 5);
  assert.deepEqual((await row("select metadata from private.audit_events where action = 'agent.action.executed' and entity_id = $1", [autoWelcome.id])).metadata,
    { agent: 'account_manager', kind: 'email.send', auto: true }, 'recorded honestly as sent on its own');
  assert.equal((await actionFor('autosetup')).status, 'proposed', 'a template that is not listed waits for the owner, even with email.send in auto_approve_kinds');

  // One approved on its own while the Account Manager is then paused is refused at send time.
  await makeAccount('autopause', { subscriptions: [{ started: 0.3 }] });
  {
    const pausedRun = await ownerCall('hub.request_agent_task', ['account_manager', 'accounts.lifecycle']);
    const [pausedClaim] = await call('private.agent_task_claim', [1, 600]);
    assert.equal(pausedClaim.id, pausedRun.id);
    const pausedHandler = lifecycleHandlers({ store: team.store, features: new Set(features), lifecycle: { ...customerEmail, publicOrigin: origin } })['accounts.lifecycle'];
    const pausedHandled = await pausedHandler(pausedClaim, { now: () => new Date() });
    await team.store.finish(pausedClaim.id, 'done', { result: pausedHandled.result, attempt: pausedClaim.attempts });
    const pausedAction = await actionFor('autopause');
    assert.equal(pausedAction.status, 'auto_approved');
    await admin.query("update private.agents set status = 'paused' where key = 'account_manager'");
    try {
      assert.deepEqual(await team.actions.executeOne(pausedAction.id, { kind: 'email.send' }), { executed: false, failed: true, skipped: false, error: 'auto_send_off' }, 'a paused agent sends nothing on its own');
      assert.equal(sent.length, 5);
    } finally { await admin.query("update private.agents set status = 'active' where key = 'account_manager'"); }
  }

  // One approved on its own whose template the owner then takes off the list is refused at send time.
  await makeAccount('autooff', { subscriptions: [{ started: 0.3 }] });
  const manual = await ownerCall('hub.request_agent_task', ['account_manager', 'accounts.lifecycle']);
  const [claimed] = await call('private.agent_task_claim', [1, 600]);
  assert.equal(claimed.id, manual.id);
  const handler = lifecycleHandlers({ store: team.store, features: new Set(features), lifecycle: { ...customerEmail, publicOrigin: origin } })['accounts.lifecycle'];
  const handled = await handler(claimed, { now: () => new Date() });
  await team.store.finish(claimed.id, 'done', { result: handled.result, attempt: claimed.attempts });
  const offAction = await actionFor('autooff');
  assert.equal(offAction.status, 'auto_approved');
  await admin.query("update private.agents set config = jsonb_set(config, '{auto_send_templates}', '[]'::jsonb) where key = 'account_manager'");
  assert.deepEqual(await team.actions.executeOne(offAction.id, { kind: 'email.send' }), { executed: false, failed: true, skipped: false, error: 'auto_send_off' });
  assert.equal(sent.length, 5);

  // ---- More than a page: 205 newer trials on their eighth day cannot hide an older account whose email is due -----------------------
  // (Day 8: no email is due then, the mid-trial emails of the trial path starting on day 10.)
  const bulk = (await rows(`insert into hub.tenants(slug, name) select '${prefix}-bulk-' || n, 'Lifecycle Bulk ${run} ' || n from generate_series(1, 205) n returning id`)).map(entry => entry.id);
  tenants.push(...bulk);
  await admin.query(`with t as (select id, row_number() over (order by slug) as n from hub.tenants where id = any($1::uuid[]))
    insert into private.billing_customers(tenant_id, stripe_customer_id, email, name, livemode, seen_at) select id, 'cus_lc${run}bulk' || n, 'bulk' || n || '.${run}@example.test', '', true, now() from t`, [bulk]);
  await admin.query(`with t as (select id, row_number() over (order by slug) as n from hub.tenants where id = any($1::uuid[]))
    insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, trial_start, trial_end, livemode, stripe_created, seen_at)
    select 'sub_lc${run}bulk' || n, t.id, 'cus_lc${run}bulk' || n, p.id, 'trialing', 'charge_automatically', now() - interval '8 days', now() + interval '22 days', true, now() - interval '8 days', now()
    from t cross join (select id from hub.products where slug = 'carebase') p`, [bulk]);
  await makeAccount('paged', { subscriptions: [{ status: 'active', started: 100, ends: -70, paid: 50 }] });
  // A trial that reported zero (the usage API accepts it) has no usage, so it still gets the setup offer.
  await makeAccount('zerousage', { subscriptions: [{ started: 4, ends: 26 }] });
  await admin.query(`insert into private.billing_usage_reports(product_id, tenant_id, metric, quantity, request_key, outcome, reported_at)
    select p.id, t.id, 'facility', 0, gen_random_uuid(), 'updated', now() - interval '1 day' from hub.products p, hub.tenants t where p.slug = 'carebase' and t.slug = $1`, [slugs.zerousage]);
  const firstPage = await call('private.agent_lifecycle_snapshot', [200, null, null, 0]);
  assert.ok(firstPage.truncated === true && !firstPage.accounts.some(entry => entry.tenant === slugs.paged), 'the older paying account is not on the first page');
  assert.ok((await call('private.agent_lifecycle_snapshot', [200, null, null, 200])).accounts.some(entry => entry.tenant === slugs.paged), 'it is on the second');
  const pagedRun = await fire();
  assert.deepEqual([pagedRun.result.outcome, pagedRun.result.proposed, pagedRun.result.truncated], ['proposed', 2, false]);
  assert.deepEqual(pagedRun.result.byTemplate, { card_reminder: 0, welcome: 0, setup_nudge: 1, midtrial_nudge: 0, value_followup: 0, trial_checkin: 0, testimonial_ask: 1 });
  assert.ok(pagedRun.result.read > 200, `every page was read (${pagedRun.result.read} accounts)`);
  assert.equal((await actionFor('paged')).input.template, 'testimonial_ask', 'the account on the second page gets its email');
  assert.equal((await actionFor('zerousage')).input.template, 'setup_nudge', 'and a report of zero does not hold back the setup offer');
  await removeAccounts(bulk);
  tenants.splice(tenants.indexOf(bulk[0]), bulk.length);

  // ---- Cancellation and win-back (20261113300000_lifecycle_save.sql): only with the owner's switch on, always for approval -------------
  await makeAccount('leaving', { subscriptions: [{ status: 'active', started: 200, ends: -170, paid: 170, cancelling: true }] });
  // Set to cancel at the end of its trial, then ended: Stripe keeps the cancellation fields on it.
  await makeAccount('ended', { subscriptions: [{ status: 'canceled', started: 35, ends: -5, cancelling: true }] });
  await makeAccount('longended', { subscriptions: [{ status: 'canceled', started: 60, ends: -30 }] });
  // An ended trial with a newer subscription of any status (here still awaiting its first payment): the customer came back.
  await makeAccount('cameback', { subscriptions: [{ status: 'canceled', started: 35, ends: -5 }, { status: 'incomplete', started: 1, ends: -1 }] });
  const saveFacts = Object.fromEntries(mine((await call('private.agent_lifecycle_snapshot', [500, null, null])).accounts).map(entry => [entry.tenant, entry]));
  assert.deepEqual([saveFacts[slugs.leaving]?.cancelling, saveFacts[slugs.ended]?.status, saveFacts[slugs.longended], saveFacts[slugs.cameback]], [true, 'canceled', undefined, undefined],
    'a long-paid plan being cancelled and a trial that ended 5 days ago are in the facts; one that ended a month ago, or whose customer started a new subscription since, is not');
  assert.deepEqual(Object.keys(saveFacts[slugs.ended].emails).sort(), ['cancel_save', 'card_reminder', 'midtrial_nudge', 'setup_nudge', 'testimonial_ask', 'trial_checkin', 'trial_ended', 'value_followup', 'welcome']);
  await fire();
  assert.ok(!(await emailActions()).some(action => ['cancel_save', 'trial_ended'].includes(action.input.template)), 'nothing is proposed while the switch is off');
  const saveRun = await ownerCall('hub.request_agent_task', ['account_manager', 'accounts.lifecycle']);
  const [saveClaim] = await call('private.agent_task_claim', [1, 600]);
  assert.equal(saveClaim.id, saveRun.id);
  const saveHandler = lifecycleHandlers({ store: team.store, features: new Set(features), lifecycle: { ...customerEmail, publicOrigin: origin, saveEmails: () => true } })['accounts.lifecycle'];
  const saveHandled = await saveHandler(saveClaim, { now: () => new Date() });
  await team.store.finish(saveClaim.id, 'done', { result: saveHandled.result, attempt: saveClaim.attempts });
  for (const [key, template] of [['cancelling', 'cancel_save'], ['leaving', 'cancel_save'], ['ended', 'trial_ended']]) {
    const action = await actionFor(key);
    assert.deepEqual([action?.input.template, action?.status], [template, 'proposed'], `${key}: ${template}, for the owner's approval`);
    assert.equal(action.preview, lifecyclePreview(action.input, { postalAddress: postal }));
  }
  const beforeSave = sent.length;
  assert.equal((await approve('leaving')).status, 'executed');
  assert.equal(sent.length, beforeSave + 1);
  assert.deepEqual([sent.at(-1).to, sent.at(-1).subject], [canary('leaving'), 'Before your CareMetric CareBase plan ends'], 'sent once, to that account');
  tokens.push(new RegExp(`^${origin}/api/email/unsubscribe/([0-9a-f]{64})$`).exec(sent.at(-1).unsubscribeUrl)[1]);

  // ---- No address is anywhere but the fake sender's captured messages -------------------------------------------------------------------
  const everything = JSON.stringify([
    await rows('select to_jsonb(t) as r from private.agent_tasks t'), await rows('select to_jsonb(r) as r from private.agent_runs r'),
    await rows('select to_jsonb(a) as r from private.agent_actions a'), await rows('select to_jsonb(n) as r from private.owner_notifications n'),
    await rows('select to_jsonb(e) as r from private.agent_lifecycle_emails e'), await rows("select to_jsonb(e) as r from private.audit_events e where action like 'agent.%'"),
    logs, texts, ownerMail,
  ]);
  for (const key of ['welcome', 'setup', 'checkin', 'testimonial', 'refused', 'silent', 'crash', 'replay', 'autowelcome', 'autosetup', 'autooff', 'noemail', 'unsubscribed', 'paged', 'zerousage', 'leaving', 'ended', 'longended', 'cameback']) {
    assert.ok(!everything.includes(canary(key)), `${key}'s address appears in no agent table, ledger, audit event, log line or alert`);
  }
  for (const secret of [contactName, `cus_lc${run}`, `sub_lc${run}`, ...tokens]) assert.ok(!everything.includes(secret), `${secret.slice(0, 18)}… is kept nowhere`);
  assert.ok(sent.every(entry => entry.to.startsWith('canary.') && entry.text.includes(postal)), 'while every captured message did go to a canary, with the footer');
  assert.equal(ownerMail.length + texts.length, 0, 'no owner alert was needed');

  // ---- The deployment gate re-runs cleanly, and refuses to declare the feature once the boundary drifts --------------------------------
  const gateClient = await admin.connect();
  try {
    await gateClient.query('begin');
    await gateClient.query(gate);
    await gateClient.query('rollback');
    for (const [sql, message] of [
      ['revoke execute on function private.agent_lifecycle_snapshot(integer,text,text,integer) from hub_app_server', /executable by the Hub server only/],
      ['grant execute on function private.agent_lifecycle_begin_send(uuid,integer,text) to authenticated', /executable by the Hub server only/],
      ['alter function private.agent_lifecycle_finish_send(uuid,text,text) reset search_path', /executable by the Hub server only/],
      ['alter function private.email_unsubscribe(text,boolean) security invoker', /executable by the Hub server only/],
      ['grant execute on function private.agent_lifecycle_json(integer,text,text,integer) to hub_app_server', /must stay internal/],
      ['grant select on private.agent_lifecycle_emails to authenticated', /closed to every browser, service and server role/],
      ['alter table private.agent_lifecycle_emails disable row level security', /must exist with row level security/],
      ['drop index private.agent_actions_email_send_once', /proposed once per period/],
      ['alter table private.agent_actions drop constraint agent_actions_email_send_check', /proposed once per period/],
      ["create or replace function private.agent_action_propose(p_task_id uuid, p_run_id uuid, p_kind text, p_target_kind text, p_target_id text, p_preview text, p_input jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$ begin perform private.require_hub_app_server(); return null; end $$", /template by template/],
      ["delete from private.agent_schedules where agent_key = 'account_manager' and task_kind = 'accounts.lifecycle'", /customer email schedule must exist/],
      ["update private.agents set config = config - 'auto_send_templates' where key = 'account_manager'", /auto_send_templates setting/],
      ["create or replace function hub.get_backend_contract() returns jsonb language sql stable as $$ select '{\"api_version\":4,\"features\":[\"platform.agents.v1\",\"platform.agents.accounts.v1\",\"support.bulk-email.v1\"]}'::jsonb $$", /Apply the Account Manager, the AI team hardening and bulk email first/],
    ]) {
      await gateClient.query('begin');
      try {
        await gateClient.query(sql);
        await assert.rejects(gateClient.query(gate), rejection => rejection.code === '55000' && message.test(rejection.message), sql);
      } finally { await gateClient.query('rollback'); }
    }
  } finally { gateClient.release(); }

  console.log('Account Manager customer emails: the server-only facts (no address, contact name or Stripe identifier; live records only), observe and not-configured runs that propose nothing, ten proposals with their exact text and whitelisted facts, one per account and once per period, approval that sends once from the one address the database hands over, a working one-click unsubscribe into the shared suppression list, refusals for an unsubscribed address, a changed account and a missing address, refused and unanswered deliveries, a crash and a replay that never send twice, the daily cap, auto-send only for the listed template, a book of more than 200 accounts read page by page, a usage report of zero, and the deployment gate all behave through hub_app_server.');
} finally {
  const problems = [];
  const attempt = async (sql, params = []) => { try { await admin.query(sql, params); } catch (error) { problems.push(`${error.message} [${sql.slice(0, 70)}]`); } };
  await attempt("delete from private.audit_events where action like 'agent.%' or actor_id = $1", [owner]);
  await attempt('delete from private.agent_actions');
  await attempt('delete from private.agent_runs');
  await attempt('delete from private.owner_notifications');
  await attempt('delete from private.agent_tasks');
  await attempt('delete from private.email_suppressions where email_hash = any($1::text[])', [['welcome', 'unsubscribed'].map(key => hashOf(canary(key)))]);
  try { await removeAccounts(tenants); } catch (error) { problems.push(error.message); }
  await attempt('update private.billing_settings set livemode = $1, stripe_account_id = $2, verified_at = $3, updated_at = $4', [seedBilling.livemode, seedBilling.stripe_account_id, seedBilling.verified_at, seedBilling.updated_at]);
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
