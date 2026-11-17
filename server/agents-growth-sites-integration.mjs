// A web search for roster agencies not found, through the real roles (20261117200000_growth_reach.sql, stage 3 of the 2026-11-17 review):
// only agencies the lookups left unresolved (no site, or a site not confirmed) are handed out, within the day's number and once an hour;
// a site the code confirms graduates the agency through the roster's own path with its contact recorded; a site it cannot confirm is
// kept only as a suggestion; a lookup that took the agency meanwhile wins; and an agency searched is not searched again for 30 days.
// The model and the contact finder are stand-ins. Disposable loopback database only; nothing is fetched, searched or sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { growthStore } from './growth/store.mjs';
import { growthReachFeature } from './growth/reach.mjs';
import { siteSearchHandlers } from './growth/site-search.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool);
const run = randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase();
const period = '2099Q3';
const ccn = n => `W${run}${n}`;
const domainOf = label => `${label}-${run.toLowerCase()}.example.org`;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const seedSync = await row('select * from private.growth_roster_sync');
const target = n => row('select * from private.growth_roster_targets where ccn=$1', [ccn(n)]);
const domains = [domainOf('confirmed'), domainOf('elsewhere'), domainOf('taken')];
const phone = '4125550199';

// Stand-ins: the model names the agency's site by its CCN; the contact finder confirms only the "confirmed" site by its telephone number.
const answers = { 1: `https://www.${domainOf('confirmed')}\nhttps://www.yelp.com/biz/synthetic`, 2: `https://${domainOf('elsewhere')}`, 3: `https://${domainOf('taken')}` };
const model = { configured: true, research: async (_task, request) => {
  const name = JSON.parse(request.user).agency.name;
  const n = Number(name.match(/AGENCY (\d)/)?.[1]);
  return { outcome: 'completed', text: answers[n] ?? 'none', sources: [], searches: 1, fetches: 0, costCents: 4 };
} };
const contacts = { configured: true, find: async domain => (domain === domainOf('confirmed')
  ? { phoneSeen: true, site: { url: `https://${domain}/`, claim: `Synthetic Agency 1 serves Erie, PA.` }, email: null, sourceUrl: null }
  : { phoneSeen: false, site: { url: `https://${domain}/`, claim: 'Another home health agency in Austin, Texas.' } }) };
const settings = { enabled: () => true, perDay: () => 3, cents: () => 10 };
const handlers = siteSearchHandlers({ growth: { store, contacts, roster: { siteResearch: settings } }, model,
  features: new Set([growthReachFeature]), marketed: ['caremetric-intel'] });
const task = { id: randomUUID(), agentKey: 'marketing_manager', agent: { autonomy: 'act' } };
let earlier = [];

try {
  // ---- Access ------------------------------------------------------------------------------------------------------------------------
  for (const fn of ['private.growth_roster_site_next(integer,integer)', 'private.growth_roster_site_record(text,jsonb)']) {
    assert.equal((await row('select has_function_privilege($1,$2,\'execute\') as ok', ['hub_app_server', fn])).ok, true, `the server runs ${fn}`);
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await row('select has_function_privilege($1,$2,\'execute\') as ok', [role, fn])).ok, false, `${role} never runs ${fn}`);
  }
  await assert.rejects(admin.query('select private.growth_roster_site_next(1,1)'), refused('42501'), 'only the Hub server\'s session hands searches out');
  await assert.rejects(store.rosterSiteNext(11, 1), refused('22023'));
  await assert.rejects(store.rosterSiteRecord(ccn(9), { outcome: 'unresolved', suggestions: [] }), refused('22023'), 'an agency never handed out is not recorded');

  // ---- Fixtures: the roster's current read, three agencies not found, one waiting and one in the pipeline ------------------------------
  await admin.query('update private.growth_roster_sync set period=$1,states=$2', [period, ['PA']]);
  const insert = (n, status, reason, rank) => admin.query(`insert into private.growth_roster_targets (ccn, name, setting, city, state, period, facts, claim, rank, status, reason)
    values ($1, $2, 'home_health', 'Erie', 'PA', $3, $4::jsonb, 'CMS Provider of Services file: a synthetic Medicare-certified home health agency.', $5, $6, $7)`,
  [ccn(n), `SYNTHETIC AGENCY ${n}`, period, JSON.stringify({ phone }), rank, status, reason]);
  await insert(1, 'unresolved', 'no_site', 90);
  await insert(2, 'unresolved', 'not_confirmed', 80);
  await insert(3, 'unresolved', 'no_site', 70);
  await insert(4, 'unresolved', 'no_site', 60);
  await insert(5, 'new', null, 99);
  await admin.query('update private.growth_roster_targets set site_search_started_at = null, site_searched_at = null where ccn like $1', [`W${run}%`]);
  // Today's number is counted across the database: this run's searches are its own if the day started clean.
  earlier = (await admin.query('select ccn, site_search_started_at from private.growth_roster_targets where site_search_started_at >= private.agent_day_start() and ccn not like $1', [`W${run}%`])).rows;
  await admin.query("update private.growth_roster_targets set site_search_started_at = site_search_started_at - interval '2 days' where ccn = any($1::text[])", [earlier.map(r => r.ccn)]);

  // ---- A lookup takes agency 3 meanwhile: its web search's site does not win -------------------------------------------------------------
  const first = await handlers['growth.sites'](task);
  assert.equal(first.result.searched, 2, 'two agencies a run');
  const one = await target(1);
  assert.equal(one.status, 'graduated', 'a site the code confirmed graduates the agency');
  assert.equal(one.confirmation, 'phone');
  assert.equal((await row('select domain from private.growth_organizations where id=$1', [one.organization_id])).domain, domainOf('confirmed'));
  assert.ok(one.site_searched_at, 'the search is recorded');
  assert.ok((await row('select count(*)::int as n from private.growth_opportunities where organization_id=$1 and product=\'caremetric-intel\'', [one.organization_id])).n === 1,
    'the agency is in the pipeline as an Intel opportunity');
  const two = await target(2);
  assert.deepEqual([two.status, two.reason, two.site_suggestions], ['unresolved', 'not_confirmed', [domainOf('elsewhere')]], 'an unconfirmed site is only a suggestion');
  assert.equal((await row('select count(*)::int as n from private.growth_organizations where domain=$1', [domainOf('elsewhere')])).n, 0, 'no organization is made for a suggestion');

  const [three] = await store.rosterSiteNext(1, 3);
  assert.equal(three.ccn, ccn(3), 'the third search of the day is handed out');
  // A lookup claims it while the search runs.
  await admin.query("update private.growth_roster_targets set status='resolving', resolve_started_at=now() where ccn=$1", [ccn(3)]);
  assert.deepEqual(await store.rosterSiteRecord(ccn(3), { outcome: 'graduated', domain: domainOf('taken'), confirmation: 'phone', evidence: [] }),
    { graduated: false, reason: 'changed' }, 'a lookup that took the agency wins');
  assert.equal((await target(3)).status, 'resolving');

  // ---- The day's number and the 30 days -----------------------------------------------------------------------------------------------
  assert.deepEqual(await store.rosterSiteNext(5, 3), [], 'three a day means three');
  const later = await handlers['growth.sites'](task);
  assert.equal(later.result.searched, 0, 'the next run searches nothing more today');
  await admin.query("update private.growth_roster_targets set site_search_started_at = site_search_started_at - interval '2 days' where ccn like $1", [`W${run}%`]);
  const next = (await store.rosterSiteNext(5, 3)).map(t => t.ccn);
  assert.deepEqual(next, [ccn(4)], 'tomorrow: an agency searched in the last 30 days, a waiting one and one in the pipeline are never handed out');
  await store.rosterSiteRecord(ccn(4), { outcome: 'unresolved', suggestions: [] });
  await assert.rejects(store.rosterSiteRecord(ccn(4), { outcome: 'unresolved', suggestions: ['a', 'b', 'c'] }), refused('22023'));
  await admin.query("update private.growth_roster_targets set site_searched_at = now() - interval '31 days' where ccn=$1", [ccn(2)]);
  assert.deepEqual((await store.rosterSiteNext(5, 10)).map(t => t.ccn), [ccn(2)], 'after 30 days an agency not found is searched again');

  console.log('Roster website search integration passed: only agencies not found are handed out, two a run within the day\'s number and once an hour; a confirmed site graduates through the roster\'s own path into the pipeline; an unconfirmed one is only a suggestion; a lookup that took the agency wins; and an agency searched waits 30 days. No search was made, no site read and nothing sent.');
} finally {
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    await admin.query('update private.growth_roster_targets set organization_id=null,status=\'new\' where organization_id=$1', [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.customer_success_plans where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query("delete from private.audit_events where action = 'growth.roster_site_searched' and metadata ->> 'ccn' like $1", [`W${run}%`]);
  await admin.query('delete from private.growth_roster_targets where ccn like $1', [`W${run}%`]);
  for (const { ccn: other, site_search_started_at: at } of earlier) await admin.query('update private.growth_roster_targets set site_search_started_at=$2 where ccn=$1', [other, at]);
  await admin.query('update private.growth_roster_sync set period=$1,states=$2,cursor=$3,complete=$4,started_at=$5,synced_at=$6,pages=$7,rows=$8',
    [seedSync.period, seedSync.states, seedSync.cursor, seedSync.complete, seedSync.started_at, seedSync.synced_at, seedSync.pages, seedSync.rows]);
  await pool.end(); await admin.end();
}
