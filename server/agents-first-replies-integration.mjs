// The Nov 24 follow-up through the real roles (20261124150000_first_replies.sql): with "Check an address before the first email" on
// Strict, a shared address (info@) is written to only once a mail server or the verification service confirmed it, one that can no
// longer be confirmed (a catch-all domain, or no answer after three tries) goes to the owner's review with its business back on the
// people finder's list, and a named person's address keeps its rule; Check is unchanged; and with "Spread the day's cold emails over
// the send hours" on, a cold email waits until the day's last one is the hours divided by the day's number old, and its deferral waits
// for that moment. Disposable loopback database only; no mail server is asked and no email is sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { verifyHandlers, growthAddressCheckFeature, growthDiagnosticsFeature } from './growth/verify.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool), agents = sqlAgentStore(pool, { fenced: true, growth: true, growthPriority: true });
const run = randomUUID().slice(0, 8);
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const settingKeys = ['growth.presend_check', 'growth.bounce_guard_percent', 'growth.cold_email_daily_cap', 'growth.send_spread', 'growth.send_from_hour',
  'growth.send_until_hour', 'growth.send_priority'];
const seedAgents = (await admin.query("select key,status,autonomy,config from private.agents where key='marketing_manager'")).rows;
const seedPolicies = (await admin.query('select * from private.growth_policies')).rows;
const seedSettings = (await admin.query('select key,value,changed_at from private.hub_settings where key=any($1::text[])', [settingKeys])).rows;
const seedGuard = await row('select resumed_at,resumed_by,tripped_at from private.growth_send_guard where id');
const runStart = (await row('select now() as t')).t;
const domains = [], tasks = [];
const domainOf = label => { const value = `${label}-${run}.example.org`; domains.push(value); return value; };
const signing = { hash: digest, unsubscribeToken: key => digest(`first-replies-test:${key}`) };
const setting = (key, value) => admin.query('update private.hub_settings set value=$2,changed_at=now() where key=$1', [key, value === null ? null : JSON.stringify(value)]);
const task = async (kind = 'growth.pipeline') => {
  const id = (await row("insert into private.agent_tasks(agent_key,kind,request_key,status,attempts,lease_until) values('marketing_manager',$1,$2,'running',1,now()+interval '10 minutes') returning id", [kind, `first-replies:${run}:${randomUUID()}`])).id;
  tasks.push(id); return id;
};
const opportunityOf = domain => row('select o.* from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where g.domain=$1', [domain]);
const contactOf = email => row('select * from private.growth_contacts where email=$1', [email]);
const messageOf = id => row('select * from private.growth_messages where id=$1', [id]);
async function prospect(label) {
  const domain = domainOf(label);
  await store.discover('caremetric-intel', [{ name: `Synthetic ${label}`, domain, url: `https://${domain}/about`, claim: 'A Medicare-certified home health agency.' }]);
  const org = (await row('select id from private.growth_organizations where domain=$1', [domain])).id;
  await store.recordContact(org, `info@${domain}`, `https://${domain}/contact`);
  let o = await opportunityOf(domain);
  const evidence = (await admin.query('select id from private.growth_evidence where opportunity_id=$1', [o.id])).rows.map(e => e.id);
  assert.equal(await store.assess(o.id, { fit: 85, intent: null, rationale: 'Synthetic assessment.', citations: evidence, nextAction: 'Qualify', version: o.version }), true);
  await store.autoQualify(100);
  o = await opportunityOf(domain);
  assert.equal(o.stage, 'qualified');
  return { domain, org, opportunity: o.id, evidence, email: `info@${domain}` };
}
async function touch(p) {
  const versions = await row('select o.version,c.version as "contactVersion",p.version as "policyVersion" from private.growth_opportunities o join private.growth_contacts c on c.id=o.contact_id join private.growth_policies p on p.product=o.product where o.id=$1', [p.opportunity]);
  const work = await store.plan(p.opportunity, { key: 'outreach:0', kind: 'outreach', action: 'Offer the market report.', success: 'A reply.', owner: 'marketing_manager', dueAt: new Date().toISOString() });
  const draft = await store.draft(p.opportunity, work, { ...versions, purpose: 'marketing', subject: 'Your county\'s referrals', body: 'The approved words.',
    citations: p.evidence, unsubscribeHash: signing.hash(signing.unsubscribeToken(work)), modelGenerated: true });
  const action = await store.propose(await task(), draft.id);
  return { id: draft.id, action: action.id, work };
}
async function begin(message) {
  await admin.query("update private.agent_actions set status=case when decided_by is null then 'auto_approved' else 'approved' end,executing_at=null,not_before=null where id=$1 and status in ('executing','auto_approved','approved')", [message.action]);
  return agents.beginExecution(message.action);
}
async function claim(message) { await begin(message); return store.claim(message.id, message.action); }
async function verify(answers) {
  const mailbox = { configured: true, available: () => true, check: async (domain, addresses) => {
    const answer = answers[addresses[0]] ?? 'unknown'; return typeof answer === 'string' ? { result: answer } : answer;
  } };
  const scoped = { ...store, mailboxCandidates: async limit => (await store.mailboxCandidates(50)).filter(c => domains.includes(c.email.split('@')[1])).slice(0, limit) };
  const handler = verifyHandlers({ growth: { store: scoped, people: { mailbox } }, features: new Set([growthAddressCheckFeature, growthDiagnosticsFeature]) })['growth.verify'];
  return (await handler({ id: await task('growth.verify'), agentKey: 'marketing_manager', agent: { autonomy: 'act' }, kind: 'growth.verify' })).result;
}
const age = email => admin.query("update private.growth_contacts set mailbox_checked_at=now()-interval '17 hours' where email=$1", [email]);

try {
  await admin.query("update private.agents set status='active',autonomy='act',config=jsonb_set(config,'{auto_approve_kinds}','[\"growth.cold_email\"]') where key='marketing_manager'");
  await admin.query("insert into private.agent_evaluations(product,version,passed,results) values('caremetric-intel','growth.1',true,'[]')");
  for (const p of seedPolicies) await admin.query('update private.growth_policies set enabled=true,auto_send=false,daily_limit=100,min_gap_hours=72,max_touches=3 where product=$1', [p.product]);
  for (const key of ['growth.bounce_guard_percent', 'growth.send_spread', 'growth.send_from_hour', 'growth.send_until_hour', 'growth.send_priority']) await setting(key, null);
  await setting('growth.cold_email_daily_cap', 100);

  // ---- 1. Check is unchanged: a catch-all shared address is written to --------------------------------------------------------------
  await setting('growth.presend_check', 'check');
  const open = await prospect('shared-check');
  await verify({ [open.email]: 'catch_all' });
  assert.deepEqual([(await contactOf(open.email)).eligibility, await store.draftHold((await contactOf(open.email)).id)], ['permitted', null], 'Check: a catch-all shared address goes as before');

  // ---- 2. Strict: a shared address waits until it is confirmed ----------------------------------------------------------------------
  await setting('growth.presend_check', 'strict');
  assert.equal(await store.draftHold((await contactOf(open.email)).id), 'address_review', 'Strict: a catch-all shared address can never be confirmed, so it goes to review');
  const opened = await contactOf(open.email);
  assert.equal(opened.eligibility, 'review');
  assert.equal((await opportunityOf(open.domain)).contact_id, null, 'its business may take another contact');
  assert.equal((await row('select people_searched_at from private.growth_organizations where id=$1', [open.org])).people_searched_at, null, 'and the people finder looks there again');

  const confirmed = await prospect('shared-confirmed');
  const pending = await prospect('shared-pending');
  const catchAll = await prospect('shared-catchall');
  for (const p of [confirmed, pending, catchAll]) assert.equal(await store.draftHold((await contactOf(p.email)).id), 'address_unconfirmed', 'an unchecked shared address waits');
  const pendingTouch = await touch(pending), catchAllTouch = await touch(catchAll);
  assert.equal(await store.sendHold(pendingTouch.id), 'address_unconfirmed', 'an email already waiting waits too');
  const answered = await verify({ [confirmed.email]: 'verified', [pending.email]: { result: 'unknown', reason: 'blocked' }, [catchAll.email]: 'catch_all' });
  assert.equal(answered.checked, 3);
  assert.equal(await store.draftHold((await contactOf(confirmed.email)).id), null, 'a confirmed shared address is drafted at once');
  const confirmedTouch = await touch(confirmed);
  assert.equal(await store.sendHold(confirmedTouch.id), null);
  assert.equal((await claim(confirmedTouch)).send, true, 'and sent');
  assert.equal(await store.finish(confirmedTouch.id, 'accepted', 'synthetic-provider'), true);
  assert.equal((await contactOf(catchAll.email)).eligibility, 'review', 'a shared address on a catch-all domain goes to review at once');
  assert.equal((await messageOf(catchAllTouch.id)).status, 'cancelled', 'its waiting email is cancelled');
  assert.equal((await contactOf(pending.email)).eligibility, 'permitted', 'one asked without an answer is asked again');
  assert.equal(await store.sendHold(pendingTouch.id), 'address_unconfirmed');
  for (let i = 0; i < 2; i++) { await age(pending.email); await verify({ [pending.email]: { result: 'unknown', reason: 'blocked' } }); }
  assert.deepEqual([(await contactOf(pending.email)).eligibility, (await messageOf(pendingTouch.id)).status], ['review', 'cancelled'], 'after three tries without an answer: review');
  assert.equal((await row("select count(*)::int as n from private.audit_events where action='growth.address_checked' and entity_id=$1 and metadata->>'eligibility'='review'", [pending.org])).n, 1);

  // A shared address whose tries ended under Check is settled at its next send or draft under Strict, not held for ever.
  await setting('growth.presend_check', 'check');
  const exhausted = await prospect('shared-exhausted');
  for (let i = 0; i < 3; i++) { await verify({ [exhausted.email]: { result: 'unknown', reason: 'blocked' } }); await age(exhausted.email); }
  const exhaustedTouch = await touch(exhausted);
  assert.equal(await store.sendHold(exhaustedTouch.id), null, 'Check: written to after three tries, as before');
  await setting('growth.presend_check', 'strict');
  assert.equal(await store.sendHold(exhaustedTouch.id), 'address_review', 'Strict: it goes to review instead');
  assert.equal((await claim(exhaustedTouch)).send, false, 'and the claim never writes to it');

  // A named person's address keeps its rule: held while unchecked, written to once a server answered for it.
  const named = await prospect('named-person');
  await admin.query("update private.growth_contacts set source_kind='enriched' where email=$1", [named.email]);
  assert.equal(await store.draftHold((await contactOf(named.email)).id), 'address_unchecked');
  await verify({ [named.email]: 'catch_all' });
  assert.equal(await store.draftHold((await contactOf(named.email)).id), null, 'a named person on a catch-all domain is written to as before');

  // ---- 3. The day's cold emails spread over the send hours --------------------------------------------------------------------------
  const earlier = (await row(`select x.id from private.growth_messages x join private.growth_contacts xc on xc.id=x.contact_id
     where x.id=$1`, [confirmedTouch.id])).id;
  await admin.query("update private.growth_messages set attempted_at=greatest(private.agent_day_start(), now()-interval '5 minutes') where id=$1", [earlier]);
  // No later cold email of the day may exist for the arithmetic below.
  const last = (await row(`select max(x.attempted_at) as t from private.growth_messages x join private.growth_contacts xc on xc.id=x.contact_id
     where x.attempted_at>=private.agent_day_start() and private.growth_message_class('marketing_manager',x.purpose,xc.source_kind)='growth.cold_email'`)).t;
  assert.equal(await row('select private.growth_cold_pace_at() as t').then(r => r.t), null, 'off: nothing waits');
  await setting('growth.send_spread', true);
  assert.equal(await row('select private.growth_cold_pace_at() as t').then(r => r.t), null, 'without both send hours: nothing waits');
  await setting('growth.send_from_hour', 8); await setting('growth.send_until_hour', 16); await setting('growth.cold_email_daily_cap', 10);
  const pace = (await row('select private.growth_cold_pace_at() as t')).t;
  assert.equal(pace.getTime() - new Date(last).getTime(), 48 * 60_000, '8 to 16 and 10 a day: 48 minutes after the day\'s last cold email');
  await setting('growth.cold_email_daily_cap', 4);
  assert.equal((await row('select private.growth_cold_pace_at() as t')).t.getTime() - new Date(last).getTime(), 120 * 60_000, '4 a day: two hours');
  await setting('growth.cold_email_daily_cap', 10);
  // The send claim refuses a cold email inside the hours with 'paced' (outside them 'outside_hours' comes first).
  const paced = await prospect('paced');
  await verify({ [paced.email]: 'verified' });
  const pacedTouch = await touch(paced);
  const inside = (await row("select private.growth_next_send_at(now())=now() as inside")).inside;
  const refused = await claim(pacedTouch);
  assert.deepEqual([refused.send, refused.status], [false, inside ? 'paced' : 'outside_hours'], 'the claim refuses a cold email that would come too soon');
  const execution = (await row('select executions from private.agent_actions where id=$1', [pacedTouch.action])).executions;
  assert.equal(await agents.deferExecution(pacedTouch.action, execution, 'growth.message', 'paced'), true);
  const waitUntil = (await row('select not_before from private.agent_actions where id=$1', [pacedTouch.action])).not_before;
  const opening = (await row('select private.growth_next_send_at($1::timestamptz) as t', [pace])).t;
  assert.equal(waitUntil.getTime(), opening.getTime(), 'the deferral waits for the moment the pace allows (or the next opening after it)');
  await setting('growth.send_spread', false);
  if (inside) assert.equal((await claim(pacedTouch)).send, true, 'off again: it goes at once');

  console.log('First replies integration passed: Check is unchanged; Strict writes to a shared address only once it is confirmed, sends one that can never be (a catch-all domain, three tries without an answer, or tries spent under Check) to review with its business back on the people finder\'s list, and keeps a named person\'s rule; and the day\'s cold emails wait for the pace over the send hours. No mail server was asked and no email was sent.');
} finally {
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    const ids = (await admin.query('select m.id from private.growth_messages m join private.growth_opportunities o on o.id=m.opportunity_id where o.organization_id=$1', [org])).rows.map(r => r.id);
    await admin.query('delete from private.growth_delivery_events where message_id=any($1::uuid[])', [ids]);
    await admin.query('delete from private.growth_messages where id=any($1::uuid[])', [ids]);
    await admin.query('delete from private.customer_success_plans where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.customer_activity_events where organization_id=$1', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    const emails = (await admin.query('select email from private.growth_contacts where organization_id=$1', [org])).rows.map(r => digest(r.email));
    await admin.query('delete from private.email_suppressions where email_hash=any($1::text[])', [emails]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query("delete from private.audit_events where entity_type='agent_action' and entity_id in (select id from private.agent_actions where task_id=any($1::uuid[]))", [tasks]);
  await admin.query('delete from private.agent_actions where task_id=any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_tasks where id=any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_evaluations where created_at>=$1', [runStart]);
  await admin.query("delete from private.audit_events where action='growth.auto_qualified' and created_at>=$1", [runStart]);
  for (const s of seedSettings) await admin.query('update private.hub_settings set value=$2,changed_at=$3 where key=$1', [s.key, s.value, s.changed_at]);
  await admin.query('update private.growth_send_guard set resumed_at=$1,resumed_by=$2,tripped_at=$3 where id', [seedGuard?.resumed_at ?? null, seedGuard?.resumed_by ?? null, seedGuard?.tripped_at ?? null]);
  for (const a of seedAgents) await admin.query('update private.agents set status=$2,autonomy=$3,config=$4 where key=$1', [a.key, a.status, a.autonomy, a.config]);
  for (const p of seedPolicies) await admin.query('update private.growth_policies set enabled=$2,auto_send=$3,daily_limit=$4,min_gap_hours=$5,max_touches=$6,booking_url=$7,approved_claim=$8,version=$9 where product=$1', [p.product, p.enabled, p.auto_send, p.daily_limit, p.min_gap_hours, p.max_touches, p.booking_url, p.approved_claim, p.version]);
  await pool.end(); await admin.end();
}
