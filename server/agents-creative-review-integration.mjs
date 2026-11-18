// Ads and creative upgrades through the real roles (20261116130000_creative_review.sql): the county snapshots picture every county of the
// roster's states (a county with no agency located in it too, from the list the server passes), the least recently pictured first, with
// how many of the roster's home health agencies and hospices are located in each and the setting it was pictured with last; never one
// pictured in the last eight weeks, within the week's number; a malformed list is refused and a malformed entry ignored; only the Hub
// server may ask; the vision review's settings exist; and the gate refuses drift. Disposable loopback database only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const server = async (fn, values) => (await pool.query(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(',')}) as r`, values)).rows[0].r;
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261116130100_creative_review_contract.sql', import.meta.url), 'utf8');
const run = randomUUID().replace(/[^0-9]/g, '').padEnd(6, '7').slice(0, 6);
// Synthetic five-digit codes that no real county uses (9xxxN).
// Five-digit codes that sort in the order of n: the middle part never wraps past 999 (a wrap once in a thousand runs put fips(4) before
// fips(3), and the county order assertions failed).
const fips = n => `9${String((Number(run.slice(0, 3)) * 7) % 990 + n).padStart(3, '0')}${n}`.slice(0, 5);
const ccns = [], briefs = [];
const mine = list => list.filter(item => [fips(1), fips(2), fips(3), fips(4)].includes(item.countyFips));
const shape = list => mine(list).map(item => [item.countyFips, item.agencies, item.homeHealth, item.hospice, item.lastSetting]);

try {
  assert.deepEqual((await admin.query("select key, kind from private.hub_settings where key in ('creative.vision_review','creative.vision_min_score') order by key")).rows,
    [{ key: 'creative.vision_min_score', kind: 'number' }, { key: 'creative.vision_review', kind: 'flag' }]);

  // ---- 1. Every county of the list, the roster's counts by setting, a county with no agency in it too -------------------------------
  const target = async (n, county, setting, status = 'new') => {
    const ccn = `8${run.slice(0, 5)}${n}`; ccns.push(ccn);
    await admin.query(`insert into private.growth_roster_targets(ccn,name,setting,state,county_fips,period,claim,status) values($1,$2,$3,'PA',$4,'2026Q3','A Medicare-certified agency.',$5)`,
      [ccn, `Synthetic ${n}`, setting, county, status]);
  };
  await target(1, fips(1), 'home_health'); await target(2, fips(1), 'home_health'); await target(3, fips(1), 'hospice');
  await target(4, fips(2), 'hospice'); await target(5, fips(4), 'home_health', 'excluded');
  const list = [{ countyFips: fips(1), state: 'PA' }, { countyFips: fips(2), state: 'PA' }, { countyFips: fips(3), state: 'PA' }, { countyFips: fips(4), state: 'PA' },
    { countyFips: '123', state: 'PA' }, { countyFips: fips(3), state: 'Pennsylvania' }, 'not a county'];
  const week = new Date(Date.now() - 60_000).toISOString();
  const pick = counties => server('private.creative_data_counties', [7, week, counties === null ? null : JSON.stringify(counties)]);
  // The roster's own counties first by how many agencies, then the counties only the list names; an excluded agency counts for nothing.
  assert.deepEqual(shape(await pick(list)), [[fips(1), 3, 2, 1, null], [fips(2), 1, 0, 1, null], [fips(3), 0, 0, 0, null], [fips(4), 0, 0, 0, null]]);
  // Without the list, the roster's own counties, as the older choice gave.
  assert.deepEqual(shape(await pick(null)), [[fips(1), 3, 2, 1, null], [fips(2), 1, 0, 1, null]]);
  await assert.rejects(admin.query('select private.creative_data_counties(3, now(), null)'), refused('42501'));
  await assert.rejects(server('private.creative_data_counties', [8, week, null]), refused('22023'));
  await assert.rejects(server('private.creative_data_counties', [3, week, JSON.stringify({ countyFips: fips(1) })]), refused('22023'));

  // ---- 2. The least recently pictured first, with the setting it showed; a county pictured in the last eight weeks waits ------------
  const brief = async (n, county, setting, daysAgo) => {
    const created = await server('private.creative_brief_create', [JSON.stringify({ product: 'caremetric-intel', goal: 'Show one public number', audience: 'Owners of home health agencies',
      platforms: ['meta'], formats: ['static'], source: 'data.county', requestKey: `data:county:${county}:${run}:${n}`,
      facts: { kind: 'county', setting, countyFips: county, stat: '12', statLabel: 'home health agencies billed Medicare for Synthetic County, PA residents', statSource: 'CMS, 2024' } })]);
    assert.equal(created.created, true); briefs.push(created.id);
    if (daysAgo) await admin.query("update private.creative_briefs set created_at = now() - make_interval(days => $2) where id = $1", [created.id, daysAgo]);
  };
  await brief(1, fips(1), 'home_health', 60);
  assert.deepEqual(shape(await pick(list)), [[fips(2), 1, 0, 1, null], [fips(3), 0, 0, 0, null], [fips(4), 0, 0, 0, null], [fips(1), 3, 2, 1, 'home_health']]);
  await brief(2, fips(2), 'hospice', 0);
  assert.deepEqual(shape(await pick(list)).map(([county]) => county), [fips(3), fips(4), fips(1)], 'A county pictured this week waits eight weeks');
  // The week's number counts the snapshots opened since it began.
  const opened = Number((await admin.query("select count(*) n from private.creative_briefs where source='data.county' and created_at >= $1", [week])).rows[0].n);
  assert.deepEqual(await server('private.creative_data_counties', [opened, week, JSON.stringify(list)]), [], 'The week\'s number is spent');

  // ---- 3. The gate refuses drift --------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    await client.query('begin'); await client.query(gate); await client.query(gate); await client.query('rollback');
    for (const drift of [
      "delete from private.hub_settings where key='creative.vision_review'",
      "delete from private.hub_settings where key='creative.vision_min_score'",
      'grant execute on function private.creative_data_counties(integer,timestamptz,jsonb) to authenticated',
      'drop function private.creative_data_counties(integer,timestamptz,jsonb)',
      rewrite('private.creative_data_counties(integer,timestamptz,jsonb)', "interval '56 days'", "interval '1 day'"),
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Creative review integration passed: every county of the roster\'s states (the list\'s too), least recently pictured first with its roster counts by setting and the setting it last showed, eight weeks\' rest, the week\'s number, malformed input refused or ignored, only the Hub server asks, the vision review settings, and gate drift. Nothing was rendered or posted.');
} finally {
  await admin.query('delete from private.creative_briefs where id=any($1::uuid[])', [briefs]);
  await admin.query("delete from private.agent_tasks where kind = 'creative.request' and request_key in (select 'creative:brief:' || unnest($1::uuid[])::text)", [briefs]);
  await admin.query('delete from private.growth_roster_targets where ccn=any($1::text[])', [ccns]);
  await pool.end(); await admin.end();
}
