// The Creative Director's database rules through the actual Hub server role, on disposable local fixtures only: a brief recorded once;
// drafts stored with their own utm_content landing address; the render claim and its daily cap; a blocked asset never listed for the owner;
// a rendered asset proposed (with a warning: never automatically approved); the hand-over only inside an execution the database started;
// a rejection note becoming a revision brief and a drafting task; the public file only while approved; retirement; the leads join; and the
// refusals (another agent's creative action, an unknown product, any other session). Nothing renders and nothing reaches a platform.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sqlAgentStore } from './agents/store.mjs';

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
const store = sqlAgentStore(pool, { fenced: true, growth: true, social: true, creative: true });

const run = randomUUID().slice(0, 8);
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const original = await row("select status, autonomy, config from private.agents where key = 'creative_director'");
assert.ok(original, 'The Creative Director is seeded');
assert.equal(original.status, 'paused');
assert.equal(original.autonomy, 'propose');
const kits = await row("select jsonb_agg(to_jsonb(k) order by product) as kits from private.brand_kits k");
const owner = (await row("insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id", [`creative-${run}@example.invalid`])).id;
const tasks = [];
const briefs = [];
async function runningTask(agent, kind) {
  const created = await row("insert into private.agent_tasks (agent_key, kind, request_key, status, claimed_at, lease_until, attempts) values ($1, $2, $3, 'running', now(), now() + interval '10 minutes', 1) returning id", [agent, kind, `creative-it-${run}-${tasks.length}`]);
  tasks.push(created.id);
  return created.id;
}
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const draft = (label, overrides = {}) => ({ platform: 'meta', placement: 'meta.feed_square', kind: 'static', layout: 'headline', width: 1080, height: 1080, lengthKey: null,
  variantLabel: label, hookType: 'problem', concept: 'A concept', headline: `Headline ${label}`, primaryText: 'Primary text', description: '', cta: 'Start free trial',
  altText: 'A headline on a light background', overlay: {}, landingBase: 'https://cmcarebase.com/#pricing', provider: 'internal', compliance: { verdict: 'pass', reasons: [] }, ...overrides });

try {
  await admin.query("update private.agents set status = 'active', autonomy = 'propose', config = jsonb_set(config, '{auto_approve_kinds}', '[]') where key = 'creative_director'");
  await admin.query("update private.brand_kits set primary_color = '#0B5394', background_color = '#FFFFFF', text_color = '#111827'");

  // A brief is recorded once per request key.
  const brief = { product: 'carebase', goal: 'Drive trials', audience: 'Administrators of personal care homes', platforms: ['meta'], formats: ['static'], videoLengths: [],
    angle: '', source: 'owner', requestKey: `it:${run}:brief` };
  const first = await store.creativeBriefCreate(brief);
  assert.equal(first.created, true);
  briefs.push(first.id);
  assert.equal((await store.creativeBriefCreate(brief)).created, false, 'The same request key is one brief');
  await assert.rejects(store.creativeBriefCreate({ ...brief, requestKey: `it:${run}:advisors`, product: 'advisors' }), error => error.code === '23514', 'Only CareBase and Intel get creative');
  await assert.rejects(store.creativeBriefCreate({ ...brief, requestKey: `it:${run}:health`, audience: 'Patients with diabetes' }), error => error.code === '23514', 'An audience never names a health condition');
  const context = await store.creativeBriefContext(first.id);
  assert.equal(context.brief.product, 'carebase');
  assert.equal(context.brandKit.brandName, 'CareMetric');

  // Drafts: the landing address carries the asset's own id; a blocked one is kept for the record only.
  const saved = await store.creativeDraftsSave(first.id, null, [draft('A'), draft('B', { compliance: { verdict: 'block', reasons: [{ rule: 'phi', level: 'block', message: 'x' }] } }), draft('C')]);
  assert.deepEqual(saved.map(item => item.status), ['draft', 'blocked', 'draft']);
  const [a, blocked, c] = saved.map(item => item.id);
  const stored = await row('select landing_url from private.creative_assets where id = $1', [a]);
  assert.ok(stored.landing_url.includes(`utm_content=${a}`) && stored.landing_url.endsWith('#pricing'), 'The landing address carries utm_content = the asset id');
  assert.equal((await store.creativeDraftsSave(first.id, null, [draft('A')]))[0].created, false, 'A retried save stores each variant once');

  // The render claim honors the day's cap and the products given.
  assert.equal((await store.creativeRenderClaim(5, 40, ['caremetric-intel'])).claimed.length, 0, 'Only the products given are claimed');
  const claim = await store.creativeRenderClaim(1, 40, ['carebase']);
  assert.equal(claim.claimed.length, 1);
  assert.ok(claim.claimed[0].brandKit.primaryColor, 'A claim carries the brand kit');
  const capped = await store.creativeRenderClaim(5, claim.renderedToday, ['carebase']);
  assert.equal(capped.claimed.length, 0, 'Nothing more is claimed once the day\'s cap is reached');
  const claimedId = claim.claimed[0].id;
  const other = claimedId === a ? c : a;

  // Finishing: a ready asset needs its file and a passing verdict.
  await assert.rejects(store.creativeRenderFinish(claimedId, 'ready', null, 'image/png', { verdict: 'pass', reasons: [] }, {}), error => error.code === '22023');
  const ready = await store.creativeRenderFinish(claimedId, 'ready', png, 'image/png', { verdict: 'warn', reasons: [{ rule: 'text_heavy', level: 'warn', message: 'Text covers 30%.' }] }, {});
  assert.equal(ready.status, 'ready');
  assert.equal((await store.creativeReady(10, ['carebase']))[0].id, claimedId);

  // A blocked asset never reaches the owner's gallery (the owner reads it only through hub.get_creative_studio, which leaves it out).
  assert.ok(!(await row("select pg_get_functiondef('hub.get_creative_studio(jsonb)'::regprocedure) as def")).def.includes("status = 'blocked' and (v_product"));
  assert.equal((await row('select status from private.creative_assets where id = $1', [blocked])).status, 'blocked');

  // A warned asset is proposed for review and can never be approved automatically, even for an agent on Act that lists it.
  const renderTask = await runningTask('creative_director', 'creative.render');
  await admin.query("update private.agents set autonomy = 'act', config = jsonb_set(config, '{auto_approve_kinds}', '[\"creative.asset\", \"creative.asset_review\"]') where key = 'creative_director'");
  await assert.rejects(store.proposeAction({ taskId: renderTask, kind: 'creative.asset_review', targetKind: 'creative_asset', targetId: claimedId, preview: 'Review', input: { assetId: claimedId } }),
    error => error.code === '23514', 'An automatically approved asset with a warning is refused');
  await admin.query("update private.agents set autonomy = 'propose', config = jsonb_set(config, '{auto_approve_kinds}', '[]') where key = 'creative_director'");
  const proposal = await store.proposeAction({ taskId: renderTask, kind: 'creative.asset_review', targetKind: 'creative_asset', targetId: claimedId, preview: 'Review', input: { assetId: claimedId } });
  assert.equal(proposal.status, 'proposed');
  assert.equal(await store.creativeAssetProposed(claimedId, proposal.id), true);
  assert.ok((await store.creativeOpenTargets()).includes(`creative.asset_review:${claimedId}`));

  // No hand-over without an execution the database started for an approved action.
  assert.equal((await store.creativeHandoff(proposal.id, 1)).handedOver, false, 'A proposal that nobody approved is not handed over');
  assert.equal(await store.creativePublicFile('0'.repeat(64)), null);
  await admin.query("update private.agent_actions set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [proposal.id, owner]);
  const execution = await store.beginExecution(proposal.id);
  assert.ok(execution, 'An approved action starts');
  assert.equal((await store.creativeHandoff(proposal.id, execution.execution + 1)).handedOver, false, 'Only the execution the database started may hand it over');
  const handed = await store.creativeHandoff(proposal.id, execution.execution);
  assert.equal(handed.handedOver, true);
  await store.completeExecution(proposal.id, true, { handedOver: true }, execution.execution);
  const approved = await store.creativeApproved({ product: 'carebase', platform: 'meta' });
  assert.equal(approved.length, 1);
  assert.match(approved[0].token, /^[0-9a-f]{64}$/);
  const file = await store.creativePublicFile(approved[0].token);
  assert.equal(file.contentType, 'image/png');
  assert.ok(Buffer.from(file.bytes).equals(png), 'The approved file is served under its token');
  assert.equal(await store.creativeMarkLive(claimedId, 'post-1'), true);
  assert.equal((await store.creativeLiveAssets(['carebase'])).find(item => item.id === claimedId)?.status, 'live');

  // A rejection note becomes a revision brief and a task to draft it; a rejection without a note does not.
  const second = (await store.creativeRenderClaim(1, 40, ['carebase'])).claimed[0];
  assert.equal(second.id, other);
  await store.creativeRenderFinish(other, 'ready', png, 'image/png', { verdict: 'pass', reasons: [] }, {});
  const pass = await store.proposeAction({ taskId: renderTask, kind: 'creative.asset', targetKind: 'creative_asset', targetId: other, preview: 'Pass', input: { assetId: other } });
  await store.creativeAssetProposed(other, pass.id);
  await admin.query("update private.agent_actions set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = 'Make the headline about training hours' where id = $1", [pass.id, owner]);
  const rejected = await row('select status, revision_notes from private.creative_assets where id = $1', [other]);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.revision_notes, 'Make the headline about training hours');
  const revision = await row("select id, source, revision_note, parent_asset_id from private.creative_briefs where request_key = $1", [`revision:${pass.id}`]);
  assert.equal(revision.source, 'revision');
  assert.equal(revision.parent_asset_id, other);
  briefs.push(revision.id);
  const revisionTask = await row("select kind, status, payload from private.agent_tasks where request_key = $1", [`creative:brief:${revision.id}`]);
  assert.equal(revisionTask.kind, 'creative.request');
  assert.equal(revisionTask.payload.briefId, revision.id);
  tasks.push((await row("select id from private.agent_tasks where request_key = $1", [`creative:brief:${revision.id}`])).id);

  // Retirement takes an asset out of use; its public file is gone.
  const refreshTask = await runningTask('creative_director', 'creative.refresh');
  const retire = await store.proposeAction({ taskId: refreshTask, kind: 'creative.retire', targetKind: 'creative_asset', targetId: claimedId, preview: 'Retire', input: { assetId: claimedId } });
  await admin.query("update private.agent_actions set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [retire.id, owner]);
  const retiring = await store.beginExecution(retire.id);
  assert.equal((await store.creativeRetire(retire.id, retiring.execution)).retired, true);
  await store.completeExecution(retire.id, true, { retired: true }, retiring.execution);
  assert.equal(await store.creativePublicFile(approved[0].token), null, 'A retired asset is no longer served');

  // Another agent cannot propose a creative action, and a creative action names an asset.
  const brief2 = await runningTask('chief_of_staff', 'brief.daily');
  await assert.rejects(store.proposeAction({ taskId: brief2, kind: 'creative.asset', targetKind: 'creative_asset', targetId: claimedId, preview: 'x', input: {} }), error => error.code === '23514');
  await assert.rejects(store.proposeAction({ taskId: renderTask, kind: 'creative.asset', targetKind: 'creative_asset', targetId: 'not-an-asset', preview: 'x', input: {} }), error => error.code === '23514');

  // Leads join by utm_content (test leads never count), learnings save once per pattern, and the brief counts.
  assert.ok(Array.isArray(await store.creativeLeads(new Date(Date.now() - 86_400_000), new Date())));
  const learning = { product: 'carebase', platform: 'meta', kind: 'hook', value: `problem-${run}`, verdict: 'win', samples: 2, score: 0.4, evidence: {} };
  assert.equal(await store.creativeLearningsSave([learning]), 1);
  assert.equal(await store.creativeLearningsSave([{ ...learning, verdict: 'lose', score: -0.3 }]), 1, 'A pattern keeps one verdict');
  assert.equal((await row('select verdict from private.creative_learnings where pattern_value = $1', [`problem-${run}`])).verdict, 'lose');
  const facts = await store.creativeBriefFacts();
  assert.ok(Number.isInteger(facts.waiting) && Array.isArray(facts.learnings));
  assert.ok(Array.isArray(await store.creativePlanInputs(7)));

  // Any other session is refused every server operation.
  await assert.rejects(admin.query('select private.creative_open_targets()'), error => error.code === '42501');
  await assert.rejects(admin.query("select private.creative_public_file($1)", ['0'.repeat(64)]), error => error.code === '42501');
  console.log('Creative Director database integration passed.');
} finally {
  await admin.query("delete from private.creative_learnings where pattern_value = $1", [`problem-${run}`]);
  await admin.query('update private.creative_briefs set parent_asset_id = null where id = any($1::uuid[])', [briefs]);
  await admin.query('delete from private.agent_actions where task_id = any($1::uuid[])', [tasks]);
  await admin.query('delete from private.creative_assets where brief_id = any($1::uuid[])', [briefs]);
  await admin.query('delete from private.creative_briefs where id = any($1::uuid[])', [briefs]);
  await admin.query('delete from private.agent_tasks where id = any($1::uuid[])', [tasks]);
  await admin.query("update private.agents set status = $1, autonomy = $2, config = $3 where key = 'creative_director'", [original.status, original.autonomy, original.config]);
  for (const kit of kits.kits) {
    await admin.query('update private.brand_kits set primary_color = $2, background_color = $3, text_color = $4 where product = $1', [kit.product, kit.primary_color, kit.background_color, kit.text_color]);
  }
  await admin.query('delete from auth.users where id = $1', [owner]);
  await pool.end();
  await admin.end();
}
