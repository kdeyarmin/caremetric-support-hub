// The Social Media Manager's database rules through the actual Hub server role, on disposable local fixtures only: proposing its
// actions, holding a post until its time slot, handing back a post that started early, the open-target read, and the refusals (another
// agent's social action, an automatically approved budget change). Nothing reaches Meta.
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
const store = sqlAgentStore(pool, { fenced: true, growth: true, social: true, socialVideo: true });

const run = randomUUID().slice(0, 8);
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const original = await row("select status, autonomy, config from private.agents where key = 'social_manager'");
assert.ok(original, 'The Social Media Manager is seeded');
const tasks = [];
let videoBrief = null;
// The owner who approves the founder post below: an owner's approval records who decided (decided_by).
const owner = randomUUID();
async function runningTask(agent, kind) {
  const created = await row("insert into private.agent_tasks (agent_key, kind, request_key, status, claimed_at, lease_until, attempts) values ($1, $2, $3, 'running', now(), now() + interval '10 minutes', 1) returning id", [agent, kind, `social-it-${run}-${tasks.length}`]);
  tasks.push(created.id);
  return created.id;
}

try {
  await admin.query("update private.agents set status = 'active', autonomy = 'propose', config = jsonb_set(config, '{auto_approve_kinds}', '[]') where key = 'social_manager'");
  const plan = await runningTask('social_manager', 'social.plan');
  const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const post = await store.proposeAction({ taskId: plan, kind: 'social.post', targetKind: 'social_post', targetId: `facebook:${run}:1`, preview: 'A post',
    input: { platform: 'facebook', product: 'carebase', message: 'A post', link: null, imageUrl: null, scheduledFor: later } });
  assert.equal(post.status, 'proposed');
  assert.equal(await store.socialSchedule(post.id, null), true, 'A proposed post is held');
  const held = await row('select not_before from private.agent_actions where id = $1', [post.id]);
  assert.ok(Math.abs(held.not_before.getTime() - Date.parse(later)) < 1000, 'until its time slot');
  assert.ok((await store.socialOpenTargets()).includes(`social.post:facebook:${run}:1`), 'and is an open target');

  // Approved, it does not start before its slot; once started early it is handed back with the same hold.
  await admin.query("update private.agent_actions set status = 'approved', decided_at = now() where id = $1", [post.id]);
  assert.equal(await store.beginExecution(post.id), null, 'An approved post does not start before its time slot');
  await admin.query('update private.agent_actions set not_before = null where id = $1', [post.id]);
  const execution = await store.beginExecution(post.id);
  assert.ok(execution, 'It starts once nothing holds it');
  assert.equal(await store.deferExecution(post.id, execution.execution, 'social.post'), true, 'An early start is handed back');
  const back = await row('select status, not_before from private.agent_actions where id = $1', [post.id]);
  assert.ok(['approved', 'auto_approved'].includes(back.status), 'back to its approved state');
  assert.ok(back.not_before.getTime() > Date.now() + 3_600_000, 'with its hold restored');

  // A post for the founder's own profile waits for its slot the same way (20261113260000).
  const founderDay = `2099-${String(1 + (parseInt(run.slice(0, 2), 16) % 12)).padStart(2, '0')}-${String(1 + (parseInt(run.slice(2, 4), 16) % 28)).padStart(2, '0')}`;
  const founderPost = await store.proposeAction({ taskId: plan, kind: 'social.founder_post', targetKind: 'social_item', targetId: `founder:${founderDay}:1`, preview: 'A founder post',
    input: { product: 'caremetric-intel', pillar: 'insight', message: 'A founder post', scheduledFor: later } });
  assert.equal(founderPost.status, 'proposed');
  assert.equal(await store.socialSchedule(founderPost.id, null), true, 'A founder post is held');
  const founderHeld = await row('select not_before from private.agent_actions where id = $1', [founderPost.id]);
  assert.ok(Math.abs(founderHeld.not_before.getTime() - Date.parse(later)) < 1000, 'until its time slot');
  await admin.query('insert into auth.users (id, email, is_anonymous) values ($1, $2, false)', [owner, `social-it-owner-${run}@test.invalid`]);
  await admin.query("update private.agent_actions set status = 'approved', decided_at = now(), decided_by = $2 where id = $1", [founderPost.id, owner]);
  assert.equal(await store.beginExecution(founderPost.id), null, 'An approved founder post does not publish before its slot');
  await admin.query('update private.agent_actions set not_before = null where id = $1', [founderPost.id]);
  const founderExecution = await store.beginExecution(founderPost.id);
  assert.ok(founderExecution, 'It starts once nothing holds it');
  assert.equal(await store.deferExecution(founderPost.id, founderExecution.execution, 'social.founder_post'), true, 'An early start is handed back');
  const founderBack = await row('select status, not_before from private.agent_actions where id = $1', [founderPost.id]);
  // The owner approved it, so it goes back to approved (one approved automatically under the owner's hand-over keeps that instead).
  assert.equal(founderBack.status, 'approved');
  assert.ok(founderBack.not_before.getTime() > Date.now() + 3_600_000, 'with its hold restored');

  // A budget change is never automatic, even for an agent on Act that lists it.
  await admin.query("update private.agents set autonomy = 'act', config = jsonb_set(config, '{auto_approve_kinds}', '[\"social.ad_budget\", \"social.ad_pause\"]') where key = 'social_manager'");
  const ads = await runningTask('social_manager', 'social.ads');
  await assert.rejects(store.proposeAction({ taskId: ads, kind: 'social.ad_budget', targetKind: 'social_adset', targetId: `${run}`, preview: 'Raise', input: { adsetId: '40', from: 2000, to: 2400 } }),
    error => error.code === '23514', 'An automatically approved budget change is refused');
  const pause = await store.proposeAction({ taskId: ads, kind: 'social.ad_pause', targetKind: 'social_ad', targetId: `5${run.replace(/\D/g, '')}1`, preview: 'Pause', input: { adId: '51' } });
  assert.equal(pause.status, 'auto_approved', 'A handed-over pause is approved automatically');
  assert.equal(await store.socialSchedule(pause.id, null), false, 'Only a post can be held');

  // Another agent cannot propose a social action.
  const brief = await runningTask('chief_of_staff', 'brief.daily');
  await assert.rejects(store.proposeAction({ taskId: brief, kind: 'social.post', targetKind: 'social_post', targetId: `x-${run}`, preview: 'A post', input: {} }), error => error.code === '23514');

  // Video provider state is private, fenced, asset-bound, and never resets an uncertain upload or publish.
  await admin.query("update private.agents set autonomy = 'propose', config = jsonb_set(config, '{auto_approve_kinds}', '[]') where key = 'social_manager'");
  videoBrief = (await row("insert into private.creative_briefs(product,goal,audience,platforms,formats,source,request_key) values('carebase','Explain training','Administrators',array['meta'],array['video'],'owner',$1) returning id", [`social-video:${run}`])).id;
  const publicToken = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
  const video = await row(`insert into private.creative_assets(brief_id,product,platform,placement,kind,layout,width,height,duration_seconds,variant_label,hook_type,status,public_token,content_type)
    values($1,'carebase','meta','meta.video_vertical','video','headline',1080,1920,15,'A','problem','approved',$2,'video/mp4') returning id`, [videoBrief, publicToken]);
  const videoPost = await store.proposeAction({ taskId: plan, kind: 'social.post', targetKind: 'social_post', targetId: `instagram:${run}:video`, preview: 'Approved video',
    input: { platform: 'instagram', product: 'carebase', message: 'Training in one place.', videoUrl: `https://hub.example.test/api/creative/a/${publicToken}.mp4`, creativeAssetId: video.id, scheduledFor: new Date(Date.now() - 1000).toISOString() } });
  await admin.query("update private.agent_actions set status = 'approved', decided_at = now() where id = $1", [videoPost.id]);
  const firstVideo = await store.beginExecution(videoPost.id);
  assert.equal((await store.socialVideoStage(videoPost.id, firstVideo.execution)).phase, 'new');
  await admin.query('update private.creative_assets set content_type = null where id = $1', [video.id]);
  await assert.rejects(store.socialVideoStage(videoPost.id, firstVideo.execution), error => error.code === '55000', 'A video without MP4 metadata is refused');
  await admin.query("update private.creative_assets set content_type = 'video/mp4' where id = $1", [video.id]);
  await assert.rejects(store.socialVideoStage(videoPost.id, firstVideo.execution + 1), error => error.code === '55000', 'A stale or invented execution is refused');
  await assert.rejects(store.socialVideoStage(videoPost.id, firstVideo.execution, 'published', '900'), error => error.code === '55000', 'Publishing cannot skip uploading');
  assert.equal((await store.socialVideoStage(videoPost.id, firstVideo.execution, 'uploading')).phase, 'uploading');
  await assert.rejects(store.socialVideoStage(videoPost.id, firstVideo.execution, 'uploading'), error => error.code === '55000', 'An upload is never attempted twice');
  assert.equal((await store.socialVideoStage(videoPost.id, firstVideo.execution, 'processing', '900')).providerId, '900');
  assert.equal(await store.deferExecution(videoPost.id, firstVideo.execution, 'social.post'), true);
  await admin.query('update private.agent_actions set not_before = null where id = $1', [videoPost.id]);
  const nextVideo = await store.beginExecution(videoPost.id);
  assert.equal((await store.socialVideoStage(videoPost.id, nextVideo.execution)).providerId, '900', 'A retry resumes the same provider video');
  await assert.rejects(store.socialVideoStage(videoPost.id, firstVideo.execution), error => error.code === '55000');
  await admin.query("update private.creative_assets set status = 'retired', public_token = null where id = $1", [video.id]);
  await assert.rejects(store.socialVideoStage(videoPost.id, nextVideo.execution, 'publishing'), error => error.code === '55000', 'A retired video cannot publish');
  await admin.query("update private.creative_assets set status = 'approved', public_token = $2 where id = $1", [video.id, publicToken]);
  await store.socialVideoStage(videoPost.id, nextVideo.execution, 'publishing');
  await assert.rejects(store.socialVideoStage(videoPost.id, nextVideo.execution, 'processing', '900'), error => error.code === '55000', 'An uncertain publish never rolls back to processing');
  assert.equal((await store.socialVideoStage(videoPost.id, nextVideo.execution, 'published', '901')).publishedId, '901');
  await assert.rejects(pool.query('select * from private.social_video_publications'), error => error.code === '42501');
  await assert.rejects(admin.query('select private.social_video_stage($1,1,$2,null)', [videoPost.id, 'read']), error => error.code === '42501');

  await assert.rejects(admin.query('select private.social_open_targets()'), error => error.code === '42501', 'Only the Hub server reads open targets');
  console.log('Social Media Manager database checks passed.');
} finally {
  if (videoBrief) {
    await admin.query('delete from private.creative_assets where brief_id = $1', [videoBrief]);
    await admin.query('delete from private.creative_briefs where id = $1', [videoBrief]);
  }
  await admin.query('delete from private.agent_runs where task_id = any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_actions where task_id = any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_tasks where id = any($1::uuid[])', [tasks]);
  await admin.query("update private.agents set status = $1, autonomy = $2, config = $3 where key = 'social_manager'", [original.status, original.autonomy, original.config]);
  await admin.query('delete from auth.users where id = $1', [owner]);
  await Promise.all([pool.end(), admin.end()]);
}
