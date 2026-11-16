// An account brief per CareMetric Intel agency, through the real roles (20261116110000_growth_brief.sql): the database hands out the
// agencies about to be written to first (qualified with a permitted contact, then the best fit), within the day's number and once in 30
// days, never one already emailed or of another product; a brief is saved in two parts and replaced with a new version; the server's
// writer reads only the writer part; the owner reads both; the Marketing Manager's budget covers the quality tier; and the gate refuses
// drift. Disposable loopback database only; no model is called and nothing is sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool);
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `growth-brief-${randomUUID()}`;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261116110100_growth_brief_contract.sql', import.meta.url), 'utf8');
const runStart = (await row('select now() as t')).t;
const domains = [];
let earlier = [];
const domainOf = label => { const value = `${label}-${run}.example.org`; domains.push(value); return value; };
const opportunityOf = domain => row('select o.* from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where g.domain=$1', [domain]);
// An Intel (or CareBase) prospect found online with its fit and stage set, and its public role address as its contact when asked.
async function prospect(label, { fit, stage = 'researched', contact = false, product = 'caremetric-intel' }) {
  const domain = domainOf(label);
  await store.discover(product, [{ name: `Synthetic ${label}`, domain, url: `https://${domain}/about`, claim: 'A Medicare-certified home health agency in Erie, Pennsylvania.' }]);
  const org = (await row('select id from private.growth_organizations where domain=$1', [domain])).id;
  if (contact) await store.recordContact(org, `info@${domain}`, `https://${domain}/contact`);
  await admin.query('update private.growth_opportunities set fit=$2,stage=$3 where organization_id=$1', [org, fit, stage]);
  return { domain, org, opportunity: (await opportunityOf(domain)).id };
}
// The day's number counts briefs handed out across the database: this run's picks are its own if the day started clean.
const mine = async daily => {
  const picks = [];
  for (;;) {
    const pick = await store.briefNext(daily);
    if (!pick) return picks;
    if (domains.includes(pick.domain)) picks.push(pick.domain);
  }
};

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `growth-brief-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550978',now())", [owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  // Briefs from earlier runs today would use up the number; this run counts from a clean day.
  earlier = (await admin.query('select id from private.growth_brief_log where started_at >= private.agent_day_start()')).rows.map(r => r.id);
  await admin.query("update private.growth_brief_log set started_at = started_at - interval '2 days' where id = any($1::uuid[])", [earlier]);

  // ---- 1. Who is briefed first ------------------------------------------------------------------------------------------------------
  const borderline = await prospect('brief-borderline', { fit: 64 });
  const strong = await prospect('brief-strong', { fit: 90 });
  const ready = await prospect('brief-ready', { fit: 78, stage: 'qualified', contact: true });
  const weak = await prospect('brief-weak', { fit: 40 });
  const emailed = await prospect('brief-emailed', { fit: 95, stage: 'qualified', contact: true });
  const carebase = await prospect('brief-carebase', { fit: 95, product: 'carebase' });
  const contact = await row('select id from private.growth_contacts where organization_id=$1', [emailed.org]);
  await admin.query("insert into private.growth_messages(opportunity_id,contact_id,purpose,subject,body,opportunity_version,contact_version,policy_version,status,unsubscribe_hash,attempted_at) values($1,$2,'marketing','Synthetic','Synthetic',1,1,1,'delivered',$3,now())",
    [emailed.opportunity, contact.id, digest(`brief-${run}`)]);
  assert.equal(await store.briefNext(0), null, 'no brief past the day\'s number');
  const first = await store.briefNext(1);
  assert.equal(first?.domain, ready.domain, 'a qualified agency with a permitted contact is briefed first');
  assert.equal(await store.briefNext(1), null, 'one a day means one');
  assert.deepEqual(first.agencies, []);
  assert.ok(first.evidence.length >= 1 && first.evidence[0].sourceUrl === `https://${ready.domain}/about`);
  assert.deepEqual(await mine(10), [strong.domain, borderline.domain], 'then the best fit; never one below 60 without a roster record, one already emailed or another product');
  assert.deepEqual(await mine(10), [], 'an attempt rests the agency a day');
  void weak; void carebase;

  // ---- 2. Two parts, a new version, the writer reads only its own ---------------------------------------------------------------------
  const brief = { writer: { summary: 'A home health agency in Erie.', angle: 'referral_sources', hook: { sentence: 'It serves Erie.', sourceUrl: `https://${ready.domain}/about` } },
    research: { fit: 82, intel: { position: { county_rank: 9, county_share: 0.041 } } }, model: 'claude-opus-5-5', promptVersion: 'brief.1', costCents: 31.5 };
  assert.deepEqual(await store.briefSave(ready.opportunity, brief), { version: 1 });
  assert.deepEqual(await store.briefSave(ready.opportunity, { ...brief, writer: { ...brief.writer, summary: 'A family-owned home health agency in Erie.' } }), { version: 2 });
  // A day on: the attempts that saved nothing are tried again; the agency with a saved brief rests 30 days.
  await admin.query("update private.growth_brief_log set started_at = started_at - interval '2 days' where opportunity_id = any($1::uuid[])",
    [[ready.opportunity, strong.opportunity, borderline.opportunity]]);
  assert.deepEqual(await mine(10), [strong.domain, borderline.domain], 'a failed or deferred attempt is tried again the next day; a saved brief rests 30 days');
  const writer = await store.briefWriter(ready.opportunity);
  assert.deepEqual(writer, { summary: 'A family-owned home health agency in Erie.', angle: 'referral_sources', hook: brief.writer.hook, briefVersion: 2 });
  assert.equal(JSON.stringify(writer).includes('county_rank'), false, 'the writer never reads the agency\'s own figures');
  assert.equal(await store.briefWriter(strong.opportunity), null);
  await assert.rejects(store.briefSave(ready.opportunity, { writer: 'text' }), refused('22023'));
  assert.equal((await row("select count(*)::int as n from private.audit_events where action='growth.brief_written' and entity_id=$1", [ready.org])).n, 2);
  const seen = await withSession(pool, token, async db => (await db.query('select hub.growth_brief($1) as r', [ready.opportunity])).rows[0].r);
  assert.deepEqual([seen.version, seen.research.intel.position.county_rank, seen.model, Number(seen.costCents)], [2, 9, 'claude-opus-5-5', 31.5], 'the owner reads both parts');
  await assert.rejects(pool.query('select hub.growth_brief($1)', [ready.opportunity]), refused('42501'), 'not without the owner');
  await assert.rejects(pool.query('select * from private.growth_briefs'), refused('42501'), 'nobody reads the table directly');

  // ---- 3. The budget covers the quality tier ------------------------------------------------------------------------------------------
  assert.ok((await row("select daily_budget_cents from private.agents where key='marketing_manager'")).daily_budget_cents >= 1500);

  // ---- 4. The gate refuses drift --------------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    await client.query('begin'); await client.query(gate); await client.query(gate); await client.query('rollback');
    for (const drift of [
      "delete from private.hub_settings where key='growth.quality_writer'",
      'grant select on private.growth_briefs to hub_app_server',
      'grant execute on function private.growth_brief_save(uuid,jsonb) to authenticated',
      rewrite('private.growth_brief_writer(uuid)', 'select writer ||', 'select research || writer ||'),
      rewrite('private.growth_brief_next(integer)', 'perform private.require_hub_app_server();', ' '),
      "delete from private.agent_schedules where agent_key='marketing_manager' and task_kind='growth.brief'",
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Account brief integration passed: agencies about to be written to are briefed first, within the day\'s number, a saved brief once in 30 days and a failed attempt again the next day, never one already emailed or of another product; a brief is saved in two parts with a new version; the writer reads only its part; the owner reads both; the budget covers the quality tier; and gate drift. No model was called and nothing was sent.');
} finally {
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    await admin.query('delete from private.growth_brief_log where opportunity_id in (select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_briefs where opportunity_id in (select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_messages where opportunity_id in (select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.customer_success_plans where opportunity_id in (select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in (select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query("update private.growth_brief_log set started_at = started_at + interval '2 days' where id = any($1::uuid[])", [earlier]);
  await admin.query("delete from private.audit_events where actor_id=$1 or (action='growth.auto_qualified' and created_at>=$2)", [owner, runStart]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
