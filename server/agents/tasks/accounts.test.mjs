import { describe, expect, it, vi } from 'vitest';
import { account, iso, now, snapshot, subscription } from '../accounts/fixtures.mjs';
import { accountsFeature, accountsHandlers } from './accounts.mjs';

const origin = 'https://hub.example.test';
const book = [
  account({ slug: 'maple-grove', name: 'Maple Grove Senior Living' }),
  account({ slug: 'cedar-ridge', name: 'Cedar Ridge Care', subscriptions: [subscription({ status: 'past_due' })], invoices: { open: 1, overdue: 1, remainingCents: 31337 } }),
];
const task = (over = {}) => ({ id: 't1', agentKey: 'account_manager', kind: 'accounts.weekly', sourceKind: 'schedule', attempts: 1, ...over });

const fixture = ({ accounts = book, deliveries = [{ channel: 'email', delivery: 'sent' }], features = new Set([accountsFeature]) } = {}) => {
  const logs = [];
  const store = {
    accountsSnapshot: vi.fn(async () => snapshot(accounts)),
    startRun: vi.fn(async () => 'run-1'),
    finishRun: vi.fn(async () => undefined),
  };
  const notifier = { send: vi.fn(async () => deliveries) };
  const handlers = accountsHandlers({ store, notifier, publicOrigin: origin, features, log: line => logs.push(line) });
  return { store, notifier, logs, handlers, run: (over, at = now) => handlers['accounts.weekly'](task(over), { now: () => at }) };
};

describe('the weekly account report task', () => {
  it('is registered only when the database declares the feature', () => {
    for (const features of [undefined, null, new Set(), new Set(['platform.agents.v1']), ['platform.agents.v1'], 'platform.agents.accounts.v1']) {
      expect(Object.keys(accountsHandlers({ store: {}, notifier: {}, publicOrigin: origin, features })), String(features)).toEqual([]);
    }
    for (const features of [new Set([accountsFeature]), [accountsFeature]]) expect(Object.keys(fixture({ features }).handlers)).toEqual(['accounts.weekly']);
  });

  it('reads one snapshot, emails the owner under the week\'s key and records a run with counts only', async () => {
    const { run, store, notifier } = fixture();
    const outcome = await run();
    expect(store.accountsSnapshot).toHaveBeenCalledWith({ limit: 200 });
    expect(notifier.send).toHaveBeenCalledTimes(1);
    const sent = notifier.send.mock.calls[0][0];
    expect(sent).toMatchObject({ severity: 'info', dedupeKey: 'accounts:weekly:2026-11-02', agentKey: 'account_manager', taskId: 't1', subject: 'Weekly accounts: 2 accounts, 1 needs you' });
    expect(JSON.stringify(sent.blocks)).toContain('Cedar Ridge Care');
    expect(JSON.stringify(sent.blocks)).toContain('$313.37');
    expect(outcome).toEqual({ result: { week: '2026-11-02', delivery: ['email:sent'], accounts: 2, needsYou: 1, healthy: 1, watch: 1, atRisk: 0, newAccounts: 0, inactive: 0, renewals: 0, expansion: 0, trialsEnding: 0, truncated: false } });
    expect(store.startRun).toHaveBeenCalledWith('t1', 'none', 'accounts.1');
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, 'Sent the weekly accounts report: 2 accounts: 1 healthy, 1 watch, 0 at risk, 0 new. 1 needs you.', null);
  });

  it('keeps names and money out of the subject, the stored body, the run, the result and the log', async () => {
    const { run, store, notifier, logs } = fixture();
    const outcome = await run();
    const { subject, body } = notifier.send.mock.calls[0][0];
    const kept = JSON.stringify([subject, body, store.startRun.mock.calls, store.finishRun.mock.calls, outcome, logs]);
    for (const secret of ['Maple Grove', 'Cedar Ridge', '313', '$', 'maple-grove', 'cedar-ridge']) expect(kept, secret).not.toContain(secret);
    expect(Buffer.byteLength(JSON.stringify(outcome.result))).toBeLessThan(1024);
  });

  it('uses the same key all week, so only the first run sends and a later one does nothing', async () => {
    const first = fixture();
    await first.run({}, new Date('2026-11-02T12:15:00Z'));
    await first.run({}, new Date('2026-11-05T12:15:00Z'));
    expect(first.notifier.send.mock.calls.map(call => call[0].dedupeKey)).toEqual(['accounts:weekly:2026-11-02', 'accounts:weekly:2026-11-02']);
    const later = fixture({ deliveries: [{ channel: 'email', delivery: 'duplicate', original: 'sent' }] });
    expect(await later.run({}, new Date('2026-11-05T12:15:00Z'))).toEqual({ result: { skipped: 'already_sent', week: '2026-11-02' } });
    expect(later.store.startRun).not.toHaveBeenCalled();
    // An earlier attempt that never reached the owner (stuck, unknown or switched off) is not called "sent".
    for (const original of ['pending', 'unknown', 'suppressed']) {
      const unconfirmed = fixture({ deliveries: [{ channel: 'email', delivery: 'duplicate', original }] });
      expect(await unconfirmed.run({}, new Date('2026-11-05T12:15:00Z')), original).toEqual({ result: { skipped: 'earlier_attempt_unconfirmed', week: '2026-11-02' } });
    }
    const nextWeek = fixture();
    await nextWeek.run({}, new Date('2026-11-09T12:15:00Z'));
    expect(nextWeek.notifier.send.mock.calls[0][0].dedupeKey).toBe('accounts:weekly:2026-11-09');
  });

  it('reports when the owner asks, on any day and under a key of its own, and a retry of that task finds it sent', async () => {
    const asked = fixture();
    await asked.run({ sourceKind: 'owner', id: 'task-9' }, new Date('2026-11-04T15:00:00Z'));
    expect(asked.notifier.send.mock.calls[0][0].dedupeKey).toBe('accounts:run:task-9');
    const retried = fixture({ deliveries: [{ channel: 'email', delivery: 'duplicate', original: 'sent' }] });
    const outcome = await retried.run({ sourceKind: 'owner', id: 'task-9' });
    expect(outcome.result).toMatchObject({ delivery: ['email:duplicate'], accounts: 2 });
    expect(retried.store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, expect.stringContaining('Sent the weekly accounts report'), null);
  });

  it('says so and sends nothing when there are no accounts yet', async () => {
    const { run, notifier, store } = fixture({ accounts: [] });
    expect(await run()).toEqual({ result: { skipped: 'no_accounts', week: '2026-11-02' } });
    expect(await run({ sourceKind: 'owner' })).toEqual({ result: { skipped: 'no_accounts', week: '2026-11-02' } });
    expect(notifier.send).not.toHaveBeenCalled();
    expect(store.startRun).not.toHaveBeenCalled();
  });

  it('records a run that was not delivered as failed, whatever went wrong with the email', async () => {
    for (const delivery of ['suppressed', 'failed', 'unknown']) {
      const { run, store } = fixture({ deliveries: [{ channel: 'email', delivery }] });
      const outcome = await run();
      expect(outcome.result.delivery).toEqual([`email:${delivery}`]);
      expect(store.finishRun).toHaveBeenCalledWith('run-1', 'failed', {}, `The weekly accounts report was written but not delivered (email:${delivery}).`, 'not_delivered');
    }
  });

  it('lets a failed snapshot or send reach the scheduler, which retries the task', async () => {
    const broken = fixture();
    broken.store.accountsSnapshot.mockRejectedValue(Object.assign(new Error('database'), { code: '57014' }));
    await expect(broken.run()).rejects.toMatchObject({ code: '57014' });
    const mute = fixture();
    mute.notifier.send.mockRejectedValue(new TypeError('A notification needs a subject'));
    await expect(mute.run()).rejects.toThrow(TypeError);
  });

  it('does not let a run row that cannot be written fail a report that was sent', async () => {
    const { run, store, logs } = fixture();
    store.startRun.mockRejectedValue(new Error('database'));
    expect((await run()).result.delivery).toEqual(['email:sent']);
    expect(logs).toContain(JSON.stringify({ event: 'hub_agent_run_unrecorded', agent: 'account_manager', kind: 'accounts.weekly' }));
  });

  it('keeps the same week through the nights Eastern time changes', async () => {
    const key = async at => { const { run, notifier } = fixture(); await run({}, new Date(at)); return notifier.send.mock.calls[0][0].dedupeKey; };
    expect(await key('2026-11-02T05:30:00Z')).toBe('accounts:weekly:2026-11-02');
    expect(await key('2026-11-02T04:30:00Z')).toBe('accounts:weekly:2026-10-26');
    expect(await key('2027-03-15T11:15:00Z')).toBe('accounts:weekly:2027-03-15');
    expect(iso(0)).toBe(now.toISOString());
  });
});
