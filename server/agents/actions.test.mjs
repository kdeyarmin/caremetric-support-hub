import { describe, expect, it, vi } from 'vitest';
import { actionExecutor, recordOnlyExecutors } from './actions.mjs';

const execution = (overrides = {}) => ({ id: 'a1', agentKey: 'support_concierge', taskId: 't1', kind: 'communication.reply', targetKind: 'communication', targetId: 'CM-1', input: { body: 'Hi' }, requestKey: 'k1', autoApproved: false, ...overrides });
const fixture = ({ ready = [], started = execution(), executors = {} } = {}) => {
  const logs = [];
  const store = {
    readyActions: vi.fn(async () => ready),
    beginExecution: vi.fn(async () => started),
    completeExecution: vi.fn(async () => undefined),
  };
  return { store, logs, executor: actionExecutor({ store, executors, log: line => logs.push(line) }) };
};

describe('action executor', () => {
  it('carries out an action and records the result', async () => {
    const send = vi.fn(async () => ({ delivery: 'sent' }));
    const { executor, store } = fixture({ executors: { 'communication.reply': send } });
    expect(await executor.executeOne('a1')).toEqual({ executed: true, failed: false, skipped: false });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', requestKey: 'k1', input: { body: 'Hi' } }));
    expect(store.completeExecution).toHaveBeenCalledWith('a1', true, { delivery: 'sent' });
  });

  it('does nothing when another caller already has the action', async () => {
    const send = vi.fn();
    const { executor, store } = fixture({ started: null, executors: { 'communication.reply': send } });
    expect(await executor.executeOne('a1')).toEqual({ executed: false, failed: false, skipped: true });
    expect(send).not.toHaveBeenCalled();
    expect(store.completeExecution).not.toHaveBeenCalled();
  });

  it('records a failure when there is no executor or the executor throws, without logging the message', async () => {
    const missing = fixture({ executors: {} });
    expect(await missing.executor.executeOne('a1')).toEqual({ executed: false, failed: true, skipped: false });
    expect(missing.store.completeExecution).toHaveBeenCalledWith('a1', false, { error: 'no_executor' });

    const throwing = fixture({ executors: { 'communication.reply': async () => { throw new Error('Dear Jane Doe, your MRN is 12345'); } } });
    expect(await throwing.executor.executeOne('a1')).toMatchObject({ failed: true });
    expect(throwing.store.completeExecution).toHaveBeenCalledWith('a1', false, { error: 'executor_error' });
    expect(throwing.logs.join()).not.toMatch(/Jane|MRN/);
    expect(JSON.parse(throwing.logs[0])).toMatchObject({ event: 'hub_agent_action_error', action_id: 'a1', kind: 'communication.reply', code: 'executor_error' });
  });

  it('keeps an executor\'s named error code', async () => {
    const { executor, store } = fixture({ executors: { 'communication.reply': async () => { throw Object.assign(new Error('x'), { code: 'channel_unavailable' }); } } });
    await executor.executeOne('a1');
    expect(store.completeExecution).toHaveBeenCalledWith('a1', false, { error: 'channel_unavailable' });
  });

  it('drains every ready action and carries on past one that cannot be started', async () => {
    const { executor, store } = fixture({ ready: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], executors: { 'communication.reply': async () => ({}) } });
    store.beginExecution.mockRejectedValueOnce(Object.assign(new Error('db'), { code: '57014' })).mockResolvedValue(execution());
    expect(await executor.executeReady()).toEqual({ executed: 2, failed: 0 });
    expect(store.beginExecution).toHaveBeenCalledTimes(3);
  });

  it('records incidents without side effects', async () => {
    const { executor, store } = fixture({ started: execution({ kind: 'incident.open' }), executors: { ...recordOnlyExecutors } });
    expect(await executor.executeOne('a1')).toMatchObject({ executed: true });
    expect(store.completeExecution).toHaveBeenCalledWith('a1', true, { recorded: true });
    expect(Object.keys(recordOnlyExecutors)).toEqual(['incident.open', 'incident.resolve']);
  });
});
