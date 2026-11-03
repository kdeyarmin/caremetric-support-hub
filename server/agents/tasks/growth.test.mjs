import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkForm, growthFeature, growthHandlers, probeSignature } from './growth.mjs';

const feature = new Set(['platform.agents.v1', growthFeature]);
const origin = 'https://hub.example.test';
const ids = { demo: '11111111-1111-4111-8111-111111111111', trial: '22222222-2222-4222-8222-222222222222', news: '33333333-3333-4333-8333-333333333333', trial2: '44444444-4444-4444-8444-444444444444' };
const secrets = { carebase: 'c'.repeat(64), intel: 'i'.repeat(64), advisors: null };
const forms = [
  { key: 'carebase_forms', source: 'carebase', label: 'CareBase lead form', url: 'https://forms.example.test/carebase', body: { name: 'CareMetric Form Check', email: 'probe@caremetric.invalid' }, form: true, timeoutSeconds: 1 },
  { key: 'intel_forms', source: 'intel', label: 'Intel lead form', url: 'https://forms.example.test/intel', body: { name: 'CareMetric Form Check' }, form: true, timeoutSeconds: 1 },
  { key: 'advisors_forms', source: 'advisors', label: 'Advisors consultation form', url: 'https://forms.example.test/advisors', body: {}, form: true, timeoutSeconds: 1 },
];
const trialLead = (id = ids.trial, overrides = {}) => ({
  id, kind: 'trial_signup', source: 'carebase', test: false, receivedAt: '2026-11-03T14:05:00Z', productSlug: 'carebase', organization: 'Sunrise Assisted Living Facility',
  details: { plan: 'complete' }, attribution: { source: 'google', medium: 'cpc', campaign: null, landingPath: '/pricing' }, reference: null, ...overrides,
});
const sent = (results = ['email:sent']) => results.map(entry => { const [channel, delivery, original] = entry.split(':'); return { channel, delivery, ...(original ? { original } : {}) }; });

const fixture = ({ pending = [], leads = {}, unanswered = [], facts = {}, seen = true, deliveries = {}, fetchImpl = vi.fn(), leadSecrets = secrets, features = feature } = {}) => {
  const alerts = [];
  const logs = [];
  const store = {
    growthPending: vi.fn(async () => pending),
    growthLead: vi.fn(async id => leads[id] ?? null),
    growthMarkSeen: vi.fn(async list => list.length),
    growthUnanswered: vi.fn(async () => unanswered),
    growthFacts: vi.fn(async () => facts),
    leadProbeSeen: vi.fn(async () => seen),
    probeRecord: vi.fn(async ({ targetKey }) => ({ target: targetKey, state: 'up', transition: 'none', failures: 0, incident: 0, taskId: null })),
    startRun: vi.fn(async () => 'run-1'),
    finishRun: vi.fn(async () => undefined),
  };
  const notifier = { send: vi.fn(async input => { alerts.push(input); return sent(deliveries[input.dedupeKey] ?? ['email:sent']); }) };
  const handlers = growthHandlers({ store, notifier, publicOrigin: origin, features, leadSecrets, formTargets: forms, fetchImpl, log: line => logs.push(line) });
  return { store, notifier, alerts, logs, handlers };
};
const task = (kind, overrides = {}) => ({
  id: 't1', agentKey: kind === 'probe.forms' ? 'platform_engineer' : 'growth_manager', kind, attempts: 1, sourceKind: 'schedule',
  requestKey: 'schedule:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:20261103T143000Z', payload: {}, agent: { autonomy: 'observe', config: {} }, ...overrides,
});
const at = iso => ({ now: () => new Date(iso) });

describe('registering the Growth Manager', () => {
  it('registers its work only when the database declares its feature', () => {
    for (const features of [undefined, null, new Set(), new Set(['platform.agents.v1']), ['platform.agents.v1'], growthFeature]) {
      expect(Object.keys(growthHandlers({ store: {}, notifier: {}, features })), String(features)).toEqual([]);
    }
    for (const features of [feature, [growthFeature]]) {
      expect(Object.keys(growthHandlers({ store: {}, notifier: {}, features })).sort()).toEqual(['growth.followup', 'growth.leads', 'growth.weekly', 'probe.forms']);
    }
  });
});

describe('new leads', () => {
  it('emails the owner about a trial at once, under the lead\'s own key, and leaves the rest to the Concierge and the brief', async () => {
    const harness = fixture({
      pending: [{ id: ids.demo, kind: 'demo_request', source: 'carebase' }, { id: ids.trial, kind: 'trial_signup', source: 'carebase' }, { id: ids.news, kind: 'newsletter', source: 'intel' }],
      leads: { [ids.trial]: trialLead() },
    });
    const outcome = await harness.handlers['growth.leads'](task('growth.leads'), at('2026-11-03T14:31:00Z'));
    expect(harness.store.growthPending).toHaveBeenCalledWith({ limit: 50, windowHours: 24 });
    expect(harness.store.growthLead).toHaveBeenCalledTimes(1);
    expect(harness.alerts).toHaveLength(1);
    expect(harness.alerts[0]).toMatchObject({
      severity: 'warning', subject: 'New CareBase trial: Sunrise Assisted Living Facility', dedupeKey: `growth:trial:${ids.trial}`, agentKey: 'growth_manager', taskId: 't1',
    });
    expect(harness.alerts[0].body).toContain('Plan: complete. Came from google (cpc), landing page /pricing.');
    expect(harness.alerts[0].blocks.at(-1)).toEqual({ type: 'button', label: 'Open Leads', url: `${origin}/admin/leads` });
    expect(harness.store.growthMarkSeen).toHaveBeenCalledWith([ids.demo, ids.trial, ids.news]);
    expect(outcome).toEqual({ result: { seen: 3, trials: 1, conversations: 1, digest: 1, delivery: ['email:sent'] } });
    expect(harness.store.startRun).toHaveBeenCalledWith('t1', 'none', 'growth.1');
    expect(harness.store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {},
      'Looked at 3 new leads: 1 trial alerted (email:sent), 1 left to the Support Concierge, 1 for the brief.', null);
  });

  it('leaves a trial whose alert the provider refused unseen and asks the scheduler to try again, after handling the rest', async () => {
    const harness = fixture({
      pending: [{ id: ids.trial, kind: 'trial_signup', source: 'carebase' }, { id: ids.trial2, kind: 'trial_signup', source: 'intel' }],
      leads: { [ids.trial]: trialLead(), [ids.trial2]: trialLead(ids.trial2, { source: 'intel', productSlug: 'caremetric-intel' }) },
      deliveries: { [`growth:trial:${ids.trial}`]: ['email:failed'] },
    });
    await expect(harness.handlers['growth.leads'](task('growth.leads'), at('2026-11-03T14:31:00Z'))).rejects.toMatchObject({ code: 'notification_failed', transient: true });
    expect(harness.alerts.map(alert => alert.subject)).toEqual(['New CareBase trial: Sunrise Assisted Living Facility', 'New CareMetric Intel trial: Sunrise Assisted Living Facility']);
    expect(harness.store.growthMarkSeen).toHaveBeenCalledWith([ids.trial2]);
    expect(harness.store.finishRun.mock.calls[0][1]).toBe('failed');
    expect(harness.store.finishRun.mock.calls[0][3]).toContain('1 alert refused, tried again shortly');
  });

  it('sets aside a trial whose alert used up its tries or had nowhere to go, and says it was not delivered', async () => {
    for (const result of [['email:duplicate:failed'], ['email:suppressed'], ['email:unknown']]) {
      const harness = fixture({ pending: [{ id: ids.trial, kind: 'trial_signup', source: 'carebase' }], leads: { [ids.trial]: trialLead() }, deliveries: { [`growth:trial:${ids.trial}`]: result } });
      const outcome = await harness.handlers['growth.leads'](task('growth.leads'), at('2026-11-03T14:31:00Z'));
      expect(harness.store.growthMarkSeen, result[0]).toHaveBeenCalledWith([ids.trial]);
      expect(outcome.result.trials).toBe(1);
      expect(harness.store.finishRun.mock.calls[0].slice(1, 2).concat(harness.store.finishRun.mock.calls[0][4]), result[0]).toEqual(['failed', 'not_delivered']);
    }
    // One reached by an earlier attempt is delivered.
    const before = fixture({ pending: [{ id: ids.trial, kind: 'trial_signup', source: 'carebase' }], leads: { [ids.trial]: trialLead() }, deliveries: { [`growth:trial:${ids.trial}`]: ['email:duplicate:sent'] } });
    await before.handlers['growth.leads'](task('growth.leads'), at('2026-11-03T14:31:00Z'));
    expect(before.store.finishRun.mock.calls[0][1]).toBe('completed');
  });

  it('never alerts about a test lead or one that is gone, and marks both seen', async () => {
    const harness = fixture({ pending: [{ id: ids.trial, kind: 'trial_signup', source: 'carebase' }, { id: ids.trial2, kind: 'trial_signup', source: 'carebase' }], leads: { [ids.trial]: trialLead(ids.trial, { test: true }) } });
    const outcome = await harness.handlers['growth.leads'](task('growth.leads'), at('2026-11-03T14:31:00Z'));
    expect(harness.alerts).toHaveLength(0);
    expect(harness.store.growthMarkSeen).toHaveBeenCalledWith([ids.trial, ids.trial2]);
    expect(outcome.result).toMatchObject({ seen: 2, trials: 0 });
  });

  it('records a run only when something arrived, plus one at the top of each hour', async () => {
    const quiet = fixture();
    expect(await quiet.handlers['growth.leads'](task('growth.leads'), at('2026-11-03T14:31:00Z'))).toEqual({ result: { seen: 0, trials: 0, conversations: 0, digest: 0, delivery: [] } });
    expect(quiet.store.startRun).not.toHaveBeenCalled();
    expect(quiet.store.growthMarkSeen).not.toHaveBeenCalled();
    const pulse = fixture();
    await pulse.handlers['growth.leads'](task('growth.leads'), at('2026-11-03T15:02:00Z'));
    expect(pulse.store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, 'No new leads.', null);
  });

  it('sends nothing when the scheduler stops it while a lead is being read', async () => {
    const controller = new AbortController();
    const harness = fixture({ pending: [{ id: ids.trial, kind: 'trial_signup', source: 'carebase' }] });
    harness.store.growthLead.mockImplementation(async () => { controller.abort(); return trialLead(); });
    await expect(harness.handlers['growth.leads'](task('growth.leads'), { ...at('2026-11-03T14:31:00Z'), signal: controller.signal })).rejects.toMatchObject({ code: 'task_timeout', transient: true });
    expect(harness.store.growthLead).toHaveBeenCalledTimes(1);
    expect(harness.alerts).toHaveLength(0);
    expect(harness.store.growthMarkSeen).not.toHaveBeenCalled();
  });

  it('stops before alerting once the scheduler has stopped it, and marks nothing', async () => {
    const harness = fixture({ pending: [{ id: ids.trial, kind: 'trial_signup', source: 'carebase' }], leads: { [ids.trial]: trialLead() } });
    const controller = new AbortController();
    controller.abort();
    await expect(harness.handlers['growth.leads'](task('growth.leads'), { ...at('2026-11-03T14:31:00Z'), signal: controller.signal })).rejects.toMatchObject({ code: 'task_timeout' });
    expect(harness.alerts).toHaveLength(0);
    expect(harness.store.growthMarkSeen).not.toHaveBeenCalled();
  });

  it('keeps contact details out of everything it stores, because it never has them', async () => {
    const harness = fixture({ pending: [{ id: ids.trial, kind: 'trial_signup', source: 'carebase' }], leads: { [ids.trial]: trialLead() } });
    const outcome = await harness.handlers['growth.leads'](task('growth.leads'), at('2026-11-03T14:31:00Z'));
    expect(JSON.stringify([outcome, harness.store.finishRun.mock.calls, harness.logs])).not.toMatch(/Sunrise|@/);
  });
});

describe('reminders about unanswered leads', () => {
  const waiting = (overrides = {}) => ({ leadId: ids.demo, kind: 'demo_request', product: 'carebase', reference: 'CM-1042', minutesWaiting: 75, step: 60, ...overrides });

  it('reminds the owner once per lead and step, by email, naming the reference, kind, product and wait', async () => {
    const harness = fixture({ unanswered: [waiting(), waiting({ leadId: ids.trial2, kind: 'consultation', product: 'advisors', reference: 'CM-1043', minutesWaiting: 1500, step: 1440 })] });
    const outcome = await harness.handlers['growth.followup'](task('growth.followup'), at('2026-11-03T15:00:00Z'));
    // The steps go to the database, which leaves out those already reminded before it limits the list; a lead is chased for a week.
    expect(harness.store.growthUnanswered).toHaveBeenCalledWith({ steps: [60, 1440], maxMinutes: 10080, limit: 50 });
    expect(harness.alerts).toEqual([
      expect.objectContaining({ severity: 'warning', subject: 'Still unanswered after 1 hour: demo request CM-1042', dedupeKey: `growth:followup:${ids.demo}:60`, agentKey: 'growth_manager', taskId: 't1' }),
      expect.objectContaining({ severity: 'warning', subject: 'Still unanswered after 24 hours: consultation request CM-1043', dedupeKey: `growth:followup:${ids.trial2}:1440` }),
    ]);
    expect(harness.alerts[0].body).toContain('A CareBase demo request (CM-1042) has waited 1 hour 15 minutes for a first reply.');
    expect(harness.alerts[1].body).toContain('A Healthcare Advisors consultation request (CM-1043) has waited 25 hours for a first reply.');
    expect(outcome).toEqual({ result: { waiting: 2, reminded: 2, alreadyReminded: 0, delivery: ['email:sent', 'email:sent'] } });
    expect(harness.store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {},
      'Reminded you about 2 unanswered leads: CM-1042 (demo request), CM-1043 (consultation request) (email:sent, email:sent).', null);
  });

  it('reminds at the step the database names, the largest a lead has reached, so one found late is not reminded twice at once', async () => {
    const harness = fixture({ unanswered: [waiting({ minutesWaiting: 3000, step: 1440 })] });
    await harness.handlers['growth.followup'](task('growth.followup'), at('2026-11-03T15:00:00Z'));
    expect(harness.alerts.map(alert => alert.dedupeKey)).toEqual([`growth:followup:${ids.demo}:1440`]);
    // A step the database could not have chosen from these steps is worked out here instead.
    const odd = fixture({ unanswered: [waiting({ minutesWaiting: 3000, step: 999 }), waiting({ leadId: ids.trial2, minutesWaiting: 70, step: undefined })] });
    await odd.handlers['growth.followup'](task('growth.followup'), at('2026-11-03T15:00:00Z'));
    expect(odd.alerts.map(alert => alert.dedupeKey)).toEqual([`growth:followup:${ids.demo}:1440`, `growth:followup:${ids.trial2}:60`]);
  });

  it('follows the agent\'s own steps, and chases for a week or a day past the largest step', async () => {
    const harness = fixture({ unanswered: [waiting({ minutesWaiting: 35, step: 30 })] });
    await harness.handlers['growth.followup'](task('growth.followup', { agent: { config: { followup_minutes: [30, 240] } } }), at('2026-11-03T15:00:00Z'));
    expect(harness.store.growthUnanswered).toHaveBeenCalledWith({ steps: [30, 240], maxMinutes: 10080, limit: 50 });
    expect(harness.alerts[0]).toMatchObject({ subject: 'Still unanswered after 30 minutes: demo request CM-1042', dedupeKey: `growth:followup:${ids.demo}:30` });
    for (const [steps, maxMinutes] of [[[60, 20160], 21600], [[43200], 44640]]) {
      const long = fixture();
      await long.handlers['growth.followup'](task('growth.followup', { agent: { config: { followup_minutes: steps } } }), at('2026-11-03T15:00:00Z'));
      expect(long.store.growthUnanswered, JSON.stringify(steps)).toHaveBeenCalledWith({ steps, maxMinutes, limit: 50 });
    }
  });

  it('records no run when another run sent the same reminders first', async () => {
    const harness = fixture({ unanswered: [waiting()], deliveries: { [`growth:followup:${ids.demo}:60`]: ['email:duplicate:sent'] } });
    const outcome = await harness.handlers['growth.followup'](task('growth.followup'), at('2026-11-03T15:00:00Z'));
    expect(outcome.result).toEqual({ waiting: 1, reminded: 0, alreadyReminded: 1, delivery: [] });
    expect(harness.store.startRun).not.toHaveBeenCalled();
  });

  it('works through more than one run\'s worth of waiting leads, because reminded steps no longer come back', async () => {
    // Fifty-five lead conversations wait. The database lists at most fifty, never one whose step was reminded.
    const all = Array.from({ length: 55 }, (_, index) => waiting({ leadId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, reference: `CM-${2000 + index}`, minutesWaiting: 100 + index }));
    const reminded = new Set();
    const harness = fixture();
    harness.store.growthUnanswered.mockImplementation(async ({ limit }) => all.filter(item => !reminded.has(item.leadId)).slice(0, limit));
    harness.notifier.send.mockImplementation(async input => { reminded.add(input.dedupeKey.split(':')[2]); return sent(); });
    const first = await harness.handlers['growth.followup'](task('growth.followup'), at('2026-11-03T15:00:00Z'));
    const second = await harness.handlers['growth.followup'](task('growth.followup'), at('2026-11-03T15:15:00Z'));
    const third = await harness.handlers['growth.followup'](task('growth.followup'), at('2026-11-03T15:30:00Z'));
    expect([first.result.reminded, second.result.reminded, third.result.reminded]).toEqual([50, 5, 0]);
    expect(new Set(harness.notifier.send.mock.calls.map(([input]) => input.dedupeKey)).size).toBe(55);
    expect(harness.store.finishRun.mock.calls[0][3]).toMatch(/^Reminded you about 50 unanswered leads: CM-2000 \(demo request\), .+, and more \(email:sent/);
  });

  it('sends nothing during quiet hours and says when they end, without even asking the database', async () => {
    const harness = fixture({ unanswered: [waiting()] });
    const outcome = await harness.handlers['growth.followup'](task('growth.followup'), at('2026-11-04T03:00:00Z'));
    expect(outcome).toEqual({ result: { skipped: 'quiet_hours', resumesAt: '2026-11-04T12:00:00.000Z' } });
    expect(harness.store.growthUnanswered).not.toHaveBeenCalled();
    expect(harness.alerts).toHaveLength(0);
    // The agent's own quiet hours, in its own zone.
    const late = fixture({ unanswered: [waiting()] });
    const own = { agent: { config: { quiet_hours: { start: '23:00', end: '06:00', timezone: 'America/Los_Angeles' } } } };
    expect((await late.handlers['growth.followup'](task('growth.followup', own), at('2026-11-04T03:00:00Z'))).result.reminded).toBe(1);
    expect((await late.handlers['growth.followup'](task('growth.followup', own), at('2026-11-04T08:00:00Z'))).result).toEqual({ skipped: 'quiet_hours', resumesAt: '2026-11-04T14:00:00.000Z' });
  });

  it('fails transiently when a reminder is refused, after sending the others, so the scheduler tries it again under the same key', async () => {
    const harness = fixture({
      unanswered: [waiting(), waiting({ leadId: ids.trial2, reference: 'CM-1043' })],
      deliveries: { [`growth:followup:${ids.demo}:60`]: ['email:failed'] },
    });
    await expect(harness.handlers['growth.followup'](task('growth.followup'), at('2026-11-03T15:00:00Z'))).rejects.toMatchObject({ code: 'notification_failed', transient: true });
    expect(harness.alerts.map(alert => alert.dedupeKey)).toEqual([`growth:followup:${ids.demo}:60`, `growth:followup:${ids.trial2}:60`]);
    expect(harness.store.finishRun.mock.calls[0][3]).toContain('(email:failed, email:sent)');
    // A reminder that used up its tries, or had nowhere to go, is not a reason to try again.
    for (const result of [['email:duplicate:failed'], ['email:suppressed'], ['email:unknown']]) {
      const settled = fixture({ unanswered: [waiting()], deliveries: { [`growth:followup:${ids.demo}:60`]: result } });
      await expect(settled.handlers['growth.followup'](task('growth.followup'), at('2026-11-03T15:00:00Z')), result[0]).resolves.toMatchObject({ result: expect.any(Object) });
    }
  });
});

describe('the weekly growth report', () => {
  const facts = {
    leads: { total: 2, byKind: { demo_request: 1, trial_signup: 1 }, byProduct: [{ product: 'carebase', count: 2 }], bySource: [{ source: 'google', count: 2 }], otherSources: 0, landingPaths: [], campaigns: [] },
    trials: { started: 1, subscriptions: 0, converted: 0 }, replies: { replied: 1, medianMinutes: 30 }, unanswered: { count: 0, byKind: {} },
  };
  const monday = 'schedule:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:20261109T123000Z';

  it('does Monday\'s work only, and only the day the task was due for counts', async () => {
    const harness = fixture({ facts });
    expect(await harness.handlers['growth.weekly'](task('growth.weekly', { requestKey: 'schedule:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:20261110T123000Z' }), at('2026-11-10T12:31:00Z')))
      .toEqual({ result: { skipped: 'not_monday' } });
    expect(harness.store.growthFacts).not.toHaveBeenCalled();
    // A Monday task retried after midnight is still Monday's.
    const retried = fixture({ facts });
    expect((await retried.handlers['growth.weekly'](task('growth.weekly', { requestKey: monday }), at('2026-11-10T05:30:00Z'))).result.week).toBe('2026-11-09');
  });

  it('emails the seven days before Monday under the week\'s key, once', async () => {
    const harness = fixture({ facts });
    const outcome = await harness.handlers['growth.weekly'](task('growth.weekly', { requestKey: monday }), at('2026-11-09T12:31:00Z'));
    expect(harness.store.growthFacts).toHaveBeenCalledWith({ since: new Date('2026-11-02T05:00:00Z'), until: new Date('2026-11-09T05:00:00Z') });
    expect(harness.alerts).toHaveLength(1);
    expect(harness.alerts[0]).toMatchObject({ severity: 'info', subject: 'Weekly growth: 2 leads, 1 trial started (Nov 2 to Nov 8)', dedupeKey: 'growth:weekly:2026-11-09', agentKey: 'growth_manager' });
    expect(outcome.result).toMatchObject({ week: '2026-11-09', since: '2026-11-02T05:00:00.000Z', until: '2026-11-09T05:00:00.000Z', delivery: ['email:sent'], leads: 2 });
    expect(outcome.result.suggestions).toHaveLength(3);
    expect(harness.store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, 'Sent the weekly growth report: 2 leads from Nov 2 to Nov 8: 1 demo request and 1 trial sign-up.', null);
  });

  it('finds the week already reported, or an earlier attempt unconfirmed, and sends nothing more', async () => {
    const done = fixture({ facts, deliveries: { 'growth:weekly:2026-11-09': ['email:duplicate:sent'] } });
    expect((await done.handlers['growth.weekly'](task('growth.weekly', { requestKey: monday }), at('2026-11-09T12:31:00Z'))).result).toEqual({ skipped: 'already_sent', week: '2026-11-09' });
    expect(done.store.startRun).not.toHaveBeenCalled();
    const unsure = fixture({ facts, deliveries: { 'growth:weekly:2026-11-09': ['email:duplicate:suppressed'] } });
    expect((await unsure.handlers['growth.weekly'](task('growth.weekly', { requestKey: monday }), at('2026-11-09T12:31:00Z'))).result).toEqual({ skipped: 'earlier_attempt_unconfirmed', week: '2026-11-09' });
  });

  it('reports on any day when the owner asks, under a key of its own', async () => {
    const harness = fixture({ facts });
    const outcome = await harness.handlers['growth.weekly'](task('growth.weekly', { id: 't9', sourceKind: 'owner', requestKey: 'owner:x' }), at('2026-11-04T18:00:00Z'));
    expect(harness.alerts[0].dedupeKey).toBe('growth:run:t9');
    expect(harness.store.growthFacts).toHaveBeenCalledWith({ since: new Date('2026-10-28T04:00:00Z'), until: new Date('2026-11-04T05:00:00Z') });
    expect(outcome.result.week).toBe('2026-11-02');
  });

  it('says on the Team screen when the report was written but not delivered', async () => {
    const harness = fixture({ facts, deliveries: { 'growth:weekly:2026-11-09': ['email:suppressed'] } });
    await harness.handlers['growth.weekly'](task('growth.weekly', { requestKey: monday }), at('2026-11-09T12:31:00Z'));
    expect(harness.store.finishRun).toHaveBeenCalledWith('run-1', 'failed', {}, 'The weekly growth report was written but not delivered (email:suppressed).', 'not_delivered');
  });

  it('reads and sends nothing once the scheduler has stopped it, and nothing after it stopped during the read', async () => {
    const stoppedBefore = new AbortController();
    stoppedBefore.abort();
    const before = fixture({ facts });
    await expect(before.handlers['growth.weekly'](task('growth.weekly', { requestKey: monday }), { ...at('2026-11-09T12:31:00Z'), signal: stoppedBefore.signal }))
      .rejects.toMatchObject({ code: 'task_timeout', transient: true });
    expect(before.store.growthFacts).not.toHaveBeenCalled();
    const during = new AbortController();
    const reading = fixture({ facts });
    reading.store.growthFacts.mockImplementation(async () => { during.abort(); return facts; });
    await expect(reading.handlers['growth.weekly'](task('growth.weekly', { requestKey: monday }), { ...at('2026-11-09T12:31:00Z'), signal: during.signal }))
      .rejects.toMatchObject({ code: 'task_timeout' });
    expect(reading.alerts).toHaveLength(0);
    expect(reading.store.startRun).not.toHaveBeenCalled();
  });

  it('fails transiently when the provider refuses the report, so the week is retried under its own key instead of lost', async () => {
    const harness = fixture({ facts });
    harness.notifier.send.mockResolvedValueOnce(sent(['email:failed']));
    await expect(harness.handlers['growth.weekly'](task('growth.weekly', { requestKey: monday }), at('2026-11-09T12:31:00Z')))
      .rejects.toMatchObject({ code: 'notification_failed', transient: true });
    expect(harness.store.finishRun).toHaveBeenCalledWith('run-1', 'failed', {}, 'The weekly growth report was written but not delivered (email:failed).', 'not_delivered');
    // The retry is still Monday's task, whatever the clock says, and goes out under the same key.
    const retried = await harness.handlers['growth.weekly'](task('growth.weekly', { requestKey: monday, attempts: 2 }), at('2026-11-10T05:10:00Z'));
    expect(retried.result).toMatchObject({ week: '2026-11-09', delivery: ['email:sent'] });
    expect(harness.notifier.send.mock.calls.map(([input]) => input.dedupeKey)).toEqual(['growth:weekly:2026-11-09', 'growth:weekly:2026-11-09']);
    // Once the notifier has used up its tries, a later run says so and stops.
    const spent = fixture({ facts, deliveries: { 'growth:weekly:2026-11-09': ['email:duplicate:failed'] } });
    expect((await spent.handlers['growth.weekly'](task('growth.weekly', { requestKey: monday, attempts: 4 }), at('2026-11-09T12:50:00Z'))).result)
      .toEqual({ skipped: 'earlier_attempt_unconfirmed', week: '2026-11-09' });
    // Run now is retried the same way.
    const asked = fixture({ facts, deliveries: { 'growth:run:t9': ['email:failed'] } });
    await expect(asked.handlers['growth.weekly'](task('growth.weekly', { id: 't9', sourceKind: 'owner', requestKey: 'owner:x' }), at('2026-11-04T18:00:00Z')))
      .rejects.toMatchObject({ code: 'notification_failed', transient: true });
  });
});

describe('checking a lead form', () => {
  const probeAnswer = (body, status = 200) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  const now = () => new Date('2026-11-03T14:30:00Z');

  it('signs the probe exactly as the contract says and sends the endpoint\'s own body', async () => {
    const fetchImpl = probeAnswer({ probe: true, forwarded: true, status: 202 });
    const check = await checkForm(forms[0], { secret: secrets.carebase, fetchImpl, now });
    expect(check).toMatchObject({ ok: true, statusCode: 200, failure: null, hubStatus: 202 });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://forms.example.test/carebase');
    expect(options).toMatchObject({ method: 'POST', redirect: 'manual', body: JSON.stringify(forms[0].body) });
    const timestamp = String(Math.floor(now().getTime() / 1000));
    expect(options.headers).toEqual({
      'content-type': 'application/json', accept: 'application/json', 'user-agent': 'CareMetric-Hub-Probe/1',
      'x-caremetric-probe': `v1=${createHmac('sha256', secrets.carebase).update(`${timestamp}.probe`).digest('hex')}`, 'x-caremetric-timestamp': timestamp,
    });
    expect(probeSignature('k'.repeat(32), '1700000000')).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(JSON.stringify(options.headers)).not.toContain(secrets.carebase);
  });

  it('names each way a form can fail', async () => {
    const cases = [
      [probeAnswer({ probe: true, forwarded: false, status: 401 }), { failure: 'not_forwarded', statusCode: 200, hubStatus: 401 }],
      [probeAnswer({ probe: true, forwarded: false, status: 0 }), { failure: 'not_forwarded', hubStatus: 0 }],
      [probeAnswer({ ok: true }), { failure: 'not_probe', statusCode: 200 }],
      [probeAnswer('not json'), { failure: 'not_probe' }],
      [probeAnswer({ probe: 'true', forwarded: true }), { failure: 'not_probe' }],
      [probeAnswer({ probe: true, forwarded: true }, 202), { failure: 'status', statusCode: 202 }],
      [probeAnswer({ error: 'Demo request verification is required' }, 400), { failure: 'status', statusCode: 400 }],
      [probeAnswer('', 503), { failure: 'status', statusCode: 503 }],
      [vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.test' } })), { failure: 'redirect', statusCode: 302 }],
      [vi.fn(async () => { throw new TypeError('fetch failed'); }), { failure: 'network', statusCode: 0 }],
      [vi.fn((url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))), { failure: 'timeout', statusCode: 0 }],
      [probeAnswer(`{"probe":true,"forwarded":true,"pad":"${'x'.repeat(5000)}"}`), { failure: 'not_probe' }],
    ];
    for (const [fetchImpl, expected] of cases) expect(await checkForm(forms[0], { secret: secrets.carebase, fetchImpl, now }), JSON.stringify(expected)).toMatchObject({ ok: false, ...expected });
  });

  it('passes a form whose test lead reached the Hub, and records it under the form\'s own key', async () => {
    const fetchImpl = probeAnswer({ probe: true, forwarded: true, status: 202 });
    const harness = fixture({ fetchImpl });
    const outcome = await harness.handlers['probe.forms'](task('probe.forms'), { now });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://forms.example.test/carebase', 'https://forms.example.test/intel']);
    expect(harness.store.leadProbeSeen.mock.calls.map(([call]) => call)).toEqual([
      { source: 'carebase', since: new Date('2026-11-03T14:20:00Z') }, { source: 'intel', since: new Date('2026-11-03T14:20:00Z') },
    ]);
    expect(harness.store.probeRecord.mock.calls.map(([call]) => [call.targetKey, call.ok, call.statusCode, call.failure, call.threshold, call.agentKey])).toEqual([
      ['carebase_forms', true, 200, null, 2, 'platform_engineer'], ['intel_forms', true, 200, null, 2, 'platform_engineer'],
    ]);
    expect(outcome.result).toMatchObject({ checked: 2, passed: 2, skipped: ['advisors_forms'], failing: [], transitions: [] });
    expect(harness.store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {},
      'CareBase lead form passed; Intel lead form passed. Skipped (no secret on the Hub): Advisors consultation form.', null);
  });

  it('fails a form whose test lead never arrived, even though it said it forwarded one', async () => {
    const harness = fixture({ fetchImpl: probeAnswer({ probe: true, forwarded: true, status: 202 }), seen: false });
    const outcome = await harness.handlers['probe.forms'](task('probe.forms'), { now });
    expect(harness.store.probeRecord.mock.calls.map(([call]) => [call.targetKey, call.ok, call.failure])).toEqual([['carebase_forms', false, 'not_received'], ['intel_forms', false, 'not_received']]);
    expect(outcome.result.failing).toEqual([
      { target: 'carebase_forms', failure: 'not_received', statusCode: 200, hubStatus: 202 }, { target: 'intel_forms', failure: 'not_received', statusCode: 200, hubStatus: 202 },
    ]);
  });

  it('does not ask whether a lead arrived when the form already failed, and words the Hub\'s answer', async () => {
    const harness = fixture({ fetchImpl: probeAnswer({ probe: true, forwarded: false, status: 401 }) });
    const outcome = await harness.handlers['probe.forms'](task('probe.forms'), { now });
    expect(harness.store.leadProbeSeen).not.toHaveBeenCalled();
    expect(outcome.result.summary).toBe('CareBase lead form did not forward the test lead (the Hub answered 401); Intel lead form did not forward the test lead (the Hub answered 401). Skipped (no secret on the Hub): Advisors consultation form.');
  });

  it('lists the incidents its results opened', async () => {
    const harness = fixture({ fetchImpl: probeAnswer('', 500) });
    harness.store.probeRecord.mockImplementation(async ({ targetKey }) => ({ target: targetKey, state: 'down', transition: targetKey === 'intel_forms' ? 'down' : 'none', failures: 2, incident: 4, taskId: 'x' }));
    expect((await harness.handlers['probe.forms'](task('probe.forms'), { now })).result.transitions).toEqual([{ target: 'intel_forms', transition: 'down', incident: 4 }]);
  });

  it('skips a product with no usable secret instead of failing it, and checks none when no product has one', async () => {
    const fetchImpl = vi.fn();
    const harness = fixture({ fetchImpl, leadSecrets: { carebase: 'short', intel: '', advisors: undefined } });
    const outcome = await harness.handlers['probe.forms'](task('probe.forms'), { now });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(harness.store.probeRecord).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({ checked: 0, passed: 0, skipped: ['carebase_forms', 'intel_forms', 'advisors_forms'] });
    expect(harness.store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, 'No lead form has its product\'s secret on the Hub, so none was checked.', null);
  });

  it('never keeps the secret or the answer anywhere', async () => {
    const harness = fixture({ fetchImpl: probeAnswer({ probe: true, forwarded: false, status: 503, detail: 'CANARY-ANSWER' }) });
    const outcome = await harness.handlers['probe.forms'](task('probe.forms'), { now });
    const everything = JSON.stringify([outcome, harness.store.probeRecord.mock.calls, harness.store.finishRun.mock.calls, harness.logs]);
    for (const secret of [secrets.carebase, secrets.intel, 'CANARY-ANSWER']) expect(everything).not.toContain(secret);
  });

  it('records nothing once the scheduler has stopped it', async () => {
    const controller = new AbortController();
    const harness = fixture({ fetchImpl: vi.fn(async () => { controller.abort(); return new Response(JSON.stringify({ probe: true, forwarded: true }), { status: 200 }); }) });
    await expect(harness.handlers['probe.forms'](task('probe.forms'), { now, signal: controller.signal })).rejects.toMatchObject({ code: 'task_timeout' });
    expect(harness.store.probeRecord).not.toHaveBeenCalled();
  });
});
