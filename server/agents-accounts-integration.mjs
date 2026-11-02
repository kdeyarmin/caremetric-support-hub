// The Account Manager through the actual Hub server role, on disposable local fixtures only. The server pool logs in as
// hub_app_server exactly like production: it reads the accounts only through the one server-only operation the migration adds
// (private.agent_accounts_snapshot), scores them in code, and emails the owner through the real store, task queue and notifier.
// No model is called, nothing here goes to a customer, and the mail and text senders are recording fakes. The fixtures are invented
// tenants with a canary billing address, canary Stripe identifiers and a distinctive amount: those may appear in the owner's email and
// nowhere else (no task, run, notification, audit event, log line or text).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { escapeHtml } from './email-layout.mjs';
import { agentTeam } from './agents/index.mjs';
import { assess } from './agents/accounts/health.mjs';
import { monthlyTotals } from './agents/accounts/money.mjs';
import { composeAccountsReport } from './agents/accounts/report.mjs';
import { weekStart } from './agents/accounts/week.mjs';

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
const gate = await readFile(new URL('../supabase/migrations/20261102170100_agent_accounts_contract.sql', import.meta.url), 'utf8');

const run = randomUUID().slice(0, 8);
const prefix = `acct-it-${run}`;
const owner = randomUUID();
const ownerToken = `accounts-owner-${randomUUID()}`;
const ownerPhone = `+1202555${String(1000 + Math.floor(Math.random() * 9000))}`;
const day = 86_400_000;

// Text that may reach the owner's email and nothing else: names, the billing contact, Stripe identifiers, a case subject and amounts.
const secrets = { email: `billing.${run}@example.test`, customerName: `Canary Customer ${run}`, requester: `Canary Requester ${run}`, caseSubject: `Canary case subject ${run}` };
const names = {
  payer: `A0 Pay <script>alert('${run}')</script> & "Co"`,
  trial: `A0 Trial Ending ${run}`,
  renewing: `A0 Annual Renewal ${run}`,
  growing: `A0 Growing Usage ${run}`,
  long: `A0 ${'Very Long Facility Name '.repeat(6)}${run}`,
  closedbilling: `A0 Closed Still Billing ${run}`,
  customeronly: `A0 Customer Only ${run}`,
  testmode: `A0 Test Mode Only ${run}`,
  nobilling: `A0 No Billing ${run}`,
};
const stripePrefixes = ['cus', 'sub', 'in', 'si', 'price', 'prod', 'di'].map(kind => `${kind}_acct${run}`);
const amounts = { overdue: '$73.19', annual: '$1,234.56' };
const couponId = `cpn_acct${run}`;
const shortDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);

const call = async (fn, args = []) => (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r;
const refused = (code, pattern) => error => { assert.equal(error.code, code, error.message); if (pattern) assert.match(error.message, pattern); return true; };
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await admin.query(sql, params)).rows;
const ownerCall = (fn, args = [], token = ownerToken) => withSession(pool, token, async db =>
  (await db.query(`select to_jsonb(${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})) as r`, args)).rows[0].r);
const inDays = param => `(case when ${param}::int is null then null else now() + make_interval(days => ${param}::int) end)`;

const tenants = [];
const live = ['payer', 'trial', 'renewing', 'growing', 'long', 'closedbilling', 'customeronly'];

// One invented account: the tenant, its products, its Stripe customer, subscriptions with items, invoices, usage reports and cases.
async function makeAccount(key, { status = 'active', livemode = true, customer = null, subscriptions = [], invoices = [], usage = [], cases = [], products = ['carebase'] } = {}) {
  const tenant = (await row('insert into hub.tenants(slug, name, status) values ($1, $2, $3::hub.tenant_status) returning id', [`${prefix}-${key}`, names[key], status])).id;
  tenants.push(tenant);
  for (const product of products) {
    await admin.query("insert into hub.tenant_products(tenant_id, product_id, plan_code, status) select $1::uuid, id, 'core', 'active' from hub.products where slug = $2::text", [tenant, product]);
  }
  const customerId = `cus_acct${run}${key}`;
  if (customer) {
    await admin.query('insert into private.billing_customers(tenant_id, stripe_customer_id, email, name, delinquent, balance, livemode, seen_at) values ($1, $2, $3, $4, $5, $6, $7, now())',
      [tenant, customerId, customer.email ?? '', customer.name ?? '', customer.delinquent ?? false, customer.balance ?? 0, livemode]);
  }
  for (const [index, subscription] of subscriptions.entries()) {
    const subscriptionId = `sub_acct${run}${key}${index}`;
    await admin.query(`insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, current_period_end, trial_end,
        cancel_at_period_end, discounts, livemode, stripe_created, seen_at)
      select $1::text, $2::uuid, $3::text, p.id, $4::text, 'charge_automatically', ${inDays('$5')}, ${inDays('$6')}, $7::boolean, $8::jsonb, $9::boolean, now() - make_interval(days => $10::int), now() from hub.products p where p.slug = 'carebase'`,
    [subscriptionId, tenant, customerId, subscription.status, subscription.periodEnd ?? null, subscription.trialEnd ?? null, subscription.cancelAtPeriodEnd ?? false,
      JSON.stringify(subscription.coupon ? [{ id: `di_acct${run}${key}`, coupon: subscription.coupon, promotion_code: null }] : []), livemode, subscription.createdDaysAgo ?? 90]);
    for (const [position, item] of subscription.items.entries()) {
      await admin.query(`insert into private.billing_subscription_items(stripe_item_id, stripe_subscription_id, stripe_price_id, stripe_product_id, quantity, unit_amount, currency, recurring_interval, interval_count)
        values ($1, $2, $3, $4, $5, $6, 'usd', $7, $8)`,
      [`si_acct${run}${key}${index}x${position}`, subscriptionId, `price_acct${run}${key}${index}x${position}`, `prod_acct${run}${key}${index}x${position}`, item.quantity, item.amount, item.interval ?? 'month', item.count ?? 1]);
    }
  }
  for (const [index, invoice] of invoices.entries()) {
    await admin.query(`insert into private.billing_invoices(stripe_invoice_id, tenant_id, stripe_customer_id, stripe_subscription_id, status, currency, total, subtotal, amount_due, amount_paid, amount_remaining,
        due_date, livemode, stripe_created, seen_at)
      values ($1, $2, $3, null, $4, 'usd', $5, $5, $5, $6, $7, ${inDays('$8')}, $9, now() - make_interval(days => $10::int), now())`,
    [`in_acct${run}${key}${index}`, tenant, customerId, invoice.status, invoice.amount, invoice.status === 'paid' ? invoice.amount : 0, invoice.status === 'paid' ? 0 : invoice.amount, invoice.dueInDays ?? null, livemode, invoice.createdDaysAgo ?? 20]);
  }
  for (const report of usage) {
    await admin.query(`insert into private.billing_usage_reports(product_id, tenant_id, metric, quantity, request_key, outcome, reported_at)
      select p.id, $1::uuid, $2::text, $3::int, gen_random_uuid(), 'updated', now() - make_interval(days => $4::int) from hub.products p where p.slug = 'carebase'`, [tenant, report.metric, report.quantity, report.daysAgo]);
  }
  for (const entry of cases) {
    await admin.query(`insert into hub.support_cases(id, tenant_id, product_id, requester_id, requester_display_name, subject, status, priority, created_at, resolved_at)
      select gen_random_uuid(), $1::uuid, p.id, $2::uuid, $3::text, $4::text, $5::text::hub.case_status, $6::text::hub.case_priority, now() - make_interval(days => $7::int),
        case when $5::text in ('resolved', 'closed') then now() - interval '1 day' end from hub.products p where p.slug = 'carebase'`,
    [tenant, owner, secrets.requester, secrets.caseSubject, entry.status, entry.priority, entry.daysAgo ?? 2]);
  }
  return tenant;
}

// Children before parents: the billing tables restrict deleting a tenant.
async function removeAccounts(list) {
  if (list.length === 0) return;
  for (const sql of [
    'delete from hub.support_cases where tenant_id = any($1::uuid[])',
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
const mail = [];
const texts = [];
const logs = [];
const clock = { value: null };

try {
  await admin.query("delete from private.owner_notifications where dedupe_key like 'accounts:%'");
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'accounts-owner@test.invalid',false)", [owner]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, ownerPhone]);
  await admin.query("insert into hub.profiles(id,display_name) values($1,'Accounts integration owner') on conflict (id) do update set display_name=excluded.display_name", [owner]);
  await admin.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at)
    select $1,$2,user_id,identity_version,now(),now()+interval '1 hour' from private.sms_identities where user_id=$3`, [randomUUID(), digest(ownerToken), owner]);
  // The owner is "the single active administrator": set the ones other scripts left behind aside for this run.
  setAside = (await admin.query("update private.staff_permissions set revoked_at = now() where permission = 'platform.admin' and revoked_at is null and user_id <> $1 returning id", [owner])).rows.map(entry => entry.id);

  // ---- The boundary: the Hub server reads through one operation; nobody else reads anything ----------------------------------
  await assert.rejects(admin.query('select private.agent_accounts_snapshot(10)'), refused('42501', /Application server required/));
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      await assert.rejects(client.query('select private.agent_accounts_snapshot(10)'), refused('42501'), `${role} cannot read the snapshot`);
    } finally { await client.query('rollback'); client.release(); }
  }
  await assert.rejects(pool.query('select private.agent_accounts_json(10)'), refused('42501'), 'the helpers are not callable, even by the server role');
  await assert.rejects(pool.query('select private.agent_subscription_facts(null::private.billing_subscriptions)'), refused('42501'));
  await assert.rejects(pool.query('select count(*) from private.billing_customers'), refused('42501'), 'the server role has no direct access to the billing mirror');
  for (const limit of [0, 501, -1, null]) await assert.rejects(call('private.agent_accounts_snapshot', [limit]), refused('22023', /Choose a limit between 1 and 500/), `limit ${limit}`);
  const features = (await api.rpc('get_backend_contract', {})).features;
  assert.ok(features.includes('platform.agents.accounts.v1'), 'the feature is declared');

  // ---- Fixtures: seven live accounts, one test-mode account and one tenant with no billing ------------------------------------------
  await admin.query('update private.billing_settings set livemode = true');
  await admin.query("insert into private.billing_coupons(stripe_coupon_id, percent_off, duration, valid, livemode, stripe_created, seen_at) values ($1, 25, 'forever', true, true, now(), now())", [couponId]);
  await makeAccount('payer', {
    customer: { email: secrets.email, name: secrets.customerName, delinquent: true, balance: 1234 },
    subscriptions: [{ status: 'past_due', createdDaysAgo: 200, periodEnd: -2, items: [{ quantity: 3, amount: 1999 }] }],
    invoices: [{ status: 'open', amount: 7319, dueInDays: -10, createdDaysAgo: 40 }, { status: 'paid', amount: 5997, createdDaysAgo: 70 }],
    cases: [{ status: 'open', priority: 'high' }, { status: 'waiting_on_customer', priority: 'low', daysAgo: 6 }],
  });
  await makeAccount('trial', { customer: { email: '' }, subscriptions: [{ status: 'trialing', createdDaysAgo: 30, trialEnd: 3, periodEnd: 3, items: [{ quantity: 1, amount: 4900 }] }] });
  await makeAccount('renewing', { customer: { email: secrets.email }, subscriptions: [{ status: 'active', createdDaysAgo: 340, periodEnd: 20, items: [{ quantity: 1, amount: 123456, interval: 'year' }] }] });
  await makeAccount('growing', {
    customer: { email: secrets.email }, subscriptions: [{ status: 'active', createdDaysAgo: 100, periodEnd: 15, coupon: couponId, items: [{ quantity: 2, amount: 5900 }] }],
    usage: [{ metric: 'facility', quantity: 10, daysAgo: 40 }, { metric: 'facility', quantity: 14, daysAgo: 1 }, { metric: 'seat', quantity: 5, daysAgo: 2 }],
  });
  await makeAccount('long', { customer: { email: secrets.email }, subscriptions: [{ status: 'active', createdDaysAgo: 150, periodEnd: 12, cancelAtPeriodEnd: true, items: [{ quantity: 1, amount: 2500 }] }] });
  await makeAccount('closedbilling', { status: 'closed', customer: { email: secrets.email }, subscriptions: [{ status: 'active', createdDaysAgo: 120, periodEnd: 25, items: [{ quantity: 1, amount: 3100 }] }] });
  await makeAccount('customeronly', { customer: { email: secrets.email } });
  await makeAccount('testmode', { livemode: false, customer: { email: secrets.email }, subscriptions: [{ status: 'active', createdDaysAgo: 60, items: [{ quantity: 1, amount: 9900 }] }] });
  await makeAccount('nobilling');

  // ---- What the snapshot holds ------------------------------------------------------------------------------------------------------
  const read = async (limit = 500) => call('private.agent_accounts_snapshot', [limit]);
  const mine = snapshot => snapshot.accounts.filter(entry => entry.slug.startsWith(prefix));
  const slugs = snapshot => mine(snapshot).map(entry => entry.slug.slice(prefix.length + 1)).sort();
  let snap = await read();
  assert.deepEqual(Object.keys(snap).sort(), ['accounts', 'coupons', 'generatedAt', 'mode', 'total', 'truncated']);
  assert.equal(snap.mode, 'live');
  assert.deepEqual(slugs(snap), [...live].sort(), 'live mode: the seven live accounts, not the test-mode one, not the tenant with no billing');
  assert.ok(snap.total >= live.length);
  assert.deepEqual(mine(snap).map(entry => entry.name),
    (await rows('select name from hub.tenants where slug = any($1::text[]) order by name, id', [live.map(key => `${prefix}-${key}`)])).map(entry => entry.name), 'accounts come by name, then id, in the database\'s own order');
  const serialized = JSON.stringify(snap);
  for (const secret of [secrets.email, secrets.customerName, secrets.requester, secrets.caseSubject, ...stripePrefixes.filter(value => !/^(prod|di)_/.test(value))]) {
    assert.ok(!serialized.includes(secret), `the snapshot never carries ${secret.slice(0, 14)}…`);
  }
  const byKey = Object.fromEntries(mine(snap).map(entry => [entry.slug.slice(prefix.length + 1), entry]));
  assert.deepEqual(Object.keys(byKey.payer).sort(), ['cases', 'createdAt', 'customer', 'invoices', 'name', 'products', 'slug', 'status', 'subscriptions', 'usage']);
  assert.deepEqual(byKey.payer.customer, { delinquent: true, balanceCents: 1234, hasEmail: true });
  assert.deepEqual(byKey.trial.customer.hasEmail, false, 'an empty billing address is "no address", never an address');
  assert.deepEqual([byKey.payer.invoices.open, byKey.payer.invoices.overdue, byKey.payer.invoices.remainingCents], [1, 1, 7319]);
  assert.deepEqual([byKey.payer.cases.waitingOnYou, byKey.payer.cases.highOrUrgent, byKey.payer.cases.waitingOnCustomer], [1, 1, 1], 'cases are numbers only');
  assert.deepEqual(byKey.growing.usage.map(entry => [entry.metric, entry.latest, entry.baseline]), [['facility', 14, 10], ['seat', 5, null]]);

  // The same facts through the pure scoring: what the database says reaches the health score as written.
  const asOf = new Date();
  const health = Object.fromEntries(Object.entries(byKey).map(([key, entry]) => [key, assess(entry, asOf)]));
  assert.deepEqual([health.payer.band, health.payer.score, health.payer.reasons], ['at_risk', 45, ['past_due', 'invoice_overdue', 'delinquent', 'urgent_case_waiting']]);
  assert.deepEqual([health.trial.band, health.trial.score, health.trial.reasons], ['healthy', 75, ['trial_ending', 'no_billing_email']]);
  assert.deepEqual([health.renewing.band, health.renewing.reasons, health.renewing.flags], ['healthy', [], ['renewing_soon']]);
  assert.deepEqual([health.growing.band, health.growing.reasons, health.growing.flags], ['healthy', [], ['usage_up']]);
  assert.deepEqual([health.long.band, health.long.reasons], ['watch', ['cancel_scheduled']]);
  assert.deepEqual([health.closedbilling.band, health.closedbilling.reasons], ['watch', ['closed_but_billing']]);
  assert.equal(health.customeronly.band, 'inactive');
  // MRR by hand: 3 x $19.99 + $1,234.56 a year + 2 x $59.00 less 25% + $25.00 + $31.00, with the trial counted apart.
  const totals = monthlyTotals(mine(snap).flatMap(entry => entry.subscriptions), snap.coupons);
  assert.deepEqual([totals.mrrCents, totals.trialMrrCents, totals.byStatus.past_due], [5997 + 10288 + 8850 + 2500 + 3100, 4900, 1], 'the revenue figures agree with a hand count');
  assert.equal(JSON.stringify(await read()).replace(/"generatedAt":"[^"]+"/, ''), JSON.stringify(snap).replace(/"generatedAt":"[^"]+"/, ''), 'reading twice gives the same answer');

  // ---- The three Stripe modes -----------------------------------------------------------------------------------------------------
  for (const [livemode, mode, expectedKeys] of [[false, 'test', ['testmode']], [null, 'unverified', [...live, 'testmode']], [true, 'live', live]]) {
    await admin.query('update private.billing_settings set livemode = $1', [livemode]);
    const view = await read();
    assert.equal(view.mode, mode);
    assert.deepEqual(slugs(view), [...expectedKeys].sort(), `${mode} mode shows only what that mode shows`);
  }

  // ---- The team: one weekly report, through the real store, queue and notifier ----------------------------------------------------
  await admin.query("update private.agents set status = 'active' where key = 'account_manager'");
  await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day', enabled = true");
  const sender = { configured: true, send: async (to, subject, content) => { mail.push({ to, subject, content }); return { delivery: 'sent', id: `fixture-${mail.length}` }; } };
  const phone = { configured: true, send: async (to, body) => { texts.push([to, body]); return { delivery: 'sent', id: `SM${'0'.repeat(32)}` }; } };
  const teamFor = (options = {}) => agentTeam({
    pool, enabled: true, ownerEmail: 'owner@example.test', publicOrigin: 'https://hub.test', log: line => logs.push(line), features: new Set(features),
    now: () => clock.value ?? new Date(), sms: phone, email: sender, ...options,
  });
  const team = teamFor();
  assert.ok(team.scheduler.kinds().includes('accounts.weekly'), 'registered once the database declares the feature');
  const bare = teamFor({ features: new Set(['platform.agents.v1']) });
  assert.ok(!bare.scheduler.kinds().includes('accounts.weekly'), 'a server whose database lacks the feature does not run it');
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '1 minute' where task_kind = 'accounts.weekly'");
  assert.deepEqual([(await bare.tick()).fired], [0], 'and its schedule stays due instead of failing');
  assert.equal((await row("select next_run_at < now() as due from private.agent_schedules where task_kind = 'accounts.weekly'")).due, true);

  let minutes = 2;
  const latestTask = () => row("select * from private.agent_tasks where kind = 'accounts.weekly' order by created_at desc, id limit 1");
  const fire = async (who = team) => {
    minutes += 1;
    await admin.query("update private.agent_schedules set next_run_at = now() - make_interval(mins => $1::int) where task_kind = 'accounts.weekly'", [minutes]);
    const tick = await who.tick();
    assert.deepEqual([tick.fired, tick.claimed], [1, 1], 'the schedule fires the report');
    return latestTask();
  };
  const runNow = async (who = team) => {
    const asked = await ownerCall('hub.request_agent_task', ['account_manager', 'accounts.weekly']);
    assert.equal(asked.status, 'queued');
    assert.equal((await who.tick()).claimed, 1);
    const finished = await row('select * from private.agent_tasks where id = $1', [asked.id]);
    assert.equal(finished.status, 'done');
    return finished;
  };

  // The first scheduled run of the week sends.
  const weekBefore = weekStart(new Date());
  const first = await fire();
  const weekAfter = weekStart(new Date());
  assert.equal(first.status, 'done');
  assert.equal(first.source_kind, 'schedule');
  assert.equal(mail.length, 1, 'one email');
  assert.equal(texts.length, 0, 'the report never texts');
  const expected = composeAccountsReport({ snapshot: await read(200), now: new Date(), publicOrigin: 'https://hub.test' });
  assert.ok([weekBefore, weekAfter].includes(first.result.week));
  assert.deepEqual(first.result, { week: first.result.week, delivery: ['email:sent'], ...expected.result }, 'the task result is the counts and nothing else');
  assert.ok(JSON.stringify(first.result).length < 600);
  assert.ok(expected.result.accounts >= live.length - 1, 'every live account with something to report is counted (a closed account with nothing live is not)');
  assert.equal(mail[0].subject, expected.subject);
  const notification = await row("select * from private.owner_notifications where dedupe_key like 'accounts:%' order by created_at limit 1");
  assert.deepEqual([notification.dedupe_key, notification.channel, notification.severity, notification.status, notification.agent_key, notification.task_id, notification.subject, notification.body],
    [`accounts:weekly:${first.result.week}`, 'email', 'info', 'sent', 'account_manager', first.id, expected.subject, expected.body]);
  const firstRun = await row("select * from private.agent_runs where agent_key = 'account_manager' order by started_at desc limit 1");
  assert.deepEqual([firstRun.model, firstRun.prompt_version, firstRun.outcome, Number(firstRun.cost_cents), firstRun.task_id], ['none', 'accounts.1', 'completed', 0, first.id]);
  assert.equal(firstRun.summary, `Sent the weekly accounts report: ${expected.body}`);

  // What is in the owner's email: names, reasons and amounts, escaped, clipped, and no billing address or Stripe identifier.
  const { html, text } = mail[0].content;
  assert.ok(html.includes(escapeHtml(names.payer)) && !html.includes('<script>alert('), 'a hostile name is escaped');
  assert.ok(text.includes(names.payer));
  const trialEnd = shortDay.format(new Date(Date.now() + 3 * day));
  const cancelDate = shortDay.format(new Date(Date.now() + 12 * day));
  const renewDate = shortDay.format(new Date(Date.now() + 20 * day));
  for (const phrase of [
    `Payment past due; 1 overdue invoice, ${amounts.overdue} remaining; marked delinquent in Stripe`, `Trial ends ${trialEnd}; no billing email on file`, 'Account closed but still billing',
    `Cancels ${cancelDate}`, `Renews ${renewDate}, ${amounts.annual} a year`, 'Usage is growing', 'Needs you', 'Renewing in the next 30 days', 'Growing', 'Revenue',
  ]) assert.ok(text.includes(phrase), `the email says "${phrase}"`);
  assert.ok(text.includes(clip(names.long, 60)) && !text.includes(names.long), 'a long name is clipped');
  assert.ok(html.includes('https://hub.test/admin/team'), 'the button opens the Team screen');
  assert.ok(!html.includes('Test data.') && !html.includes('Stripe mode not verified.'), 'live data carries no warning');
  for (const secret of [secrets.email, secrets.customerName, secrets.requester, secrets.caseSubject, ...stripePrefixes]) {
    assert.ok(!html.includes(secret) && !text.includes(secret), `the email never carries ${secret.slice(0, 14)}…`);
  }

  // A second scheduled run the same week finds the report already sent: no email, no run, no new alert row.
  const second = await fire();
  assert.deepEqual(second.result, { skipped: 'already_sent', week: first.result.week });
  assert.equal(mail.length, 1, 'the week is reported once');
  assert.equal(Number((await row("select count(*) from private.agent_runs where agent_key = 'account_manager'")).count), 1, 'and a skipped run leaves no run row');
  assert.equal(Number((await row("select count(*) from private.owner_notifications where dedupe_key like 'accounts:%'")).count), 1);

  // "Run now" always reports, under a key of its own.
  const asked = await runNow();
  assert.equal(asked.source_kind, 'owner');
  assert.equal(mail.length, 2, 'Run now sends the report again');
  assert.equal((await row("select count(*) from private.owner_notifications where dedupe_key = $1", [`accounts:run:${asked.id}`])).count, '1');
  assert.deepEqual(asked.result.delivery, ['email:sent']);

  // The next Eastern week sends its own report; the same moment's second run does not.
  clock.value = new Date(Date.now() + 8 * day);
  const nextWeek = weekStart(clock.value);
  assert.notEqual(nextWeek, first.result.week);
  const third = await fire();
  assert.deepEqual([third.result.week, third.result.delivery], [nextWeek, ['email:sent']]);
  assert.equal(mail.length, 3);
  assert.deepEqual((await fire()).result, { skipped: 'already_sent', week: nextWeek });
  assert.equal(mail.length, 3);

  // An email switched off is recorded as suppressed and not retried by itself; Run now sends it. (Two weeks ahead, so the key is new.)
  clock.value = new Date(Date.now() + 16 * day);
  const quiet = teamFor({ email: { configured: false, send: async () => ({ delivery: 'sent', id: 'never' }) } });
  const suppressed = await fire(quiet);
  assert.deepEqual(suppressed.result.delivery, ['email:suppressed']);
  assert.equal(mail.length, 3, 'nothing was sent');
  const suppressedRun = await row("select * from private.agent_runs where agent_key = 'account_manager' order by started_at desc limit 1");
  assert.deepEqual([suppressedRun.outcome, suppressedRun.error_code], ['failed', 'not_delivered'], 'the run says it was not delivered');
  assert.equal((await row("select status from private.owner_notifications where dedupe_key = $1", [`accounts:weekly:${weekStart(clock.value)}`])).status, 'suppressed');
  assert.deepEqual((await fire()).result, { skipped: 'already_sent', week: weekStart(clock.value) }, 'a later run does not resend a week that was switched off');
  assert.equal(mail.length, 3);
  assert.deepEqual((await runNow()).result.delivery, ['email:sent']);
  assert.equal(mail.length, 4, 'but Run now does');
  clock.value = null;

  // The three Stripe modes, as the owner reads them in the email.
  for (const [livemode, warning] of [[false, 'Test data.'], [null, 'Stripe mode not verified.'], [true, null]]) {
    await admin.query('update private.billing_settings set livemode = $1', [livemode]);
    await runNow();
    const { html: view } = mail.at(-1).content;
    for (const phrase of ['Test data.', 'Stripe mode not verified.']) assert.equal(view.includes(phrase), phrase === warning, `${livemode}: "${phrase}"`);
  }
  assert.ok(mail.length === 7);

  // ---- A big book: 300 more accounts, inside the statement timeout, reported as a partial list ----------------------------------------
  const bulk = (await rows(`insert into hub.tenants(slug, name) select '${prefix}-bulk-' || n, 'A1 Bulk Account ${run} ' || lpad(n::text, 4, '0') from generate_series(1, 300) n returning id`)).map(entry => entry.id);
  tenants.push(...bulk);
  await admin.query(`with t as (select id, row_number() over (order by slug) as n from hub.tenants where id = any($1::uuid[]))
    insert into private.billing_customers(tenant_id, stripe_customer_id, email, name, livemode, seen_at) select id, 'cus_acct${run}bulk' || n, 'bulk' || n || '@example.test', '', true, now() from t`, [bulk]);
  await admin.query(`with t as (select id, row_number() over (order by slug) as n from hub.tenants where id = any($1::uuid[]))
    insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, current_period_end, livemode, stripe_created, seen_at)
    select 'sub_acct${run}bulk' || n, t.id, 'cus_acct${run}bulk' || n, p.id, 'active', 'charge_automatically', now() + interval '20 days', true, now() - interval '90 days', now()
    from t cross join (select id from hub.products where slug = 'carebase') p`, [bulk]);
  await admin.query(`with t as (select id, row_number() over (order by slug) as n from hub.tenants where id = any($1::uuid[]))
    insert into private.billing_subscription_items(stripe_item_id, stripe_subscription_id, stripe_price_id, stripe_product_id, quantity, unit_amount, currency, recurring_interval, interval_count)
    select 'si_acct${run}bulk' || n, 'sub_acct${run}bulk' || n, 'price_acct${run}bulk', 'prod_acct${run}bulk', 1, 4900, 'usd', 'month', 1 from t`, [bulk]);
  await admin.query(`with t as (select id, row_number() over (order by slug) as n from hub.tenants where id = any($1::uuid[]))
    insert into private.billing_usage_reports(product_id, tenant_id, metric, quantity, request_key, outcome, reported_at)
    select p.id, t.id, 'facility', r.quantity, gen_random_uuid(), 'updated', now() - r.age from t cross join (select id from hub.products where slug = 'carebase') p
    cross join (values (10, interval '40 days'), (12, interval '1 day')) as r(quantity, age)`, [bulk]);
  await admin.query(`with t as (select id, row_number() over (order by slug) as n from hub.tenants where id = any($1::uuid[]))
    insert into private.billing_invoices(stripe_invoice_id, tenant_id, stripe_customer_id, status, currency, total, subtotal, amount_due, amount_paid, amount_remaining, due_date, livemode, stripe_created, seen_at)
    select 'in_acct${run}bulk' || n, t.id, 'cus_acct${run}bulk' || n, 'open', 'usd', 4900, 4900, 4900, 0, 4900, now() - interval '9 days', true, now() - interval '30 days', now() from t where n % 10 = 0`, [bulk]);

  const client = await pool.connect();
  let large;
  let took;
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '12s'");
    const started = performance.now();
    large = (await client.query('select private.agent_accounts_snapshot(500) as r')).rows[0].r;
    took = performance.now() - started;
    await client.query('commit');
  } finally { client.release(); }
  assert.ok(took < 12_000, `the largest snapshot answers inside the statement timeout (${Math.round(took)} ms)`);
  assert.deepEqual([large.accounts.length, large.truncated], [Math.min(500, large.total), large.total > 500]);
  assert.ok(large.total >= live.length + 300);
  assert.ok(JSON.stringify(large).length < 2_500_000, 'and its size is bounded');
  const capped = await read(200);
  assert.deepEqual([capped.accounts.length, capped.truncated, capped.total], [200, true, large.total], 'a list longer than the limit is cut at the limit and says so');

  const huge = await runNow();
  assert.deepEqual([huge.result.accounts, huge.result.truncated], [200, true]);
  const { html: partial, text: partialText } = mail.at(-1).content;
  assert.match(partialText, new RegExp(`Showing 200 of ${large.total} accounts`));
  assert.ok(partial.includes('Partial list.'));
  assert.ok(partial.length < 80_000, `the email stays small however many accounts there are (${partial.length} characters)`);
  assert.ok((partialText.match(/And \d+ more\./g) ?? []).length >= 1, 'and each section says how many rows it left out');
  await removeAccounts(bulk);
  tenants.splice(tenants.length - bulk.length, bulk.length);

  // ---- Nothing the accounts held is anywhere but the owner's email ------------------------------------------------------------------
  const everything = JSON.stringify([
    await rows('select to_jsonb(t) as r from private.agent_tasks t'), await rows('select to_jsonb(r) as r from private.agent_runs r'),
    await rows('select to_jsonb(a) as r from private.agent_actions a'), await rows('select to_jsonb(n) as r from private.owner_notifications n'),
    await rows("select metadata from private.audit_events where action like 'agent.%'"), logs, texts,
  ]);
  // The stored rows are JSON text, which escapes quotes and backslashes: look for each probe as written and as JSON writes it.
  for (const secret of [...Object.values(names), ...Object.values(secrets), ...stripePrefixes, ...Object.values(amounts), couponId, ownerToken]) {
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      assert.ok(!everything.includes(form), `${secret.slice(0, 14)}… appears in no task, run, alert, audit event, log line or text`);
    }
  }
  assert.ok(mail.some(entry => entry.content.text.includes(names.payer)), 'while the email did carry the names');

  // ---- The deployment gate re-runs cleanly, and refuses to declare the feature once the boundary drifts ---------------------------------
  const gateClient = await admin.connect();
  try {
    await gateClient.query('begin');
    await gateClient.query(gate);
    await gateClient.query('rollback');
    for (const [sql, message] of [
      ['revoke execute on function private.agent_accounts_snapshot(integer) from hub_app_server', /executable by the Hub server only/],
      ['grant execute on function private.agent_accounts_snapshot(integer) to authenticated', /executable by the Hub server only/],
      ['alter function private.agent_accounts_snapshot(integer) security invoker', /executable by the Hub server only/],
      ['grant execute on function private.agent_accounts_json(integer) to hub_app_server', /must not be executable by any application role/],
      ['grant execute on function private.agent_subscription_facts(private.billing_subscriptions) to anon', /must not be executable by any application role/],
      ['alter function private.agent_accounts_json(integer) reset search_path', /must not be executable by any application role/],
      ["delete from private.agent_schedules where agent_key = 'account_manager' and task_kind = 'accounts.weekly'", /weekly schedule must exist/],
      ["delete from private.owner_notifications where agent_key = 'account_manager'; delete from private.agent_actions where agent_key = 'account_manager'; delete from private.agent_runs where agent_key = 'account_manager'; delete from private.agent_tasks where agent_key = 'account_manager'; delete from private.agent_schedules where agent_key = 'account_manager'; delete from private.agents where key = 'account_manager'", /agent must exist/],
      ["create or replace function hub.get_backend_contract() returns jsonb language sql stable as $$ select '{\"api_version\":4,\"features\":[\"platform.agents.v1\"]}'::jsonb $$", /Apply the AI team control plane and the platform billing mirror first/],
    ]) {
      await gateClient.query('begin');
      try {
        await gateClient.query(sql);
        await assert.rejects(gateClient.query(gate), rejection => rejection.code === '55000' && message.test(rejection.message), sql);
      } finally { await gateClient.query('rollback'); }
    }
  } finally { gateClient.release(); }

  console.log(`Account Manager: the server-only snapshot (no billing address, name or customer, subscription or invoice identifier; three Stripe modes; a 300-account book in ${Math.round(took)} ms), the health scores read from real rows, one weekly report through the real store, queue and notifier, the weekly key and Run now, suppressed and partial-list reports, the privacy of every stored record, and the deployment gate all behave through hub_app_server.`);
} finally {
  const problems = [];
  const attempt = async (sql, params = []) => { try { await admin.query(sql, params); } catch (error) { problems.push(`${error.message} [${sql.slice(0, 70)}]`); } };
  await attempt("delete from private.audit_events where action like 'agent.%' or actor_id = $1", [owner]);
  await attempt('delete from private.agent_actions');
  await attempt('delete from private.agent_runs');
  await attempt('delete from private.owner_notifications');
  await attempt('delete from private.agent_tasks');
  try { await removeAccounts(tenants); } catch (error) { problems.push(error.message); }
  await attempt('delete from private.billing_coupons where stripe_coupon_id = $1', [couponId]);
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
