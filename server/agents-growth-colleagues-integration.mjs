// Each cold touch also to the other decision-makers at the organization, through the real roles (20261115230000_growth_colleagues.sql):
// the sweep records each chosen person as their own email (a copy of the touch's approved words, with their own signed opt-out) and
// proposes it under the cold-email hand-over; the claim checks each person again, keeps them within the owner's number, counts them
// against "Most cold emails a day" and the product's daily limit, keeps the 72-hour gap per address, and never counts them as touches;
// touch 2 goes only to the people who received touch 1; a reply, an opt-out by anyone or a hard bounce of the first contact stops the
// organization; the owner sees who received each touch; and the gate refuses drift. Disposable loopback database only; no email is sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { colleagueUnsubscribeKey, growthAutonomyFeature, growthColleaguesFeature, growthHandlers } from './growth/worker.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool), agents = sqlAgentStore(pool, { fenced: true, growth: true });
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `growth-colleagues-${randomUUID()}`;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const ownerCall = (fn, values) => withSession(pool, token, async db => (await db.query(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(',')}) as r`, values)).rows[0].r);
const gate = await readFile(new URL('../supabase/migrations/20261115230100_growth_colleagues_contract.sql', import.meta.url), 'utf8');
const seedAgents = (await admin.query("select key,status,autonomy,config from private.agents where key in ('marketing_manager','account_manager')")).rows;
const seedPolicies = (await admin.query('select * from private.growth_policies')).rows;
const seedSettings = (await admin.query("select key,value from private.hub_settings where key in ('growth.people_per_organization','growth.cold_email_daily_cap')")).rows;
const runStart = (await row('select now() as t')).t;
const domains = [], tasks = [], primaries = new Set();
const domainOf = label => { const value = `${label}-${run}.example.org`; domains.push(value); return value; };
const features = new Set([growthAutonomyFeature, growthColleaguesFeature]);
const signing = { signingReady: true, hash: digest, unsubscribeToken: key => digest(`colleague-test:${key}`) };
const setting = (key, value) => admin.query('update private.hub_settings set value=$2 where key=$1', [key, value === null ? null : JSON.stringify(value)]);
const task = async () => {
  const id = (await row("insert into private.agent_tasks(agent_key,kind,request_key,status,attempts,lease_until) values('marketing_manager','growth.pipeline',$1,'running',1,now()+interval '10 minutes') returning id", [`growth-colleagues:${run}:${randomUUID()}`])).id;
  tasks.push(id); return id;
};
const opportunityOf = async domain => row('select o.* from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where g.domain=$1', [domain]);
const contactOf = async email => row('select * from private.growth_contacts where email=$1', [email]);
const messageOf = async id => row('select * from private.growth_messages where id=$1', [id]);
const touchesOf = async opportunityId => {
  for (let offset = 0; ; offset += 100) {
    const page = await store.snapshot(offset);
    const hit = page.items.find(item => item.id === opportunityId);
    if (hit || page.items.length === 0) return hit;
  }
};
// A qualified Intel prospect, found online, with its public role address as its contact.
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
  return { domain, org, opportunity: o.id, evidence };
}
// A named person at the business, as the people finder records one and the owner permits it (or not).
const person = (org, domain, local, name, role, { source = 'enriched', eligibility = 'permitted' } = {}) => admin.query(
  'insert into private.growth_contacts(organization_id,email,name,role,eligibility,verified_at,source_kind) values($1,$2,$3,$4,$5,now(),$6)',
  [org, `${local}@${domain}`, name, role, eligibility, source]);
// The touch's own email: drafted, proposed by the Marketing Manager (approved on its own under the cold-email hand-over).
async function touch(p, key) {
  const versions = await row('select o.version,c.version as "contactVersion",p.version as "policyVersion" from private.growth_opportunities o join private.growth_contacts c on c.id=o.contact_id join private.growth_policies p on p.product=o.product where o.id=$1', [p.opportunity]);
  const work = await store.plan(p.opportunity, { key, kind: 'outreach', action: 'Offer the market report.', success: 'A reply.', owner: 'marketing_manager', dueAt: new Date().toISOString() });
  const draft = await store.draft(p.opportunity, work, { ...versions, purpose: 'marketing', subject: 'Your county\'s referrals', body: `Touch ${key}: the approved words and https://www.caremetricintel.com/report/synthetic-${run}`,
    citations: p.evidence, unsubscribeHash: signing.hash(signing.unsubscribeToken(work)), modelGenerated: true });
  const action = await store.propose(await task(), draft.id);
  primaries.add(draft.id);
  return { id: draft.id, action: action.id, status: action.status, work };
}
// Carry out a message's action as the executor does (an action handed back after a deferral is begun again).
async function claim(message) {
  await admin.query("update private.agent_actions set status=case when decided_by is null then 'auto_approved' else 'approved' end,executing_at=null where id=$1 and status='executing'", [message.action]);
  await agents.beginExecution(message.action);
  return store.claim(message.id, message.action);
}
// The sweep's colleague step, for this run's touches only (the database may hold other tests' rows).
async function sweep() {
  const scoped = { ...store, snapshot: async () => ({ total: 0, items: [] }),
    colleagueCandidates: async limit => (await store.colleagueCandidates(limit)).filter(item => primaries.has(item.primaryId)) };
  return (await growthHandlers({ growth: { store: scoped, ...signing }, features, marketed: ['caremetric-intel'] })['growth.pipeline']({ id: await task(), agent: { autonomy: 'act' }, kind: 'growth.pipeline' })).result;
}
const colleaguesOf = async primaryId => (await admin.query(`select m.id,m.status,m.action_id as action,m.contact_id,c.email,a.status as action_status,a.preview
  from private.growth_messages m join private.growth_contacts c on c.id=m.contact_id left join private.agent_actions a on a.id=m.action_id
  where m.primary_message_id=$1 order by m.created_at,c.email`, [primaryId])).rows;

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `growth-colleagues-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550976',now())", [owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  // The owner handed cold email over; the Marketing Manager is active on Act; the daily guardrail check passed.
  await admin.query("update private.agents set status='active',autonomy='act',config=jsonb_set(config,'{auto_approve_kinds}','[\"growth.cold_email\"]') where key='marketing_manager'");
  await admin.query("insert into private.agent_evaluations(product,version,passed,results) values('caremetric-intel','growth.1',true,'[]')");
  for (const p of seedPolicies) {
    await store.manage(token, 'policy', { product: p.product, version: p.version, enabled: true, autoSend: false, dailyLimit: 100, minGapHours: 72, maxTouches: 3, bookingUrl: '', approvedClaim: 'Know every referral source in your county.' });
  }
  await setting('growth.people_per_organization', null);
  await setting('growth.cold_email_daily_cap', 100);

  // ---- 1. Touch 1 goes to the first contact -----------------------------------------------------------------------------------------
  const agency = await prospect('colleague-agency');
  for (const [local, name, role, options] of [['owen.owner', 'Owen Owner', 'Owner'], ['ann.admin', 'Ann Admin', 'Administrator'], ['pat.office', 'Pat Office', 'Office Manager'],
    ['intake', 'Intake Desk', 'Intake', { source: 'imported' }], ['tom.typed', 'Tom Typed', 'Owner', { source: 'owner' }], ['rae.review', 'Rae Review', 'President', { eligibility: 'review' }]]) {
    await person(agency.org, agency.domain, local, name, role, options);
  }
  const first = await touch(agency, 'outreach:0');
  assert.equal(first.status, 'auto_approved', 'the cold-email hand-over approves the touch on its own');
  const sent = await claim(first);
  assert.equal(sent.send, true); assert.equal(sent.to, `info@${agency.domain}`);
  assert.equal(sent.unsubscribeKey, first.work, 'the first contact\'s link is signed for the work alone, as before');
  assert.equal(await store.finish(first.id, 'accepted', 'synthetic-provider'), true);
  const afterTouch = await opportunityOf(agency.domain);
  assert.equal(afterTouch.stage, 'contacted');

  // ---- 2. The sweep records the owner and the administrator, each as their own email, and proposes them --------------------------------
  assert.deepEqual(await sweep(), { inspected: 0, planned: 0, drafted: 0, colleagues: 2 });
  let colleagues = await colleaguesOf(first.id);
  assert.deepEqual(colleagues.map(c => c.email).sort(), [`ann.admin@${agency.domain}`, `owen.owner@${agency.domain}`], 'three people: never a generic mailbox, a typed-in contact or one waiting for review');
  for (const c of colleagues) {
    const m = await messageOf(c.id);
    const primary = await messageOf(first.id);
    assert.deepEqual([m.subject, m.body, m.citations, m.model_generated, m.work_id, m.purpose], [primary.subject, primary.body, primary.citations, true, null, 'marketing'], 'the same approved words, no work of its own');
    assert.equal(m.unsubscribe_hash, signing.hash(signing.unsubscribeToken(colleagueUnsubscribeKey(first.work, c.contact_id))), 'each person\'s own signed opt-out');
    assert.equal(c.action_status, 'auto_approved', 'the cold-email hand-over decides exactly as for the first contact');
    assert.match(c.preview, /^Also to (Owen Owner \(Owner\)|Ann Admin \(Administrator\)) <[^>]+>, the same email/, 'the approval names the person');
  }
  assert.deepEqual(await sweep(), { inspected: 0, planned: 0, drafted: 0 }, 'nobody is recorded twice');
  const owen = colleagues.find(c => c.email.startsWith('owen.'));
  const ann = colleagues.find(c => c.email.startsWith('ann.'));

  // ---- 3. Each is claimed and checked on its own; touches count once; the opportunity does not move ----------------------------------
  const owenSent = await claim(owen);
  assert.equal(owenSent.send, true); assert.equal(owenSent.to, `owen.owner@${agency.domain}`); assert.equal(owenSent.colleague, true);
  assert.equal(owenSent.workId, first.work);
  assert.equal(owenSent.unsubscribeKey, colleagueUnsubscribeKey(first.work, owen.contact_id));
  assert.equal(signing.hash(signing.unsubscribeToken(owenSent.unsubscribeKey)), owenSent.unsubscribeHash, 'the executor\'s link matches the stored hash');
  assert.equal(owenSent.contactName, 'Owen Owner');
  await store.finish(owen.id, 'accepted', 'synthetic-provider-owen');
  assert.equal((await opportunityOf(agency.domain)).version, afterTouch.version, 'a colleague\'s email does not move its opportunity');
  // The owner lowers the number to two people: the administrator's email, waiting, is no longer sent.
  await setting('growth.people_per_organization', 2);
  assert.deepEqual(await claim(ann), { send: false, status: 'cancelled' });
  await setting('growth.people_per_organization', null);
  assert.equal((await touchesOf(agency.opportunity)).touches, 1, 'two emails, one touch');

  // ---- 4. Every one counts against "Most cold emails a day" -----------------------------------------------------------------------------
  const coldToday = Number((await row("select count(*) as n from private.growth_messages x join private.growth_contacts xc on xc.id=x.contact_id where private.growth_message_class('marketing_manager',x.purpose,xc.source_kind)='growth.cold_email' and x.attempted_at>=private.agent_day_start()")).n);
  assert.ok(coldToday >= 2, 'the colleague\'s email is counted as cold email');
  await admin.query("update private.growth_messages set status='cancelled',withdrawn_at=now() where id=$1", [ann.id]);
  assert.deepEqual(await sweep(), { inspected: 0, planned: 0, drafted: 0, colleagues: 1 }, 'a withdrawn email frees its person');
  const annAgain = (await colleaguesOf(first.id)).find(c => c.email.startsWith('ann.') && c.status === 'proposed');
  await setting('growth.cold_email_daily_cap', coldToday);
  assert.deepEqual(await claim(annAgain), { send: false, status: 'daily_limit' }, 'the cap holds colleague emails back like any cold email');
  await setting('growth.cold_email_daily_cap', 100);
  const annSent = await claim(annAgain);
  assert.equal(annSent.send, true);
  await store.finish(annAgain.id, 'accepted', 'synthetic-provider-ann');
  // Ann's address bounces softly: she is dropped from the sequence, nobody is opted out.
  await store.delivery(`colleague-soft:${run}`, annAgain.id, 'bounced', new Date().toISOString(), false);
  assert.equal((await contactOf(`ann.admin@${agency.domain}`)).eligibility, 'permitted');

  // ---- 5. Touch 2: only to the people who received touch 1, each at least 72 hours after their own last email -----------------------------
  await admin.query("update private.growth_messages set attempted_at=attempted_at-interval '4 days' where id=$1", [first.id]);
  const second = await touch(agency, 'outreach:1');
  const secondSent = await claim(second);
  assert.equal(secondSent.send, true, 'colleague emails never make the first contact\'s next touch "another contact" of the business');
  await store.finish(second.id, 'accepted', 'synthetic-provider-2');
  await setting('growth.people_per_organization', 5);
  assert.deepEqual(await sweep(), { inspected: 0, planned: 0, drafted: 0, colleagues: 1 });
  const touch2 = await colleaguesOf(second.id);
  assert.deepEqual(touch2.map(c => c.email), [`owen.owner@${agency.domain}`], 'the bounced administrator and the office manager, who never had touch 1, are not added');
  assert.deepEqual(await claim(touch2[0]), { send: false, status: 'frequency_limited' }, 'the 72-hour gap holds for each address');
  await admin.query("update private.growth_messages set attempted_at=attempted_at-interval '4 days' where id=$1", [owen.id]);
  const owenSecond = await claim(touch2[0]);
  assert.equal(owenSecond.send, true);
  await store.finish(touch2[0].id, 'accepted', 'synthetic-provider-owen-2');
  assert.equal((await touchesOf(agency.opportunity)).touches, 2, 'two touches, however many people');

  // ---- 6. The owner sees who received each touch ---------------------------------------------------------------------------------------
  const detail = await ownerCall('hub.growth_detail', [agency.opportunity]);
  const shown = detail.messages.find(m => m.id === first.id);
  assert.deepEqual(shown.recipients.map(r => [r.email, r.status, r.primary]), [[`info@${agency.domain}`, 'accepted', true], [`owen.owner@${agency.domain}`, 'accepted', false],
    [`ann.admin@${agency.domain}`, 'bounced', false]], 'its first contact first, then each colleague with the state of their own email');
  assert.ok(!detail.messages.some(m => touch2.some(c => c.id === m.id)), 'a colleague\'s email is listed under its touch, not as a touch');
  await assert.rejects(pool.query('select hub.growth_detail($1)', [agency.opportunity]), error => ['28000', '42501'].includes(error?.code));

  // ---- 7. Stop rules cover the whole organization -------------------------------------------------------------------------------------
  // A reply from anyone there stops every colleague's email.
  const replied = await prospect('colleague-replied');
  await person(replied.org, replied.domain, 'owen.owner', 'Owen Owner', 'Owner');
  const repliedTouch = await touch(replied, 'outreach:0');
  assert.equal((await claim(repliedTouch)).send, true); await store.finish(repliedTouch.id, 'accepted', 'p');
  await sweep();
  const [repliedColleague] = await colleaguesOf(repliedTouch.id);
  await admin.query("insert into private.customer_activity_events(product,organization_id,event_key,kind,occurred_at) values('caremetric-intel',$1,$2,'reply',now())", [replied.org, `colleague-reply:${run}`]);
  assert.deepEqual(await claim(repliedColleague), { send: false, status: 'cancelled' });
  // A hard bounce of the first contact stops everyone there.
  const bounced = await prospect('colleague-bounced');
  await person(bounced.org, bounced.domain, 'owen.owner', 'Owen Owner', 'Owner');
  const bouncedTouch = await touch(bounced, 'outreach:0');
  assert.equal((await claim(bouncedTouch)).send, true); await store.finish(bouncedTouch.id, 'accepted', 'p');
  await sweep();
  const [bouncedColleague] = await colleaguesOf(bouncedTouch.id);
  await store.delivery(`colleague-hard:${run}`, bouncedTouch.id, 'bounced', new Date().toISOString());
  assert.equal((await messageOf(bouncedColleague.id)).status, 'cancelled', 'the first contact\'s hard bounce cancels the colleague\'s waiting email');
  // An opt-out by anyone there cancels everyone's unsent email and stops the organization's cold outreach for good.
  const pending = await touch(agency, 'outreach:2');
  await store.unsubscribe(signing.hash(signing.unsubscribeToken(colleagueUnsubscribeKey(second.work, touch2[0].contact_id))));
  assert.equal((await contactOf(`owen.owner@${agency.domain}`)).eligibility, 'opted_out', 'each colleague\'s own link opts that person out');
  assert.equal((await messageOf(pending.id)).status, 'cancelled', 'and stops the first contact\'s waiting touch');
  assert.equal((await touchesOf(agency.opportunity)).outreach_stopped, true, 'the sweep plans no more outreach for the organization');
  const third = await touch(agency, 'outreach:3');
  assert.deepEqual(await claim(third), { send: false, status: 'cancelled' }, 'a new touch is refused too');
  assert.deepEqual(await sweep(), { inspected: 0, planned: 0, drafted: 0 });

  // ---- 8. The gate declares the feature again as it is, and refuses drift ----------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    await client.query('begin'); await client.query(gate); await client.query(gate); await client.query('rollback');
    for (const drift of [
      "delete from private.hub_settings where key='growth.people_per_organization'",
      'drop index private.growth_messages_colleague_key',
      'grant execute on function private.growth_colleague_candidates(integer) to authenticated',
      'grant execute on function private.growth_colleague_pool(uuid) to hub_app_server',
      rewrite('private.growth_claim_message(uuid,uuid)', 'or not exists(select 1 from private.growth_colleague_pool(m.primary_message_id) x where x.contact_id=c.id)', ' '),
      rewrite('private.growth_claim_message(uuid,uuid)', 'or (v_cold and private.growth_outreach_stopped(o.organization_id))', ' '),
      rewrite('private.growth_claim_message(uuid,uuid)', 'm.primary_message_id is null and v_n>=', 'v_n>='),
      rewrite('private.growth_snapshot(integer)', ' and m.primary_message_id is null) as touches', ') as touches'),
      rewrite('private.growth_finish_message(uuid,text,text)', ' and m.primary_message_id is null;', ';'),
      rewrite('private.growth_delivery_event(text,uuid,text,timestamptz,boolean)', "y.organization_id=v_org and x.purpose='marketing' and x.status in ('draft','proposed')", "false"),
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Colleague outreach integration passed: each cold touch also to the best-ranked permitted decision-makers there as separate emails with their own opt-out, under the cold-email hand-over, the owner\'s number, the cold-email cap and the 72-hour gap per address; touches counted once; touch 2 only to those who received touch 1; replies, opt-outs and the first contact\'s hard bounce stop the organization; the owner sees who received each touch; and gate drift. No email left the machine.');
} finally {
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    const ids = (await admin.query('select m.id from private.growth_messages m join private.growth_opportunities o on o.id=m.opportunity_id where o.organization_id=$1', [org])).rows.map(r => r.id);
    await admin.query("delete from private.audit_events where action='growth.colleague_added' and entity_id=any($1::uuid[])", [ids]);
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
  for (const s of seedSettings) await admin.query('update private.hub_settings set value=$2 where key=$1', [s.key, s.value]);
  for (const a of seedAgents) await admin.query('update private.agents set status=$2,autonomy=$3,config=$4 where key=$1', [a.key, a.status, a.autonomy, a.config]);
  for (const p of seedPolicies) await admin.query('update private.growth_policies set enabled=$2,auto_send=$3,daily_limit=$4,min_gap_hours=$5,max_touches=$6,booking_url=$7,approved_claim=$8,version=$9 where product=$1', [p.product, p.enabled, p.auto_send, p.daily_limit, p.min_gap_hours, p.max_touches, p.booking_url, p.approved_claim, p.version]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
