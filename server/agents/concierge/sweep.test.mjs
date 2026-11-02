import { describe, expect, it, vi } from 'vitest';
import { sweepHandler } from './sweep.mjs';
import { conciergeSettings } from './settings.mjs';

const item = (n, overrides = {}) => ({ id: `1111111${n}-1111-4111-8111-111111111111`, reference: 1000 + n, channel: 'email', messageId: `2222222${n}-2222-4222-8222-222222222222`, receivedAt: '2026-11-02T11:55:00Z', ...overrides });
const task = (config = {}) => ({ id: 't1', agentKey: 'support_concierge', kind: 'concierge.sweep', agent: { config } });

describe('the concierge sweep', () => {
  it('gives each pending message its own task, keyed by the message, with ids and a reference only', async () => {
    const store = { conciergePending: vi.fn(async () => [item(1), item(2)]), enqueue: vi.fn(async () => 'task-id') };
    expect(await sweepHandler({ store })(task())).toEqual({ result: { pending: 2, enqueued: 2 } });
    expect(store.conciergePending).toHaveBeenCalledWith({ limit: 10, settleSeconds: 90, windowHours: 72, channels: ['email', 'chat', 'web_form', 'phone'] });
    expect(store.enqueue).toHaveBeenNthCalledWith(1, 'support_concierge', 'concierge.communication', 'concierge:22222221-2222-4222-8222-222222222222', {
      payload: { communicationId: '11111111-1111-4111-8111-111111111111', messageId: '22222221-2222-4222-8222-222222222222' }, priority: 5, sourceKind: 'communication', sourceRef: 'CM-1001',
    });
  });

  it('counts only the tasks that were new, because a duplicate key returns nothing', async () => {
    const store = { conciergePending: vi.fn(async () => [item(1), item(2), item(3)]), enqueue: vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce(null).mockResolvedValueOnce('c') };
    expect((await sweepHandler({ store })(task())).result).toEqual({ pending: 3, enqueued: 2 });
  });

  it('does nothing when nothing is pending', async () => {
    const store = { conciergePending: vi.fn(async () => []), enqueue: vi.fn() };
    expect(await sweepHandler({ store })(task())).toEqual({ result: { pending: 0, enqueued: 0 } });
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it('uses the agent\'s own settings', async () => {
    const store = { conciergePending: vi.fn(async () => []), enqueue: vi.fn() };
    await sweepHandler({ store })(task({ channels: ['email'], settle_seconds: 0, window_hours: 24 }));
    expect(store.conciergePending).toHaveBeenCalledWith({ limit: 10, settleSeconds: 0, windowHours: 24, channels: ['email'] });
  });

  it('stops when the scheduler has given up on it, so no work is left half done in the background', async () => {
    const controller = new AbortController();
    const store = { conciergePending: vi.fn(async () => [item(1), item(2)]), enqueue: vi.fn(async () => { controller.abort(); return 'x'; }) };
    await expect(sweepHandler({ store })(task(), { signal: controller.signal })).rejects.toMatchObject({ code: 'task_timeout', transient: true });
    expect(store.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('the concierge settings', () => {
  it('defaults to email, chat, web form and phone-line messages, and leaves text messages off', () => {
    expect(conciergeSettings(undefined)).toEqual({ channels: ['email', 'chat', 'web_form', 'phone'], settleSeconds: 90, windowHours: 72 });
    expect(conciergeSettings({})).toEqual({ channels: ['email', 'chat', 'web_form', 'phone'], settleSeconds: 90, windowHours: 72 });
    expect(conciergeSettings('nonsense')).toEqual({ channels: ['email', 'chat', 'web_form', 'phone'], settleSeconds: 90, windowHours: 72 });
  });

  it('takes the owner\'s values, ignoring channels it does not know and repeats', () => {
    expect(conciergeSettings({ channels: ['sms', 'email', 'email', 'fax'], settle_seconds: 0, window_hours: 720 })).toEqual({ channels: ['sms', 'email'], settleSeconds: 0, windowHours: 720 });
    expect(conciergeSettings({ channels: [] }).channels).toEqual([]);
  });

  it('falls back to the defaults for anything out of range or not a whole number', () => {
    for (const value of [-1, 3601, 1.5, '90', null, NaN]) expect(conciergeSettings({ settle_seconds: value }).settleSeconds, String(value)).toBe(90);
    for (const value of [0, 721, 2.5, '72', null]) expect(conciergeSettings({ window_hours: value }).windowHours, String(value)).toBe(72);
  });
});
