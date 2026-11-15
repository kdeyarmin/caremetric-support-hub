// Web-found prospects matched to their Medicare record through the real roles (20261115233000_growth_roster_match.sql): the table
// closed, the day's prospects handed out best fit first within the daily number (never an internal business, a lost one, another
// product's or one that already has a roster record), a match saved as the roster saves an agency and attached to the organization
// with its public record as high-confidence evidence that the report link reads, back-off for no match, a CCN tied to another
// organization or closed never attached, a stale claim handed out again, and the gate's drift checks. Disposable loopback database
// only; nothing is fetched or sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { growthStore } from './growth/store.mjs';
import { rosterRow } from './growth/roster.mjs';
import { rosterAgency } from './growth/report-link.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool);
const run = randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
// Synthetic six-character CCNs no CMS record uses.
const ccn = n => `Z${run}${n}`;
const period = '2099Q4';
const domains = [];
const domainOf = label => { const value = `${label}-${run.toLowerCase()}.example.org`; domains.push(value); return value; };
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261115233100_growth_roster_match_contract.sql', import.meta.url), 'utf8');
const now = new Date();
const item = (n, extra = {}) => ({ ccn: ccn(n), name: `SYNTHETIC SUNRISE HOME HEALTH ${n}`, setting: 'home_health', city: 'Cleveland', state: 'OH', zip: '44113',
  county_fips: '39035', control_type: 'Proprietary', control_type_code: '4', certification_date: '2012-03-01', termination_date: null,
  change_of_ownership_date: null, signals: [], quality: null, volume: null, ...extra });
const prospect = async (label, { product = 'caremetric-intel', stage = 'researched', fit = 90, claim = 'Home health in Cleveland, Ohio.' } = {}) => {
  const domain = domainOf(label);
  await store.discover(product, [{ name: `Synthetic ${label}`, domain, url: `https://${domain}/`, claim }]);
  const org = (await row('select id from private.growth_organizations where domain=$1', [domain])).id;
  await admin.query('update private.growth_opportunities set stage=$2,fit=$3 where organization_id=$1', [org, stage, fit]);
  return org;
};
const ours = list => list.filter(item => domains.includes(item.domain));
const match = org => row('select * from private.growth_roster_matches where organization_id=$1', [org]);
const target = n => row('select * from private.growth_roster_targets where ccn=$1', [ccn(n)]);
const reclaim = org => admin.query("update private.growth_roster_matches set status='matching',started_at=now() where organization_id=$1", [org]);

try {
  // ---- 1. The table is closed; only the server's functions reach it ------------------------------------------------------------
  await assert.rejects(pool.query('select * from private.growth_roster_matches'), refused('42501'));

  // ---- 2. The day's prospects: CareMetric Intel, open stages, no roster record, best fit first ------------------------------------
  const best = await prospect('sunrise', { fit: 99 });
  const next = await prospect('lakeshore', { stage: 'identified', fit: 98, claim: 'Hospice care across Northeast Ohio.' });
  const internal = await prospect('internal', { fit: 97 });
  await admin.query('update private.growth_organizations set internal=true where id=$1', [internal]);
  const lost = await prospect('lost', { stage: 'lost', fit: 97 });
  const carebase = await prospect('carebase', { product: 'carebase', fit: 97 });
  const handed = ours(await store.matchNext(25, 200));
  assert.deepEqual(handed.map(item => item.organizationId), [best, next], 'Best fit first; never internal, lost or another product\'s');
  assert.deepEqual(handed[0].evidence, ['Home health in Cleveland, Ohio.']);
  assert.equal((await match(best)).status, 'matching');
  for (const org of [internal, lost, carebase]) assert.equal(await match(org), undefined);
  assert.deepEqual(ours(await store.matchNext(25, 200)), [], 'A prospect being matched is not handed out twice');
  await assert.rejects(store.matchNext(26, 40), refused('22023'));

  // ---- 3. A match is saved as the roster saves an agency, and attached with its public record as evidence ------------------------
  const matched = await store.matchRecord(best, { outcome: 'matched', method: 'phone', period, row: rosterRow(item(1), period, now) });
  assert.deepEqual(matched, { matched: true, ccn: ccn(1) });
  const t1 = await target(1);
  assert.equal(t1.status, 'graduated'); assert.equal(t1.organization_id, best); assert.equal(t1.confirmation, 'phone');
  assert.equal(t1.facts.phone, undefined, 'No telephone number is stored');
  assert.deepEqual([(await match(best)).status, (await match(best)).ccn, (await match(best)).method], ['matched', ccn(1), 'phone']);
  const opp = (await row("select id from private.growth_opportunities where organization_id=$1 and product='caremetric-intel'", [best])).id;
  const evidence = (await admin.query('select * from private.growth_evidence where opportunity_id=$1', [opp])).rows;
  const record = evidence.find(e => e.source_url === 'https://www.caremetricintel.com/data-use' && e.confidence === 'high' && /^CMS Provider of Services file/.test(e.claim));
  assert.ok(record, 'The public record is evidence on the opportunity');
  assert.deepEqual(rosterAgency(evidence), { ccn: ccn(1), setting: 'hha' }, 'The report link reads its CCN');
  assert.ok(await row("select 1 from private.audit_events where action='growth.roster_matched' and entity_id=$1", [best]));
  await assert.rejects(store.matchRecord(best, { outcome: 'unmatched' }), refused('22023'), 'A prospect no longer being matched');
  // Even with its match row gone, an organization with a roster record is never matched again.
  await admin.query('delete from private.growth_roster_matches where organization_id=$1', [best]);
  assert.ok(!ours(await store.matchNext(25, 200)).some(item => item.organizationId === best), 'A prospect with a roster record is never matched again');

  // ---- 4. No match: tried again in 30 days; an unknown reason is stored as not_found ---------------------------------------------
  assert.deepEqual(await store.matchRecord(next, { outcome: 'unmatched', reason: 'ambiguous' }), { matched: false, reason: 'ambiguous' });
  let m = await match(next);
  assert.equal(m.status, 'unmatched'); assert.ok(new Date(m.retry_after) - Date.now() > 29 * 86_400_000);
  await reclaim(next);
  assert.deepEqual(await store.matchRecord(next, { outcome: 'unmatched', reason: 'NOT A CODE' }), { matched: false, reason: 'not_found' });

  // ---- 5. Never a CCN tied to another organization, a closed agency, or an invalid record ---------------------------------------
  await reclaim(next);
  assert.deepEqual(await store.matchRecord(next, { outcome: 'matched', method: 'name_place', period, row: rosterRow(item(1), period, now) }),
    { matched: false, reason: 'other_organization' });
  assert.equal((await target(1)).organization_id, best);
  await reclaim(next);
  assert.deepEqual(await store.matchRecord(next, { outcome: 'matched', method: 'name_place', period, row: rosterRow(item(2, { termination_date: '2020-01-01' }), period, now) }),
    { matched: false, reason: 'excluded' });
  assert.equal((await target(2)).status, 'excluded');
  await reclaim(next);
  await assert.rejects(store.matchRecord(next, { outcome: 'matched', method: 'phone', period: '2099', row: rosterRow(item(3), period, now) }), refused('22023'));
  await assert.rejects(store.matchRecord(next, { outcome: 'matched', method: 'guess', period, row: rosterRow(item(3), period, now) }), refused('22023'));
  assert.equal(await target(3), undefined, 'A refused record saves nothing');

  // ---- 6. One the website or feed could not answer waits an hour; a claim left for an hour is handed out again -------------------
  assert.deepEqual(await store.matchRecord(next, { outcome: 'unmatched', reason: 'retry' }), { matched: false, reason: 'retry' });
  m = await match(next);
  assert.ok(new Date(m.retry_after) - Date.now() < 3_700_000);
  await admin.query("update private.growth_roster_matches set status='matching',started_at=now()-interval '2 hours' where organization_id=$1", [next]);
  const again = ours(await store.matchNext(25, 200));
  assert.deepEqual(again.map(item => item.organizationId), [next]);
  assert.ok((await match(next)).attempts > m.attempts);
  // A website that could not be read waits an hour for its first three attempts, then a month like any other reason.
  await admin.query('update private.growth_roster_matches set attempts=2 where organization_id=$1', [next]);
  assert.deepEqual(await store.matchRecord(next, { outcome: 'unmatched', reason: 'site_unreadable' }), { matched: false, reason: 'site_unreadable' });
  assert.ok(new Date((await match(next)).retry_after) - Date.now() < 3_700_000);
  await reclaim(next);
  await admin.query('update private.growth_roster_matches set attempts=3 where organization_id=$1', [next]);
  await store.matchRecord(next, { outcome: 'unmatched', reason: 'site_unreadable' });
  assert.ok(new Date((await match(next)).retry_after) - Date.now() > 29 * 86_400_000);
  await reclaim(next);
  await store.matchRecord(next, { outcome: 'unmatched', reason: 'not_found' });

  // ---- 7. The daily number ---------------------------------------------------------------------------------------------------
  const third = await prospect('third', { fit: 96 });
  const used = Number((await row('select count(*) n from private.growth_roster_matches where started_at>=private.agent_day_start()')).n);
  assert.deepEqual(await store.matchNext(5, used), [], 'The day\'s number is spent');
  assert.deepEqual(ours(await store.matchNext(5, used + 1)).map(item => item.organizationId), [third]);

  // ---- 8. The gate refuses drift -----------------------------------------------------------------------------------------------
  const client = await admin.connect();
  try {
    for (const drift of [
      'grant select on private.growth_roster_matches to authenticated',
      'grant execute on function private.growth_roster_match_next(integer,integer) to authenticated',
      'revoke execute on function private.growth_roster_match_record(uuid,jsonb) from hub_app_server',
      'alter table private.growth_roster_matches disable row level security',
      "delete from private.hub_settings where key='growth.roster_match_daily'",
      "delete from private.agent_schedules where agent_key='marketing_manager' and task_kind='growth.match'",
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Roster match integration passed: closed table, the day\'s prospects best fit first within the daily number, a match saved and attached as a roster record the report link reads, back-off, no CCN of another organization or closed agency attached, stale claims handed out again, and gate drift. Nothing was fetched or sent.');
} finally {
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    await admin.query('delete from private.growth_roster_matches where organization_id=$1', [org]);
    await admin.query("update private.growth_roster_targets set organization_id=null,status='new' where organization_id=$1", [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query('delete from private.growth_roster_targets where ccn like $1', [`Z${run}%`]);
  await pool.end(); await admin.end();
}
