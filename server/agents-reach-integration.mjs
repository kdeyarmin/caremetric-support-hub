// Stage 6 of the 2026-11-17 team review through the real roles (20261117250000_reach.sql): an interested or pricing comment is recorded
// once, with no words from it, and only by the Hub server; website leads are counted per post by its own utm_content, leaving out tests,
// replies and paid ads; a paused campaign with no ad no longer takes the month's flight, while one held back by the month's number still
// does; images with a warning about to lapse are listed; the roster's counties are counted without excluded agencies; and the gate is
// idempotent and refuses drift. Disposable loopback database only; nothing leaves the machine.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { sqlAgentStore } from './agents/store.mjs';
import { takesFlight } from './agents/ads/index.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = sqlAgentStore(pool, { fenced: true, social: true, creative: true, ads: true, workRecovery: true, reach: true });
const run = randomUUID().replaceAll('-', '').slice(0, 8);
const RUN = run.toUpperCase();
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261117250100_reach_contract.sql', import.meta.url), 'utf8');
const actions = [], leads = [], items = [], ccns = [];
let brief = null;
// A month and two counties no other fixture uses.
const seed = parseInt(run.slice(0, 6), 16);
const month = `${2040 + (seed % 50)}-${String(1 + (seed % 12)).padStart(2, '0')}`;
const fipsA = `9${String(seed % 10000).padStart(4, '0')}`;
const fipsB = `8${String(seed % 10000).padStart(4, '0')}`;
const action = async (values, sql = "insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, input, status, result, expires_at) values ($1, $2, $3, $4, 'x', $5, $6, $7, coalesce($8::timestamptz, now() + interval '7 days')) returning id") => {
  const id = (await row(sql, values)).id; actions.push(id); return id;
};

try {
  // 1. Interest: once, by the server only, never the person's words.
  const item = `1_${seed}`;
  items.push(item);
  assert.equal(await store.socialInterestRecord({ platform: 'facebook', itemId: item, url: `https://facebook.com/c/${seed}`, product: 'caremetric-intel', intent: 'pricing', ad: true }), true);
  assert.equal(await store.socialInterestRecord({ platform: 'facebook', itemId: item, url: `https://facebook.com/c/${seed}`, product: 'caremetric-intel', intent: 'pricing', ad: true }), false, 'recorded once');
  await assert.rejects(store.socialInterestRecord({ platform: 'facebook', itemId: `${item}9`, intent: 'complaint' }), refused('22023'), 'only interest or a price question');
  assert.deepEqual(Object.keys(await row('select * from private.social_interest where item_id = $1', [item])).sort(), ['ad', 'created_at', 'id', 'intent', 'item_id', 'platform', 'product', 'url']);
  await assert.rejects(pool.query('select * from private.social_interest'), refused('42501'), 'the server reads interest only through its functions');
  const client = await admin.connect();
  try {
    await client.query('begin'); await client.query('set local role authenticated');
    await assert.rejects(client.query("select private.social_interest_record('facebook', 'x', null, null, 'interested', false)"), refused('42501'), 'a signed-in person cannot record interest');
  } finally { await client.query('rollback'); client.release(); }

  // 2. Website leads per post, by each post's own utm_content.
  const content = `post-${run}-facebook-1`;
  await action(['social_manager', 'social.post', 'social_post', `facebook:${run}:1`, { platform: 'facebook', product: 'carebase', pillar: 'tip', message: 'Training hours piling up?\nKeep them in one place.', utmContent: content }, 'executed', null, null]);
  for (const [n, test, medium, tag] of [[1, false, 'social', content], [2, false, 'social', content], [3, true, 'social', content], [4, false, 'social', 'reply'], [5, false, 'paid', content]]) {
    leads.push((await row(`insert into private.leads(kind, source, external_id, status, test, occurred_at, received_at, contact_email, utm_source, utm_medium, utm_content)
      values ('contact', 'carebase', $1, 'new', $2, now(), now(), $3, 'facebook', $4, $5) returning id`, [`reach-${run}-${n}`, test, `reach-${run}-${n}@home.example`, medium, tag])).id);
  }
  const reached = await store.socialPostLeads(new Date(Date.now() - 86_400_000).toISOString());
  assert.deepEqual(reached.posts.find(post => post.content === content), { content, leads: 2, platform: 'facebook', product: 'carebase', pillar: 'tip', firstLine: 'Training hours piling up?', creativeAssetId: null });
  assert.ok(reached.interested >= 1 && reached.interestedOnAds >= 1, 'and the comments read as interest');
  await assert.rejects(store.socialPostLeads(new Date(Date.now() - 200 * 86_400_000).toISOString()), refused('22023'), 'at most 120 days back');

  // 3. The month's flight: a campaign with no ad because no creative fit does not take it; one held back by the month's number does.
  const campaign = (platform, product, result) => action(['social_manager', 'social.campaign_create', 'social_item', `${platform}:${product}:${month}`, { platform, flightDays: 7 }, 'executed', result, null]);
  await campaign('meta', 'caremetric-intel', { created: true, launched: false, reason: 'no_approved_creative' });
  await campaign('linkedin', 'caremetric-intel', { created: true, launched: false, reason: 'monthly_budget_used' });
  await campaign('meta', 'carebase', { created: true, launched: true, adId: '603' });
  const history = await store.adsMonthCampaigns(month);
  assert.deepEqual(history.map(item => [item.targetId.split(':').slice(0, 2).join(':'), item.empty, takesFlight(item)]),
    [['meta:caremetric-intel', true, false], ['linkedin:caremetric-intel', false, true], ['meta:carebase', false, true]]);

  // 4. Images with a warning about to lapse.
  brief = (await row(`insert into private.creative_briefs(product, goal, audience, platforms, formats, source, request_key)
    values ('caremetric-intel', 'Drive reports', 'Agency owners', array['meta'], array['static'], 'owner', $1) returning id`, [`reach-${run}`])).id;
  const assets = [randomUUID(), randomUUID(), randomUUID()];
  const expiring = [['warn', '20 hours'], ['pass', '20 hours'], ['warn', '5 days']];
  for (const [index, [verdict, left]] of expiring.entries()) {
    const id = await action(['creative_director', 'creative.asset', 'creative_asset', assets[index], {}, 'proposed', null],
      `insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, input, status, result, expires_at) values ($1, $2, $3, $4, 'x', $5, $6, $7, now() + interval '${left}') returning id`);
    await admin.query(`insert into private.creative_assets(id, brief_id, product, platform, placement, kind, layout, width, height, variant_label, hook_type, headline, status, compliance, action_id)
      values ($1, $2, 'caremetric-intel', 'meta', 'meta.feed_square', 'static', 'headline', 1080, 1080, $3, 'proof', 'Where does your agency rank?', 'proposed', $4, $5)`,
    [assets[index], brief, `V${index}`, { verdict }, id]);
  }
  const lapsing = (await store.creativeExpiringWarnings(48)).filter(item => assets.includes(item.assetId));
  assert.deepEqual(lapsing.map(item => [item.assetId, item.placement, item.headline]), [[assets[0], 'meta.feed_square', 'Where does your agency rank?']]);

  // 5. The roster's counties, without excluded agencies.
  for (const [n, fips, status] of [[1, fipsA, 'new'], [2, fipsA, 'unresolved'], [3, fipsB, 'new'], [4, fipsB, 'excluded'], [5, fipsB, 'excluded']]) {
    const ccn = `R${RUN.slice(0, 6)}${n}`;
    ccns.push(ccn);
    await admin.query(`insert into private.growth_roster_targets(ccn, name, setting, city, state, county_fips, period, claim, rank, status)
      values ($1, $2, 'home_health', 'Lancaster', 'PA', $3, '2026Q3', 'CMS record.', 50, $4)`, [ccn, `Reach ${run} ${n} Home Health`, fips, status]);
  }
  const counties = (await store.contentRosterCounties(100)).filter(item => [fipsA, fipsB].includes(item.countyFips));
  assert.deepEqual(counties, [{ countyFips: fipsA, state: 'PA', agencies: 2 }, { countyFips: fipsB, state: 'PA', agencies: 1 }]);

  // 6. The gate: idempotent, and it refuses drift.
  const gateClient = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    await gateClient.query('begin'); await gateClient.query(gate); await gateClient.query(gate); await gateClient.query('rollback');
    const drifts = [
      'alter table private.social_interest disable row level security',
      'grant select on private.social_interest to hub_app_server',
      'grant execute on function private.social_post_leads(timestamptz) to authenticated',
      'revoke execute on function private.content_roster_counties(integer) from hub_app_server',
      rewrite('private.creative_expiring_warnings(integer)', 'perform private.require_hub_app_server();', 'perform 1;'),
      rewrite('private.ads_month_campaigns(text)', "'empty'", "'nothing'"),
      "delete from private.hub_settings where key = 'social.ad_comments'",
    ];
    for (const drift of drifts) {
      await gateClient.query('begin');
      try {
        await gateClient.query(drift);
        await assert.rejects(gateClient.query(gate), refused('55000'), `the gate refuses: ${drift.slice(0, 90)}`);
      } finally { await gateClient.query('rollback'); }
    }
    console.log(`Reach integration passed: interest recorded once by the server only, with no words from the comment; leads per post by utm_content without tests, replies or paid ads; an empty campaign leaves the month's flight free while a budget-held one keeps it; only warned images about to lapse are listed; roster counties without excluded agencies; and ${drifts.length} kinds of gate drift. Nothing left the machine.`);
  } finally { gateClient.release(); }
} finally {
  await admin.query('delete from private.social_interest where item_id = any($1::text[])', [items]);
  await admin.query('delete from private.leads where id = any($1::uuid[])', [leads]);
  await admin.query('delete from private.creative_assets where brief_id = $1', [brief]);
  await admin.query('delete from private.creative_briefs where id = $1', [brief]);
  await admin.query("delete from private.audit_events where entity_type = 'agent_action' and entity_id = any($1::uuid[])", [actions]);
  await admin.query('delete from private.agent_actions where id = any($1::uuid[])', [actions]);
  await admin.query('delete from private.growth_roster_targets where ccn = any($1::text[])', [ccns]);
  await pool.end(); await admin.end();
}
