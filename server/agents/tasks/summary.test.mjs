import { describe, expect, it, vi } from 'vitest';
import { actionList, composeSummary, easternAt, summaryFeature, summaryHandlers, summaryHour } from './summary.mjs';
import { briefHandlers } from './brief.mjs';
import { builtInHandlers } from './index.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
const features = new Set([summaryFeature]);
const facts = (overrides = {}) => ({
  generatedAt: '2026-11-18T22:00:00Z', approvals: { count: 0, oldestAt: null }, awaitingSession: 0, incidents: [], failedTasks: 0, undeliveredAlerts: 0,
  yesterday: { runs: 0, tasksDone: 0, tasksFailed: 0, actionsExecuted: 0, incidentsOpened: 0, incidentsClosed: 0, spendCents: 0 },
  agents: [], billing: { pastDue: 0, trialsEnding: 0 }, ...overrides,
});
const day = (overrides = {}) => ({
  since: '2026-11-17T22:00:00Z', until: '2026-11-18T22:00:00Z',
  day: { runs: 9, tasksDone: 120, tasksFailed: 1, actionsExecuted: 6, incidentsOpened: 0, incidentsClosed: 0, spendCents: 84 },
  work: [{ agent: 'support_concierge', name: 'Support Concierge', runs: 5, spendCents: 40 }, { agent: 'social_manager', name: 'Social Media Manager', runs: 3, spendCents: 0 }],
  executed: { 'communication.reply': 2, 'growth.message': 3, 'social.post': 1, 'incident.open': 1 },
  waiting: {},
  inbound: { messages: 7, conversations: 5, newConversations: 3, byChannel: { email: 4, chat: 1 } },
  outbound: { messages: 4, conversations: 3 },
  notifications: { held: [], heldCount: 0, sent: [], sentCount: 0 },
  ...overrides,
});
const evening = new Date('2026-11-18T22:00:00Z');

describe('the summary\'s words', () => {
  it('names what went out in the owner\'s words, most first, leaving bookkeeping out', () => {
    expect(actionList({ 'growth.message': 3, 'social.post': 1, 'communication.reply': 2, 'incident.open': 4, 'mystery.kind': 1 }))
      .toBe('3 prospect emails, 2 replies to customers, 1 social post and 1 other change');
    expect(actionList({ 'social.post': 1 })).toBe('1 social post');
    expect(actionList({ 'incident.resolve': 2 })).toBeNull();
    expect(actionList({})).toBeNull();
  });

  it('finds the summary hour on any day, through the clock changes', () => {
    expect(easternAt('2026-11-18', 17).toISOString()).toBe('2026-11-18T22:00:00.000Z');
    expect(easternAt('2026-07-01', 17).toISOString()).toBe('2026-07-01T21:00:00.000Z');
    expect(easternAt('2026-11-01', 23).toISOString()).toBe('2026-11-02T04:00:00.000Z');
    expect(summaryHour(18)).toBe(18);
    for (const value of [null, undefined, 11, 24, 17.5, '18']) expect(summaryHour(value), String(value)).toBe(17);
  });
});

describe('composing the end-of-day summary', () => {
  it('says plainly when nothing needs the owner, and what came in and went out', () => {
    const summary = composeSummary(facts(), day(), { now: evening, since: '2026-11-17T22:00:00Z', publicOrigin: origin });
    expect(summary.needsYou).toBe(0);
    expect(summary.subject).toBe('CareMetric end of day, Wed, Nov 18: nothing needs you');
    expect(summary.blocks[0]).toEqual({ type: 'callout', tone: 'success', title: 'All clear.', text: 'Nothing needs your decision right now.' });
    expect(summary.body).toContain('What the team did since Tue, Nov 17, 5:00 PM: 9 jobs done, 6 approved actions carried out, 1 task failed, AI spend $0.84.');
    expect(summary.body).toContain('What came in:\n- Customer messages: 7 messages in 5 conversations (3 new): 4 emails, 1 chat');
    expect(summary.body).toContain('What went out:\n- Replies sent from Communications: 4 messages in 3 conversations\n- Carried out by the team: 3 prospect emails, 2 replies to customers and 1 social post');
    expect(summary.blocks).toContainEqual({ type: 'details', rows: [['Support Concierge', '5 jobs done, $0.40 of AI'], ['Social Media Manager', '3 jobs done']] });
    expect(summary.blocks.at(-1)).toEqual({ type: 'button', label: 'Open the AI team', url: `${origin}/admin/team` });
  });

  it('puts what needs the owner first, with what the approvals are', () => {
    const summary = composeSummary(facts({ approvals: { count: 6, oldestAt: '2026-11-18T13:00:00Z' }, failedTasks: 1 }),
      day({ waiting: { 'social.post': 4, 'creative.asset': 1, 'growth.message': 1 } }), { now: evening, publicOrigin: origin });
    expect(summary.needsYou).toBe(2);
    expect(summary.subject).toBe('CareMetric end of day, Wed, Nov 18: 2 things need you');
    expect(summary.body.startsWith('2 things need you.\n\nNeeds you:\n- Waiting for your approval: 6 (oldest 9 hours): 4 social posts, 1 creative asset and 1 prospect email\n- Failed tasks in the last 24 hours: 1')).toBe(true);
    expect(summary.blocks[0]).toMatchObject({ type: 'callout', tone: 'warning', title: 'Needs your decision.' });
  });

  it('counts the messages still waiting for an answer, so a held message never reads as all clear', () => {
    const summary = composeSummary(facts({ approvals: { count: 2, oldestAt: '2026-11-18T20:00:00Z' } }),
      day({ unanswered: { count: 3, oldestAt: '2026-11-18T14:00:00Z' }, waiting: { 'communication.reply': 2 } }), { now: evening, publicOrigin: origin });
    expect(summary.needsYou).toBe(2);
    expect(summary.body).toContain('Needs you:\n- Waiting for your approval: 2 (oldest 2 hours): 2 replies to customers\n- Messages waiting for an answer: 3 (oldest 8 hours)');
    const only = composeSummary(facts(), day({ unanswered: { count: 1, oldestAt: '2026-11-18T21:30:00Z' } }), { now: evening });
    expect(only.subject).toBe('CareMetric end of day, Wed, Nov 18: 1 thing needs you');
    expect(only.blocks[0]).toMatchObject({ tone: 'warning', title: 'Needs your decision.' });
  });

  it('lists what was held instead of emailed, approval requests first, and what had to go at once', () => {
    const summary = composeSummary(facts(), day({ notifications: {
      held: [
        { subject: 'Social media weekly: 3 posts, $0.00 ad spend', attention: 'update', name: 'Social Media Manager', at: '2026-11-18T13:05:00Z' },
        { subject: 'Social plan: 4 posts to approve', attention: 'decision', name: 'Social Media Manager', at: '2026-11-18T13:15:00Z' },
      ],
      heldCount: 30,
      sent: [{ subject: 'Still unanswered after 4 hours: contact CM-1201', severity: 'warning', at: '2026-11-18T15:14:00Z' }], sentCount: 1,
    } }), { now: evening, publicOrigin: origin });
    expect(summary.body).toContain('Already emailed to you today because it could not wait:\n- 10:14 AM: Still unanswered after 4 hours: contact CM-1201');
    expect(summary.body).toContain([
      'Held for this summary instead of separate emails:', '- Social Media Manager: Social plan: 4 posts to approve',
      '- Social Media Manager: Social media weekly: 3 posts, $0.00 ad spend', '- …and 28 more on the AI team page.',
    ].join('\n'));
  });

  it('includes website leads and trials when growth is counted, and says when they could not be read', () => {
    const growth = { leads: { total: 2, byKind: { county_report: 1, contact: 1 } }, trials: { started: 1, subscriptions: 0 }, unanswered: { count: 0, oldestMinutes: null } };
    const summary = composeSummary(facts(), day(), { now: evening, publicOrigin: origin, growth });
    expect(summary.body).toMatch(/- Website leads: 2 \(/);
    expect(summary.body).toContain('- Trials: 1 sign-up, 0 new trial subscriptions');
    expect(composeSummary(facts(), day(), { now: evening, growth: { unavailable: true } }).body).toContain('- Website leads: Could not be read just now');
  });
});

describe('the end-of-day summary task', () => {
  // Fired at noon Eastern on Nov 18 (17:00 UTC).
  const scheduled = { id: 't1', agentKey: 'chief_of_staff', kind: 'summary.daily', sourceKind: 'schedule', requestKey: 'schedule:00000000-0000-4000-8000-000000000001:20261118T170000Z' };
  const fixture = ({ enabled = true, hour = 17, held = 0, cutoff = null, results = [{ channel: 'email', delivery: 'sent' }] } = {}) => {
    const store = {
      summaryFacts: vi.fn(async () => day({ notifications: { held: [], heldCount: held, sent: [], sentCount: 0 } })),
      summaryCutoff: vi.fn(async () => (cutoff instanceof Error ? Promise.reject(cutoff) : cutoff)),
      briefFacts: vi.fn(async () => facts()),
      startRun: vi.fn(async () => 'run-1'), finishRun: vi.fn(async () => {}),
    };
    const notifier = { send: vi.fn(async () => results) };
    const handlers = summaryHandlers({ store, notifier, publicOrigin: origin, features, settings: { enabled: () => enabled, hour: () => hour }, log: () => {} });
    return { store, notifier, run: (task, at) => handlers['summary.daily'](task, { now: () => at }) };
  };

  it('waits, queued, until the owner\'s hour', async () => {
    const { run, store, notifier } = fixture({ hour: 18 });
    const outcome = await run(scheduled, new Date('2026-11-18T17:00:30Z'));
    expect(outcome).toEqual({ status: 'queued', retryAt: new Date('2026-11-18T23:00:00Z'), result: { date: '2026-11-18', waitingUntil: '2026-11-18T23:00:00.000Z' } });
    expect(store.summaryFacts).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('then sends one summary for the 24 hours since the last, at once, under the day\'s key', async () => {
    const { run, store, notifier } = fixture();
    const outcome = await run(scheduled, new Date('2026-11-18T22:00:05Z'));
    expect(store.summaryFacts).toHaveBeenCalledWith({ since: new Date('2026-11-17T22:00:00Z'), until: new Date('2026-11-18T22:00:00Z') });
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'summary:2026-11-18', attention: 'now', agentKey: 'chief_of_staff', taskId: 't1' }));
    // It records where its window ended, for the next one to start from.
    expect(outcome).toEqual({ result: { date: '2026-11-18', until: '2026-11-18T22:00:00.000Z', needsYou: 0, held: 0, delivery: ['email:sent'] } });
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, 'Sent the end-of-day summary: Nothing needs your decision right now.', null);
  });

  it('sends nothing while switched off, unless updates were held before it was', async () => {
    const off = fixture({ enabled: false });
    expect(await off.run(scheduled, new Date('2026-11-18T22:01:00Z'))).toEqual({ result: { date: '2026-11-18', until: '2026-11-18T22:00:00.000Z', skipped: 'summary_off' } });
    expect(off.notifier.send).not.toHaveBeenCalled();
    const leftover = fixture({ enabled: false, held: 2 });
    await leftover.run(scheduled, new Date('2026-11-18T22:01:00Z'));
    expect(leftover.notifier.send).toHaveBeenCalledTimes(1);
  });

  it('starts where the last summary ended, so a changed hour neither skips nor repeats anything', async () => {
    const at = new Date('2026-11-18T23:00:05Z');
    // Yesterday's ended at 5 PM; today's is at 6 PM: the hour between is not lost.
    const later = fixture({ hour: 18, cutoff: '2026-11-17T22:00:00.000Z' });
    await later.run(scheduled, at);
    expect(later.store.summaryFacts).toHaveBeenCalledWith({ since: new Date('2026-11-17T22:00:00.000Z'), until: new Date('2026-11-18T23:00:00Z') });
    // A summary long switched off covers at most the last week; no summary yet, or a cutoff that cannot be read, covers 24 hours.
    const stale = fixture({ hour: 18, cutoff: '2026-10-01T22:00:00.000Z' });
    await stale.run(scheduled, at);
    expect(stale.store.summaryFacts).toHaveBeenCalledWith({ since: new Date('2026-11-11T23:00:00Z'), until: new Date('2026-11-18T23:00:00Z') });
    for (const cutoff of [null, new Error('database blip'), '2026-11-19T00:00:00.000Z']) {
      const fresh = fixture({ hour: 18, cutoff });
      await fresh.run(scheduled, at);
      expect(fresh.store.summaryFacts, String(cutoff)).toHaveBeenCalledWith({ since: new Date('2026-11-17T23:00:00Z'), until: new Date('2026-11-18T23:00:00Z') });
    }
  });

  it('sends one the owner asks for at once, for the last 24 hours, under its own key', async () => {
    const { run, store, notifier } = fixture({ hour: 23 });
    const at = new Date('2026-11-18T15:00:00Z');
    await run({ ...scheduled, sourceKind: 'owner', requestKey: 'owner:x' }, at);
    expect(store.summaryFacts).toHaveBeenCalledWith({ since: new Date('2026-11-17T15:00:00Z'), until: at });
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'summary:owner:t1' }));
  });

  it('tries again when the provider refused it', async () => {
    const { run } = fixture({ results: [{ channel: 'email', delivery: 'failed' }] });
    await expect(run(scheduled, new Date('2026-11-18T22:00:05Z'))).rejects.toMatchObject({ code: 'notification_failed', transient: true });
  });

  it('is not registered until the database declares it', () => {
    expect(summaryHandlers({ store: { summaryFacts: vi.fn() }, notifier: {}, features: new Set() })).toEqual({});
    expect(summaryHandlers({ store: {}, notifier: {}, features })).toEqual({});
  });
});

describe('the morning brief beside the summary', () => {
  const task = { id: 'b1', agentKey: 'chief_of_staff', kind: 'brief.daily', sourceKind: 'schedule', requestKey: 'schedule:00000000-0000-4000-8000-000000000002:20261118T120000Z' };
  const store = () => ({ briefFacts: vi.fn(async () => facts()), startRun: vi.fn(async () => 'r'), finishRun: vi.fn(async () => {}) });

  it('is not sent on schedule while the summary carries it, but is when the owner asks', async () => {
    const quietStore = store();
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    const brief = briefHandlers({ store: quietStore, notifier, publicOrigin: origin, inSummary: () => true, log: () => {} })['brief.daily'];
    expect(await brief(task, { now: () => new Date('2026-11-18T12:00:10Z') })).toEqual({ result: { date: '2026-11-18', skipped: 'in_summary' } });
    expect(quietStore.briefFacts).not.toHaveBeenCalled();
    await brief({ ...task, sourceKind: 'owner', requestKey: 'owner:y' }, { now: () => new Date('2026-11-18T12:00:10Z') });
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ attention: 'now', dedupeKey: 'brief:owner:b1' }));
  });

  it('steps aside only for a summary this server can send', async () => {
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    const at = { now: () => new Date('2026-11-18T12:00:10Z') };
    // The database has not declared the summary: the brief goes as before, whatever the setting says.
    const before = builtInHandlers({ store: store(), notifier }, { publicOrigin: origin, log: () => {}, features: new Set(), summary: { enabled: true } });
    expect(before['summary.daily']).toBeUndefined();
    expect((await before['brief.daily'](task, at)).result.skipped).toBeUndefined();
    const declared = builtInHandlers({ store: { ...store(), summaryFacts: vi.fn() }, notifier }, { publicOrigin: origin, log: () => {}, features, summary: { enabled: () => true } });
    expect(declared['summary.daily']).toBeTypeOf('function');
    expect((await declared['brief.daily'](task, at)).result.skipped).toBe('in_summary');
    const off = builtInHandlers({ store: { ...store(), summaryFacts: vi.fn() }, notifier }, { publicOrigin: origin, log: () => {}, features, summary: { enabled: false } });
    expect((await off['brief.daily'](task, at)).result.skipped).toBeUndefined();
  });
});
