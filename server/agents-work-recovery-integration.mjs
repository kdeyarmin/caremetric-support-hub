// Work recovery through the real roles (20261117180000_work_recovery.sql, AI workforce review 2026-11-17): a county whose snapshot was
// blocked frees itself after a week and gives the week its room back; images blocked only by the first image review or by the render's
// reading of a snapshot's own figure are rendered once more, no other; the ad platforms' refusals and reconnects are read back; the
// bounce guard trips on two hard bounces in ten cold emails; a mail server's confirmation is recorded with the address; intent follows
// each event; a trial from a CareMetric address is internal and one from an agency is not; the watchdog reads what was lost; only the
// Hub server may ask; and the gate refuses drift. Disposable loopback database only; nothing is rendered, posted or sent.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const server = async (fn, values = []) => (await pool.query(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(',')}) as r`, values)).rows[0].r;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const gate = await readFile(new URL('../supabase/migrations/20261117180100_work_recovery_contract.sql', import.meta.url), 'utf8');
const run = randomUUID().replace(/[^0-9]/g, '').padEnd(6, '3').slice(0, 6);
const tag = randomUUID().slice(0, 8);
// Synthetic five-digit county codes no real county uses (9xxxN).
const fips = n => `9${String((Number(run.slice(0, 3)) * 11 + n) % 1000).padStart(3, '0')}${n}`.slice(0, 5);
const briefs = [], assets = [], tasks = [], actions = [], orgs = [], tenants = [], ccns = [];
const seedSettings = (await admin.query("select key,value,changed_at,changed_by from private.hub_settings where key in ('growth.bounce_guard_percent','agents.owner_email')")).rows;
const seedGuard = await row('select resumed_at,resumed_by,tripped_at from private.growth_send_guard where id');
const runStart = (await row('select now() as t')).t;

const brief = async (n, county, { daysAgo = 0, status = 'open' } = {}) => {
  const created = await server('private.creative_brief_create', [JSON.stringify({ product: 'caremetric-intel', goal: 'Show one public number', audience: 'Owners of home health agencies',
    platforms: ['meta'], formats: ['static'], source: 'data.county', requestKey: `data:county:${county}:${tag}:${n}`,
    facts: { kind: 'county', setting: 'home_health', countyFips: county, stat: '61%', statLabel: 'of the Medicare patients of Synthetic County, PA home health agencies went to the 3 largest', statSource: 'CMS, 2024' } })]);
  assert.equal(created.created, true); briefs.push(created.id);
  await admin.query('update private.creative_briefs set created_at = now() - make_interval(secs => $2), status = $3 where id = $1', [created.id, daysAgo * 86400 + 30, status]);
  return created.id;
};
const asset = async (briefId, { layout = 'stat', status = 'blocked', compliance = {}, rendered = true } = {}) => {
  const id = (await row(`insert into private.creative_assets (brief_id, product, platform, placement, kind, layout, width, height, variant_label, hook_type, status, compliance, rendered_at, render_attempts)
    values ($1, 'caremetric-intel', 'meta', 'meta.feed_square', 'static', $2, 1080, 1080, $6, 'curiosity', $3, $4::jsonb, case when $5 then now() end, 2) returning id`,
  [briefId, layout, status, JSON.stringify(compliance), rendered, `V${assets.length + 1}`])).id;
  assets.push(id); return id;
};
const blockedBy = (rule, extra = {}) => ({ verdict: 'block', version: 'creative-compliance.2', reasons: [{ rule, level: 'block', message: 'Synthetic.' }], ...extra });
const setting = (key, value) => admin.query('update private.hub_settings set value=$2, changed_at=now() where key=$1', [key, value === null ? null : JSON.stringify(value)]);

try {
  // ---- 1. A county counts as pictured only while its snapshot pictures it -------------------------------------------------------------
  const list = [{ countyFips: fips(1), state: 'PA' }, { countyFips: fips(2), state: 'PA' }, { countyFips: fips(3), state: 'PA' }];
  const week = new Date(Date.now() - 10 * 60_000).toISOString();
  const pick = async (perWeek = 7) => (await server('private.creative_data_counties', [perWeek, week, JSON.stringify(list)])).map(item => item.countyFips)
    .filter(county => list.some(item => item.countyFips === county));
  // fips(1): a snapshot whose every image was blocked, nine days ago: the county is free again. fips(2): blocked today: it waits a week.
  // fips(3): a snapshot still in the works: it rests eight weeks, as before.
  await asset(await brief(1, fips(1), { daysAgo: 9, status: 'done' }), { compliance: blockedBy('fact_sheet') });
  await asset(await brief(2, fips(2), { status: 'done' }), { compliance: blockedBy('fact_sheet') });
  await brief(3, fips(3));
  assert.deepEqual(await pick(), [fips(1)], 'a blocked snapshot frees its county after a week; a fresh one waits; one in the works rests');
  // The blocked one this week gives the week its room back (one of one still free), up to twice the week's number opened.
  const openedThisWeek = Number((await row("select count(*) n from private.creative_briefs where source='data.county' and created_at >= $1", [week])).n);
  const picturedThisWeek = Number((await row("select count(*) n from private.creative_briefs b where source='data.county' and created_at >= $1 and private.creative_brief_pictured(b.id)", [week])).n);
  assert.deepEqual([openedThisWeek, picturedThisWeek], [2, 1]);
  assert.deepEqual(await pick(2), [fips(1)], 'the blocked snapshot gives its room back');
  assert.deepEqual(await pick(1), [], 'two opened this week fill twice a week\'s number of one');

  // ---- 2. Images blocked only by checks this release corrects are rendered again once ------------------------------------------------
  const ordinary = await brief(4, fips(4), { daysAgo: 70, status: 'done' });
  const vision = await asset(ordinary, { layout: 'headline', compliance: blockedBy('vision_defect', { review: { version: 'creative-vision.1', score: 2 } }) });
  const visionAndContrast = await asset(ordinary, { layout: 'headline', compliance: { ...blockedBy('vision_defect', { review: { version: 'creative-vision.1' } }),
    reasons: [{ rule: 'vision_defect', level: 'block', message: 'x' }, { rule: 'contrast', level: 'block', message: 'y' }] } });
  const reviewedAgain = await asset(ordinary, { layout: 'headline', compliance: blockedBy('vision_defect', { review: { version: 'creative-vision.2' } }) });
  const snapshot = await asset(briefs[0], { compliance: blockedBy('fact_sheet') });
  const drafted = await asset(briefs[0], { compliance: blockedBy('data_number'), rendered: false });
  const statusOf = async id => (await row('select status, render_attempts from private.creative_assets where id=$1', [id]));
  assert.ok(await server('private.creative_render_requeue', [false]) >= 1);
  assert.deepEqual(await statusOf(snapshot), { status: 'draft', render_attempts: 0 }, 'a snapshot blocked at render on its own figure is queued again');
  assert.equal((await statusOf(vision)).status, 'blocked', 'with the review off, a vision block stays: nothing passes unseen');
  assert.ok(await server('private.creative_render_requeue', [true]) >= 1);
  assert.deepEqual(await statusOf(vision), { status: 'draft', render_attempts: 0 }, 'with the review on, a first-review block is queued again');
  for (const [id, why] of [[visionAndContrast, 'another check blocked it too'], [reviewedAgain, 'the new review blocked it'], [drafted, 'blocked when drafted, never rendered']]) {
    assert.equal((await statusOf(id)).status, 'blocked', why);
  }
  for (const id of [vision, snapshot]) await admin.query("update private.creative_assets set status='blocked' where id=$1", [id]);
  await admin.query("update private.creative_assets set compliance = jsonb_set(jsonb_set(compliance, '{version}', '\"creative-compliance.3\"'), '{review,version}', '\"creative-vision.2\"', true) where id = any($1::uuid[])", [[vision, snapshot]]);
  assert.equal(await server('private.creative_render_requeue', [true]) >= 0, true);
  assert.deepEqual([(await statusOf(vision)).status, (await statusOf(snapshot)).status], ['blocked', 'blocked'], 'blocked again under the new versions: never queued twice');
  assert.ok((await row("select count(*) n from private.audit_events where action='creative.requeued' and created_at >= $1", [runStart])).n > 0);

  // ---- 3. The ad platforms' refusals, and their reconnects ----------------------------------------------------------------------------
  const plan = (await row("insert into private.agent_tasks (agent_key, kind, request_key, status, claimed_at, lease_until, attempts) values ('social_manager', 'ads.plan', $1, 'running', now(), now() + interval '10 minutes', 1) returning id", [`work-recovery-${tag}-plan`])).id;
  tasks.push(plan);
  const review = (await row("insert into private.agent_tasks (agent_key, kind, request_key, status, attempts, finished_at, result) values ('social_manager', 'social.ads', $1, 'done', 1, now(), $2::jsonb) returning id",
    [`work-recovery-${tag}-ads`, JSON.stringify({ adsets: 0, refusedBy: { meta: 'meta_token_invalid' } })])).id;
  tasks.push(review);
  const month = `2099-${String(1 + (Number(run) % 12)).padStart(2, '0')}`;
  actions.push((await row(`insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview, input, status, result)
    values ($1, 'social_manager', 'social.campaign_create', 'social_item', $2, 'Synthetic campaign', '{"dailyBudgetCents":1000,"flightDays":5}'::jsonb, 'failed', '{"error":"linkedin_permission"}'::jsonb) returning id`,
  [plan, `linkedin:caremetric-intel:${month}`])).id);
  let answer = await server('private.ads_platform_refusals');
  assert.ok(answer.refusals.some(item => item.platform === 'linkedin' && item.code === 'linkedin_permission'), 'a campaign LinkedIn refused');
  assert.ok(answer.refusals.some(item => item.platform === 'meta' && item.code === 'meta_token_invalid'), 'the daily ad review\'s refusal by platform');
  await admin.query("insert into private.audit_events (action, entity_type, metadata) values ('hub.social_connection', 'settings', '{\"provider\":\"linkedin\"}'::jsonb)");
  answer = await server('private.ads_platform_refusals');
  assert.ok(Date.parse(answer.reconnected.linkedin) >= Date.parse(answer.refusals.find(item => item.platform === 'linkedin').at), 'reconnected since');
  await assert.rejects(admin.query('select private.ads_platform_refusals()'), refused('42501'), 'only the Hub server reads the refusals');

  // ---- 4. The bounce guard trips on two hard bounces in ten ------------------------------------------------------------------------
  const org = (await row("insert into private.growth_organizations (name, domain) values ('Synthetic guard agency', $1) returning id", [`guard-${tag}.example.org`])).id;
  orgs.push(org);
  const opportunity = (await row("insert into private.growth_opportunities (organization_id, product, stage) values ($1, 'caremetric-intel', 'contacted') returning id", [org])).id;
  await setting('growth.bounce_guard_percent', 5);
  await admin.query("update private.hub_settings set changed_at = now() - interval '1 hour' where key = 'growth.bounce_guard_percent'");
  const send = async (i, status) => {
    const contact = (await row("insert into private.growth_contacts (organization_id, email, name, role, eligibility, verified_at, source_kind, mailbox_result) values ($1, $2, 'Synthetic person', 'Owner', 'permitted', now(), 'enriched', 'verified') returning id",
      [org, `person${i}@guard-${tag}.example.org`])).id;
    await admin.query("insert into private.growth_messages (opportunity_id, contact_id, purpose, subject, body, opportunity_version, contact_version, policy_version, status, unsubscribe_hash, attempted_at) values ($1, $2, 'marketing', 'Synthetic', 'Synthetic', 1, 1, 1, $3, $4, now())",
      [opportunity, contact, status, digest(`guard-${tag}-${i}`)]);
    if (status === 'bounced') await admin.query('insert into private.email_suppressions (email_hash) values ($1) on conflict do nothing', [digest(`person${i}@guard-${tag}.example.org`)]);
  };
  await send(0, 'bounced');
  for (let i = 1; i < 10; i++) await send(i, 'delivered');
  let guard = (await row('select private.growth_bounce_guard() as g')).g;
  assert.deepEqual([guard.sent, guard.bounced, guard.over], [10, 1, false], 'one hard bounce in ten does not trip it');
  await send(10, 'bounced');
  guard = (await row('select private.growth_bounce_guard() as g')).g;
  assert.deepEqual([guard.sent, guard.bounced, guard.over], [11, 2, true], 'two hard bounces in eleven trip it at 5%');

  // ---- 5. A mail server's confirmation is recorded with the address --------------------------------------------------------------
  const person = (await row("insert into private.growth_people (organization_id, name, title, source) values ($1, 'Jane Synthetic', 'Administrator', 'website') returning id", [org])).id;
  const found = await server('private.growth_person_address', [person, `jane.synthetic@guard-${tag}.example.org`, 'Jane Synthetic', 'mail_server', null]);
  assert.equal(found.found, true);
  assert.deepEqual(await row('select mailbox_result, mailbox_checks from private.growth_contacts where id=$1', [found.contactId]), { mailbox_result: 'verified', mailbox_checks: 1 },
    'the address check does not ask the same server again');

  // ---- 6. Intent follows each event ------------------------------------------------------------------------------------------------
  const event = (kind, n) => admin.query("insert into private.customer_activity_events (product, organization_id, event_key, kind, occurred_at) values ('caremetric-intel', $1, $2, $3, now())", [org, `work-recovery:${tag}:${n}`, kind]);
  const intent = async () => (await row('select intent from private.growth_opportunities where id=$1', [opportunity])).intent;
  await event('report_viewed', 1); assert.equal(await intent(), 50);
  await event('positive_reply', 2); assert.equal(await intent(), 75);
  await event('negative_reply', 3); assert.equal(await intent(), 0, 'the business\'s latest word stands');

  // ---- 7. A trial from a CareMetric address is internal; one from an agency is not ------------------------------------------------
  const product = (await row("select id from hub.products where slug='caremetric-intel'")).id;
  const trialFrom = async (label, email) => {
    const id = randomUUID(); tenants.push(id);
    await admin.query('insert into hub.tenants (id, slug, name) values ($1, $2, $3)', [id, `work-recovery-${tag}-${label}`, 'Synthetic trial']);
    const stripe = `cus_workrecovery${tag}${label}`;
    await admin.query('insert into private.billing_customers (tenant_id, stripe_customer_id, email, livemode, seen_at) values ($1, $2, $3, true, now())', [id, stripe, email]);
    await admin.query(`insert into private.billing_subscriptions (stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, livemode, stripe_created, seen_at, trial_start, trial_end)
      values ($1, $2, $3, $4, 'trialing', 'charge_automatically', true, clock_timestamp(), clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '14 days')`, [`sub_workrecovery${tag}${label}`, id, stripe, product]);
    // An Intel trial starts once Stripe confirms its card (20261117230000_trial_path.sql).
    await admin.query('insert into private.billing_trial_cards (stripe_subscription_id, tenant_id) values ($1, $2)', [`sub_workrecovery${tag}${label}`, id]);
    return id;
  };
  const ours = await trialFrom('ours', `trial-${tag}@caremetric.ai`);
  const theirs = await trialFrom('theirs', `owner@agency-${tag}.example.org`);
  await server('private.growth_drain_billing');
  const internalOf = async tenant => (await row('select internal from private.growth_organizations where tenant_id=$1', [tenant]))?.internal;
  assert.equal(await internalOf(ours), true, 'a trial from a CareMetric address is internal');
  assert.equal(await internalOf(theirs), false, 'a trial from an agency is not');
  for (const tenant of [ours, theirs]) { const id = (await row('select id from private.growth_organizations where tenant_id=$1', [tenant]))?.id; if (id) orgs.push(id); }

  // ---- 8. The watchdog reads what was lost ------------------------------------------------------------------------------------------
  const facts = await server('private.agent_watchdog_facts');
  assert.deepEqual(Object.keys(facts.losses).sort(), ['ads', 'bounce', 'cap', 'creativeBlocked', 'creativeMade', 'held', 'launchFailed', 'reach']);
  assert.equal(facts.losses.launchFailed?.code, 'linkedin_permission');
  assert.ok(facts.losses.creativeBlocked.fact_sheet >= 1 || facts.losses.creativeBlocked.data_number >= 1);

  // ---- 9. The gate refuses drift ----------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    await client.query('begin'); await client.query(gate); await client.query(gate); await client.query('rollback');
    for (const drift of [
      'grant execute on function private.creative_render_requeue(boolean) to authenticated',
      'grant execute on function private.growth_internal_address(text) to hub_app_server',
      'drop trigger growth_event_intent on private.customer_activity_events',
      rewrite('private.growth_bounce_guard()', 'greatest(v_sent, 20)', 'v_sent'),
      rewrite('private.agent_watchdog_facts()', "'losses'", "'lost'"),
      rewrite('private.creative_data_counties(integer,timestamptz,jsonb)', 'private.creative_brief_pictured(b.id)', 'true'),
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Work recovery integration passed: counties freed from blocked snapshots, blocked images queued again once, platform refusals and reconnects, the bounce guard at two of ten, a mail server\'s confirmation kept, intent from events, internal trials, the watchdog\'s losses and gate drift. Nothing was rendered, posted or sent.');
} finally {
  await admin.query('delete from private.creative_assets where id=any($1::uuid[]) or brief_id=any($2::uuid[])', [assets, briefs]);
  await admin.query('delete from private.creative_briefs where id=any($1::uuid[])', [briefs]);
  await admin.query("delete from private.agent_tasks where kind = 'creative.request' and request_key in (select 'creative:brief:' || unnest($1::uuid[])::text)", [briefs]);
  await admin.query('delete from private.growth_roster_targets where ccn=any($1::text[])', [ccns]);
  await admin.query("delete from private.audit_events where action in ('creative.requeued', 'hub.social_connection', 'growth.marked_internal', 'growth.customer_linked', 'growth.person_found') and created_at >= $1", [runStart]);
  await admin.query('delete from private.agent_actions where id=any($1::uuid[]) or task_id=any($2::uuid[])', [actions, tasks]);
  await admin.query('delete from private.agent_tasks where id=any($1::uuid[])', [tasks]);
  await admin.query('delete from private.growth_billing_outbox where tenant_id=any($1::uuid[])', [tenants]);
  for (const t of tenants) { const id = (await row('select id from private.growth_organizations where tenant_id=$1', [t]))?.id; if (id && !orgs.includes(id)) orgs.push(id); }
  await admin.query('delete from private.growth_messages where opportunity_id in (select id from private.growth_opportunities where organization_id=any($1::uuid[]))', [orgs]);
  await admin.query('delete from private.customer_success_plans where opportunity_id in (select id from private.growth_opportunities where organization_id=any($1::uuid[]))', [orgs]);
  await admin.query('delete from private.customer_activity_events where organization_id=any($1::uuid[])', [orgs]);
  await admin.query('delete from private.growth_opportunities where organization_id=any($1::uuid[])', [orgs]);
  await admin.query('update private.growth_people set contact_id = null where organization_id=any($1::uuid[])', [orgs]);
  await admin.query('delete from private.growth_people where organization_id=any($1::uuid[])', [orgs]);
  const emails = (await admin.query('select email from private.growth_contacts where organization_id=any($1::uuid[])', [orgs])).rows.map(r => digest(r.email));
  await admin.query('delete from private.email_suppressions where email_hash=any($1::text[])', [emails]);
  await admin.query('delete from private.growth_contacts where organization_id=any($1::uuid[])', [orgs]);
  await admin.query('delete from private.growth_organizations where id=any($1::uuid[])', [orgs]);
  await admin.query('delete from private.billing_subscriptions where tenant_id=any($1::uuid[])', [tenants]);
  await admin.query('delete from private.billing_customers where tenant_id=any($1::uuid[])', [tenants]);
  await admin.query('delete from hub.tenants where id=any($1::uuid[])', [tenants]);
  for (const s of seedSettings) await admin.query('update private.hub_settings set value=$2, changed_at=$3, changed_by=$4 where key=$1', [s.key, s.value, s.changed_at, s.changed_by]);
  await admin.query('update private.growth_send_guard set resumed_at=$1, resumed_by=$2, tripped_at=$3 where id', [seedGuard?.resumed_at ?? null, seedGuard?.resumed_by ?? null, seedGuard?.tripped_at ?? null]);
  await pool.end(); await admin.end();
}
