// Addresses checked before the first email, and the bounce guard, through the real roles (20261116100000_growth_address_check.sql):
// while checking is off nothing waits and nothing is handed out; once on, a first cold email to an address waits (before drafting and
// before the send claim) until the business's mail server answered; a mailbox that does not exist becomes undeliverable, its waiting
// email is cancelled, its business's opportunity is free for another contact and the people finder looks there again; a server that
// never answers lets the email go after three tries, or sends the address to the owner's review in strict mode; the bounce guard holds
// cold email (never a reply to someone who wrote in) above the owner's rate or after a complaint, the owner sees it and resumes it;
// and the gate refuses drift. Disposable loopback database only; no mail server is asked and no email is sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { verifyHandlers, growthAddressCheckFeature } from './growth/verify.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool), agents = sqlAgentStore(pool, { fenced: true, growth: true });
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `growth-address-check-${randomUUID()}`;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261116100100_growth_address_check_contract.sql', import.meta.url), 'utf8');
const seedAgents = (await admin.query("select key,status,autonomy,config from private.agents where key='marketing_manager'")).rows;
const seedPolicies = (await admin.query('select * from private.growth_policies')).rows;
const seedSettings = (await admin.query("select key,value,changed_at from private.hub_settings where key in ('growth.presend_check','growth.bounce_guard_percent','growth.cold_email_daily_cap')")).rows;
const seedGuard = await row('select resumed_at,resumed_by from private.growth_send_guard where id');
const runStart = (await row('select now() as t')).t;
const domains = [], tasks = [];
const domainOf = label => { const value = `${label}-${run}.example.org`; domains.push(value); return value; };
const features = new Set([growthAddressCheckFeature]);
const signing = { hash: digest, unsubscribeToken: key => digest(`address-check-test:${key}`) };
const setting = (key, value) => admin.query('update private.hub_settings set value=$2,changed_at=now() where key=$1', [key, value === null ? null : JSON.stringify(value)]);
const task = async (kind = 'growth.pipeline') => {
  const id = (await row("insert into private.agent_tasks(agent_key,kind,request_key,status,attempts,lease_until) values('marketing_manager',$1,$2,'running',1,now()+interval '10 minutes') returning id", [kind, `growth-address-check:${run}:${randomUUID()}`])).id;
  tasks.push(id); return id;
};
const opportunityOf = domain => row('select o.* from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where g.domain=$1', [domain]);
const contactOf = email => row('select * from private.growth_contacts where email=$1', [email]);
const messageOf = id => row('select * from private.growth_messages where id=$1', [id]);
// A qualified Intel prospect found online, with its public role address as its contact.
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
// Its first email: drafted and proposed (approved on its own under the cold-email hand-over).
async function touch(p) {
  const versions = await row('select o.version,c.version as "contactVersion",p.version as "policyVersion" from private.growth_opportunities o join private.growth_contacts c on c.id=o.contact_id join private.growth_policies p on p.product=o.product where o.id=$1', [p.opportunity]);
  const work = await store.plan(p.opportunity, { key: 'outreach:0', kind: 'outreach', action: 'Offer the market report.', success: 'A reply.', owner: 'marketing_manager', dueAt: new Date().toISOString() });
  const draft = await store.draft(p.opportunity, work, { ...versions, purpose: 'marketing', subject: 'Your county\'s referrals', body: 'The approved words.',
    citations: p.evidence, unsubscribeHash: signing.hash(signing.unsubscribeToken(work)), modelGenerated: true });
  const action = await store.propose(await task(), draft.id);
  return { id: draft.id, action: action.id, work };
}
async function claim(message) {
  await admin.query("update private.agent_actions set status=case when decided_by is null then 'auto_approved' else 'approved' end,executing_at=null where id=$1 and status='executing'", [message.action]);
  await agents.beginExecution(message.action);
  return store.claim(message.id, message.action);
}
// The verify task with a stand-in mail server, for this run's addresses only (the database may hold other tests' rows).
const notices = [];
async function verify(answers, { available = () => true } = {}) {
  const asked = [];
  const mailbox = { configured: true, available, check: async (domain, addresses) => {
    asked.push(addresses[0]); assert.equal(domain, addresses[0].split('@')[1]);
    const answer = answers[addresses[0]] ?? 'unknown'; return typeof answer === 'string' ? { result: answer } : answer;
  } };
  const scoped = { ...store, mailboxCandidates: async limit => (await store.mailboxCandidates(50)).filter(c => domains.includes(c.email.split('@')[1])).slice(0, limit) };
  const handler = verifyHandlers({ growth: { store: scoped, people: { mailbox } }, features, notifier: { send: async n => { notices.push(n); } } })['growth.verify'];
  const outcome = await handler({ id: await task('growth.verify'), agentKey: 'marketing_manager', agent: { autonomy: 'act' }, kind: 'growth.verify' });
  return { result: outcome.result, asked };
}

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `growth-address-check-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550977',now())", [owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  await admin.query("update private.agents set status='active',autonomy='act',config=jsonb_set(config,'{auto_approve_kinds}','[\"growth.cold_email\"]') where key='marketing_manager'");
  await admin.query("insert into private.agent_evaluations(product,version,passed,results) values('caremetric-intel','growth.1',true,'[]')");
  for (const p of seedPolicies) {
    await store.manage(token, 'policy', { product: p.product, version: p.version, enabled: true, autoSend: false, dailyLimit: 100, minGapHours: 72, maxTouches: 3, bookingUrl: '', approvedClaim: 'Know every referral source in your county.' });
  }
  await setting('growth.cold_email_daily_cap', 100);
  await setting('growth.bounce_guard_percent', null);

  // ---- 1. Off: nothing waits and nothing is handed out -----------------------------------------------------------------------------
  await setting('growth.presend_check', null);
  const quiet = await prospect('address-off');
  assert.equal(await store.draftHold((await contactOf(quiet.email)).id), null, 'checking off: a first email is drafted as before');
  const quietTouch = await touch(quiet);
  assert.equal(await store.sendHold(quietTouch.id), null, 'checking off: nothing waits before the claim');
  assert.deepEqual((await store.mailboxCandidates(50)).filter(c => c.email === quiet.email), [], 'checking off: no address is handed out');
  assert.equal((await verify({})).result.checked, 0);

  // ---- 2. Check: the first email waits for its address's answer ---------------------------------------------------------------------
  await setting('growth.presend_check', 'check');
  const dead = await prospect('address-dead');
  const live = await prospect('address-live');
  const silent = await prospect('address-silent');
  assert.equal(await store.draftHold((await contactOf(dead.email)).id), 'address_unchecked', 'no model call for an address not yet checked');
  const deadTouch = await touch(dead);
  assert.equal(await store.sendHold(deadTouch.id), 'address_unchecked', 'an email already waiting waits for the check too');
  const candidates = (await store.mailboxCandidates(50)).filter(c => domains.includes(c.email.split('@')[1])).map(c => c.email);
  assert.deepEqual(new Set(candidates.slice(0, 2)), new Set([quiet.email, dead.email]), 'addresses with an email waiting are asked first');
  assert.deepEqual(new Set(candidates), new Set([quiet.email, dead.email, live.email, silent.email]));

  // ---- 3. The mail server answers --------------------------------------------------------------------------------------------------
  const first = await verify({ [dead.email]: 'rejected', [live.email]: 'verified', [quiet.email]: 'catch_all', [silent.email]: { result: 'unknown', reason: 'temporary' } });
  assert.deepEqual(first.result, { checked: 4, verified: 1, rejected: 1, catch_all: 1, unknown: 1, undeliverable: 1, cancelled: 1 });
  assert.deepEqual(new Set(first.asked.slice(0, 2)), new Set([quiet.email, dead.email]));
  const deadContact = await contactOf(dead.email);
  assert.deepEqual([deadContact.eligibility, deadContact.mailbox_result, deadContact.mailbox_checks], ['undeliverable', 'rejected', 1], 'a mailbox that does not exist is never written to');
  assert.equal((await messageOf(deadTouch.id)).status, 'cancelled', 'its waiting email is cancelled');
  assert.equal((await opportunityOf(dead.domain)).contact_id, null, 'its business may take another contact');
  assert.equal((await row('select people_searched_at from private.growth_organizations where id=$1', [dead.org])).people_searched_at, null, 'and the people finder looks there again');
  assert.equal((await row("select count(*)::int as n from private.audit_events where action='growth.address_checked' and entity_id=$1", [dead.org])).n, 1);
  assert.equal((await claim(deadTouch)).send, false, 'the send claim never writes to it');
  assert.equal(await store.draftHold((await contactOf(live.email)).id), null, 'a confirmed address is drafted at once');
  assert.equal(await store.draftHold((await contactOf(quiet.email)).id), null, 'a server that accepts any address cannot say more: drafted');
  const liveTouch = await touch(live);
  assert.equal(await store.sendHold(liveTouch.id), null);
  const sent = await claim(liveTouch);
  assert.equal(sent.send, true); assert.equal(sent.to, live.email);
  assert.equal(await store.finish(liveTouch.id, 'accepted', 'synthetic-provider'), true);
  assert.equal(await store.draftHold((await contactOf(live.email)).id), null);
  assert.equal(await store.draftHold((await contactOf(silent.email)).id), 'address_unchecked', 'an unanswered address is asked again before its first email');

  // ---- 4. A server that never answers ----------------------------------------------------------------------------------------------
  assert.deepEqual((await verify({})).asked, [], 'not asked again within 16 hours');
  await admin.query("update private.growth_contacts set mailbox_checked_at=now()-interval '17 hours' where email=$1", [silent.email]);
  assert.deepEqual((await verify({ [silent.email]: 'unreachable' })).result, { checked: 1, unreachable: 1 });
  await admin.query("update private.growth_contacts set mailbox_checked_at=now()-interval '17 hours' where email=$1", [silent.email]);
  await verify({ [silent.email]: 'unknown' });
  assert.equal((await contactOf(silent.email)).mailbox_checks, 3);
  assert.equal((await contactOf(silent.email)).eligibility, 'permitted', 'check mode: after three tries the address is written to as before');
  assert.equal(await store.draftHold((await contactOf(silent.email)).id), null);
  await admin.query("update private.growth_contacts set mailbox_checked_at=now()-interval '17 hours' where email=$1", [silent.email]);
  assert.deepEqual((await verify({})).asked, [], 'never asked a fourth time');
  await setting('growth.presend_check', 'strict');
  const stubborn = await prospect('address-stubborn');
  for (let i = 0; i < 3; i++) {
    await verify({ [stubborn.email]: 'unknown' });
    await admin.query("update private.growth_contacts set mailbox_checked_at=now()-interval '17 hours' where email=$1", [stubborn.email]);
  }
  assert.equal((await contactOf(stubborn.email)).eligibility, 'review', 'strict mode: an address no server answered for waits for the owner');
  assert.equal((await verify({}, { available: () => false })).result.checked, 0);
  const resting = await prospect('address-resting');
  const restingRun = await verify({ [resting.email]: 'verified' }, { available: () => false });
  assert.deepEqual([restingRun.result.stopped, restingRun.asked], ['mail_servers_unreachable', []], 'mail servers out of reach: no try is spent');

  // ---- 5. The bounce guard ---------------------------------------------------------------------------------------------------------
  await setting('growth.presend_check', 'check');
  const sender = await prospect('guard-sender');
  const opportunity = await opportunityOf(sender.domain);
  for (let i = 0; i < 20; i++) {
    const contact = (await row("insert into private.growth_contacts(organization_id,email,name,role,eligibility,verified_at,source_kind,mailbox_result) values($1,$2,'Synthetic person','Owner','permitted',now(),'enriched','verified') returning id",
      [sender.org, `person${i}@${sender.domain}`])).id;
    await admin.query("insert into private.growth_messages(opportunity_id,contact_id,purpose,subject,body,opportunity_version,contact_version,policy_version,status,unsubscribe_hash,attempted_at) values($1,$2,'marketing','Synthetic','Synthetic',1,1,1,$3,$4,now())",
      [opportunity.id, contact, i < 2 ? 'bounced' : 'delivered', digest(`guard-${run}-${i}`)]);
  }
  // One soft bounce among them: bounced, never suppressed.
  await admin.query("update private.growth_messages set status='bounced' where contact_id=(select id from private.growth_contacts where email=$1)", [`person2@${sender.domain}`]);
  for (const i of [0, 1]) await admin.query('insert into private.email_suppressions(email_hash) values($1) on conflict do nothing', [digest(`person${i}@${sender.domain}`)]);
  const guarded = await prospect('guard-next');
  await verify({ [guarded.email]: 'verified' });
  const guardedTouch = await touch(guarded);
  assert.equal(await store.sendHold(guardedTouch.id), null, 'guard off: cold email goes');
  await setting('growth.bounce_guard_percent', 5);
  let state = await store.sendGuardState();
  assert.deepEqual([state.on, state.tripped], [true, false], 'bounces from before the guard was saved never count');
  await admin.query("update private.hub_settings set changed_at=now()-interval '1 hour' where key='growth.bounce_guard_percent'");
  await admin.query('update private.growth_messages set attempted_at=now() where opportunity_id=$1', [opportunity.id]);
  state = await store.sendGuardState();
  assert.equal(state.bounced, 2, `two hard bounces counted, the soft one not (${JSON.stringify(state)})`);
  assert.ok(state.sent >= 21);
  assert.equal(state.tripped, true, 'two of at least 21 is above 5%');
  assert.equal(await store.sendHold(guardedTouch.id), 'bounce_guard', 'a cold email waits while the guard is tripped');
  assert.equal(await store.draftHold((await contactOf(guarded.email)).id), 'bounce_guard', 'and no first email is drafted');
  const asked = (await row("insert into private.growth_contacts(organization_id,email,name,role,eligibility,verified_at,source_kind) values($1,$2,'Synthetic asker','Owner','permitted',now(),'inbound') returning id",
    [guarded.org, `asker@${guarded.domain}`])).id;
  assert.equal(await store.draftHold(asked), null, 'a reply to someone who wrote in never waits');
  const alerted = await verify({});
  assert.equal(alerted.result.guard, 'tripped');
  const notice = notices.find(n => n.subject === 'Cold email is paused');
  assert.ok(notice && /^growth:bounce-guard:\d{4}-\d{2}-\d{2}$/.test(notice.dedupeKey), 'the owner is told, once a day');
  assert.match(notice.body, /2 of the \d+ cold emails sent since \d{4}-\d{2}-\d{2} bounced for good, above your 5% limit/);
  const seen = await withSession(pool, token, async db => (await db.query('select hub.growth_send_guard() as r')).rows[0].r);
  assert.deepEqual([seen.tripped, seen.mode, seen.bounced], [true, 'check', 2], 'the owner sees the guard on Growth');
  assert.ok(seen.addresses.undeliverable >= 1 && seen.addresses.verified >= 2);
  const resumed = await withSession(pool, token, async db => (await db.query('select hub.growth_send_guard_resume() as r')).rows[0].r);
  assert.deepEqual([resumed.tripped, resumed.sent], [false, 0], 'resuming starts the seven days afresh');
  assert.equal((await row("select count(*)::int as n from private.audit_events where action='growth.cold_email_resumed' and actor_id=$1", [owner])).n, 1);
  assert.equal(await store.sendHold(guardedTouch.id), null);
  await admin.query("update private.growth_messages set status='complaint',attempted_at=now() where contact_id=(select id from private.growth_contacts where email=$1)", [`person3@${sender.domain}`]);
  assert.equal((await store.sendGuardState()).tripped, true, 'one spam complaint trips the guard at once');
  await withSession(pool, token, async db => db.query('select hub.growth_send_guard_resume()'));
  await assert.rejects(pool.query('select hub.growth_send_guard_resume()'), refused('42501'), 'the server cannot resume cold email');
  await assert.rejects(pool.query('select private.growth_bounce_guard()'), refused('42501'), 'the guard\'s helper is closed');

  // ---- 6. The gate refuses drift --------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    await client.query('begin'); await client.query(gate); await client.query(gate); await client.query('rollback');
    for (const drift of [
      "delete from private.hub_settings where key='growth.bounce_guard_percent'",
      'grant select on private.growth_send_guard to hub_app_server',
      'grant execute on function private.growth_bounce_guard() to hub_app_server',
      'grant execute on function private.growth_mailbox_record(uuid,text) to authenticated',
      'alter table private.growth_contacts drop constraint growth_contacts_eligibility_check',
      rewrite('private.growth_bounce_guard()', "'growth.cold_email'", "'growth.sales_followup'"),
      rewrite('private.growth_send_hold(uuid)', 'perform private.require_hub_app_server();', ' '),
      "delete from private.agent_schedules where agent_key='marketing_manager' and task_kind='growth.verify'",
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Address check integration passed: off changes nothing; on, a first cold email waits before drafting and before the claim until the business\'s mail server answers; a mailbox that does not exist is undeliverable, its email cancelled, its business free for another contact and back on the people finder\'s list; an unanswered address goes after three tries, or to the owner in strict mode; the bounce guard holds cold email (never a reply) above the owner\'s rate or after a complaint, alerts once a day and resumes on the owner\'s word; and gate drift. No mail server was asked and no email was sent.');
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
  await admin.query("delete from private.audit_events where (action='growth.auto_qualified' and created_at>=$1) or actor_id=$2", [runStart, owner]);
  for (const s of seedSettings) await admin.query('update private.hub_settings set value=$2,changed_at=$3 where key=$1', [s.key, s.value, s.changed_at]);
  await admin.query('update private.growth_send_guard set resumed_at=$1,resumed_by=$2 where id', [seedGuard?.resumed_at ?? null, seedGuard?.resumed_by ?? null]);
  for (const a of seedAgents) await admin.query('update private.agents set status=$2,autonomy=$3,config=$4 where key=$1', [a.key, a.status, a.autonomy, a.config]);
  for (const p of seedPolicies) await admin.query('update private.growth_policies set enabled=$2,auto_send=$3,daily_limit=$4,min_gap_hours=$5,max_touches=$6,booking_url=$7,approved_claim=$8,version=$9 where product=$1', [p.product, p.enabled, p.auto_send, p.daily_limit, p.min_gap_hours, p.max_touches, p.booking_url, p.approved_claim, p.version]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
