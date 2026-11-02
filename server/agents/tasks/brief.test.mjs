import { describe, expect, it, vi } from 'vitest';
import { briefHandlers, composeBrief } from './brief.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
const labels = { carebase: 'CareBase', hub: 'Support Hub' };
const now = new Date('2026-11-02T12:00:00Z');
const quiet = (overrides = {}) => ({
  generatedAt: '2026-11-02T12:00:00Z', approvals: { count: 0, oldestAt: null }, awaitingSession: 0, incidents: [], failedTasks: 0, undeliveredAlerts: 0,
  yesterday: { runs: 0, tasksDone: 0, tasksFailed: 0, actionsExecuted: 0, incidentsOpened: 0, incidentsClosed: 0, spendCents: 0 },
  agents: [], billing: { pastDue: 0, trialsEnding: 0 }, ...overrides,
});
const busy = () => quiet({
  approvals: { count: 2, oldestAt: '2026-10-30T15:00:00Z' }, awaitingSession: 2,
  incidents: [{ target: 'carebase', since: '2026-11-02T10:05:00Z', failures: 5 }], failedTasks: 1, undeliveredAlerts: 1,
  yesterday: { runs: 14, tasksDone: 13, tasksFailed: 1, actionsExecuted: 3, incidentsOpened: 1, incidentsClosed: 0, spendCents: 12.5 },
  agents: [{ key: 'support_concierge', name: 'Support Concierge', status: 'paused', hitBudget: false }, { key: 'chief_of_staff', name: 'Chief of Staff', status: 'active', hitBudget: true }],
  billing: { pastDue: 1, trialsEnding: 3 },
});
const compose = (facts, options = {}) => composeBrief(facts, { now, publicOrigin: origin, labels, ...options });

describe('composing the brief', () => {
  it('says plainly when nothing needs the owner', () => {
    const brief = compose(quiet());
    expect(brief.needsYou).toBe(0);
    expect(brief.subject).toBe('CareMetric brief for Mon, Nov 2: nothing needs you');
    expect(brief.body).toBe('Nothing needs you this morning.\n\nYesterday: 0 runs, 0 tasks done and 0 failed, 0 actions carried out, 0 incidents opened and 0 closed, AI spend $0.00.');
    expect(brief.blocks[0]).toEqual({ type: 'callout', tone: 'success', title: 'All clear.', text: 'Nothing needs you this morning.' });
    expect(brief.blocks.some(block => block.type === 'button')).toBe(false);
  });

  it('lists everything that needs the owner, one line each, with how long approvals have waited', () => {
    const brief = compose(busy());
    expect(brief.needsYou).toBe(6);
    expect(brief.subject).toBe('CareMetric brief for Mon, Nov 2: 6 things need you');
    expect(brief.body).toContain([
      'Needs you:', '- Waiting for your approval: 2 (oldest 3 days)', '- Waiting for you to sign in: 2 tasks', '- CareBase is down: since Nov 2, 5:05 AM Eastern',
      '- Failed tasks in the last 24 hours: 1', '- Urgent alerts that did not reach you: 1', '- Subscriptions past due: 1',
    ].join('\n'));
    expect(brief.blocks[0]).toMatchObject({ type: 'callout', tone: 'warning', text: '6 things need you this morning.' });
    expect(brief.blocks[1]).toMatchObject({ type: 'details' });
    expect(brief.blocks.at(-1)).toEqual({ type: 'button', label: 'Open the AI team', url: `${origin}/admin/team` });
  });

  it('uses the singular for one thing', () => {
    const brief = compose(quiet({ failedTasks: 1 }));
    expect(brief.subject).toBe('CareMetric brief for Mon, Nov 2: 1 thing needs you');
    expect(brief.headline).toBe('One thing needs you this morning.');
  });

  it('reports yesterday in words and dollars', () => {
    expect(compose(busy()).body).toContain('Yesterday: 14 runs, 13 tasks done and 1 failed, 3 actions carried out, 1 incident opened and 0 closed, AI spend $0.13.');
  });

  it('adds what is worth knowing without making it urgent', () => {
    const brief = compose(busy(), { services: { sms: false } });
    expect(brief.body).toContain([
      'Worth knowing:', '- 3 trials end within a week.', '- Paused, so it does nothing until you resume it: Support Concierge.',
      '- Reached the daily budget yesterday: Chief of Staff.', '- Text alerts are not set up, so urgent items reach you by email only.',
    ].join('\n'));
    expect(compose(quiet({ billing: { pastDue: 0, trialsEnding: 1 } })).body).toContain('- 1 trial ends within a week.');
    expect(compose(quiet({ agents: [{ name: 'A', status: 'paused' }, { name: 'B', status: 'paused' }] })).body).toContain('Paused, so they do nothing until you resume them: A, B.');
    expect(compose(quiet(), { services: { sms: true } }).body).not.toContain('Text alerts');
    expect(compose(quiet()).body).not.toContain('Text alerts');
  });

  it('names a product it has no label for by its key, and never quotes anything else', () => {
    const brief = compose(quiet({ incidents: [{ target: 'newthing', since: '2026-11-02T10:05:00Z', failures: 2 }] }));
    expect(brief.body).toContain('- newthing is down: since Nov 2, 5:05 AM Eastern');
    expect(JSON.stringify(brief)).not.toMatch(/@|https?:\/\/(?!support-hub)/);
  });

  it('survives missing or malformed facts instead of failing the morning email', () => {
    for (const facts of [{}, null, undefined, { approvals: 'x', incidents: 'x', yesterday: 'x', agents: 'x', billing: 'x', failedTasks: 'many', awaitingSession: -4 }]) {
      const brief = compose(facts);
      expect(brief.needsYou, JSON.stringify(facts)).toBe(0);
      expect(brief.subject).toMatch(/nothing needs you/);
    }
  });

  it('leaves out the button when the Hub has no https address', () => {
    expect(compose(busy(), { publicOrigin: 'http://localhost:8080' }).blocks.some(block => block.type === 'button')).toBe(false);
    expect(compose(busy(), { publicOrigin: undefined }).blocks.some(block => block.type === 'button')).toBe(false);
  });

  it('is the same email for the same facts', () => {
    expect(compose(busy())).toEqual(compose(busy()));
  });
});

const task = (overrides = {}) => ({ id: 't1', agentKey: 'chief_of_staff', kind: 'brief.daily', attempts: 1, sourceKind: 'schedule', payload: {}, ...overrides });
const fixture = ({ facts = busy(), delivery = [{ channel: 'email', delivery: 'sent' }] } = {}) => {
  const store = { briefFacts: vi.fn(async () => facts), startRun: vi.fn(async () => 'run-1'), finishRun: vi.fn(async () => undefined) };
  const notifier = { send: vi.fn(async () => delivery) };
  const logs = [];
  return { store, notifier, logs, handlers: briefHandlers({ store, notifier, publicOrigin: origin, labels, services: { sms: true }, log: line => logs.push(line) }) };
};
const at = iso => ({ now: () => new Date(iso) });

describe('the morning brief task', () => {
  it('sends the brief by email as a warning when something needs the owner', async () => {
    const { handlers, notifier } = fixture();
    const { result } = await handlers['brief.daily'](task(), at('2026-11-02T12:00:00Z'));
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(notifier.send.mock.calls[0][0]).toMatchObject({
      severity: 'warning', subject: 'CareMetric brief for Mon, Nov 2: 6 things need you', dedupeKey: 'brief:2026-11-02', agentKey: 'chief_of_staff', taskId: 't1',
      body: expect.stringContaining('6 things need you this morning.'), blocks: expect.arrayContaining([expect.objectContaining({ type: 'callout' })]),
    });
    expect(result).toEqual({ date: '2026-11-02', needsYou: 6, delivery: ['email:sent'] });
  });

  it('sends it as plain information when nothing needs the owner', async () => {
    const { handlers, notifier } = fixture({ facts: quiet() });
    await handlers['brief.daily'](task(), at('2026-11-02T12:00:00Z'));
    expect(notifier.send.mock.calls[0][0].severity).toBe('info');
  });

  it('keys the scheduled brief by the Eastern day, so a retry never sends it twice', async () => {
    const { handlers, notifier } = fixture();
    await handlers['brief.daily'](task(), at('2026-11-02T12:00:00Z'));
    await handlers['brief.daily'](task({ attempts: 2 }), at('2026-11-02T12:30:00Z'));
    expect(notifier.send.mock.calls.map(([input]) => input.dedupeKey)).toEqual(['brief:2026-11-02', 'brief:2026-11-02']);
    // Just after midnight Eastern is still the previous Eastern day in UTC terms, and just after midnight UTC is not yet the next one.
    await handlers['brief.daily'](task(), at('2026-11-03T03:30:00Z'));
    await handlers['brief.daily'](task(), at('2026-11-03T05:30:00Z'));
    expect(notifier.send.mock.calls.slice(2).map(([input]) => input.dedupeKey)).toEqual(['brief:2026-11-02', 'brief:2026-11-03']);
  });

  it('keeps a scheduled brief under the day it was due for, so a retry after midnight cannot send it twice or take tomorrow\'s key', async () => {
    const schedule = '6c1d0000-0000-4000-8000-000000000001';
    const monday = task({ requestKey: `schedule:${schedule}:20261102T120000Z` });
    const { handlers, notifier } = fixture();
    await handlers['brief.daily'](monday, at('2026-11-02T12:00:00Z'));
    // The retry runs at 00:30 Eastern on Tuesday. It is still Monday's brief.
    const retried = await handlers['brief.daily'](task({ ...monday, attempts: 2 }), at('2026-11-03T05:30:00Z'));
    // Tuesday's own brief then has its own key, and is not taken for a repeat.
    await handlers['brief.daily'](task({ requestKey: `schedule:${schedule}:20261103T120000Z` }), at('2026-11-03T12:00:00Z'));
    expect(notifier.send.mock.calls.map(([input]) => input.dedupeKey)).toEqual(['brief:2026-11-02', 'brief:2026-11-02', 'brief:2026-11-03']);
    expect(retried.result.date).toBe('2026-11-02');
  });

  it('falls back to the clock for a task whose request key is not a schedule\'s', async () => {
    const { handlers, notifier } = fixture();
    for (const requestKey of ['owner:abc', 'schedule:not-an-id:20261102T120000Z', 'schedule:6c1d0000-0000-4000-8000-000000000001:soon', undefined]) {
      await handlers['brief.daily'](task({ requestKey }), at('2026-11-03T12:00:00Z'));
    }
    expect(new Set(notifier.send.mock.calls.map(([input]) => input.dedupeKey))).toEqual(new Set(['brief:2026-11-03']));
  });

  it('sends a brief the owner asks for once per request, whatever day a retry falls on', async () => {
    const { handlers, notifier } = fixture();
    const asked = task({ sourceKind: 'owner', id: 'a' });
    await handlers['brief.daily'](asked, at('2026-11-02T23:55:00-05:00'));
    await handlers['brief.daily'](task({ ...asked, attempts: 2 }), at('2026-11-03T00:10:00-05:00'));
    await handlers['brief.daily'](task({ sourceKind: 'owner', id: 'b' }), at('2026-11-03T00:11:00-05:00'));
    expect(notifier.send.mock.calls.map(([input]) => input.dedupeKey)).toEqual(['brief:owner:a', 'brief:owner:a', 'brief:owner:b']);
  });

  it('records a run the owner can see', async () => {
    const { handlers, store } = fixture();
    await handlers['brief.daily'](task(), at('2026-11-02T12:00:00Z'));
    expect(store.startRun).toHaveBeenCalledWith('t1', 'none', 'brief.1');
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, 'Sent the morning brief: 6 things need you this morning.', null);
  });

  it('says so when the brief was written but reached nobody', async () => {
    for (const delivery of [[{ channel: 'email', delivery: 'suppressed' }], [{ channel: 'email', delivery: 'unknown' }]]) {
      const { handlers, store } = fixture({ delivery });
      const { result } = await handlers['brief.daily'](task(), at('2026-11-02T12:00:00Z'));
      expect(result.delivery).toEqual([`email:${delivery[0].delivery}`]);
      expect(store.finishRun).toHaveBeenCalledWith('run-1', 'failed', {}, `The morning brief was written but not delivered (email:${delivery[0].delivery}).`, 'not_delivered');
    }
  });

  it('retries when the provider refuses the brief, under the same key, and records each attempt', async () => {
    const { handlers, notifier, store } = fixture();
    notifier.send.mockResolvedValueOnce([{ channel: 'email', delivery: 'failed' }]);
    await expect(handlers['brief.daily'](task(), at('2026-11-02T12:00:00Z'))).rejects.toMatchObject({ code: 'notification_failed', transient: true });
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'failed', {}, 'The morning brief was written but not delivered (email:failed).', 'not_delivered');
    notifier.send.mockResolvedValueOnce([{ channel: 'email', delivery: 'sent' }]);
    const { result } = await handlers['brief.daily'](task({ attempts: 2 }), at('2026-11-02T12:10:00Z'));
    expect(result).toMatchObject({ delivery: ['email:sent'] });
    expect(notifier.send.mock.calls.map(([input]) => input.dedupeKey)).toEqual(['brief:2026-11-02', 'brief:2026-11-02']);
  });

  it('counts a brief that was already sent as delivered, and one that only reached the record as not', async () => {
    const { handlers, store } = fixture({ delivery: [{ channel: 'email', delivery: 'duplicate', original: 'sent' }] });
    await handlers['brief.daily'](task(), at('2026-11-02T12:00:00Z'));
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, expect.stringContaining('Sent the morning brief'), null);
    for (const original of ['pending', 'unknown', 'suppressed', 'failed']) {
      const stuck = fixture({ delivery: [{ channel: 'email', delivery: 'duplicate', original }] });
      await stuck.handlers['brief.daily'](task(), at('2026-11-02T12:00:00Z'));
      expect(stuck.store.finishRun, original).toHaveBeenCalledWith('run-1', 'failed', {}, 'The morning brief was written but not delivered (email:duplicate).', 'not_delivered');
    }
  });

  it('retries when the facts cannot be read, and sends nothing', async () => {
    const { handlers, store, notifier } = fixture();
    store.briefFacts.mockRejectedValue(new Error('database down'));
    await expect(handlers['brief.daily'](task(), at('2026-11-02T12:00:00Z'))).rejects.toThrow('database down');
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('retries when the owner cannot be told, rather than recording a brief that was never sent', async () => {
    const { handlers, notifier, store } = fixture();
    notifier.send.mockRejectedValue(new Error('database down'));
    await expect(handlers['brief.daily'](task(), at('2026-11-02T12:00:00Z'))).rejects.toThrow('database down');
    expect(store.startRun).not.toHaveBeenCalled();
  });

  it('still succeeds when the run row cannot be written', async () => {
    const { handlers, store, logs } = fixture();
    store.startRun.mockRejectedValue(new Error('boom'));
    const { result } = await handlers['brief.daily'](task(), at('2026-11-02T12:00:00Z'));
    expect(result.needsYou).toBe(6);
    expect(logs).toEqual([JSON.stringify({ event: 'hub_agent_run_unrecorded', agent: 'chief_of_staff', kind: 'brief.daily' })]);
  });
});
