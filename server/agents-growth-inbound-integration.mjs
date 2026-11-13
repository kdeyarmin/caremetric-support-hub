// Replies, trials, website leads and the one re-ask through the real roles (20261113171000_growth_inbound.sql,
// 20261113172000_growth_reengage.sql), on top of main's reply reading (20261113150000) and trial link (20261113170000): replies read
// from the sender's own words through real email ingestion (a quoted footer or a quoted pitch decides nothing, another mailbox at the
// same business joins it for review), the Sales Executive's reading correcting the keyword reading, a trial finding the prospect it
// was, website leads captured as qualified follow-ups and a trial sign-up stopping cold email, one re-ask after the owner's wait and
// never after a no, and the gates' drift checks. Disposable loopback database only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { growthStore } from './growth/store.mjs';
import { sqlAgentStore } from './agents/store.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool), agents = sqlAgentStore(pool, { fenced: true, growth: true });
const run = randomUUID().slice(0, 8);
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const call = async (fn, values = []) => (await pool.query(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(',')}) as r`, values)).rows[0].r;
const refused = code => error => error?.code === code;
const inboundGate = await readFile(new URL('../supabase/migrations/20261113171100_growth_inbound_contract.sql', import.meta.url), 'utf8');
const reengageGate = await readFile(new URL('../supabase/migrations/20261113172100_growth_reengage_contract.sql', import.meta.url), 'utf8');
const domains = [], communications = [], leads = [], tenants = [];
const domainOf = label => { const value = `${label}-${run}.example.org`; domains.push(value); return value; };
const ingest = async (key, body, email) => {
  const thread = await call('private.ingest_inbound_communication', ['email', `inbound:${run}:${key}`, `inbound-${key}:${run}`, null, 'caremetric-intel', 'Re: Your agency', body, 'Reader', email, null]);
  communications.push(thread.id);
  return (await row('select id from private.communication_messages where provider_message_id=$1', [`email:inbound-${key}:${run}`])).id;
};
// A discovered business with a role address and an Intel opportunity, qualified, with one proposed outreach message.
async function prospect(label) {
  const domain = domainOf(label);
  await store.discover('caremetric-intel', [{ name: `Synthetic ${label}`, domain, url: `https://${domain}/`, claim: 'A Medicare-certified home health agency.' }]);
  const org = (await row('select id from private.growth_organizations where domain=$1', [domain])).id;
  await store.recordContact(org, `info@${domain}`, `https://${domain}/contact`);
  const o = await row("select * from private.growth_opportunities where organization_id=$1 and product='caremetric-intel'", [org]);
  await admin.query("update private.growth_opportunities set stage='qualified',version=version+1 where id=$1", [o.id]);
  return { domain, org, opportunity: o.id, email: `info@${domain}` };
}
async function queued(p) {
  const o = await row('select o.version,c.version as cv,pp.version as pv from private.growth_opportunities o join private.growth_contacts c on c.id=o.contact_id join private.growth_policies pp on pp.product=o.product where o.id=$1', [p.opportunity]);
  const work = await store.plan(p.opportunity, { key: `outreach:${randomUUID()}`, kind: 'outreach', action: 'Offer the trial.', success: 'A reply.', owner: 'marketing_manager', dueAt: new Date().toISOString() });
  const citations = (await admin.query('select id from private.growth_evidence where opportunity_id=$1', [p.opportunity])).rows.map(e => e.id);
  const draft = await store.draft(p.opportunity, work, { version: o.version, contactVersion: o.cv, policyVersion: o.pv, purpose: 'marketing', subject: 'Your referral sources', body: 'Would the free trial help?', citations, unsubscribeHash: randomUUID().replaceAll('-', ''), modelGenerated: true, arms: { trigger: 'web', angle: 'territory', 'Bad Key': 'x', note: 'has spaces in it' } });
  return draft.id;
}
const status = async id => (await row('select status from private.growth_messages where id=$1', [id])).status;
const lead = async (kind, email, extra = {}) => {
  const recorded = (await row('select private.lead_record($1, $2::jsonb) as r', ['intel', JSON.stringify({ version: 1, source: 'intel', kind,
    externalId: `inbound-${run}-${randomUUID().slice(0, 8)}`, occurredAt: new Date().toISOString(), contact: { email, name: 'Pat Reader', organization: 'Synthetic Lead Agency' },
    details: { county: 'Allegheny', state: 'PA' }, attribution: { landingPath: '/county-report' }, ...extra })])).r;
  leads.push(recorded.id);
  return recorded.id;
};

try {
  // ---- 1. Replies through real ingestion ----------------------------------------------------------------------------------------
  const a = await prospect('quoted-no');
  const aMessage = await queued(a);
  // The email reached the business (main's reading links a colleague only to a business growth email has reached).
  await admin.query("update private.growth_messages set status='delivered', attempted_at=now() where id=$1", [aMessage]);
  // Another mailbox at the same business, saying no above a quoted pitch that says "interested".
  const aReply = await ingest('a', 'Not really interested, thanks.\n\nOn Tue, Nov 12, 2026 at 9:00 AM Founder wrote:\n> Would you be interested in the free trial?\n> Opt out of these emails', `director@${a.domain}`);
  assert.equal((await row('select kind from private.customer_activity_events where event_key=$1', [`inquiry:${aReply}`])).kind, 'negative_reply');
  assert.equal((await row('select stage from private.growth_opportunities where id=$1', [a.opportunity])).stage, 'nurture');
  // Main's reading (20261113150000): the colleague joins the business for review, and the reply counts as the business's reply, so the
  // send claim refuses marketing still queued there.
  const colleague = await row('select organization_id,eligibility from private.growth_contacts where email=$1', [`director@${a.domain}`]);
  assert.deepEqual([colleague.organization_id, colleague.eligibility], [a.org, 'review'], 'Another mailbox at the business joins it for review');
  assert.equal((await row('select eligibility from private.growth_contacts where email=$1', [a.email])).eligibility, 'permitted', 'A quoted footer opts nobody out');

  const b = await prospect('quoted-yes');
  const bReply = await ingest('b', 'Yes, tell me more.\n\n-----Original Message-----\nFrom: Founder\nSent: Tuesday\n> unsubscribe link below', b.email);
  assert.equal((await row('select kind from private.customer_activity_events where event_key=$1', [`inquiry:${bReply}`])).kind, 'positive_reply');
  assert.equal((await row('select eligibility from private.growth_contacts where email=$1', [b.email])).eligibility, 'permitted');
  assert.equal((await row('select count(*)::int n from private.email_suppressions where email_hash=encode(extensions.digest($1::text,\'sha256\'),\'hex\')', [b.email])).n, 0);

  // ---- 2. The Sales Executive's reading corrects the keywords ------------------------------------------------------------------
  assert.equal(await agents.growthReplyDisposition(bReply, 'not_now', 'timing'), 1);
  const corrected = await row('select kind,facts from private.customer_activity_events where event_key=$1', [`inquiry:${bReply}`]);
  assert.equal(corrected.kind, 'not_now'); assert.equal(corrected.facts.objection, 'timing'); assert.equal(corrected.facts.readBy, 'sales_executive');
  assert.equal((await row('select stage from private.growth_opportunities where id=$1', [b.opportunity])).stage, 'nurture');
  await assert.rejects(agents.growthReplyDisposition(bReply, 'Not An Intent'), refused('22023'));
  assert.equal(await agents.growthReplyDisposition(randomUUID(), 'interested'), 0, 'A message growth never recorded changes nothing');

  // ---- 3. Website leads: a qualified follow-up to the person who asked; a trial sign-up stops cold email ------------------------
  const leadDomain = domainOf('lead-agency');
  const asked = await lead('county_report', `pat@${leadDomain}`);
  const captured = await agents.growthLeadCapture(asked);
  assert.equal(captured.captured, true); assert.equal(captured.kind, 'county_report');
  const leadOpp = await row('select o.*,c.source_kind,c.eligibility,c.verified_at from private.growth_opportunities o join private.growth_contacts c on c.id=o.contact_id where o.id=$1', [captured.opportunityId]);
  assert.deepEqual([leadOpp.stage, leadOpp.source_kind, leadOpp.eligibility, leadOpp.memory.lead.kind, leadOpp.memory.lead.place], ['qualified', 'inbound', 'permitted', 'county_report', 'Allegheny, PA']);
  const leadEvidence = await row('select * from private.growth_evidence where opportunity_id=$1', [captured.opportunityId]);
  assert.equal(leadEvidence.source_url, 'https://www.caremetricintel.com/county-report'); assert.equal(leadEvidence.confidence, 'high');
  assert.match(leadEvidence.claim, /^Asked for the free county report for Allegheny, PA on /);
  assert.equal(await call('private.growth_message_class', ['marketing_manager', 'marketing', 'inbound']).catch(() => 'closed'), 'closed', 'The class helper stays internal');
  assert.equal((await row("select private.growth_message_class('marketing_manager','marketing','inbound') as c")).c, 'growth.sales_followup', 'A person who asked is never cold email');
  assert.equal((await agents.growthLeadCapture(asked)).captured, true, 'Capturing again changes nothing');
  assert.equal((await row('select count(*)::int n from private.growth_evidence where opportunity_id=$1', [captured.opportunityId])).n, 1);
  // A free mail address is its own organization; a test or unknown kind is not captured.
  const free = await lead('newsletter', `pat.reader.${run}@gmail.com`);
  const freeCaptured = await agents.growthLeadCapture(free);
  assert.equal(freeCaptured.captured, true);
  const freeOrg = await row('select g.domain from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where o.id=$1', [freeCaptured.opportunityId]);
  assert.match(freeOrg.domain, /^lead-[0-9a-f-]+\.invalid$/); domains.push(freeOrg.domain);
  // A trial sign-up from a business already contacted stops outreach to it at once.
  const c = await prospect('signs-up');
  const cMessage = await queued(c);
  const signup = await lead('trial_signup', `owner@${c.domain}`);
  assert.deepEqual(await agents.growthLeadCapture(signup), { captured: true, kind: 'signup' });
  assert.equal(await status(cMessage), 'cancelled');
  assert.equal((await row("select count(*)::int n from private.customer_activity_events where organization_id=$1 and kind='signup'", [c.org])).n, 1);
  assert.deepEqual(await agents.growthLeadCapture(await lead('trial_signup', `owner@${domainOf('unknown')}`)), { captured: false, reason: 'no_prospect' });

  // ---- 4. A trial finds the prospect it was ------------------------------------------------------------------------------------
  const tenant = randomUUID(); tenants.push(tenant);
  await admin.query('insert into hub.tenants(id,slug,name) values($1,$2,$3)', [tenant, `inbound-${run}`, 'Synthetic Trial Agency']);
  await admin.query("insert into private.billing_customers(tenant_id,stripe_customer_id,email,name,livemode,seen_at) values($1,$2,$3,'Synthetic',true,now())", [tenant, `cus_inbound${run}`, `Owner@${a.domain}`]);
  const linked = (await row("select private.growth_ensure_customer($1,'caremetric-intel') as id", [tenant])).id;
  assert.equal(linked, a.org, 'The business on the trial owner\'s domain becomes the customer: no second organization');
  assert.equal((await row('select tenant_id from private.growth_organizations where id=$1', [a.org])).tenant_id, tenant);
  assert.equal((await row("select count(*)::int n from private.growth_organizations where domain like 'customer-%' and tenant_id=$1", [tenant])).n, 0);
  const lonely = randomUUID(); tenants.push(lonely);
  await admin.query('insert into hub.tenants(id,slug,name) values($1,$2,$3)', [lonely, `inbound-lonely-${run}`, 'Synthetic New Agency']);
  await admin.query("insert into private.billing_customers(tenant_id,stripe_customer_id,email,name,livemode,seen_at) values($1,$2,$3,'Synthetic',true,now())", [lonely, `cus_lonely${run}`, `someone.${run}@gmail.com`]);
  const created = (await row("select private.growth_ensure_customer($1,'caremetric-intel') as id", [lonely])).id;
  assert.equal((await row('select domain from private.growth_organizations where id=$1', [created])).domain, `customer-${lonely}.invalid`, 'A free mail address never matches a business');
  domains.push(`customer-${lonely}.invalid`);

  // ---- 5. One re-ask, after the owner's wait, never after a no ------------------------------------------------------------------
  const d = await prospect('later');
  await admin.query("update private.growth_opportunities set stage='nurture' where id=$1", [d.opportunity]);
  await admin.query("insert into private.customer_activity_events(product,organization_id,event_key,kind,occurred_at) values('caremetric-intel',$1,$2,'not_now',now()-interval '100 days')", [d.org, `inbound:${run}:later`]);
  const oldWork = await store.plan(d.opportunity, { key: `old:${run}`, kind: 'outreach', action: 'Old.', success: 'Old.', owner: 'marketing_manager', dueAt: new Date().toISOString() });
  await admin.query("insert into private.growth_messages(opportunity_id,work_id,contact_id,purpose,subject,body,citations,opportunity_version,contact_version,policy_version,unsubscribe_hash,status,attempted_at) select o.id,$3,o.contact_id,'marketing','Old','Old.','[]',o.version,1,1,md5($2),'delivered',now()-interval '120 days' from private.growth_opportunities o where o.id=$1", [d.opportunity, run, oldWork]);
  const e = await prospect('said-no');
  await admin.query("update private.growth_opportunities set stage='nurture' where id=$1", [e.opportunity]);
  await admin.query("insert into private.customer_activity_events(product,organization_id,event_key,kind,occurred_at) values('caremetric-intel',$1,$2,'negative_reply',now()-interval '200 days')", [e.org, `inbound:${run}:no`]);
  const first = await store.reengage(200);
  assert.ok(first.reengaged >= 1); assert.equal(first.days, 90);
  const dNow = await row('select stage,memory from private.growth_opportunities where id=$1', [d.opportunity]);
  assert.equal(dNow.stage, 'qualified'); assert.equal(dNow.memory.reengageReason, 'not_now'); assert.equal(Number(dNow.memory.touchesBefore), 1);
  assert.equal((await row('select stage from private.growth_opportunities where id=$1', [e.opportunity])).stage, 'nurture', 'Never after a no');
  await admin.query("update private.growth_opportunities set stage='nurture' where id=$1", [d.opportunity]);
  await store.reengage(200);
  assert.equal((await row('select stage from private.growth_opportunities where id=$1', [d.opportunity])).stage, 'nurture', 'Never twice');
  await assert.rejects(store.reengage(0), refused('22023'));
  // The arms keep only short codes.
  const armed = await row("select arms from private.growth_messages where opportunity_id=$1 and arms<>'{}'::jsonb limit 1", [c.opportunity]);
  assert.deepEqual(armed.arms, { trigger: 'web', angle: 'territory' });

  // ---- 6. The gates refuse drift -----------------------------------------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position(${'$q$'}${from}${'$q$'} in d) = 0 then raise exception 'fixture text missing: %', ${'$q$'}${from}${'$q$'}; end if;
    execute replace(d, ${'$q$'}${from}${'$q$'}, ${'$q$'}${to}${'$q$'}); end $$`;
  try {
    for (const [gate, drift] of [
      [inboundGate, rewrite('private.growth_inquiry(uuid)', 'private.growth_reply_reading(v_body)', "jsonb_build_object('kind','reply','optOut',false,'sales',false)")],
      [inboundGate, rewrite('private.growth_ensure_customer(uuid,text)', "'growth.customer_linked'", "'growth.customer_seen'")],
      [inboundGate, 'grant execute on function private.growth_lead_capture(uuid) to authenticated'],
      [reengageGate, rewrite('private.growth_claim_message(uuid,uuid)', "'trial_started','signup')", "'trial_started')")],
      [reengageGate, rewrite('private.growth_message_class(text,text,text)', "('role_address','enriched','imported')", "('role_address')")],
      [reengageGate, 'grant execute on function private.growth_reengage(integer) to authenticated'],
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Replies, trials, leads and re-asks integration passed: main\'s reply reading kept through real ingestion (quoted footers and pitches decide nothing, another mailbox joins for review), the Sales Executive\'s reading kept, main\'s trial link kept, website leads captured as qualified follow-ups and a sign-up stopping cold email, one re-ask after the owner\'s wait and never after a no, arms kept as short codes, and gate drift. No email left the machine.');
} finally {
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    await admin.query('delete from private.growth_messages where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.customer_success_plans where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.customer_activity_events where organization_id=$1', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query("delete from private.audit_events where action='growth.reengaged' and created_at>now()-interval '1 hour'");
  await admin.query('delete from private.leads where id=any($1::uuid[])', [leads]);
  await admin.query('delete from private.communications where id=any($1::uuid[])', [communications]);
  await admin.query('delete from private.billing_customers where tenant_id=any($1::uuid[])', [tenants]);
  await admin.query('delete from hub.tenants where id=any($1::uuid[])', [tenants]);
  await pool.end(); await admin.end();
}
