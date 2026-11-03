import { describe, expect, it, vi } from 'vitest';
import { actionExecutor, recordOnlyExecutors, sessionExecutor } from './actions.mjs';

const execution = (overrides = {}) => ({ id: 'a1', agentKey: 'support_concierge', taskId: 't1', kind: 'communication.reply', targetKind: 'communication', targetId: 'CM-1', input: { body: 'Hi' }, requestKey: 'k1', autoApproved: false, ...overrides });
const fixture = ({ ready = [], started = execution(), executors = {} } = {}) => {
  const logs = [];
  const store = {
    readyActions: vi.fn(async () => ready),
    beginExecution: vi.fn(async () => started),
    completeExecution: vi.fn(async () => undefined),
    releaseExecution: vi.fn(async () => true),
    deferExecution: vi.fn(async () => true),
  };
  return { store, logs, executor: actionExecutor({ store, executors, log: line => logs.push(line) }) };
};

describe('action executor', () => {
  it('carries out an action and records the result', async () => {
    const send = vi.fn(async () => ({ delivery: 'sent' }));
    const { executor, store } = fixture({ executors: { 'communication.reply': send } });
    expect(await executor.executeOne('a1')).toEqual({ executed: true, failed: false, skipped: false });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', requestKey: 'k1', input: { body: 'Hi' } }), { sessionToken: null });
    expect(store.completeExecution).toHaveBeenCalledWith('a1', true, { delivery: 'sent' }, null);
  });

  it('quotes the execution number the database gave, so a superseded start cannot settle a newer one', async () => {
    const send = vi.fn(async () => ({ delivery: 'sent' }));
    const { executor, store } = fixture({ started: execution({ execution: 4 }), executors: { 'communication.reply': send } });
    await executor.executeOne('a1');
    expect(store.completeExecution).toHaveBeenCalledWith('a1', true, { delivery: 'sent' }, 4);
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
    expect(await missing.executor.executeOne('a1')).toEqual({ executed: false, failed: true, skipped: false, error: 'no_executor' });
    expect(missing.store.completeExecution).toHaveBeenCalledWith('a1', false, { error: 'no_executor' }, null);

    const throwing = fixture({ executors: { 'communication.reply': async () => { throw new Error('Dear Jane Doe, your MRN is 12345'); } } });
    expect(await throwing.executor.executeOne('a1')).toMatchObject({ failed: true, error: 'executor_error' });
    expect(throwing.store.completeExecution).toHaveBeenCalledWith('a1', false, { error: 'executor_error' }, null);
    expect(throwing.logs.join()).not.toMatch(/Jane|MRN/);
    expect(JSON.parse(throwing.logs[0])).toMatchObject({ event: 'hub_agent_action_error', action_id: 'a1', kind: 'communication.reply', code: 'executor_error' });
  });

  it('keeps an executor\'s named error code', async () => {
    const { executor, store } = fixture({ executors: { 'communication.reply': async () => { throw Object.assign(new Error('x'), { code: 'channel_unavailable' }); } } });
    expect(await executor.executeOne('a1')).toMatchObject({ failed: true, error: 'channel_unavailable' });
    expect(store.completeExecution).toHaveBeenCalledWith('a1', false, { error: 'channel_unavailable' }, null);
  });

  it('persists a deferred growth action with its execution number instead of immediately releasing it', async () => {
    const deferred = async () => { throw Object.assign(new Error('Rate limited'), { code: 'action_deferred' }); };
    const { executor, store } = fixture({ started: execution({ kind: 'growth.message', execution: 3 }), executors: { 'growth.message': deferred } });
    expect(await executor.executeOne('a1')).toMatchObject({ skipped: true, failed: false, needsSession: false });
    expect(store.deferExecution).toHaveBeenCalledWith('a1', 3);
    expect(store.releaseExecution).not.toHaveBeenCalled();
    expect(store.completeExecution).not.toHaveBeenCalled();
  });

  it('fails visibly if a deferral cannot be persisted, without putting it back at the front of the queue', async () => {
    for (const defer of [undefined, async () => false, async () => { throw new Error('database unavailable'); }]) {
      const { executor, store } = fixture({ started: execution({ kind: 'growth.message', execution: 2 }), executors: {
        'growth.message': async () => { throw Object.assign(new Error('Paused'), { code: 'action_deferred' }); },
      } });
      store.deferExecution = defer;
      expect(await executor.executeOne('a1')).toMatchObject({ failed: true, error: 'action_deferred' });
      expect(store.releaseExecution).not.toHaveBeenCalled();
      expect(store.completeExecution).toHaveBeenCalledWith('a1', false, { error: 'action_deferred' }, 2);
    }
  });

  it('drains every ready action and carries on past one that cannot be started', async () => {
    const { executor, store } = fixture({ ready: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], executors: { 'communication.reply': async () => ({}) } });
    store.beginExecution.mockRejectedValueOnce(Object.assign(new Error('db'), { code: '57014' })).mockResolvedValue(execution());
    expect(await executor.executeReady()).toEqual({ executed: 2, failed: 0, waiting: 0 });
    expect(store.beginExecution).toHaveBeenCalledTimes(3);
  });

  describe('actions that need the owner\'s session', () => {
    const token = 'S'.repeat(43);
    const reply = () => sessionExecutor(vi.fn(async () => ({ delivery: 'sent' })));

    it('marks an executor as needing a session without changing what it does', async () => {
      const executor = vi.fn(async () => ({ ok: true }));
      expect(sessionExecutor(executor)).toBe(executor);
      expect(executor.requiresSession).toBe(true);
      expect(await executor({})).toEqual({ ok: true });
    });

    it('gives the session to the executor and carries the action out as the owner', async () => {
      const send = reply();
      const { executor, store } = fixture({ executors: { 'communication.reply': send } });
      expect(await executor.executeOne('a1', { kind: 'communication.reply', sessionToken: token })).toEqual({ executed: true, failed: false, skipped: false });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), { sessionToken: token });
      expect(store.completeExecution).toHaveBeenCalledWith('a1', true, { delivery: 'sent' }, null);
    });

    it('skips a session action with no session BEFORE starting it, so it stays approved', async () => {
      const send = reply();
      const { executor, store } = fixture({ executors: { 'communication.reply': send } });
      for (const sessionToken of [undefined, null, '']) {
        expect(await executor.executeOne('a1', { kind: 'communication.reply', sessionToken })).toEqual({ executed: false, failed: false, skipped: true, needsSession: true });
      }
      expect(store.beginExecution).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('does not give the session to an executor that does not need it, or ask for it', async () => {
      const plain = vi.fn(async () => ({}));
      const { executor } = fixture({ started: execution({ kind: 'incident.open' }), executors: { 'incident.open': plain } });
      expect(await executor.executeOne('a1', { kind: 'incident.open' })).toMatchObject({ executed: true });
      expect(plain).toHaveBeenCalledWith(expect.anything(), { sessionToken: null });
    });

    it('gives the owner\'s session only to an executor that acts as the owner, whoever asked', async () => {
      const plain = vi.fn(async () => ({}));
      const { executor } = fixture({ started: execution({ kind: 'incident.open' }), executors: { 'incident.open': plain } });
      await executor.executeOne('a1', { kind: 'incident.open', sessionToken: token });
      expect(plain).toHaveBeenCalledWith(expect.anything(), { sessionToken: null });
      expect(JSON.stringify(plain.mock.calls)).not.toContain(token);
    });

    it('hands a session action back to approved when the session lapsed before anything was sent, instead of recording a failure', async () => {
      const lapsed = sessionExecutor(async () => { throw Object.assign(new Error('x'), { code: 'session_required' }); });
      const { executor, store, logs } = fixture({ started: execution({ execution: 3 }), executors: { 'communication.reply': lapsed } });
      expect(await executor.executeOne('a1', { kind: 'communication.reply', sessionToken: token })).toEqual({ executed: false, failed: false, skipped: true, needsSession: true });
      expect(store.releaseExecution).toHaveBeenCalledWith('a1', 3);
      expect(store.completeExecution).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    });

    it('records the failure as before when the database cannot hand it back, and for any other code', async () => {
      const lapsed = sessionExecutor(async () => { throw Object.assign(new Error('x'), { code: 'session_required' }); });
      for (const release of [vi.fn(async () => false), vi.fn(async () => { throw new Error('db'); }), undefined]) {
        const { executor, store } = fixture({ executors: { 'communication.reply': lapsed } });
        if (release) store.releaseExecution = release; else delete store.releaseExecution;
        expect(await executor.executeOne('a1', { kind: 'communication.reply', sessionToken: token })).toMatchObject({ failed: true, error: 'session_required' });
        expect(store.completeExecution).toHaveBeenCalledWith('a1', false, { error: 'session_required' }, null);
      }
      const other = sessionExecutor(async () => { throw Object.assign(new Error('x'), { code: 'thread_changed' }); });
      const { executor, store } = fixture({ executors: { 'communication.reply': other } });
      await executor.executeOne('a1', { kind: 'communication.reply', sessionToken: token });
      expect(store.releaseExecution).not.toHaveBeenCalled();
    });

    it('never hands back an action whose executor does not act as the owner, whatever code it threw', async () => {
      const plain = async () => { throw Object.assign(new Error('x'), { code: 'session_required' }); };
      const { executor, store } = fixture({ started: execution({ kind: 'incident.open' }), executors: { 'incident.open': plain } });
      expect(await executor.executeOne('a1', { kind: 'incident.open' })).toMatchObject({ failed: true });
      expect(store.releaseExecution).not.toHaveBeenCalled();
    });

    it('asks the database for the kinds each caller can run before it limits the list, so waiting replies cannot hide an incident record', async () => {
      const { executor, store } = fixture({ ready: [], executors: { 'communication.reply': reply(), 'incident.open': async () => ({}) } });
      await executor.executeReady();
      expect(store.readyActions).toHaveBeenLastCalledWith(50, { excludeKinds: ['communication.reply'] });
      await executor.sessionActions();
      expect(store.readyActions).toHaveBeenLastCalledWith(50, { kinds: ['communication.reply'] });
      const none = fixture({ executors: { 'incident.open': async () => ({}) } });
      expect(await none.executor.sessionActions()).toEqual([]);
      expect(none.store.readyActions).not.toHaveBeenCalled();
    });

    it('leaves session actions to the owner when it drains, and counts them as waiting', async () => {
      const send = reply();
      const { executor, store } = fixture({
        ready: [{ id: 'a1', kind: 'communication.reply' }, { id: 'a2', kind: 'incident.open' }, { id: 'a3', kind: 'communication.reply' }],
        executors: { 'communication.reply': send, 'incident.open': async () => ({ recorded: true }) },
        started: execution({ kind: 'incident.open' }),
      });
      expect(await executor.executeReady()).toEqual({ executed: 1, failed: 0, waiting: 2 });
      expect(store.beginExecution).toHaveBeenCalledTimes(1);
      expect(store.beginExecution).toHaveBeenCalledWith('a2');
      expect(send).not.toHaveBeenCalled();
    });

    it('lists the session actions that are ready, and carries them out one at a time with the session', async () => {
      const send = reply();
      const { executor, store } = fixture({
        ready: [{ id: 'a1', kind: 'communication.reply', agentKey: 'support_concierge' }, { id: 'a2', kind: 'incident.open' }, { id: 'a3', kind: 'communication.reply' }],
        executors: { 'communication.reply': send, 'incident.open': async () => ({}) },
      });
      const list = await executor.sessionActions();
      expect(list).toEqual([{ id: 'a1', kind: 'communication.reply' }, { id: 'a3', kind: 'communication.reply' }]);
      expect(await executor.executeSessionActions(list, { sessionToken: token })).toEqual({ executed: 2, failed: 0 });
      expect(store.beginExecution.mock.calls.map(call => call[0])).toEqual(['a1', 'a3']);
    });

    it('carries on past a session action that cannot be started, and never rejects', async () => {
      const send = reply();
      const { executor, store, logs } = fixture({ executors: { 'communication.reply': send } });
      store.beginExecution.mockRejectedValueOnce(Object.assign(new Error('db'), { code: '57014' })).mockResolvedValue(execution());
      expect(await executor.executeSessionActions([{ id: 'a1', kind: 'communication.reply' }, { id: 'a2', kind: 'communication.reply' }], { sessionToken: token })).toEqual({ executed: 1, failed: 0 });
      expect(JSON.parse(logs[0])).toEqual({ event: 'hub_agent_action_step_error', action_id: 'a1', code: 'executor_error' });
    });

    it('records a failed send with its code and never the message', async () => {
      const failing = sessionExecutor(async () => { throw Object.assign(new Error('Dear Pat Example'), { code: 'thread_changed' }); });
      const { executor, store, logs } = fixture({ executors: { 'communication.reply': failing } });
      expect(await executor.executeOne('a1', { kind: 'communication.reply', sessionToken: token })).toEqual({ executed: false, failed: true, skipped: false, error: 'thread_changed' });
      expect(store.completeExecution).toHaveBeenCalledWith('a1', false, { error: 'thread_changed' }, null);
      expect(logs.join()).not.toMatch(/Pat Example|SSSS/);
    });
  });

  it('records incidents without side effects', async () => {
    const { executor, store } = fixture({ started: execution({ kind: 'incident.open' }), executors: { ...recordOnlyExecutors } });
    expect(await executor.executeOne('a1')).toMatchObject({ executed: true });
    expect(store.completeExecution).toHaveBeenCalledWith('a1', true, { recorded: true }, null);
    expect(Object.keys(recordOnlyExecutors)).toEqual(['incident.open', 'incident.resolve']);
  });
});
