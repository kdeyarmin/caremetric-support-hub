import { describe, expect, it } from 'vitest';
import { sqlAgentStore } from './store.mjs';

const harness = (result = null) => {
  const calls = [];
  const pool = { connect: async () => ({ query: async (sql, args) => { if (/^select/.test(sql)) { calls.push([sql, args]); return { rows: [{ result }] }; } return { rows: [] }; }, release() {} }) };
  return { calls, store: sqlAgentStore(pool) };
};
const when = new Date('2026-11-02T13:00:00Z');

describe('agent store', () => {
  it('exposes durable video stages only when the database declares video publication', async () => {
    expect(harness().store.socialVideoStage).toBeUndefined();
    const calls = [];
    const pool = { connect: async () => ({ query: async (sql, args) => { if (/^select/.test(sql)) { calls.push([sql, args]); return { rows: [{ result: { phase: 'processing' } }] }; } return { rows: [] }; }, release() {} }) };
    const store = sqlAgentStore(pool, { socialVideo: true });
    expect(await store.socialVideoStage('a1', 2)).toEqual({ phase: 'processing' });
    await store.socialVideoStage('a1', 2, 'processing', 'provider-video');
    expect(calls).toEqual([
      ['select private.social_video_stage($1, $2, $3, $4) as result', ['a1', 2, 'read', null]],
      ['select private.social_video_stage($1, $2, $3, $4) as result', ['a1', 2, 'processing', 'provider-video']],
    ]);
  });

  it('re-checks a hand-over and reserves a live campaign\'s share only when the database declares the hand-over', async () => {
    expect(harness().store.actionTrusted).toBeUndefined();
    expect(harness().store.adsLaunchReserve).toBeUndefined();
    const calls = [];
    const pool = { connect: async () => ({ query: async (sql, args) => { if (/^select/.test(sql)) { calls.push([sql, args]); return { rows: [{ result: true }] }; } return { rows: [] }; }, release() {} }) };
    const store = sqlAgentStore(pool, { handover: true });
    expect(await store.actionTrusted('a1', 3)).toBe(true);
    await store.adsLaunchReserve('a1', 3, 1000, 500, 14);
    await store.adsLaunchRelease('a1', 3);
    expect(calls).toEqual([
      ['select private.agent_action_trusted($1, $2) as result', ['a1', 3]],
      ['select private.ads_launch_reserve($1, $2, $3, $4, $5) as result', ['a1', 3, 1000, 500, 14]],
      ['select private.ads_launch_release($1, $2) as result', ['a1', 3]],
    ]);
  });

  it('reads the Monday scorecard\'s setting and figures only when the database declares the scorecard', async () => {
    expect(harness().store.individualReports).toBeUndefined();
    expect(harness().store.scorecardFacts).toBeUndefined();
    const calls = [];
    const pool = { connect: async () => ({ query: async (sql, args) => { if (/^select/.test(sql)) { calls.push([sql, args]); return { rows: [{ result: false }] }; } return { rows: [] }; }, release() {} }) };
    const store = sqlAgentStore(pool, { scorecard: true });
    expect(await store.individualReports()).toBe(false);
    await store.scorecardFacts({ since: when, until: when });
    expect(calls).toEqual([
      ['select private.agent_individual_reports() as result', []],
      ['select private.agent_scorecard_facts($1, $2) as result', [when, when]],
    ]);
  });

  it('carries the external email claim and settlement execution fences to their private operations', async () => {
    const { store, calls } = harness();
    await store.externalEmailBeginSend({ actionId: 'a1', execution: 3, claim: false });
    await store.externalEmailBeginSend({ actionId: 'a1', execution: 3 });
    await store.externalEmailFinishSend({ actionId: 'a1', execution: 3, delivery: 'sent', providerMessageId: 'accepted-id' });
    await store.externalEmailFinishSend({ actionId: 'a1', execution: 3, delivery: 'unknown' });
    await store.externalEmailReady();
    await store.externalEmailReady({ limit: 5, recover: true });
    expect(calls).toEqual([
      ['select private.agent_external_email_begin_send($1, $2, $3) as result', ['a1', 3, false]],
      ['select private.agent_external_email_begin_send($1, $2, $3) as result', ['a1', 3, true]],
      ['select private.agent_external_email_finish_send($1, $2, $3, $4) as result', ['a1', 3, 'sent', 'accepted-id']],
      ['select private.agent_external_email_finish_send($1, $2, $3, $4) as result', ['a1', 3, 'unknown', null]],
      ['select private.agent_external_email_ready($1, $2) as result', [10, false]],
      ['select private.agent_external_email_ready($1, $2) as result', [5, true]],
    ]);
  });

  it('calls exactly one database operation per method, with its arguments in order', async () => {
    const { store, calls } = harness();
    await store.fireSchedules(['probe.sweep', 'brief.daily']);
    await store.maintenance();
    await store.claim(3, 600);
    await store.heartbeat('t1', 600);
    await store.finish('t1', 'queued', { result: { a: 1 }, errorCode: 'provider_outage', retryAt: when });
    await store.finish('t1', 'done');
    await store.enqueue('platform_engineer', 'probe.incident', 'incident:hub:1', { payload: { target: 'hub' }, priority: 1, sourceKind: 'probe', requiresSession: false });
    await store.sessionTasks(5);
    await store.claimSessionTask('t1', 600);
    await store.startRun('t1', 'claude-haiku-5-5', 'v1');
    await store.finishRun('r1', 'completed', { costCents: 1.5 }, 'Done.', null);
    await store.budget('chief_of_staff');
    await store.proposeAction({ taskId: 't1', runId: 'r1', kind: 'communication.reply', targetKind: 'communication', targetId: 'CM-1', preview: 'Hi', input: { body: 'Hi' } });
    await store.readyActions(10);
    await store.beginExecution('a1');
    await store.completeExecution('a1', true, { delivery: 'sent' });
    await store.notifyBegin({ channel: 'email', severity: 'info', subject: 'S', body: 'B', dedupeKey: 'k', agentKey: 'chief_of_staff' });
    await store.notifyFinish('n1', 'sent', 'SG1');
    await store.ownerContact();
    await store.briefFacts();
    await store.probeRecord({ targetKey: 'hub', ok: false, statusCode: 503, latencyMs: 90, failure: 'status' });
    await store.probeRecord({ targetKey: 'intel', ok: true, statusCode: 200, latencyMs: 40, threshold: 3, agentKey: 'platform_engineer' });
    await store.conciergePending();
    await store.conciergePending({ limit: 5, settleSeconds: 0, windowHours: 24, channels: ['email', 'chat'] });
    await store.communicationSnapshot({ id: 'c1' });
    await store.communicationSnapshot({ id: 'c1', requestKey: 'k1', messages: 3, chars: 500 });
    await store.notificationCount({ prefix: 'concierge:urgent:', channel: 'sms', since: when });
    await store.notificationCount({ prefix: 'concierge:new:', since: when });
    await store.accountsSnapshot();
    await store.accountsSnapshot({ limit: 50 });
    await store.lifecycleSnapshot();
    await store.lifecycleSnapshot({ limit: 1, tenant: 'maple-grove', product: 'carebase' });
    await store.lifecycleSnapshot({ limit: 200, offset: 400 });
    await store.lifecycleBeginSend({ actionId: 'a1', execution: 2, unsubscribeHash: 'h'.repeat(64) });
    await store.lifecycleBeginSend({ actionId: 'a1', unsubscribeHash: null });
    await store.lifecycleFinishSend({ actionId: 'a1', delivery: 'sent', providerMessageId: 'SG1' });
    await store.lifecycleFinishSend({ actionId: 'a1', delivery: 'unknown' });
    expect(calls).toEqual([
      ['select private.agent_schedule_fire($1, $2) as result', [10, ['probe.sweep', 'brief.daily']]],
      ['select private.agent_maintenance() as result', []],
      ['select private.agent_task_claim($1, $2) as result', [3, 600]],
      ['select private.agent_task_heartbeat($1, $2) as result', ['t1', 600]],
      ['select private.agent_task_finish($1, $2, $3, $4, $5) as result', ['t1', 'queued', { a: 1 }, 'provider_outage', when]],
      ['select private.agent_task_finish($1, $2, $3, $4, $5) as result', ['t1', 'done', null, null, null]],
      ['select private.agent_task_enqueue($1, $2, $3, $4, $5, $6, $7, $8, $9) as result', ['platform_engineer', 'probe.incident', 'incident:hub:1', { target: 'hub' }, 1, null, 'probe', null, false]],
      ['select private.agent_session_tasks($1) as result', [5]],
      ['select private.agent_session_task_claim($1, $2) as result', ['t1', 600]],
      ['select private.agent_run_start($1, $2, $3) as result', ['t1', 'claude-haiku-5-5', 'v1']],
      ['select private.agent_run_finish($1, $2, $3, $4, $5) as result', ['r1', 'completed', { costCents: 1.5 }, 'Done.', null]],
      ['select private.agent_budget($1) as result', ['chief_of_staff']],
      ['select private.agent_action_propose($1, $2, $3, $4, $5, $6, $7) as result', ['t1', 'r1', 'communication.reply', 'communication', 'CM-1', 'Hi', { body: 'Hi' }]],
      ['select private.agent_actions_ready($1) as result', [10]],
      ['select private.agent_action_execution($1) as result', ['a1']],
      ['select private.agent_action_executed($1, $2, $3) as result', ['a1', true, { delivery: 'sent' }]],
      ['select private.agent_notify_begin($1, $2, $3, $4, $5, $6, $7) as result', ['email', 'info', 'S', 'B', 'k', 'chief_of_staff', null]],
      ['select private.agent_notify_finish($1, $2, $3) as result', ['n1', 'sent', 'SG1']],
      ['select private.owner_contact() as result', []],
      ['select private.agent_brief_facts() as result', []],
      ['select private.agent_probe_record($1, $2, $3, $4, $5, $6, $7) as result', ['hub', false, 503, 90, 'status', 2, 'platform_engineer']],
      ['select private.agent_probe_record($1, $2, $3, $4, $5, $6, $7) as result', ['intel', true, 200, 40, null, 3, 'platform_engineer']],
      ['select private.agent_concierge_pending($1, $2, $3, $4) as result', [10, 90, 72, null]],
      ['select private.agent_concierge_pending($1, $2, $3, $4) as result', [5, 0, 24, ['email', 'chat']]],
      ['select private.agent_communication_snapshot($1, $2, $3, $4) as result', ['c1', null, 0, 2000]],
      ['select private.agent_communication_snapshot($1, $2, $3, $4) as result', ['c1', 'k1', 3, 500]],
      ['select private.agent_notification_count($1, $2, $3) as result', ['concierge:urgent:', 'sms', when]],
      ['select private.agent_notification_count($1, $2, $3) as result', ['concierge:new:', null, when]],
      ['select private.agent_accounts_snapshot($1) as result', [200]],
      ['select private.agent_accounts_snapshot($1) as result', [50]],
      ['select private.agent_lifecycle_snapshot($1, $2, $3, $4) as result', [200, null, null, 0]],
      ['select private.agent_lifecycle_snapshot($1, $2, $3, $4) as result', [1, 'maple-grove', 'carebase', 0]],
      ['select private.agent_lifecycle_snapshot($1, $2, $3, $4) as result', [200, null, null, 400]],
      ['select private.agent_lifecycle_begin_send($1, $2, $3) as result', ['a1', 2, 'h'.repeat(64)]],
      ['select private.agent_lifecycle_begin_send($1, $2, $3) as result', ['a1', null, null]],
      ['select private.agent_lifecycle_finish_send($1, $2, $3) as result', ['a1', 'sent', 'SG1']],
      ['select private.agent_lifecycle_finish_send($1, $2, $3) as result', ['a1', 'unknown', null]],
    ]);
  });

  it('keeps the old call shapes against a database without the hardening operations, ignoring what it cannot carry', async () => {
    const { store, calls } = harness();
    expect(store.fenced).toBe(false);
    await store.heartbeat('t1', 600, 2);
    await store.finish('t1', 'done', { attempt: 2 });
    await store.readyActions(20, { kinds: ['communication.reply'], excludeKinds: null });
    await store.completeExecution('a1', true, { delivery: 'sent' }, 3);
    expect(await store.releaseExecution('a1', 3)).toBe(false);
    expect(calls.map(([sql]) => sql)).toEqual([
      'select private.agent_task_heartbeat($1, $2) as result',
      'select private.agent_task_finish($1, $2, $3, $4, $5) as result',
      'select private.agent_actions_ready($1) as result',
      'select private.agent_action_executed($1, $2, $3) as result',
    ]);
  });

  it('quotes the attempt, the kind filters and the execution number once the database declares the hardening feature', async () => {
    const calls = [];
    const pool = { connect: async () => ({ query: async (sql, args) => { if (/^select/.test(sql)) { calls.push([sql, args]); return { rows: [{ result: true }] }; } return { rows: [] }; }, release() {} }) };
    const store = sqlAgentStore(pool, { fenced: true });
    expect(store.fenced).toBe(true);
    await store.heartbeat('t1', 600, 2);
    await store.heartbeat('t1', 600);
    await store.finish('t1', 'queued', { errorCode: 'provider_outage', retryAt: when, attempt: 2 });
    await store.finish('t1', 'done');
    await store.readyActions(20, { kinds: null, excludeKinds: ['communication.reply'] });
    await store.readyActions(5);
    await store.completeExecution('a1', true, { delivery: 'sent' }, 3);
    await store.completeExecution('a1', true, { delivery: 'sent' });
    expect(await store.releaseExecution('a1', 3)).toBe(true);
    expect(await store.releaseExecution('a1')).toBe(false);
    expect(calls).toEqual([
      ['select private.agent_task_heartbeat($1, $2, $3) as result', ['t1', 600, 2]],
      ['select private.agent_task_heartbeat($1, $2) as result', ['t1', 600]],
      ['select private.agent_task_finish($1, $2, $3, $4, $5, $6) as result', ['t1', 'queued', null, 'provider_outage', when, 2]],
      ['select private.agent_task_finish($1, $2, $3, $4, $5) as result', ['t1', 'done', null, null, null]],
      ['select private.agent_actions_ready($1, $2, $3) as result', [20, null, ['communication.reply']]],
      ['select private.agent_actions_ready($1, $2, $3) as result', [5, null, null]],
      ['select private.agent_action_executed($1, $2, $3, $4) as result', ['a1', true, { delivery: 'sent' }, 3]],
      ['select private.agent_action_executed($1, $2, $3) as result', ['a1', true, { delivery: 'sent' }]],
      ['select private.agent_action_release($1, $2) as result', ['a1', 3]],
    ]);
  });

  it('reads the lead desk for the Growth Manager through its six operations, with their defaults', async () => {
    const { store, calls } = harness();
    const since = new Date('2026-11-02T05:00:00Z');
    await store.growthPending();
    await store.growthPending({ limit: 5, windowHours: 48 });
    await store.growthLead('l1');
    await store.growthMarkSeen(['l1', 'l2']);
    await store.growthUnanswered({ steps: [60, 1440], maxMinutes: 10080 });
    await store.growthUnanswered({ steps: [30], maxMinutes: 1500, limit: 10 });
    await store.growthFacts({ since, until: when });
    await store.leadProbeSeen({ source: 'carebase', since });
    expect(calls).toEqual([
      ['select private.agent_growth_pending($1, $2) as result', [50, 24]],
      ['select private.agent_growth_pending($1, $2) as result', [5, 48]],
      ['select private.agent_growth_lead($1) as result', ['l1']],
      ['select private.agent_growth_mark_seen($1) as result', [['l1', 'l2']]],
      ['select private.agent_growth_unanswered($1, $2, $3) as result', [[60, 1440], 10080, 50]],
      ['select private.agent_growth_unanswered($1, $2, $3) as result', [[30], 1500, 10]],
      ['select private.agent_growth_facts($1, $2) as result', [since, when]],
      ['select private.agent_lead_probe_seen($1, $2) as result', ['carebase', since]],
    ]);
  });

  it('reads the Content Marketer\'s state and publishes an approved article through its two server-only operations', async () => {
    const { store, calls } = harness({ outcome: 'published' });
    await store.contentState(['pa-fire-drills']);
    await store.contentState();
    expect(await store.contentPublish('a1', 2)).toEqual({ outcome: 'published' });
    await store.contentPublish('a1');
    expect(calls).toEqual([
      ['select private.agent_content_state($1) as result', [['pa-fire-drills']]],
      ['select private.agent_content_state($1) as result', [[]]],
      ['select private.agent_content_publish($1, $2) as result', ['a1', 2]],
      ['select private.agent_content_publish($1, $2) as result', ['a1', null]],
    ]);
  });

  it('reads due autonomy steps, switches one and records the announcement through the server-only operations', async () => {
    const { store, calls } = harness({ due: [], soon: [] });
    await store.autonomyDue();
    await store.autonomyGraduate('account_emails');
    await store.autonomyAnnounced('account_emails', '2026-11-11T22:00:00+00:00');
    expect(calls).toEqual([
      ['select private.agent_autonomy_due() as result', []],
      ['select private.agent_autonomy_graduate($1) as result', ['account_emails']],
      ['select private.agent_autonomy_announced($1, $2) as result', ['account_emails', '2026-11-11T22:00:00+00:00']],
    ]);
  });

  it('returns what the database returns', async () => {
    const { store } = harness([{ id: 't1' }]);
    expect(await store.claim(1, 60)).toEqual([{ id: 't1' }]);
  });
});
