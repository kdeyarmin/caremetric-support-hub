// The Content Marketer through the actual Hub server role, on disposable local fixtures only. The pool logs in as hub_app_server
// exactly like production; the weekly article runs through the real store, queue, model runtime (the official Anthropic SDK against
// a scripted fake network) and run rows; the owner approves through the real owner route; the approved article is published by the
// real database operation and then served as HTML by the real Hub server, read the way an anonymous visitor's app reads it. The
// monthly outreach drafts go to a recording fake mail sender. Nothing reaches Anthropic, a directory, a partner or a customer.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { appServer } from './http.mjs';
import { helpCenter } from './help-center.mjs';
import { sqlAiUsageRecorder } from './ai-usage.mjs';
import { agentTeam } from './agents/index.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { ownerNotifier } from './agents/notify.mjs';
import { modelRuntime } from './agents/runtime/index.mjs';
import { contentFeature } from './agents/content/executor.mjs';
import { completion, fireDrillDraft, outreachDraft, referralDraft } from './agents/content/fixtures.mjs';
import { promptVersion } from './agents/content/prompt.mjs';
import { topics } from './agents/content/topics.mjs';
import { contentHandlers } from './agents/tasks/content.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1');
assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl);
appUrl.username = 'hub_app_server';
appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const api = gateway(pool);
const store = sqlAgentStore(pool, { fenced: true });
const gate = await readFile(new URL('../supabase/migrations/20261103150100_agent_content_contract.sql', import.meta.url), 'utf8');

const run = randomUUID().replace(/[^a-f]/g, '').padEnd(8, 'x').slice(0, 8);
const owner = randomUUID();
const ownerToken = `content-owner-${randomUUID()}`;
const ownerPhone = `+1202555${String(1000 + Math.floor(Math.random() * 9000))}`;
const ai = 'a1a00000-a1a0-4000-8000-000000000001';
const ownerEmail = 'owner@example.test';
const fireTopic = topics.find(topic => topic.key === 'pa-fire-drill-requirements');
const referralTopic = topics.find(topic => topic.key === 'home-health-referral-marketing');
// Addresses this run publishes or blocks, unique to the run so a repeat starts clean.
const slugs = { fire: `${fireDrillDraft.slug}-${run}`, referral: `${referralDraft.slug}-${run}`, advisors: `pgit-advisors-${run}-review`, approval: `pgit-approval-${run}-check` };
// Equal priority, so the backlog's order decides: the fire drill article first.
const backlog = [{ ...fireTopic, slug: slugs.fire, priority: 3 }, { ...referralTopic, slug: slugs.referral, priority: 3 }];

const refused = (code, pattern) => error => { assert.equal(error.code, code, error.message); if (pattern) assert.match(error.message, pattern); return true; };
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await admin.query(sql, params)).rows;
const call = async (fn, args = []) => (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r;

let setAside = [];
let dist = null;
const seedAgents = await rows('select key, status, autonomy, daily_budget_cents, config, updated_at from private.agents');
const seedSchedules = await rows('select id, next_run_at, last_run_at, last_task_id, enabled from private.agent_schedules');
const seedProducts = await rows("select id, status, support_enabled from hub.products where slug = 'advisors'");

// ---- The provider, scripted by the topic it is asked about -------------------------------------------------------------------------
const requests = [];
let referralScript = 'good';
const respond = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_content_it' } });
const provider = async (url, init) => {
  assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
  const request = JSON.parse(init.body);
  const user = request.messages[0].content;
  requests.push({ system: request.system[0].text, user, model: request.model, maxTokens: request.max_tokens });
  if (request.system[0].text.startsWith('You draft outreach')) return respond(completion(outreachDraft));
  const slug = /Suggested slug: (\S+)/.exec(user)?.[1];
  if (slug === slugs.fire) return respond(completion({ ...fireDrillDraft, slug: slugs.fire }));
  assert.equal(slug, slugs.referral, 'a scripted answer for the topic');
  if (referralScript === 'bad') return respond(completion({ ...referralDraft, slug: slugs.referral, body: `${referralDraft.body}\n\nIntel ensures compliance and saves 12 hours a week.` }));
  return respond(completion({ ...referralDraft, slug: slugs.referral }));
};

const index = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="description" content="CareMetric central support." />\n    <title>CareMetric Support Hub</title>\n    <script type="module" crossorigin src="/assets/index-it.js"></script>\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n';

try {
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'content-owner@test.invalid',false)", [owner]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())", [owner, ownerPhone]);
  await admin.query("insert into hub.profiles(id,display_name) values($1,'Content integration owner') on conflict (id) do update set display_name=excluded.display_name", [owner]);
  await admin.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at)
    select $1,$2,user_id,identity_version,now(),now()+interval '1 hour' from private.sms_identities where user_id=$3`, [randomUUID(), digest(ownerToken), owner]);
  setAside = (await admin.query("update private.staff_permissions set revoked_at = now() where permission = 'platform.admin' and revoked_at is null and user_id <> $1 returning id", [owner])).rows.map(entry => entry.id);
  await admin.query("update private.agent_actions set status = 'rejected' where status in ('proposed', 'approved', 'auto_approved', 'executing')");
  await admin.query("update private.agent_tasks set status = 'cancelled', lease_until = null where status in ('queued', 'running', 'awaiting_approval', 'awaiting_session')");
  await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day', enabled = true");

  // ---- The release, the agent and the boundary ------------------------------------------------------------------------------------
  const features = (await api.rpc('get_backend_contract', {})).features;
  assert.ok(features.includes(contentFeature), 'the Content Marketer is declared');
  const seeded = await row("select * from private.agents where key = 'content_marketer'");
  assert.deepEqual([seeded.display_name, seeded.autonomy, seeded.model_tier, seeded.daily_budget_cents], ['Content Marketer', 'propose', 'draft', 150]);
  assert.deepEqual((await rows("select task_kind, at_local::text from private.agent_schedules where agent_key = 'content_marketer' order by task_kind")).map(entry => [entry.task_kind, entry.at_local]),
    [['content.outreach', '08:05:00'], ['content.weekly', '07:45:00']]);
  await assert.rejects(admin.query('select private.agent_content_state()'), refused('42501', /Application server required/));
  await assert.rejects(admin.query('select private.agent_content_publish(gen_random_uuid(), 1)'), refused('42501', /Application server required/));
  await assert.rejects(withSession(pool, null, db => db.query('select private.agent_content_state()'), false), refused('42501'));
  await assert.rejects(pool.query('select count(*) from private.agent_actions'), refused('42501'));
  await assert.rejects(call('private.agent_content_state', [['Not A Slug']]), refused('22023'));
  // Only article addresses may be asked about (a dotted content key is never one).
  await assert.rejects(call('private.agent_content_state', [['support.protect-patient-information']]), refused('22023'));
  const empty = await call('private.agent_content_state', [[slugs.fire]]);
  assert.deepEqual(empty.takenSlugs, []);
  assert.ok(Array.isArray(empty.articles) && Array.isArray(empty.questions) && Array.isArray(empty.outreachMonths));

  // ---- The team, with the real runtime against the scripted provider ------------------------------------------------------------------
  await admin.query("update private.agents set status = 'active', autonomy = 'propose', daily_budget_cents = 150 where key = 'content_marketer'");
  const mail = [];
  const logs = [];
  const emailSender = { configured: true, send: async (to, subject, content) => { mail.push([to, subject, content]); return { delivery: 'sent', id: `fixture-${mail.length}` }; } };
  const notifier = ownerNotifier({ store, email: emailSender, ownerEmail, publicOrigin: 'https://hub.test', log: line => logs.push(line) });
  const model = modelRuntime({ apiKey: `sk-ant-content-${run}`, fetchImpl: provider, store, record: sqlAiUsageRecorder(pool, { log: line => logs.push(line) }).record, notifier, log: line => logs.push(line) });
  const featureSet = new Set(features);
  const team = agentTeam({
    pool, enabled: true, ownerEmail, publicOrigin: 'https://hub.test', features: featureSet, email: emailSender, model, log: line => logs.push(line),
    // The real handlers over a backlog of two topics, so the run is deterministic whatever else the database holds.
    handlers: shared => contentHandlers({ ...shared, features: featureSet, topics: backlog, log: line => logs.push(line) }),
  });
  assert.ok(team.scheduler.kinds().includes('content.weekly') && team.scheduler.kinds().includes('content.outreach'), 'the tasks register with a key and the feature');
  const keyless = agentTeam({ pool, enabled: true, features: featureSet, log: () => {} });
  assert.ok(!keyless.scheduler.kinds().includes('content.weekly') && !keyless.scheduler.kinds().includes('content.outreach'), 'and not without a model key');
  assert.ok(!agentTeam({ pool, enabled: true, model, features: new Set(features.filter(feature => feature !== contentFeature)), log: () => {} }).scheduler.kinds().includes('content.weekly'),
    'nor without the feature');

  let counter = 0;
  const runTask = async (kind, over = {}) => {
    counter += 1;
    // Enqueue answers with the new task's id.
    const id = await store.enqueue('content_marketer', kind, `content-it:${run}:${counter}`, { sourceKind: 'owner', priority: 1, ...over });
    for (let round = 0; round < 8; round += 1) {
      const current = await row('select status, due_at > now() as later from private.agent_tasks where id = $1', [id]);
      if (!['queued', 'running'].includes(current.status) || (current.status === 'queued' && current.later)) break;
      await team.tick();
    }
    return row('select * from private.agent_tasks where id = $1', [id]);
  };

  // ---- 1. The weekly article: drafted, checked, proposed whole -----------------------------------------------------------------------
  const first = await runTask('content.weekly');
  assert.equal(first.status, 'awaiting_approval');
  assert.deepEqual(first.result, { outcome: 'proposed', topic: 'pa-fire-drill-requirements', slug: slugs.fire, actionId: first.result.actionId, rewrites: 0 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'claude-sonnet-5-5');
  assert.match(requests[0].user, /Working title: Fire drill requirements/);
  const proposed = await row('select * from private.agent_actions where id = $1', [first.result.actionId]);
  assert.deepEqual([proposed.kind, proposed.target_kind, proposed.target_id, proposed.status, proposed.agent_key], ['content.publish', 'content_item', slugs.fire, 'proposed', 'content_marketer']);
  assert.deepEqual(Object.keys(proposed.input).sort(), ['body', 'description', 'kind', 'product', 'promptVersion', 'slug', 'title', 'topic']);
  assert.ok(proposed.preview.startsWith(`Publish on the public help center: https://help.caremetric.ai/help/articles/${slugs.fire}\nProduct: CareMetric CareBase\nTitle: ${fireDrillDraft.title}`));
  assert.ok(proposed.preview.endsWith(proposed.input.body) && proposed.input.body.includes(fireDrillDraft.body), 'the preview is the whole article');
  const firstRun = await row('select * from private.agent_runs where task_id = $1', [first.id]);
  assert.deepEqual([firstRun.model, firstRun.prompt_version, firstRun.outcome, firstRun.summary], ['claude-sonnet-5-5', promptVersion, 'completed', 'Drafted the pa-fire-drill-requirements article: it passed the checks.']);
  assert.ok(Number(firstRun.cost_cents) > 0);
  assert.equal(Number((await row("select count(*) from private.ai_usage where feature = 'agent_content_marketer'")).count), 1, 'the call is in the usage ledger');
  const overview = await team.admin.overview(ownerToken, {});
  assert.ok(overview.team.approvals.some(approval => approval.id === proposed.id && approval.kind === 'content.publish' && approval.preview === proposed.preview), 'the owner sees it waiting');

  // ---- 2. Approval publishes it as the AI assistant, with the owner's approval recorded ------------------------------------------------
  const decided = await team.admin.decide(ownerToken, { actionId: proposed.id, decision: 'approve' });
  assert.deepEqual(decided, { id: proposed.id, kind: 'content.publish', status: 'executed', decided: true });
  const executed = await row('select * from private.agent_actions where id = $1', [proposed.id]);
  assert.deepEqual(executed.result, { outcome: 'published', slug: slugs.fire, url: `https://help.caremetric.ai/help/articles/${slugs.fire}` });
  assert.equal(executed.decided_by, owner);
  const item = await row('select * from hub.content_items where content_key = $1', [slugs.fire]);
  assert.deepEqual([item.kind, item.status, item.access_level, item.source_system, item.owner_team, item.created_by], ['article', 'published', 'public', 'support_hub', 'CareMetric Marketing', ai]);
  const revision = await row('select * from hub.content_revisions where item_id = $1', [item.id]);
  assert.deepEqual([revision.revision_no, revision.review_state, revision.created_by, revision.approved_by, revision.title, revision.summary, revision.body_markdown],
    [1, 'approved', ai, owner, proposed.input.title, proposed.input.description, proposed.input.body]);
  assert.equal(new Date(revision.approved_at).getTime(), new Date(executed.decided_at).getTime(), 'approved when the owner decided');
  assert.deepEqual(revision.variables, { author: 'content_marketer', agent: 'content_marketer', topic: 'pa-fire-drill-requirements', kind: 'regulation', action: proposed.id, approvedBy: owner });
  assert.match(revision.source_hash, /^[0-9a-f]{64}$/);
  assert.equal(revision.source_version, `agent:${promptVersion}`);
  const publication = await row('select p.*, pr.slug as product from hub.content_publications p join hub.products pr on pr.id = p.product_id where p.item_id = $1', [item.id]);
  assert.deepEqual([publication.product, publication.audience, publication.revision_id, publication.published_by, publication.route_pattern], ['carebase', ['all'], revision.id, owner, null]);
  const audit = await row("select * from private.audit_events where action = 'content.published' and entity_id = $1", [item.id]);
  assert.deepEqual([audit.actor_id, audit.entity_type, audit.metadata], [ai, 'content_item', { agent: 'content_marketer', action: proposed.id, slug: slugs.fire, topic: 'pa-fire-drill-requirements', approvedBy: owner }]);
  assert.equal((await row('select status from private.agent_tasks where id = $1', [first.id])).status, 'done', 'the task closes once its proposal is carried out');

  // Anyone may now read it, exactly as the help center's app reads it.
  const published = (await api.rpc('list_published_content', {})).find(entry => entry.content_key === slugs.fire);
  assert.ok(published, 'an anonymous visitor sees the article');
  assert.deepEqual([published.kind, published.access_level, published.title, published.body_markdown], ['article', 'public', proposed.input.title, proposed.input.body]);

  // ---- 3. The article as HTML, through the real Hub server --------------------------------------------------------------------------
  dist = await mkdtemp(join(tmpdir(), 'hub-content-it-'));
  await writeFile(join(dist, 'index.html'), index);
  const server = appServer({ auth: {}, gateway: api, delegations: {}, origins: [], dist, helpCenter: helpCenter({ load: () => api.rpc('list_published_content', {}), dist, log: () => {} }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${base}/help/articles/${slugs.fire}`);
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-security-policy')?.includes("script-src 'self'"), 'the security headers stay');
    const html = await page.text();
    assert.ok(html.includes(`<title>${proposed.input.title} | CareMetric Help Center</title>`));
    assert.ok(html.includes(`<link rel="canonical" href="https://help.caremetric.ai/help/articles/${slugs.fire}" />`));
    assert.ok(html.includes(`<meta name="description" content="${proposed.input.description}" />`));
    const structured = JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)[1]);
    assert.deepEqual([structured['@type'], structured.headline, structured.url], ['Article', proposed.input.title, `https://help.caremetric.ai/help/articles/${slugs.fire}`]);
    assert.ok(html.includes('<h2>How often drills happen</h2>') && html.includes('<h2>Frequently asked questions</h2>') && html.includes('<h2>Sources</h2>'));
    assert.ok(html.includes('<a href="https://www.pacodeandbulletin.gov/secure/pacode/data/055/chapter2600/s2600.132.html">55 Pa. Code § 2600.132, fire drills</a>'));
    assert.ok(html.includes('<p><em>This article is general information about Pennsylvania regulations, not legal advice.'));
    assert.ok(html.includes('<script type="module" crossorigin src="/assets/index-it.js"></script>'), 'the app loads and takes over');
    const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
    assert.ok(sitemap.includes(`<loc>https://help.caremetric.ai/help/articles/${slugs.fire}</loc>`));
    assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Sitemap: https:\/\/help\.caremetric\.ai\/sitemap\.xml/);
  } finally { await new Promise(resolve => server.close(resolve)); }

  // ---- 4. Publishing is idempotent by address: an execution started again finds the article and writes nothing new --------------------
  await admin.query("update private.agent_actions set status = 'approved', executing_at = null where id = $1", [proposed.id]);
  assert.deepEqual(await team.actions.executeOne(proposed.id, { kind: 'content.publish' }), { executed: true, failed: false, skipped: false });
  assert.deepEqual((await row('select result from private.agent_actions where id = $1', [proposed.id])).result.outcome, 'already_published');
  assert.equal(Number((await row('select count(*) from hub.content_items where content_key = $1', [slugs.fire])).count), 1);
  assert.equal(Number((await row('select count(*) from hub.content_revisions where item_id = $1', [item.id])).count), 1);

  // ---- 5. A draft that fails the checks proposes nothing and says only why -------------------------------------------------------------
  referralScript = 'bad';
  const rejected = await runTask('content.weekly');
  assert.equal(rejected.status, 'done');
  assert.deepEqual(rejected.result, { outcome: 'rejected', topic: 'home-health-referral-marketing', reasons: ['compliance_assurance', 'unlisted_number'] });
  assert.equal(Number((await row('select count(*) from private.agent_actions where task_id = $1', [rejected.id])).count), 0);
  assert.equal((await row('select summary from private.agent_runs where task_id = $1', [rejected.id])).summary,
    'Drafted the home-health-referral-marketing article: not proposed (compliance_assurance, unlisted_number).');

  // ---- 6. An address another article took after the proposal is refused at publishing, with its code ----------------------------------
  referralScript = 'good';
  const second = await runTask('content.weekly');
  assert.equal(second.status, 'awaiting_approval');
  assert.equal(second.result.slug, slugs.referral);
  await admin.query("insert into hub.content_items (content_key, kind, status, access_level, source_system) values ($1, 'article', 'draft', 'customer', 'support_hub')", [slugs.referral]);
  assert.deepEqual(await team.admin.decide(ownerToken, { actionId: second.result.actionId, decision: 'approve' }),
    { id: second.result.actionId, kind: 'content.publish', status: 'failed', decided: true, error: 'slug_taken' });
  assert.equal((await row('select status from hub.content_items where content_key = $1', [slugs.referral])).status, 'draft', 'the other article is untouched');
  assert.deepEqual((await call('private.agent_content_state', [[slugs.referral]])).takenSlugs, [slugs.referral]);
  // Every topic is now taken or blocked, so the next run writes nothing and pays for nothing.
  const asked = requests.length;
  assert.deepEqual((await runTask('content.weekly')).result, { skipped: 'no_topic' });
  assert.equal(requests.length, asked);

  // ---- 7. Approval is the owner's: an article approved on its own is refused, by the executor and by the database -------------------
  const article = { ...proposed.input, slug: slugs.approval, topic: `pgit-approval-${run}` };
  const insertAction = async (input, status, decidedBy = null) => (await row(`insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status, decided_by, decided_at)
    values ('content_marketer', 'content.publish', 'content_item', $1, 'Publish', $2, $3, $4, case when $4::uuid is null then null else now() end) returning id`, [input.slug, input, status, decidedBy])).id;
  const automatic = await insertAction(article, 'auto_approved');
  assert.deepEqual(await team.actions.executeOne(automatic, { kind: 'content.publish' }), { executed: false, failed: true, skipped: false, error: 'approval_required' });
  await admin.query("update private.agent_actions set status = 'auto_approved' where id = $1", [automatic]);
  const started = await store.beginExecution(automatic);
  assert.deepEqual(await store.contentPublish(automatic, started.execution), { outcome: 'approval_required' });
  await store.completeExecution(automatic, false, { error: 'approval_required' }, started.execution);
  await assert.rejects(store.contentPublish(automatic, started.execution), refused('55000', /not being published/), 'only an execution in progress can publish');
  assert.equal(Number((await row('select count(*) from hub.content_items where content_key = $1', [slugs.approval])).count), 0);

  // ---- 8. A product closed to support is refused, and nothing is written -------------------------------------------------------------
  await admin.query("update hub.products set support_enabled = false where slug = 'advisors'");
  const advisors = await insertAction({ ...proposed.input, slug: slugs.advisors, product: 'advisors', topic: `pgit-advisors-${run}` }, 'approved', owner);
  assert.deepEqual(await team.actions.executeOne(advisors, { kind: 'content.publish' }), { executed: false, failed: true, skipped: false, error: 'product_unavailable' });
  assert.equal(Number((await row('select count(*) from hub.content_items where content_key = $1', [slugs.advisors])).count), 0);
  for (const seed of seedProducts) await admin.query('update hub.products set status = $2, support_enabled = $3 where id = $1', [seed.id, seed.status, seed.support_enabled]);

  // ---- 9. A used-up budget puts the work off to the next Eastern day without calling the model -----------------------------------------
  // (The failed referral proposal lets its topic go at once; with the blocking article gone, the topic is free again.)
  await admin.query('delete from hub.content_items where content_key = $1', [slugs.referral]);
  await admin.query("update private.agents set daily_budget_cents = 0 where key = 'content_marketer'");
  const before = requests.length;
  const broke = await runTask('content.weekly');
  assert.equal(broke.status, 'queued');
  assert.deepEqual(broke.result, { deferred: 'budget', topic: 'home-health-referral-marketing' });
  assert.ok(new Date(broke.due_at) > new Date(Date.now() + 60_000), 'it waits for the next day');
  assert.equal(requests.length, before, 'no call was made');
  assert.equal((await row("select outcome from private.agent_runs where task_id = $1 order by started_at desc limit 1", [broke.id])).outcome, 'budget_exhausted');
  await admin.query("update private.agent_tasks set status = 'cancelled', lease_until = null where id = $1", [broke.id]);
  await admin.query("update private.agents set daily_budget_cents = 150 where key = 'content_marketer'");

  // ---- 10. The monthly outreach drafts reach the owner and nobody else -----------------------------------------------------------------
  const outreach = await runTask('content.outreach');
  assert.equal(outreach.status, 'done');
  assert.deepEqual(outreach.result, { outcome: 'sent', month: outreach.result.month, delivery: ['email:sent'], listings: 2, pitches: 1, dropped: 0, reasons: [] });
  assert.ok(mail.length >= 1 && mail.every(([to]) => to === ownerEmail), 'every email went to the owner');
  const [, subject, content] = mail.at(-1);
  assert.match(subject, /^Outreach drafts for \w+ \d{4}: 2 listings, 1 pitch$/);
  assert.ok(content.text.includes(outreachDraft.pitches[0].body) && content.text.includes(outreachDraft.listings[1].description));
  const alert = await row("select * from private.owner_notifications where dedupe_key = $1", [`content:outreach:run:${outreach.id}`]);
  assert.deepEqual([alert.channel, alert.status, alert.agent_key], ['email', 'sent', 'content_marketer']);
  assert.ok(!alert.body.includes('$199') && !alert.body.includes(outreachDraft.pitches[0].subject), 'the stored body holds counts only');

  // ---- 11. Nothing of an article or a draft is kept anywhere but the action, the content tables and the owner's email ---------------------
  const kept = JSON.stringify([
    await rows("select result, payload, last_error_code from private.agent_tasks where agent_key = 'content_marketer'"),
    await rows("select summary, error_code from private.agent_runs where agent_key = 'content_marketer'"),
    await rows("select subject, body from private.owner_notifications where agent_key = 'content_marketer'"),
    await rows("select metadata from private.audit_events where action like 'agent.%' or action = 'content.published'"),
    logs,
  ]);
  for (const text of ['Fire drill records are among', 'saves 12 hours', 'ensures compliance', 'Staff training, resident records and survey', 'newsletter', `sk-ant-content-${run}`, ownerToken]) {
    assert.ok(!kept.includes(text), `${text.slice(0, 24)}… is kept nowhere it should not be`);
  }

  // ---- 12. The gate re-runs cleanly and refuses to declare the feature once the boundary drifts ----------------------------------------
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query(gate);
    await client.query('rollback');
    for (const [sql, message] of [
      ['revoke execute on function private.agent_content_publish(uuid,integer) from hub_app_server', /executable by the Hub server only/],
      ['grant execute on function private.agent_content_state(text[]) to authenticated', /executable by the Hub server only/],
      ['alter function private.agent_content_state(text[]) reset search_path', /pinned search path/],
      ['alter table private.agent_actions drop constraint agent_actions_content_publish_check', /checked action kind/],
      ['drop index private.agent_actions_content_publish_slug', /once per address/],
      ["delete from private.agent_schedules where agent_key = 'content_marketer' and task_kind = 'content.outreach'", /schedules must exist/],
      ["update private.agents set config = config - 'auto_approve_kinds' where key = 'content_marketer'", /with its settings/],
    ]) {
      await client.query('begin');
      try {
        await client.query(sql);
        await assert.rejects(client.query(gate), rejection => rejection.code === '55000' && message.test(rejection.message), sql);
      } finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Content Marketer: the weekly article is drafted through the metered runtime, checked in code and proposed whole; the owner\'s approval publishes it as a public help-center article authored by the AI assistant with the approval recorded, idempotently by address; the Hub serves it as HTML with its canonical address, structured data and sitemap entry; a draft that fails the checks, a taken address, an automatic approval, a closed product and a used-up budget each publish nothing; the outreach drafts reach the owner alone; and the gate refuses a drifted boundary.');
} finally {
  if (dist) await rm(dist, { recursive: true, force: true });
  const keys = Object.values(slugs);
  await admin.query('delete from private.audit_events where entity_id in (select id from hub.content_items where content_key = any($1::text[]))', [keys]);
  await admin.query('delete from hub.content_publications where item_id in (select id from hub.content_items where content_key = any($1::text[]))', [keys]);
  await admin.query('delete from hub.content_revisions where item_id in (select id from hub.content_items where content_key = any($1::text[]))', [keys]);
  await admin.query('delete from hub.content_items where content_key = any($1::text[])', [keys]);
  await admin.query("delete from private.audit_events where actor_id = $1 or (action like 'agent.%' and metadata ->> 'agent' = 'content_marketer')", [owner]);
  await admin.query("delete from private.owner_notifications where agent_key = 'content_marketer'");
  await admin.query("delete from private.agent_actions where agent_key = 'content_marketer'");
  await admin.query("delete from private.agent_runs where agent_key = 'content_marketer'");
  await admin.query("delete from private.agent_tasks where agent_key = 'content_marketer'");
  await admin.query("delete from private.ai_usage where feature = 'agent_content_marketer'");
  for (const seed of seedProducts) await admin.query('update hub.products set status = $2, support_enabled = $3 where id = $1', [seed.id, seed.status, seed.support_enabled]);
  for (const seed of seedAgents) await admin.query('update private.agents set status=$2, autonomy=$3, daily_budget_cents=$4, config=$5, updated_at=$6 where key=$1', [seed.key, seed.status, seed.autonomy, seed.daily_budget_cents, seed.config, seed.updated_at]);
  for (const seed of seedSchedules) await admin.query('update private.agent_schedules set next_run_at=$2, last_run_at=$3, last_task_id=$4, enabled=$5 where id=$1', [seed.id, seed.next_run_at, seed.last_run_at, seed.last_task_id, seed.enabled]);
  if (setAside.length) await admin.query('update private.staff_permissions set revoked_at = null where id = any($1::uuid[])', [setAside]);
  await admin.query('delete from private.sms_sessions where user_id = $1', [owner]);
  await admin.query('delete from private.sms_identities where user_id = $1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id = $1', [owner]);
  await admin.query('delete from hub.profiles where id = $1', [owner]);
  await admin.query('delete from auth.users where id = $1', [owner]);
  await pool.end();
  await admin.end();
}
