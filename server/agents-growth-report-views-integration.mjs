// Which agencies opened their market report, through the real roles (20261116120000_growth_report_views.sql): an open Intel recorded
// counts only for a CareMetric Intel opportunity whose first email went out at least two minutes before it, once per Intel open; it
// raises the opportunity's intent and notes the first open without a new version; the read cursor moves on; the owner hears only about
// an agency's first open; and the gate refuses drift. Disposable loopback database only; nothing is fetched or sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool);
const run = randomUUID().slice(0, 8);
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261116120100_growth_report_views_contract.sql', import.meta.url), 'utf8');
const seedSync = await row('select after_id, synced_at from private.growth_report_view_sync where id');
const domains = [];
// Intel's ids: high, so they never meet another run's.
const base = Number(BigInt(`0x${run}`) % 1_000_000_000n) * 100 + 1_000_000_000;
async function prospect(label, { product = 'caremetric-intel', sentMinutesAgo = 60 } = {}) {
  const domain = `${label}-${run}.example.org`; domains.push(domain);
  await store.discover(product, [{ name: `Synthetic ${label}`, domain, url: `https://${domain}/about`, claim: 'A Medicare-certified home health agency.' }]);
  const org = (await row('select id from private.growth_organizations where domain=$1', [domain])).id;
  await store.recordContact(org, `info@${domain}`, `https://${domain}/contact`);
  const o = await row('select * from private.growth_opportunities where organization_id=$1', [org]);
  if (sentMinutesAgo !== null) {
    await admin.query("insert into private.growth_messages(opportunity_id,contact_id,purpose,subject,body,opportunity_version,contact_version,policy_version,status,unsubscribe_hash,attempted_at) values($1,$2,'marketing','Synthetic','Synthetic',1,1,1,'delivered',$3,now()-make_interval(mins=>$4))",
      [o.id, o.contact_id, digest(`views-${run}-${label}`), sentMinutesAgo]);
  }
  return { org, opportunity: o.id, version: o.version };
}
const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString();

try {
  const opened = await prospect('views-opened');
  const unsent = await prospect('views-unsent', { sentMinutesAgo: null });
  const carebase = await prospect('views-carebase', { product: 'carebase' });
  const page = [
    { id: base + 1, ref: opened.opportunity, ccn: '397001', viewed_at: minutesAgo(59) },        // the mail service's scan at delivery
    { id: base + 2, ref: opened.opportunity, ccn: '397001', viewed_at: minutesAgo(30) },        // a person opened it
    { id: base + 3, ref: opened.opportunity, ccn: '397001', viewed_at: minutesAgo(10) },        // again, an hour later on Intel's side
    { id: base + 4, ref: unsent.opportunity, ccn: '397002', viewed_at: minutesAgo(5) },         // the owner's preview before any email
    { id: base + 5, ref: carebase.opportunity, ccn: '397003', viewed_at: minutesAgo(5) },       // not an Intel prospect
    { id: base + 6, ref: 'not-a-uuid', ccn: null, viewed_at: minutesAgo(5) },
    { id: base + 7, ref: randomUUID(), ccn: null, viewed_at: minutesAgo(5) },                   // no such opportunity
  ];
  const first = await store.reportViewsRecord(page, base + 7);
  assert.deepEqual([first.recorded, first.ignored], [2, 5]);
  assert.deepEqual(first.firstViews.map(item => [item.opportunity, item.name]), [[opened.opportunity, 'Synthetic views-opened']], 'the owner hears about the first open only');
  const events = (await admin.query("select event_key, kind, facts from private.customer_activity_events where organization_id=$1 order by event_key", [opened.org])).rows;
  assert.deepEqual(events.map(e => [e.event_key, e.kind, e.facts.ccn]), [[`report_view:${base + 2}`, 'report_viewed', '397001'], [`report_view:${base + 3}`, 'report_viewed', '397001']]);
  const after = await row('select intent, version, memory from private.growth_opportunities where id=$1', [opened.opportunity]);
  assert.equal(after.intent, 50, 'an open raises intent');
  assert.equal(after.version, opened.version, 'without a new version, so a touch\'s waiting emails to colleagues stand');
  assert.ok(Math.abs(Date.parse(after.memory.reportViewedAt) - (Date.now() - 30 * 60_000)) < 120_000, 'the first open is noted');
  assert.equal(Number(await store.reportViewsCursor()) >= base + 7, true, 'the next read starts after this page');
  const again = await store.reportViewsRecord(page.slice(1, 3), base + 3);
  assert.deepEqual([again.recorded, again.ignored, again.firstViews], [0, 2, []], 'an open is recorded once');
  assert.equal(Number(await store.reportViewsCursor()) >= base + 7, true, 'the cursor never moves back');
  await assert.rejects(store.reportViewsRecord({}, 1), refused('22023'));
  await assert.rejects(pool.query('select * from private.growth_report_view_sync'), refused('42501'));

  // ---- The gate refuses drift --------------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    await client.query('begin'); await client.query(gate); await client.query(gate); await client.query('rollback');
    for (const drift of [
      "delete from private.hub_settings where key='growth.report_views'",
      'grant select on private.growth_report_view_sync to hub_app_server',
      'grant execute on function private.growth_report_views_record(jsonb,bigint) to authenticated',
      rewrite('private.growth_report_views_record(jsonb,bigint)', "v_first + interval '2 minutes'", "v_first - interval '1 day'"),
      'alter table private.customer_activity_events drop constraint customer_activity_events_kind_check',
      "delete from private.agent_schedules where agent_key='marketing_manager' and task_kind='growth.views'",
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Report views integration passed: an open counts only for an Intel opportunity emailed at least two minutes before, once per Intel open; it raises intent and notes the first open without a new version; the cursor moves on and never back; the owner hears about the first open only; and gate drift. Nothing was fetched or sent.');
} finally {
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    await admin.query('delete from private.customer_activity_events where organization_id=$1', [org]);
    await admin.query('delete from private.growth_messages where opportunity_id in (select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.customer_success_plans where opportunity_id in (select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in (select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query('update private.growth_report_view_sync set after_id=$1, synced_at=$2 where id', [seedSync?.after_id ?? 0, seedSync?.synced_at ?? null]);
  await pool.end(); await admin.end();
}
