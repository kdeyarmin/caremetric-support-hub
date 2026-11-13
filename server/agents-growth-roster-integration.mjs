// The Medicare roster through the real roles (20261113170500_growth_roster.sql): pages saved and ranked, the day's best agencies
// handed out within the owner's daily number, a confirmed website graduating into the existing pipeline with the public record as
// high-confidence evidence (observed again on each read), the contact finder's address recorded on it, back-off for agencies that
// could not be resolved, a host that collects agencies refused without a telephone match, the owner's read, and the gate's drift
// checks. Disposable loopback database only; nothing is fetched or sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';
import { rosterRow } from './growth/roster.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool);
const run = randomUUID().slice(0, 8).toUpperCase(), owner = randomUUID(), token = `growth-roster-${randomUUID()}`;
const period = '2099Q4';
const ccn = n => `R${run}${n}`;
const domains = [];
const domainOf = label => { const value = `${label}-${run.toLowerCase()}.example.org`; domains.push(value); return value; };
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261113170600_growth_roster_contract.sql', import.meta.url), 'utf8');
const seedSync = await row('select * from private.growth_roster_sync');
const now = new Date();
const item = (n, extra = {}) => ({ ccn: ccn(n), name: `SYNTHETIC HOSPICE ${n}`, setting: 'hospice', city: 'Pittsburgh', state: 'PA', zip: '15213',
  county_fips: '42003', control_type: 'Proprietary', control_type_code: '4', certification_date: '2010-05-01', termination_date: null,
  change_of_ownership_date: null, signals: [], contact: { address: '1 Main Street', phone: '4125550100' }, ...extra });
const target = n => row('select * from private.growth_roster_targets where ccn=$1', [ccn(n)]);

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `growth-roster-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550973',now())", [owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);

  // ---- 1. The tables are closed; only the server's functions reach them -------------------------------------------------------
  await assert.rejects(pool.query('select * from private.growth_roster_targets'), refused('42501'));
  await assert.rejects(pool.query('select private.growth_roster_evidence($1)', [ccn(1)]), refused('42501'));

  // ---- 2. A page is saved and ranked; the read's place is kept ------------------------------------------------------------------
  const rows = [
    rosterRow(item(1, { change_of_ownership_date: new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10) }), period, now),
    rosterRow(item(2), period, now),
    rosterRow(item(3, { termination_date: '2020-01-01' }), period, now),
    rosterRow(item(4), period, now), rosterRow(item(5), period, now), rosterRow(item(6), period, now),
  ];
  assert.equal(await store.rosterUpsert(period, rows), 6);
  await assert.rejects(store.rosterUpsert('2099', rows), refused('22023'));
  assert.equal((await target(3)).status, 'excluded');
  assert.ok((await target(1)).rank > (await target(2)).rank, 'A recent change of ownership ranks first');
  const saved = await store.rosterSyncSave({ period, states: ['PA'], cursor: '', complete: true, pages: 1, rows: 6, restart: true });
  assert.equal(saved.complete, true); assert.deepEqual(saved.states, ['PA']); assert.equal(saved.rows, 6);
  await assert.rejects(store.rosterSyncSave({ period, states: ['pa'] }), refused('22023'));

  // ---- 3. The day's best agencies, within the daily number; never an excluded one ------------------------------------------------
  const [first] = await store.rosterNext(1, 25);
  assert.equal(first.ccn, ccn(1)); assert.equal(first.facts.phone, '4125550100'); assert.equal((await target(1)).status, 'resolving');
  const used = Number((await row('select count(*) n from private.growth_roster_targets where resolve_started_at>=private.agent_day_start()')).n);
  assert.deepEqual(await store.rosterNext(5, used), [], 'The day\'s number is spent');
  await assert.rejects(store.rosterNext(21, 25), refused('22023'));

  // ---- 4. A confirmed website graduates into the pipeline ----------------------------------------------------------------------
  const site = domainOf('synthetic-hospice-1');
  await assert.rejects(store.rosterResolved(ccn(1), { outcome: 'graduated', domain: site, confirmation: 'phone',
    evidence: [{ url: 'https://elsewhere.example.org/', claim: 'Not its site.' }] }), refused('22023'));
  const graduated = await store.rosterResolved(ccn(1), { outcome: 'graduated', domain: site, confirmation: 'phone',
    evidence: [{ url: `https://${site}/`, claim: "The organization's own home page. Title: Synthetic Hospice 1." }] });
  assert.equal(graduated.graduated, true); assert.equal(graduated.contactReady, true);
  const org = await row('select * from private.growth_organizations where domain=$1', [site]);
  assert.ok(org.discovered_at, 'Stamped as discovered, so the contact finder and qualification apply to it');
  const opp = await row("select * from private.growth_opportunities where organization_id=$1 and product='caremetric-intel'", [org.id]);
  const evidence = (await admin.query('select * from private.growth_evidence where opportunity_id=$1 order by confidence', [opp.id])).rows;
  assert.deepEqual(evidence.map(e => [e.confidence, e.source_url]).sort(), [['high', 'https://www.caremetricintel.com/data-use'], ['medium', `https://${site}/`]]);
  assert.match(evidence.find(e => e.confidence === 'high').claim, new RegExp(`CCN ${ccn(1)}`));
  const t1 = await target(1);
  assert.equal(t1.status, 'graduated'); assert.equal(t1.organization_id, org.id); assert.equal(t1.confirmation, 'phone');
  // The address the finder read on the agency's own site becomes its contact, as for any business found by search.
  const contact = await store.recordContact(org.id, `info@${site}`, `https://${site}/contact`);
  assert.equal(contact.found, true);
  assert.equal((await row('select contact_id from private.growth_opportunities where id=$1', [opp.id])).contact_id, contact.contactId);
  // A second resolution of the same agency is refused: it is no longer being looked up.
  await assert.rejects(store.rosterResolved(ccn(1), { outcome: 'unresolved' }), refused('22023'));

  // ---- 5. The next weekly read keeps it graduated and observes its record again -----------------------------------------------
  await admin.query("update private.growth_evidence set observed_at=now()-interval '20 days' where opportunity_id=$1 and confidence='high'", [opp.id]);
  await store.rosterUpsert(period, [rows[0]]);
  assert.equal((await target(1)).status, 'graduated');
  const refreshed = await row("select observed_at from private.growth_evidence where opportunity_id=$1 and confidence='high'", [opp.id]);
  assert.ok(Date.now() - new Date(refreshed.observed_at).getTime() < 60_000, 'The public record is observed again on each read');

  // ---- 6. Agencies that could not be resolved wait: an hour after a failed search, then a week, a month, a quarter --------------
  await admin.query("update private.growth_roster_targets set resolve_started_at=now()-interval '2 days' where ccn like $1", [`R${run}%`]);
  const [second] = await store.rosterNext(1, 25);
  assert.equal(second.ccn, ccn(2));
  await store.rosterResolved(ccn(2), { outcome: 'unresolved', reason: 'retry' });
  let t2 = await target(2);
  assert.equal(t2.reason, 'retry'); assert.ok(new Date(t2.resolve_after) - Date.now() < 3_700_000);
  await admin.query('update private.growth_roster_targets set resolve_after=now()-interval \'1 minute\' where ccn=$1', [ccn(2)]);
  await admin.query("update private.growth_roster_targets set resolve_started_at=now()-interval '2 days' where ccn like $1", [`R${run}%`]);
  const [again] = await store.rosterNext(1, 25);
  assert.equal(again.ccn, ccn(2));
  await store.rosterResolved(ccn(2), { outcome: 'unresolved', reason: 'NOT A CODE' });
  t2 = await target(2);
  assert.equal(t2.reason, 'no_site'); assert.equal(t2.resolve_attempts, 2);
  assert.ok(new Date(t2.resolve_after) - Date.now() > 29 * 86_400_000, 'The second miss waits a month');

  // ---- 7. A host that already serves three agencies takes another only on a telephone match -----------------------------------
  const chain = domainOf('synthetic-chain');
  for (const n of [4, 5, 6]) {
    await admin.query("update private.growth_roster_targets set status='resolving',resolve_started_at=now() where ccn=$1", [ccn(n)]);
    assert.equal((await store.rosterResolved(ccn(n), { outcome: 'graduated', domain: chain, confirmation: 'phone', evidence: [] })).graduated, true);
  }
  await store.rosterUpsert(period, [rosterRow(item(7), period, now)]);
  await admin.query("update private.growth_roster_targets set status='resolving',resolve_started_at=now() where ccn=$1", [ccn(7)]);
  assert.deepEqual(await store.rosterResolved(ccn(7), { outcome: 'graduated', domain: chain, confirmation: 'name', evidence: [] }), { graduated: false, reason: 'shared_host' });
  assert.equal((await target(7)).status, 'unresolved');

  // ---- 8. The owner's read -----------------------------------------------------------------------------------------------------
  const overview = await withSession(pool, token, async db => (await db.query('select hub.growth_roster(0) as r')).rows[0].r);
  assert.equal(overview.sync.period, period);
  assert.ok(overview.counts.graduated >= 4 && overview.counts.excluded >= 1);
  assert.ok(overview.items.some(i => i.ccn === ccn(1) && i.domain === site));
  await assert.rejects(pool.query('select hub.growth_roster(0)'), error => ['28000', '42501'].includes(error?.code));

  // ---- 9. The gate refuses drift -----------------------------------------------------------------------------------------------
  const client = await admin.connect();
  try {
    for (const drift of [
      'grant select on private.growth_roster_targets to authenticated',
      'grant execute on function private.growth_roster_next(integer,integer) to authenticated',
      'grant execute on function private.growth_roster_evidence(text) to hub_app_server',
      'alter table private.growth_roster_sync disable row level security',
      "delete from private.hub_settings where key='growth.roster_states'",
      'revoke execute on function private.growth_roster_resolved(text,jsonb) from hub_app_server',
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Medicare roster integration passed: closed tables, ranked pages, the day\'s best agencies within the daily number, graduation with public-record evidence observed again on each read, the finder\'s contact recorded, back-off, a shared host refused without a telephone match, the owner\'s read, and gate drift. Nothing was fetched or sent.');
} finally {
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    await admin.query('update private.growth_roster_targets set organization_id=null,status=\'new\' where organization_id=$1', [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query('delete from private.growth_roster_targets where ccn like $1', [`R${run}%`]);
  await admin.query('update private.growth_roster_sync set period=$1,states=$2,cursor=$3,complete=$4,started_at=$5,synced_at=$6,pages=$7,rows=$8',
    [seedSync.period, seedSync.states, seedSync.cursor, seedSync.complete, seedSync.started_at, seedSync.synced_at, seedSync.pages, seedSync.rows]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
