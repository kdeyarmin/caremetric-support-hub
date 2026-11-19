// Stage 2 of the 2026-11-17 review through the real roles (20261117190000_growth_priority.sql): with "Send to the best prospects first"
// off the ready queue is unchanged, and on, every other kind of action keeps its place first and growth emails follow by band, fit and
// waiting time; a deferral waits for the next Eastern day over the cap, for the next opening outside the send hours and 15 minutes
// otherwise; the send claim holds a cold email (never a customer email) outside the owner's hours; a first report open brings the second
// email forward; the snapshot carries each opportunity's band and first form; a prospect who replied, was answered and went quiet is
// listed for at most two follow-ups; a brief is never written for an agency that cannot be emailed; the Sales Executive reads the brief's
// writer part, the email answered and whether the report was opened; only the Hub server may ask; and the gate refuses drift. Disposable
// loopback database only; no model is called and no email is sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { salesContextFor, salesGrowthContextReader } from './agents/sales/context.mjs';
import { testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool);
const agents = sqlAgentStore(pool, { fenced: true, growth: true, growthPriority: true });
const before = sqlAgentStore(pool, { fenced: true, growth: true });
const readContext = salesGrowthContextReader(pool);
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `growth-priority-${randomUUID()}`;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261117190100_growth_priority_contract.sql', import.meta.url), 'utf8');
const seedAgents = (await admin.query("select key,status,autonomy,config from private.agents where key='marketing_manager'")).rows;
const seedPolicies = (await admin.query('select * from private.growth_policies')).rows;
const settingKeys = ['growth.send_priority', 'growth.send_from_hour', 'growth.send_until_hour', 'growth.send_local_time', 'growth.cold_email_daily_cap', 'growth.bounce_guard_percent', 'growth.presend_check'];
const seedSettings = (await admin.query('select key,value,changed_at,changed_by from private.hub_settings where key=any($1::text[])', [settingKeys])).rows;
const runStart = (await row('select now() as t')).t;
const intel = (await row("select id from hub.products where slug='caremetric-intel'")).id;
const domains = [], tasks = [], actions = [], communications = [];
const domainOf = label => { const value = `${label}-${run}.example.org`; domains.push(value); return value; };
const signing = { hash: digest, unsubscribeToken: key => digest(`growth-priority-test:${key}`) };
const setting = (key, value) => admin.query('update private.hub_settings set value=$2,changed_at=now() where key=$1', [key, value === null ? null : JSON.stringify(value)]);
const epoch = value => new Date(value).getTime();
const task = async (kind = 'growth.pipeline') => {
  const id = (await row("insert into private.agent_tasks(agent_key,kind,request_key,status,attempts,lease_until) values('marketing_manager',$1,$2,'running',1,now()+interval '10 minutes') returning id", [kind, `growth-priority:${run}:${randomUUID()}`])).id;
  tasks.push(id); return id;
};
const opportunityOf = domain => row('select o.* from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where g.domain=$1', [domain]);
const actionOf = id => row('select * from private.agent_actions where id=$1', [id]);
const messageOf = id => row('select * from private.growth_messages where id=$1', [id]);
// A qualified Intel prospect found online, with its public role address as its contact.
async function prospect(label, { fit = 85 } = {}) {
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
  if (fit !== 85) await admin.query('update private.growth_opportunities set fit=$2 where id=$1', [o.id, fit]);
  const contact = (await row('select id from private.growth_contacts where organization_id=$1', [org])).id;
  return { domain, org, opportunity: o.id, contact, evidence, email: `info@${domain}` };
}
// An email drafted and proposed (approved on its own under the hand-over): a cold first email by default.
async function touch(p, { key = 'outreach:0', kind = 'outreach', purpose = 'marketing', subject = 'Your county\'s referrals' } = {}) {
  const versions = await row('select o.version,c.version as "contactVersion",p.version as "policyVersion" from private.growth_opportunities o join private.growth_contacts c on c.id=o.contact_id join private.growth_policies p on p.product=o.product where o.id=$1', [p.opportunity]);
  const work = await store.plan(p.opportunity, { key, kind, action: 'Offer the market report.', success: 'A reply.', owner: 'marketing_manager', dueAt: new Date().toISOString() });
  const draft = await store.draft(p.opportunity, work, { ...versions, purpose, subject, body: 'The approved words.',
    citations: purpose === 'marketing' ? p.evidence : [], unsubscribeHash: signing.hash(signing.unsubscribeToken(work)), modelGenerated: true });
  const action = await store.propose(await task(), draft.id);
  actions.push(action.id);
  return { id: draft.id, action: action.id, work };
}
// The email went out `ago` (an interval), its action carried out.
async function sent(message, ago, arms = null) {
  await admin.query(`update private.growth_messages set status='accepted',attempted_at=now()-$2::interval${arms ? ',arms=$3::jsonb' : ''} where id=$1`, arms ? [message.id, ago, JSON.stringify(arms)] : [message.id, ago]);
  await admin.query("update private.agent_actions set status='executed',executed_at=now(),executing_at=null where id=$1", [message.action]);
}
// The action started again from the queue, as the executor does: its execution number.
async function start(action) {
  await admin.query("update private.agent_actions set status=case when decided_by is null then 'auto_approved' else 'approved' end,executing_at=null,not_before=null where id=$1 and status in ('executing','auto_approved','approved')", [action]);
  return (await agents.beginExecution(action)).execution;
}
const ready = async ids => (await agents.readyActions(50)).map(item => item.id).filter(id => ids.includes(id));
const nextMidnight = async () => (await row("select (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day') at time zone 'America/New_York' as t")).t;
const nextOpening = async at => (await row('select private.growth_next_send_at($1::timestamptz) as t', [at])).t;
const minutesAhead = async action => (epoch((await actionOf(action)).not_before) - Date.now()) / 60_000;

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `growth-priority-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, phones.owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  await admin.query("update private.agents set status='active',autonomy='act',config=jsonb_set(config,'{auto_approve_kinds}','[\"growth.cold_email\",\"growth.sales_followup\"]') where key='marketing_manager'");
  await admin.query("insert into private.agent_evaluations(product,version,passed,results) values('caremetric-intel','growth.1',true,'[]')");
  for (const p of seedPolicies) {
    await store.manage(token, 'policy', { product: p.product, version: p.version, enabled: true, autoSend: false, dailyLimit: 100, minGapHours: 72, maxTouches: 3, bookingUrl: '', approvedClaim: 'Know every referral source in your county.' });
  }
  for (const key of ['growth.send_priority', 'growth.send_from_hour', 'growth.send_until_hour', 'growth.send_local_time', 'growth.bounce_guard_percent', 'growth.presend_check']) await setting(key, null);
  await setting('growth.cold_email_daily_cap', 100);
  // A one-hour window twelve hours from now: the current Eastern time is always outside it.
  const hour = Number((await row("select extract(hour from now() at time zone 'America/New_York')::int as h")).h);
  const closed = { from: (hour + 12) % 24, until: (hour + 12) % 24 + 1 };
  const shut = async () => { await setting('growth.send_from_hour', closed.from); await setting('growth.send_until_hour', closed.until); };
  const open = async () => { await setting('growth.send_from_hour', null); await setting('growth.send_until_hour', null); };

  // ---- 1. The ready queue ---------------------------------------------------------------------------------------------------------
  // A: a first email, nothing more (band 4, fit 85). E: the same at fit 60. B: a first email with a brief (band 3). C: a brief and a named
  // person whose mailbox the server confirmed (band 2). D: a follow-up to an agency that opened its report (band 1). N: another kind.
  const pa = await prospect('queue-a'), pb = await prospect('queue-b'), pc = await prospect('queue-c'), pd = await prospect('queue-d'), pe = await prospect('queue-e', { fit: 60 });
  const ta = await touch(pa), tb = await touch(pb), tc = await touch(pc), te = await touch(pe);
  const firstD = await touch(pd);
  await sent(firstD, '3 days', { form: 'short' });
  await admin.query("update private.growth_opportunities set stage='contacted',memory=memory||jsonb_build_object('reportViewedAt',now()::text) where id=$1", [pd.opportunity]);
  const td = await touch(pd, { key: 'outreach:1', subject: 'A second note' });
  for (const p of [pb, pc]) {
    await admin.query("insert into private.growth_briefs(opportunity_id,writer,research,model,prompt_version) values($1,$2,'{}','test','brief.test')",
      [p.opportunity, JSON.stringify({ summary: 'A home health agency in Erie.', angle: 'referral_sources', pains: [{ question: 'Which hospitals send the most?', capability: 'x' }],
        hook: { sentence: 'It opened a second office this fall.', sourceUrl: `https://${p.domain}/about` } })]);
  }
  await admin.query("update private.growth_contacts set source_kind='enriched',name='Jane Doe',mailbox_result='verified',mailbox_checked_at=now() where id=$1", [pc.contact]);
  const n = (await row(`insert into private.agent_actions(task_id,agent_key,kind,target_kind,target_id,preview,status,created_at)
    values($1,'marketing_manager','growth.content','growth_content',$2,'Synthetic content',$3,now()-interval '1 hour') returning id`, [await task('growth.content'), `growth-priority:${run}`, 'auto_approved'])).id;
  actions.push(n);
  for (const [t, hours] of [[te, 6], [ta, 5], [tb, 4], [tc, 3], [td, 2]]) await admin.query('update private.agent_actions set created_at=now()-make_interval(hours=>$2) where id=$1', [t.action, hours]);
  const mine = [n, ta.action, tb.action, tc.action, td.action, te.action];
  for (const t of [ta, tb, tc, td, te]) assert.equal((await actionOf(t.action)).status, 'auto_approved', 'the cold-email hand-over approved each email');
  assert.deepEqual(await ready(mine), [te.action, ta.action, tb.action, tc.action, td.action, n], 'off: oldest first, as before');
  await setting('growth.send_priority', true);
  assert.deepEqual(await ready(mine), [n, td.action, tc.action, tb.action, ta.action, te.action],
    'on: another kind keeps its place first; then a follow-up to an opened report, a brief with a confirmed person, a brief, the rest by fit');
  // Waiting adds ten an hour, at most 3000: an email waiting 400 hours passes every band but the first.
  await admin.query("update private.agent_actions set created_at=now()-interval '400 hours' where id=$1", [te.action]);
  assert.deepEqual(await ready(mine), [n, td.action, te.action, tc.action, tb.action, ta.action], 'nothing waits forever');

  // ---- 2. Deferral ------------------------------------------------------------------------------------------------------------------
  // Over the cap with the switch on: the next Eastern day.
  assert.equal(await agents.deferExecution(ta.action, await start(ta.action), 'growth.message', 'daily_limit'), true);
  assert.equal(epoch((await actionOf(ta.action)).not_before), epoch(await nextMidnight()), 'over the cap: the next Eastern day');
  assert.equal((await actionOf(ta.action)).status, 'auto_approved', 'it waits approved as it was');
  // With send hours set, a cold email over the cap waits for the first opening on or after the next day.
  await shut();
  assert.equal(await agents.deferExecution(ta.action, await start(ta.action), 'growth.message', 'daily_limit'), true);
  assert.equal(epoch((await actionOf(ta.action)).not_before), epoch(await nextOpening(await nextMidnight())), 'over the cap with hours: the first opening of a later day');
  assert.ok(epoch((await actionOf(ta.action)).not_before) >= epoch(await nextMidnight()));
  // Outside the hours: the next opening.
  assert.equal(await agents.deferExecution(tb.action, await start(tb.action), 'growth.message', 'outside_hours'), true);
  const opening = await nextOpening(new Date(Date.now() + 15 * 60_000));
  assert.ok(Math.abs(epoch((await actionOf(tb.action)).not_before) - epoch(opening)) < 120_000, 'outside the hours: the next opening');
  assert.ok(await minutesAhead(tb.action) > 30, 'never sooner than the opening');
  await open();
  // Off: 15 minutes, with any reason; no reason: 15 minutes; the two-argument form (a server before the gate) too.
  await setting('growth.send_priority', false);
  assert.equal(await agents.deferExecution(tc.action, await start(tc.action), 'growth.message', 'daily_limit'), true);
  assert.ok(Math.abs(await minutesAhead(tc.action) - 15) < 2, 'switch off: over the cap waits 15 minutes, as before');
  assert.equal(await agents.deferExecution(te.action, await start(te.action), 'growth.message', null), true);
  assert.ok(Math.abs(await minutesAhead(te.action) - 15) < 2, 'no reason: 15 minutes');
  assert.equal(await before.deferExecution(td.action, await start(td.action), 'growth.message', 'daily_limit'), true);
  assert.ok(Math.abs(await minutesAhead(td.action) - 15) < 2, 'the two-argument form still defers 15 minutes');
  assert.equal(await agents.deferExecution(td.action, 999, 'growth.message', 'daily_limit'), false, 'another start is refused');

  // ---- 3. The send claim and the hours --------------------------------------------------------------------------------------------
  const ph = await prospect('claim-hours');
  const th = await touch(ph);
  await shut();
  let execution = await start(th.action);
  assert.deepEqual(await store.claim(th.id, th.action), { send: false, status: 'outside_hours' }, 'a cold email waits outside the owner\'s hours');
  assert.equal((await messageOf(th.id)).attempted_at, null, 'nothing was attempted');
  assert.equal((await messageOf(th.id)).status, 'proposed');
  assert.equal(await agents.deferExecution(th.action, execution, 'growth.message', 'outside_hours'), true);
  assert.ok(Math.abs(epoch((await actionOf(th.action)).not_before) - epoch(await nextOpening(new Date(Date.now() + 15 * 60_000)))) < 120_000);
  // A customer email (purpose 'success') is never held by the hours.
  const ps = await prospect('claim-customer');
  const ts = await touch(ps, { key: 'onboarding', kind: 'onboarding', purpose: 'success', subject: 'Your first step' });
  assert.equal((await actionOf(ts.action)).status, 'auto_approved');
  await start(ts.action);
  const customer = await store.claim(ts.id, ts.action);
  assert.equal(customer.send, true, 'a customer email goes outside the hours');
  await store.finish(ts.id, 'accepted', null);
  // The hours cleared: the same cold email is claimed.
  await open();
  execution = await start(th.action);
  const claimed = await store.claim(th.id, th.action);
  assert.equal(claimed.send, true, 'with no hours set the email goes');
  assert.equal((await messageOf(th.id)).status, 'sending');
  await store.finish(th.id, 'accepted', null);

  // ---- 3b. The hours in the agency's own time zone (20261118130000_growth_local_send_time.sql) ----------------------------------------
  // An agency in Hawaii whose Medicare record names its state. The hours are one hour wide and start at the current Eastern hour, so
  // Eastern is inside them on a weekday and Hawaii, five or six hours behind, never is.
  const pz = await prospect('claim-local');
  await admin.query("insert into private.growth_roster_targets(ccn,name,setting,state,period,claim,status,organization_id) values($1,'Synthetic Hawaii agency','home_health','HI','2026Q3','A Medicare-certified home health agency.','graduated',$2)",
    [`H${run.toUpperCase()}`, pz.org]);
  const zoneOf = async org => (await row('select private.growth_org_zone($1) as z', [org])).z;
  assert.equal(await zoneOf(pz.org), 'America/New_York', 'with the switch off the agency is read in Eastern time');
  await setting('growth.send_local_time', true);
  assert.equal(await zoneOf(pz.org), 'Pacific/Honolulu', 'with it on, an agency in Hawaii is read in Hawaii time');
  assert.equal(await zoneOf(ph.org), 'America/New_York', 'an agency with no Medicare record stays Eastern');
  await setting('growth.send_from_hour', hour);
  await setting('growth.send_until_hour', hour + 1);
  const tz = await touch(pz);
  execution = await start(tz.action);
  assert.deepEqual(await store.claim(tz.id, tz.action), { send: false, status: 'outside_hours' }, 'a cold email to Hawaii waits outside the hours as Hawaii keeps them');
  assert.equal((await messageOf(tz.id)).attempted_at, null, 'nothing was attempted');
  assert.equal(await agents.deferExecution(tz.action, execution, 'growth.message', 'outside_hours'), true);
  const hawaiiOpening = (await row("select private.growth_next_send_at(now() + interval '15 minutes', 'Pacific/Honolulu') as t")).t;
  const easternOpening = await nextOpening(new Date(Date.now() + 15 * 60_000));
  assert.ok(Math.abs(epoch((await actionOf(tz.action)).not_before) - epoch(hawaiiOpening)) < 120_000, 'it waits for the next opening in Hawaii');
  assert.ok(Math.abs(epoch(hawaiiOpening) - epoch(easternOpening)) > 3_600_000, 'which is not the Eastern opening');
  assert.ok(await minutesAhead(tz.action) > 30, 'never sooner than the opening');
  await setting('growth.send_local_time', false);
  await open();

  // ---- 4. A first report open brings the second email forward ------------------------------------------------------------------------
  const contacted = async label => {
    const p = await prospect(label);
    const first = await touch(p);
    await sent(first, '1 day');
    await admin.query("update private.growth_opportunities set stage='contacted',next_at=now()+interval '4 days' where id=$1", [p.opportunity]);
    return { ...p, first };
  };
  const opened = async (p, n) => admin.query("insert into private.customer_activity_events(product,organization_id,event_key,kind,occurred_at) values('caremetric-intel',$1,$2,'report_viewed',now())",
    [p.org, `report_view:${run}:${p.domain}:${n}`]);
  const nextAt = async p => epoch((await opportunityOf(p.domain)).next_at);
  const pf = await contacted('open-on');
  await setting('growth.send_priority', true);
  await opened(pf, 1);
  const due = epoch((await messageOf(pf.first.id)).attempted_at) + 72 * 3_600_000;
  assert.ok(Math.abs(await nextAt(pf) - due) < 5_000, 'a first open: the second email is due at the policy\'s gap after the first');
  await admin.query("update private.growth_opportunities set next_at=now()+interval '4 days' where id=$1", [pf.opportunity]);
  const later = await nextAt(pf);
  await opened(pf, 2);
  assert.equal(await nextAt(pf), later, 'a second open changes nothing');
  await setting('growth.send_priority', false);
  const pg2 = await contacted('open-off');
  const waiting = await nextAt(pg2);
  await opened(pg2, 1);
  assert.equal(await nextAt(pg2), waiting, 'with the switch off an open changes nothing');

  // ---- 5. The snapshot carries the band and the first form --------------------------------------------------------------------------
  const found = new Map();
  for (let offset = 0; ;) {
    const page = await store.snapshot(offset);
    for (const item of page.items) if ([pd.opportunity, pb.opportunity, pa.opportunity].includes(item.id)) found.set(item.id, item);
    offset += page.items.length;
    if (!page.items.length || offset >= page.total) break;
  }
  assert.equal(found.get(pd.opportunity)?.priority_band, 1, 'a follow-up to an opened report is band 1');
  assert.equal(found.get(pd.opportunity)?.first_form, 'short', 'its first email was the short form');
  assert.equal(found.get(pb.opportunity)?.priority_band, 3);
  assert.equal(found.get(pb.opportunity)?.first_form, null, 'no first email sent, no first form');
  assert.equal(found.get(pa.opportunity)?.priority_band, 4);

  // ---- 6. A prospect who replied, was answered and went quiet ---------------------------------------------------------------------
  const conversation = async (p, { inboundAfter = false } = {}) => {
    const first = await touch(p);
    await sent(first, '8 days');
    await admin.query("update private.growth_opportunities set stage='engaged' where id=$1", [p.opportunity]);
    const id = (await row("insert into private.communications(channel,source_system,source_key,subject,contact_email,product_id) values('email','hub.email',$1,'Re: Your county',$2,$3) returning id",
      [`growth-priority:${run}:${p.domain}`, p.email, intel])).id;
    communications.push(id);
    await admin.query("insert into private.communication_messages(communication_id,direction,body,delivery,created_at) values($1,'inbound','How does the report work?','received',now()-interval '6 days')", [id]);
    await admin.query("insert into private.communication_messages(communication_id,direction,body,delivery,delivery_channel,created_at) values($1,'outbound','Here is how it works.','sent','email',now()-interval '5 days')", [id]);
    if (inboundAfter) await admin.query("insert into private.communication_messages(communication_id,direction,body,delivery,created_at) values($1,'inbound','Thanks, we will look.','received',now()-interval '1 day')", [id]);
    const event = (await row("insert into private.customer_activity_events(product,organization_id,event_key,kind,occurred_at,facts) values('caremetric-intel',$1,$2,'reply',now()-interval '6 days',$3) returning id",
      [p.org, `inquiry:${run}:${p.domain}`, JSON.stringify({ communicationId: id })])).id;
    return { event, communication: id };
  };
  const quietOf = async p => (await store.quietCandidates(50)).filter(item => item.opportunityId === p.opportunity);
  const pq = await prospect('quiet');
  const q = await conversation(pq);
  let listed = await quietOf(pq);
  assert.deepEqual(listed.map(item => [item.step, item.key]), [[1, `quiet:${q.event}:1`]], 'answered five days ago and quiet since: step 1');
  const quiet1 = await touch(pq, { key: `quiet:${q.event}:1`, kind: 'reply', purpose: 'success', subject: 'Following up' });
  assert.deepEqual(await quietOf(pq), [], 'a follow-up waiting for its send is not listed again');
  await sent(quiet1, '6 days');
  listed = await quietOf(pq);
  assert.deepEqual(listed.map(item => [item.step, item.key]), [[2, `quiet:${q.event}:2`]], 'five days after the first follow-up: step 2');
  const quiet2 = await touch(pq, { key: `quiet:${q.event}:2`, kind: 'reply', purpose: 'success', subject: 'A last note' });
  await sent(quiet2, '6 days');
  assert.deepEqual(await quietOf(pq), [], 'never a third');
  const pq2 = await prospect('quiet-wrote');
  await conversation(pq2, { inboundAfter: true });
  assert.deepEqual(await quietOf(pq2), [], 'a word from the prospect since our answer: no follow-up');

  // ---- 7. A brief only for an agency that can be emailed ---------------------------------------------------------------------------
  const unreachable = domainOf('brief-unreachable');
  await store.discover('caremetric-intel', [{ name: 'Synthetic unreachable', domain: unreachable, url: `https://${unreachable}/about`, claim: 'A Medicare-certified home health agency.' }]);
  await admin.query("update private.growth_opportunities set fit=99,stage='researched' where organization_id=(select id from private.growth_organizations where domain=$1)", [unreachable]);
  const picked = [];
  for (let i = 0; i < 100; i++) { const pick = await store.briefNext(200); if (!pick) break; picked.push(pick.domain); }
  assert.equal(picked.includes(unreachable), false, 'an agency with no address is never briefed');

  // ---- 8. The Sales Executive's context ---------------------------------------------------------------------------------------------
  const salesConversation = (await row("insert into private.communications(channel,source_system,source_key,subject,contact_email,product_id) values('email','hub.email',$1,'Re: Your county',$2,$3) returning id",
    [`growth-priority:${run}:sales`, pd.email.toUpperCase(), intel])).id;
  communications.push(salesConversation);
  const inbound = (await row("insert into private.communication_messages(communication_id,direction,body,delivery,provider_message_id) values($1,'inbound','Tell me more.','received',$2) returning id",
    [salesConversation, `email:growth-priority-${run}`])).id;
  await admin.query("insert into private.growth_briefs(opportunity_id,writer,research,model,prompt_version) values($1,$2,$3,'test','brief.test')",
    [pd.opportunity, JSON.stringify({ summary: 'A home health agency serving two counties.', angle: 'referral_growth', pains: [{ question: 'Which hospitals send the most?', capability: 'x' }],
      hook: { sentence: 'It opened a second office this fall.', sourceUrl: `https://${pd.domain}/news` } }), JSON.stringify({ leaders: [{ name: 'Jane Doe', title: 'Owner' }], fit: 90 })]);
  const context = await readContext(salesConversation, inbound);
  assert.deepEqual(context.answered, { touch: 1, purpose: 'marketing', subject: 'Your county\'s referrals', form: 'short' }, 'the email answered, with its form');
  assert.deepEqual(context.brief, { summary: 'A home health agency serving two counties.', angle: 'referral_growth', pains: ['Which hospitals send the most?'], hook: 'It opened a second office this fall.' });
  assert.equal(context.reportOpened, true);
  assert.equal(JSON.stringify(context).includes('Jane Doe'), false, 'never the research part');
  assert.equal(salesContextFor(context)?.reportOpened, true);
  await admin.query('update private.growth_organizations set internal=true where id=$1', [pd.org]);
  assert.equal(await readContext(salesConversation, inbound), null, 'an internal organization has no context');

  // ---- 9. Only the Hub server may ask, and the gate refuses drift -------------------------------------------------------------------
  const serverFns = ['private.growth_defer_action(uuid,integer,text)', 'private.growth_quiet_candidates(integer)', 'private.sales_growth_context(uuid,uuid)',
    'private.agent_actions_ready(integer,text[],text[])', 'private.growth_learning_facts(text,integer)'];
  const helperFns = ['private.growth_send_priority_on()', 'private.growth_priority_band(uuid)', 'private.growth_action_score(uuid)', 'private.growth_next_send_at(timestamptz)',
    'private.growth_report_open_followup()', 'private.sales_growth_context_read(uuid,uuid)'];
  for (const fn of serverFns) {
    assert.equal((await row("select has_function_privilege('hub_app_server',$1,'execute') as s,has_function_privilege('anon',$1,'execute') or has_function_privilege('authenticated',$1,'execute') or has_function_privilege('service_role',$1,'execute') as o", [fn])).s, true, fn);
    assert.equal((await row("select has_function_privilege('anon',$1,'execute') or has_function_privilege('authenticated',$1,'execute') or has_function_privilege('service_role',$1,'execute') as o", [fn])).o, false, fn);
  }
  for (const fn of helperFns) assert.equal((await row("select has_function_privilege('hub_app_server',$1,'execute') or has_function_privilege('authenticated',$1,'execute') as o", [fn])).o, false, fn);
  const client = await admin.connect();
  try {
    for (const sql of [['select private.growth_quiet_candidates(5)'], ['select private.sales_growth_context($1,$2)', [salesConversation, inbound]],
      ['select private.growth_defer_action($1,1,$2)', [ta.action, 'daily_limit']]]) {
      await client.query('begin');
      try { await client.query('set local role authenticated'); await assert.rejects(client.query(...sql), refused('42501'), sql[0]); }
      finally { await client.query('rollback'); }
    }
    const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
      if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
    await client.query('begin'); await client.query(gate); await client.query(gate); await client.query('rollback');
    for (const drift of [
      'grant execute on function private.growth_quiet_candidates(integer) to authenticated',
      'grant execute on function private.growth_priority_band(uuid) to hub_app_server',
      'drop trigger growth_report_open_followup on private.customer_activity_events',
      "delete from private.hub_settings where key='growth.sales_context'",
      rewrite('private.growth_claim_message(uuid,uuid)', "'outside_hours'", "'outside_time'"),
      rewrite('private.agent_actions_ready(integer,text[],text[])', 'private.growth_send_priority_on()', 'false'),
      rewrite('private.growth_snapshot(integer)', 'as priority_band', 'as band'),
      rewrite('private.growth_snapshot(integer)', 'as first_form', 'as form'),
      rewrite('private.growth_brief_next(integer)', "and exists (select 1 from private.growth_contacts c where c.id = o.contact_id and c.eligibility = 'permitted')", 'and true'),
      rewrite('private.growth_learning_facts(text,integer)', 'weaknesses', 'weak'),
      rewrite('private.growth_quiet_candidates(integer)', 'perform private.require_hub_app_server();', ' '),
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Growth priority integration passed: the ready queue unchanged with the switch off and by band, fit and waiting time with it on (6 actions); deferrals to the next day, the next opening and 15 minutes; the hours read in an agency own time zone; the claim holds a cold email outside the hours and never a customer email; a first report open brings the second email forward, a second or the switch off does not; the snapshot\'s band and first form; quiet prospects at step 1 and 2 and never a third; no brief without an address; the Sales Executive\'s context; server-only access and 11 kinds of gate drift. No model was called and no email was sent.');
} finally {
  for (const s of seedSettings) await admin.query('update private.hub_settings set value=$2,changed_at=$3,changed_by=$4 where key=$1', [s.key, s.value, s.changed_at, s.changed_by]);
  const orgs = (await admin.query('select id from private.growth_organizations where domain=any($1::text[])', [domains])).rows.map(r => r.id);
  const opportunities = (await admin.query('select id from private.growth_opportunities where organization_id=any($1::uuid[])', [orgs])).rows.map(r => r.id);
  const ids = (await admin.query('select id from private.growth_messages where opportunity_id=any($1::uuid[])', [opportunities])).rows.map(r => r.id);
  await admin.query('delete from private.communication_messages where communication_id=any($1::uuid[])', [communications]);
  await admin.query('delete from private.communications where id=any($1::uuid[])', [communications]);
  await admin.query('delete from private.growth_delivery_events where message_id=any($1::uuid[])', [ids]);
  await admin.query('delete from private.growth_messages where id=any($1::uuid[])', [ids]);
  await admin.query("delete from private.audit_events where entity_type='agent_action' and entity_id in (select id from private.agent_actions where task_id=any($1::uuid[]) or id=any($2::uuid[]))", [tasks, actions]);
  await admin.query('delete from private.agent_actions where task_id=any($1::uuid[]) or id=any($2::uuid[])', [tasks, actions]);
  await admin.query('delete from private.agent_tasks where id=any($1::uuid[])', [tasks]);
  await admin.query('delete from private.growth_brief_log where opportunity_id=any($1::uuid[]) or started_at>=$2', [opportunities, runStart]);
  await admin.query('delete from private.growth_briefs where opportunity_id=any($1::uuid[])', [opportunities]);
  await admin.query('delete from private.customer_success_plans where opportunity_id=any($1::uuid[])', [opportunities]);
  await admin.query('delete from private.growth_evidence where opportunity_id=any($1::uuid[])', [opportunities]);
  await admin.query('delete from private.customer_activity_events where organization_id=any($1::uuid[])', [orgs]);
  await admin.query('delete from private.growth_opportunities where id=any($1::uuid[])', [opportunities]);
  const emails = (await admin.query('select email from private.growth_contacts where organization_id=any($1::uuid[])', [orgs])).rows.map(r => digest(r.email));
  await admin.query('delete from private.email_suppressions where email_hash=any($1::text[])', [emails]);
  await admin.query('delete from private.growth_contacts where organization_id=any($1::uuid[])', [orgs]);
  await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=any($1::uuid[])", [orgs]);
  await admin.query('delete from private.growth_roster_targets where organization_id=any($1::uuid[])', [orgs]);
  await admin.query('delete from private.growth_organizations where id=any($1::uuid[])', [orgs]);
  await admin.query('delete from private.agent_evaluations where created_at>=$1', [runStart]);
  await admin.query("delete from private.audit_events where (action='growth.auto_qualified' and created_at>=$1) or actor_id=$2", [runStart, owner]);
  for (const a of seedAgents) await admin.query('update private.agents set status=$2,autonomy=$3,config=$4 where key=$1', [a.key, a.status, a.autonomy, a.config]);
  for (const p of seedPolicies) await admin.query('update private.growth_policies set enabled=$2,auto_send=$3,daily_limit=$4,min_gap_hours=$5,max_touches=$6,booking_url=$7,approved_claim=$8,version=$9 where product=$1', [p.product, p.enabled, p.auto_send, p.daily_limit, p.min_gap_hours, p.max_touches, p.booking_url, p.approved_claim, p.version]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
