// County snapshots and article links through the real roles (20261113210000_creative_data.sql): counties come from where the roster's
// agencies are, most first, never an excluded one or one pictured in the last eight weeks, within the week's number; a brief carries its
// figure only from a data source and returns it to the drafter; published articles are listed from executed publications still live;
// and the gate refuses drift. Disposable loopback database only.
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
const gate = await readFile(new URL('../supabase/migrations/20261113210100_creative_data_contract.sql', import.meta.url), 'utf8');
const run = randomUUID().slice(0, 6).replace(/[^0-9]/g, '7').padEnd(6, '7');
// Synthetic five-digit codes that no real county uses (90xxx).
const fips = n => `9${String((Number(run.slice(0, 3)) * 3 + n) % 1000).padStart(3, '0')}${n}`.slice(0, 5);
const ccns = [], briefs = [], items = [], actions = [];
const ours = list => list.filter(item => [fips(1), fips(2), fips(3)].includes(item.countyFips));

try {
  // ---- 1. Counties where the roster's agencies are, most first, never an excluded one ---------------------------------------------
  const target = async (n, county, status = 'new') => {
    const ccn = `9${run.slice(0, 5)}${n}`; ccns.push(ccn);
    await admin.query(`insert into private.growth_roster_targets(ccn,name,setting,state,county_fips,period,claim,status) values($1,$2,'hospice','PA',$3,'2026Q3','A Medicare-certified hospice.',$4)`,
      [ccn, `Synthetic ${n}`, county, status]);
  };
  await target(1, fips(1)); await target(2, fips(1)); await target(3, fips(1)); await target(4, fips(2)); await target(5, fips(3), 'excluded');
  const week = new Date(Date.now() - 60_000).toISOString();
  await assert.rejects(admin.query('select private.creative_data_counties(3, now())'), refused('42501'));
  await assert.rejects(server('private.creative_data_counties', [8, week]), refused('22023'));
  const picked = ours(await server('private.creative_data_counties', [7, week]));
  assert.deepEqual(picked.map(item => [item.countyFips, item.agencies]), [[fips(1), 3], [fips(2), 1]]);

  // ---- 2. A brief carries its figure only from a data source, and gives it back to the drafter -------------------------------------
  const facts = { kind: 'county', countyFips: fips(1), stat: '250,000', statLabel: 'people on Medicare in Synthetic County, PA', statSource: 'CMS Medicare Monthly Enrollment, 2026' };
  const brief = { product: 'caremetric-intel', goal: 'Show one public number', audience: 'Owners of home health agencies', platforms: ['meta'], formats: ['static'], source: 'data.county',
    requestKey: `data:county:${fips(1)}:${run}`, facts };
  await assert.rejects(server('private.creative_brief_create', [JSON.stringify({ ...brief, source: 'owner', requestKey: `owner:${run}` })]), refused('22023'));
  const created = await server('private.creative_brief_create', [JSON.stringify(brief)]);
  assert.equal(created.created, true); briefs.push(created.id);
  assert.deepEqual((await server('private.creative_brief_context', [created.id])).brief.facts, facts);
  // ---- 3. A pictured county waits eight weeks, and the week's number counts what was opened since it began -------------------------
  assert.deepEqual(ours(await server('private.creative_data_counties', [7, week])).map(item => item.countyFips), [fips(2)]);
  const opened = Number((await admin.query("select count(*) n from private.creative_briefs where source='data.county' and created_at >= $1", [week])).rows[0].n);
  assert.deepEqual(await server('private.creative_data_counties', [opened, week]), [], 'The week\'s number is spent');

  // ---- 4. Articles from executed publications still live ------------------------------------------------------------------------
  const article = async (slug, { status = 'published', executed = true, title = 'County market basics' } = {}) => {
    const item = (await admin.query("insert into hub.content_items(content_key,kind,status) values($1,'article',$2) returning id", [slug, status])).rows[0].id; items.push(item);
    const action = (await admin.query(`insert into private.agent_actions(agent_key,kind,target_kind,target_id,preview,input,status,executed_at)
      values('content_marketer','content.publish','content_item',$1,'Article.',$2,$3,now()) returning id`,
    [slug, JSON.stringify({ slug, product: 'caremetric-intel', topic: slug, kind: 'marketing', title,
      description: 'A short synthetic guide to reading a county market, used only by this disposable test fixture.', body: 'Synthetic article body. '.repeat(30) }),
    executed ? 'executed' : 'rejected'])).rows[0].id; actions.push(action);
  };
  await article(`synthetic-live-${run}`);
  await article(`synthetic-draft-${run}`, { status: 'draft' });
  await article(`synthetic-rejected-${run}`, { executed: false });
  await assert.rejects(server('private.social_recent_articles', [0]), refused('22023'));
  const listed = (await server('private.social_recent_articles', [45])).filter(item => item.slug.endsWith(run));
  assert.deepEqual(listed, [{ slug: `synthetic-live-${run}`, product: 'caremetric-intel', title: 'County market basics' }]);

  // ---- 5. The gate refuses drift ------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  try {
    for (const drift of [
      'grant execute on function private.creative_data_counties(integer,timestamptz) to authenticated',
      "delete from private.hub_settings where key='social.event_posts'",
      'alter table private.creative_briefs drop constraint creative_briefs_source_check',
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Data creative integration passed: counties from where the roster\'s agencies are (most first, never excluded, not pictured for eight weeks, within the week\'s number), a figure carried only by a data brief and given back to the drafter, published articles from executed publications still live, and gate drift. Nothing was rendered or posted.');
} finally {
  await admin.query('delete from private.creative_briefs where id=any($1::uuid[])', [briefs]);
  await admin.query("delete from private.agent_tasks where kind = 'creative.request' and request_key in (select 'creative:brief:' || unnest($1::uuid[])::text)", [briefs]);
  await admin.query('delete from private.agent_actions where id=any($1::uuid[])', [actions]);
  await admin.query('delete from hub.content_items where id=any($1::uuid[])', [items]);
  await admin.query('delete from private.growth_roster_targets where ccn=any($1::text[])', [ccns]);
  await pool.end(); await admin.end();
}
