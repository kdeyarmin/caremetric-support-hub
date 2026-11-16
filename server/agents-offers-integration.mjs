// Offers from the owner's menu through the real roles: which accounts qualify, the daily run's proposals, an owner approval and an
// automatic one carried out without a session, every refusal (the cap, once per account, trust withdrawn, the offer switched off, an
// account that no longer qualifies, a trial extended past the offer's window), Stripe refusing (the place is given back) or not answering
// (it is kept, the owner warned), an answer that could not be recorded (settled from how the action ended), a replay after a restart, the
// owner's menu operations and the deployment gate. Disposable loopback database only; Stripe is a fake here (the session-less billing call
// itself is exercised against the fake Stripe API in billing-integration.mjs).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { StripeError } from './stripe.mjs';
import { HttpError } from './sms-auth.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { actionExecutor } from './agents/actions.mjs';
import { offerExecutors, offersFeature } from './agents/accounts/offers.mjs';
import { offerHandlers } from './agents/tasks/offers.mjs';
import { testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = sqlAgentStore(pool, { fenced: true });
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `offers-${randomUUID()}`;
const aiAssistant = 'a1a00000-a1a0-4000-8000-000000000001';
const features = new Set([offersFeature]);
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;

// Stripe stand-in: records each request and answers as the test says.
const stripeCalls = [];
let stripeAnswer = async () => ({ applied: true, already: false, mirrored: true });
const billing = { agentOffer: async request => { stripeCalls.push(request); return stripeAnswer(request); } };
const notes = [];
const notifier = { send: async note => { notes.push(note); return [{ channel: 'email', delivery: 'sent' }]; } };
const actions = actionExecutor({ store, executors: offerExecutors({ store, features, billing, notifier, log: () => {} }), log: () => {} });
const handler = offerHandlers({ store, features, log: () => {} })['accounts.offers'];

const seedManager = await row("select status, autonomy, config from private.agents where key = 'account_manager'");
const seedOffer = await row("select enabled, monthly_cap, changed_at, changed_by from private.agent_offer_menu where key = 'trial_extension_14'");
const seedLive = (await row('select livemode from private.billing_settings')).livemode;
const carebase = (await row("select id from hub.products where slug = 'carebase'")).id;
const tenants = {}, tasks = [], added = [];
const day = 86_400_000;

async function account(name, { status = 'trialing', trialDays = 3, livemode = true } = {}) {
  const id = randomUUID();
  const slug = `offers-${name}-${run}`;
  await admin.query("insert into hub.tenants(id, slug, name, status) values ($1, $2, $3, 'active')", [id, slug, `Offer ${name}`]);
  await admin.query('insert into private.billing_customers(tenant_id, stripe_customer_id, email, name, delinquent, balance, livemode, seen_at) values ($1, $2, $3, $4, false, 0, $5, now())',
    [id, `cus_${name}${run}`, `${name}-${run}@example.test`, `Offer ${name}`, livemode]);
  const trialEnd = status === 'trialing' ? new Date(Date.now() + trialDays * day) : null;
  await admin.query(`insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, trial_end, discounts, livemode, stripe_created, seen_at)
    values ($1, $2, $3, $4, $5, 'charge_automatically', $6, '[]', $7, now(), now())`, [`sub_${name}${run}`, id, `cus_${name}${run}`, carebase, status, trialEnd, livemode]);
  tenants[name] = { id, slug, subscription: `sub_${name}${run}`, trialEnd };
  return tenants[name];
}
async function task() {
  const id = (await row("insert into private.agent_tasks(agent_key, kind, request_key, status, attempts, lease_until) values ('account_manager', 'accounts.offers', $1, 'running', 1, now() + interval '10 minutes') returning id", [`offers:${run}:${randomUUID()}`])).id;
  tasks.push(id); return id;
}
const manager = async (autonomy, kinds = []) => admin.query("update private.agents set status = 'active', autonomy = $1, config = jsonb_set(config, '{auto_approve_kinds}', $2::jsonb) where key = 'account_manager'",
  [autonomy, JSON.stringify(kinds)]);
const menu = async (enabled, cap) => admin.query("update private.agent_offer_menu set enabled = $1, monthly_cap = $2 where key = 'trial_extension_14'", [enabled, cap]);
// An offer straight onto the queue, as a run or the owner would leave it.
async function offerAction(account, status = 'auto_approved') {
  return (await row(`insert into private.agent_actions (agent_key, task_id, kind, target_kind, target_id, preview, input, status)
    values ('account_manager', $1, 'offer.apply', 'billing_account', $2, 'Offer', $3, $4) returning id`,
  [await task(), account.slug, { offer: 'trial_extension_14', tenant: account.slug, product: 'carebase', subscription: account.subscription }, status])).id;
}
const outcome = async id => row('select status, result from private.agent_actions where id = $1', [id]);
const ours = list => list.filter(entry => entry.tenant.endsWith(`-${run}`)).map(entry => entry.tenant).sort();
const runDaily = async autonomy => handler({ id: await task(), agentKey: 'account_manager', kind: 'accounts.offers', agent: { autonomy } });

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `offers-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, phones.owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  const owned = (sql, values = []) => withSession(pool, token, async db => (await db.query(sql, values)).rows[0].r);

  await admin.query('update private.billing_settings set livemode = true');
  await menu(true, 10);
  await manager('propose');
  const [a, b] = [await account('a'), await account('b')];
  await account('test', { livemode: false });
  await account('later', { trialDays: 20 });
  const paying = await account('paying', { status: 'active' });

  // Who qualifies: live trials of the offer's products that end within its window. A test-mode trial, one ending later and a paying account do not.
  const first = await store.offerCandidates(50);
  assert.equal(first.mode, 'live');
  assert.deepEqual(ours(first.candidates), [a.slug, b.slug].sort());
  assert.equal(JSON.stringify(first).includes('@example.test'), false, 'the candidates carry no address');

  // The daily run proposes them for the owner's approval, with exactly what changes.
  const proposedRun = await runDaily('propose');
  assert.ok(proposedRun.result.proposed >= 2);
  const proposals = (await admin.query("select id, target_id, status, preview from private.agent_actions where kind = 'offer.apply' and target_id = any($1) order by target_id", [[a.slug, b.slug]])).rows;
  assert.deepEqual(proposals.map(entry => entry.status), ['proposed', 'proposed']);
  assert.match(proposals[0].preview, /extend Offer a's .* trial by 14 days/);
  assert.deepEqual(ours((await store.offerCandidates(50)).candidates), [], 'an open proposal keeps an account from being proposed again');

  // The owner approves one: it is made at once, without a session, at the trial end plus the offer's days, under the action's key.
  const approved = await owned('select hub.decide_agent_action($1, $2, $3) as r', [proposals[0].id, 'approve', null]);
  assert.equal(approved.status, 'approved');
  assert.equal((await actions.executeOne(proposals[0].id, { kind: 'offer.apply' })).executed, true);
  const requestKey = (await row('select request_key from private.agent_actions where id = $1', [proposals[0].id])).request_key;
  assert.deepEqual(stripeCalls.at(-1), { subscription: a.subscription, trialEnd: Math.floor((a.trialEnd.getTime() + 14 * day) / 1000), idempotencyKey: `hub-agent-offer-${requestKey}` });
  assert.equal((await row('select status from private.agent_offer_uses where action_id = $1', [proposals[0].id])).status, 'applied');
  const ownerAudit = await row("select actor_id, metadata from private.audit_events where action = 'agent.offer' and tenant_id = $1", [a.id]);
  assert.deepEqual([ownerAudit.actor_id, ownerAudit.metadata.approved, ownerAudit.metadata.status], [aiAssistant, 'owner', 'applied']);
  // The owner rejects the other: a rejected offer is not proposed to that account again.
  await owned('select hub.decide_agent_action($1, $2, $3) as r', [proposals[1].id, 'reject', null]);
  assert.deepEqual(ours((await store.offerCandidates(50)).candidates), []);

  // Handed over: a new qualifying trial is offered and made on its own.
  await manager('act', ['offer.apply']);
  const f = await account('f', { trialDays: 2 });
  await runDaily('act');
  const automatic = await row("select id, status from private.agent_actions where kind = 'offer.apply' and target_id = $1", [f.slug]);
  assert.equal(automatic.status, 'auto_approved');
  await actions.executeReady();
  assert.equal((await outcome(automatic.id)).status, 'executed');
  assert.equal((await row("select metadata from private.audit_events where action = 'agent.offer' and tenant_id = $1", [f.id])).metadata.approved, 'automatic');

  // The cap: with two made this month and a cap of two, no account is proposed and an offer that slipped onto the queue is refused.
  const used = Number((await row("select count(*) from private.agent_offer_uses where offer_key = 'trial_extension_14' and status <> 'refused' and created_at >= private.agent_offer_month_start()")).count);
  await menu(true, used);
  assert.equal((await store.offerCandidates(50)).offers.find(entry => entry.key === 'trial_extension_14').remaining, 0);
  const g = await account('g');
  const capped = await offerAction(g);
  await actions.executeOne(capped, { kind: 'offer.apply' });
  assert.deepEqual(await outcome(capped).then(entry => [entry.status, entry.result.error]), ['failed', 'cap_reached']);
  await menu(true, 50);

  // Once per account; trust withdrawn; the offer switched off; an account that no longer qualifies. Stripe is asked nothing.
  const asked = stripeCalls.length;
  const again = await offerAction(a);
  await actions.executeOne(again, { kind: 'offer.apply' });
  await manager('propose', ['offer.apply']);
  const untrusted = await offerAction(g);
  await actions.executeOne(untrusted, { kind: 'offer.apply' });
  await manager('act', ['offer.apply']);
  await menu(false, 50);
  const off = await offerAction(g);
  await actions.executeOne(off, { kind: 'offer.apply' });
  await menu(true, 50);
  const notTrial = await offerAction(paying);
  await actions.executeOne(notTrial, { kind: 'offer.apply' });
  // A trial extended after the proposal (now ending beyond the offer's window) no longer qualifies, on the daily run's own terms.
  const extended = await account('extended');
  const outsideWindow = await offerAction(extended);
  await admin.query("update private.billing_subscriptions set trial_end = now() + interval '20 days' where stripe_subscription_id = $1", [extended.subscription]);
  await actions.executeOne(outsideWindow, { kind: 'offer.apply' });
  for (const [id, code] of [[again, 'already_offered'], [untrusted, 'offers_off'], [off, 'offer_disabled'], [notTrial, 'not_eligible'], [outsideWindow, 'not_eligible']]) {
    assert.deepEqual(await outcome(id).then(entry => [entry.status, entry.result.error]), ['failed', code], code);
  }
  assert.equal(stripeCalls.length, asked);

  // Stripe refuses: nothing changed, so the place and the account's one offer are given back, and a later offer to it goes through.
  stripeAnswer = async () => { throw new StripeError(400, 'invalid_request_error', 'resource_missing', 'No such subscription'); };
  const said = await offerAction(g);
  await actions.executeOne(said, { kind: 'offer.apply' });
  assert.deepEqual(await outcome(said).then(entry => [entry.status, entry.result.error]), ['failed', 'offer_refused']);
  assert.equal((await row('select status from private.agent_offer_uses where action_id = $1', [said])).status, 'refused');
  stripeAnswer = async () => ({ applied: true, already: false, mirrored: true });
  const retried = await offerAction(g);
  await actions.executeOne(retried, { kind: 'offer.apply' });
  assert.equal((await outcome(retried)).status, 'executed');
  // The Hub could not reach Stripe at all (not configured): the place is given back too.
  stripeAnswer = async () => { throw new HttpError(503, 'Stripe is not configured.'); };
  const h = await account('h');
  const notSetUp = await offerAction(h);
  await actions.executeOne(notSetUp, { kind: 'offer.apply' });
  assert.deepEqual(await outcome(notSetUp).then(entry => [entry.status, entry.result.error]), ['failed', 'billing_unavailable']);
  assert.equal((await row('select status from private.agent_offer_uses where action_id = $1', [notSetUp])).status, 'refused');
  // No answer: it may have been applied, so it keeps its place, is never tried again on its own, and the owner is told.
  stripeAnswer = async () => { throw new TypeError('fetch failed'); };
  const silent = await offerAction(h);
  await actions.executeOne(silent, { kind: 'offer.apply' });
  assert.deepEqual(await outcome(silent).then(entry => [entry.status, entry.result.error]), ['failed', 'offer_unconfirmed']);
  assert.equal((await row('select status from private.agent_offer_uses where action_id = $1', [silent])).status, 'unconfirmed');
  assert.equal(notes.at(-1).severity, 'warning');
  assert.equal(JSON.stringify(notes).includes('@example.test'), false);
  const blocked = await offerAction(h);
  await actions.executeOne(blocked, { kind: 'offer.apply' });
  assert.equal((await outcome(blocked)).result.error, 'already_offered', 'an unconfirmed offer still counts for the account');
  stripeAnswer = async () => ({ applied: true, already: false, mirrored: true });

  // Recording Stripe's answer fails (the database blipped): the use is settled anyway, in the transaction that ends the action, from how
  // it ended. A refusal gives the place and the account's one offer back; no answer keeps both; an offer carried out counts as applied.
  const blipped = actionExecutor({ store, executors: offerExecutors({ store: { ...store, offerSettle: async () => { throw new Error('connection reset'); } },
    features, billing, notifier, log: () => {} }), log: () => {} });
  const k = await account('k');
  stripeAnswer = async () => { throw new StripeError(400, 'invalid_request_error', 'resource_missing', 'No such subscription'); };
  const refusedUnsettled = await offerAction(k);
  await blipped.executeOne(refusedUnsettled, { kind: 'offer.apply' });
  assert.deepEqual(await outcome(refusedUnsettled).then(entry => [entry.status, entry.result.error]), ['failed', 'offer_refused']);
  assert.equal((await row('select status from private.agent_offer_uses where action_id = $1', [refusedUnsettled])).status, 'refused', 'a refusal is never left counted');
  stripeAnswer = async () => { throw new TypeError('fetch failed'); };
  const silentUnsettled = await offerAction(k);
  await blipped.executeOne(silentUnsettled, { kind: 'offer.apply' });
  assert.equal((await row('select status from private.agent_offer_uses where action_id = $1', [silentUnsettled])).status, 'unconfirmed', 'no answer keeps its place');
  const l = await account('l');
  stripeAnswer = async () => ({ applied: true, already: false, mirrored: true });
  const appliedUnsettled = await offerAction(l);
  await blipped.executeOne(appliedUnsettled, { kind: 'offer.apply' });
  assert.equal((await outcome(appliedUnsettled)).status, 'executed');
  assert.equal((await row('select status from private.agent_offer_uses where action_id = $1', [appliedUnsettled])).status, 'applied');
  assert.equal(Number((await row("select count(*) from private.audit_events where action = 'agent.offer' and metadata ->> 'action_id' = $1", [refusedUnsettled])).count), 1, 'the settlement is audited once');

  // A coupon offer records its request to Stripe before sending it: the first request recorded is kept and returned (so a retry under
  // the same idempotency key sends exactly the same), a replay hands it back, and nothing but the subscription's discounts and the
  // offer's coupon is accepted.
  const couponId = `OFFERTEST${run}`;
  await admin.query("insert into private.billing_coupons(stripe_coupon_id, name, percent_off, duration, valid, livemode, stripe_created, seen_at) values ($1, 'Offer test', 10, 'once', true, true, now(), now())", [couponId]);
  await admin.query("insert into private.agent_offer_menu(key, label, kind, coupon_id, apps, window_days, monthly_cap, enabled) values ($1, 'Coupon test', 'coupon', $2, array['carebase'], 7, 10, true)", [`coupon_${run}`, couponId]);
  added.push(`coupon_${run}`);
  const m = await account('m');
  const couponAction = (await row(`insert into private.agent_actions (agent_key, task_id, kind, target_kind, target_id, preview, input, status)
    values ('account_manager', $1, 'offer.apply', 'billing_account', $2, 'Offer', $3, 'auto_approved') returning id`,
  [await task(), m.slug, { offer: `coupon_${run}`, tenant: m.slug, product: 'carebase', subscription: m.subscription }])).id;
  const couponRun = await store.beginExecution(couponAction);
  const couponBegin = () => pool.query('select private.agent_offer_begin($1, $2) as r', [couponAction, couponRun.execution]).then(result => result.rows[0].r);
  const couponReady = await couponBegin();
  assert.deepEqual([couponReady.state, couponReady.kind, couponReady.coupon, couponReady.discounts], ['ready', 'coupon', couponId, null]);
  const sent = [{ discount: 'di_existing1' }, { coupon: couponId }];
  for (const bad of [[], [{ coupon: 'SOMETHINGELSE' }], [{ discount: 'di_1', coupon: couponId }], [{ discount: 'di_1' }], [{ coupon: couponId }, { coupon: couponId }], { coupon: couponId }]) {
    await assert.rejects(store.offerRequest(couponAction, couponRun.execution, bad), refused('22023'), JSON.stringify(bad));
  }
  assert.deepEqual(await store.offerRequest(couponAction, couponRun.execution, sent), sent);
  assert.deepEqual(await store.offerRequest(couponAction, couponRun.execution, [{ coupon: couponId }]), sent, 'the first request recorded is kept');
  assert.deepEqual((await couponBegin()).discounts, sent, 'a replay hands the recorded request back');
  await assert.rejects(store.offerRequest(couponAction, couponRun.execution + 1, sent), refused('55000'), 'a stale execution records nothing');
  await assert.rejects(admin.query('select private.agent_offer_request($1, $2, $3::jsonb)', [couponAction, couponRun.execution, JSON.stringify(sent)]), refused('42501'), 'only the Hub server records a request');
  await store.offerSettle(couponAction, 'applied');
  await assert.rejects(store.offerRequest(couponAction, couponRun.execution, sent), refused('55000'), 'a settled offer takes no request');

  // A restart between recording and settling: the next attempt gets the same request back, a stale one is refused, a settled one is settled.
  const i = await account('i');
  const restarted = await offerAction(i);
  const started = await store.beginExecution(restarted);
  const begin = execution => pool.query('select private.agent_offer_begin($1, $2) as r', [restarted, execution]).then(result => result.rows[0].r);
  const ready = await begin(started.execution);
  assert.equal(ready.state, 'ready');
  const replay = await begin(started.execution);
  assert.deepEqual({ ...replay, state: 'ready' }, ready);
  assert.equal(replay.state, 'replay');
  await assert.rejects(begin(started.execution + 1), refused('55000'), 'a stale execution is refused');
  assert.equal(await store.offerSettle(restarted, 'applied'), true);
  assert.equal(await store.offerSettle(restarted, 'refused'), false, 'a use is settled once');
  assert.equal((await begin(started.execution)).state, 'recorded');
  await assert.rejects(admin.query('select private.agent_offer_begin($1, $2)', [restarted, started.execution]), refused('42501'), 'only the Hub server makes an offer');
  await assert.rejects(store.offerSettle(restarted, 'maybe'), refused('22023'));

  // The owner's menu: read it, a stale change is refused, an unknown coupon cannot be added, an added offer starts switched off.
  const shown = await owned('select hub.get_agent_offers() as r');
  const seeded = shown.offers.find(entry => entry.key === 'trial_extension_14');
  assert.deepEqual([seeded.kind, seeded.trialDays, seeded.enabled], ['trial_extension', 14, true]);
  await assert.rejects(owned('select hub.set_agent_offer($1, $2, $3, $4) as r', ['trial_extension_14', false, 5, '2020-01-01T00:00:00Z']), refused('40001'));
  const changed = await owned('select hub.set_agent_offer($1, $2, $3, $4) as r', ['trial_extension_14', false, 5, seeded.changedAt]);
  assert.deepEqual([changed.enabled, changed.monthlyCap], [false, 5]);
  await assert.rejects(owned('select hub.add_agent_offer($1, $2, $3, $4, $5, $6, $7) as r', ['A coupon', 'coupon', null, 'no_such_coupon', ['carebase'], 7, 5]), refused('22023'));
  const fresh = await owned('select hub.add_agent_offer($1, $2, $3, $4, $5, $6, $7) as r', ['A week more', 'trial_extension', 7, null, ['carebase'], 5, 3]);
  added.push(fresh.key);
  assert.deepEqual([fresh.kind, fresh.trialDays, fresh.enabled, fresh.monthlyCap], ['trial_extension', 7, false, 3]);

  // The deployment gate declares the feature again as it is, and refuses it when anything it checks has drifted.
  const gate = await readFile(new URL('../supabase/migrations/20261105140100_agent_offers_contract.sql', import.meta.url), 'utf8');
  const pgText = value => `'${value.replaceAll("'", "''")}'`;
  const rewrite = (from, to) => `do $d$ begin execute replace(pg_get_functiondef('private.agent_offer_begin(uuid,integer)'::regprocedure), ${pgText(from)}, ${pgText(to)}); end $d$`;
  const client = await admin.connect();
  try {
    await client.query('begin'); await client.query(gate); await client.query('rollback');
    for (const drift of [
      'grant execute on function private.agent_offer_begin(uuid,integer) to authenticated',
      'revoke execute on function private.agent_offer_settle(uuid,text) from hub_app_server',
      'alter function private.agent_offer_candidates(integer) reset search_path',
      'grant select on private.agent_offer_uses to hub_app_server',
      'alter table private.agent_offer_menu disable row level security',
      'drop index private.agent_offer_uses_once',
      'alter table private.agent_actions drop constraint agent_actions_offer_apply_check',
      'grant execute on function hub.get_agent_offers() to anon',
      "delete from private.agent_schedules where agent_key = 'account_manager' and task_kind = 'accounts.offers'",
      rewrite("v_agent.autonomy is distinct from 'act'", 'false'),
      rewrite("v_agent.status is distinct from 'active'", 'false'),
      rewrite('where key = v_action.agent_key for share', 'where key = v_action.agent_key'),
      rewrite("where key = v_action.input ->> 'offer' for update", "where key = v_action.input ->> 'offer'"),
      rewrite('or v_sub.trial_end > now() + make_interval(days => v_offer.window_days)', 'or false'),
      'drop trigger agent_offer_settle_on_completion on private.agent_actions',
      'alter table private.agent_actions disable trigger agent_offer_settle_on_completion',
      'grant execute on function private.agent_offer_record(uuid,text) to hub_app_server',
      'revoke execute on function private.agent_offer_request(uuid,integer,jsonb) from hub_app_server',
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Offers integration passed: qualifying live trials only, the daily proposals, an owner approval and an automatic offer made without a session under the action\'s idempotency key, the cap, once per account, trust withdrawn, offer switched off, an account that no longer qualifies or whose trial was extended past the window, Stripe refusing (place given back) or not answering (kept, owner warned), an unrecorded answer settled from how its action ended, replay after a restart, server-only making, the owner\'s menu operations and gate drift. Nothing reached Stripe.');
} finally {
  const ids = Object.values(tenants).map(entry => entry.id);
  const slugs = Object.values(tenants).map(entry => entry.slug);
  await admin.query("update private.agents set status=$1, autonomy=$2, config=$3 where key='account_manager'", [seedManager.status, seedManager.autonomy, seedManager.config]);
  await admin.query("update private.agent_offer_menu set enabled=$1, monthly_cap=$2, changed_at=$3, changed_by=$4 where key='trial_extension_14'", [seedOffer.enabled, seedOffer.monthly_cap, seedOffer.changed_at, seedOffer.changed_by]);
  await admin.query('update private.billing_settings set livemode = $1', [seedLive]);
  await admin.query('delete from private.agent_offer_uses where tenant_id = any($1::uuid[])', [ids]);
  await admin.query('delete from private.agent_offer_menu where key = any($1::text[])', [added]);
  await admin.query('delete from private.billing_coupons where stripe_coupon_id = $1', [`OFFERTEST${run}`]);
  await admin.query("delete from private.audit_events where entity_type = 'agent_action' and entity_id in (select id from private.agent_actions where kind = 'offer.apply' and target_id = any($1::text[]))", [slugs]);
  await admin.query('delete from private.agent_actions where kind = \'offer.apply\' and target_id = any($1::text[])', [slugs]);
  await admin.query('delete from private.agent_actions where task_id = any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_runs where task_id = any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_tasks where id = any($1::uuid[])', [tasks]);
  await admin.query("delete from private.audit_events where (action in ('agent.offer') and tenant_id = any($1::uuid[])) or (action = 'agent.offer_menu' and actor_id = $2) or actor_id = $2", [ids, owner]);
  await admin.query('delete from private.billing_subscriptions where tenant_id = any($1::uuid[])', [ids]);
  await admin.query('delete from private.billing_customers where tenant_id = any($1::uuid[])', [ids]);
  await admin.query('delete from hub.tenants where id = any($1::uuid[])', [ids]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
