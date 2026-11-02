import { describe, expect, it, vi } from 'vitest';
import { agentScheduler } from './scheduler.mjs';

const task = (overrides = {}) => ({ id: 't1', agentKey: 'platform_engineer', kind: 'probe.sweep', attempts: 1, ...overrides });
const fixture = ({ tasks = [], handlers = {}, ...options } = {}) => {
  const logs = [];
  const store = {
    maintenance: vi.fn(async () => ({})),
    fireSchedules: vi.fn(async () => ['x']),
    claim: vi.fn(async () => tasks),
    heartbeat: vi.fn(async () => true),
    finish: vi.fn(async (id, status) => status),
  };
  const actions = { executeReady: vi.fn(async () => ({ executed: 2, failed: 0 })) };
  const clock = new Date('2026-11-02T12:00:00Z');
  const scheduler = agentScheduler({ store, handlers, actions, enabled: true, now: () => clock, log: line => logs.push(line), ...options });
  return { store, actions, scheduler, logs, clock };
};

describe('agent scheduler', () => {
  it('does nothing unless it is enabled with exactly true', async () => {
    for (const enabled of [false, undefined, 'true', 1]) {
      const { scheduler, store } = fixture({ enabled });
      expect(await scheduler.tick()).toMatchObject({ skipped: true });
      expect(store.maintenance).not.toHaveBeenCalled();
      expect(store.claim).not.toHaveBeenCalled();
    }
  });

  it('keeps house, fires only the kinds it can handle, claims, runs and drains approved actions', async () => {
    const probe = vi.fn(async () => ({ result: { checked: 4 } }));
    const { scheduler, store, actions } = fixture({ tasks: [task()], handlers: { 'probe.sweep': probe, 'brief.daily': async () => ({}), 'not.a.function': 'x' } });
    const summary = await scheduler.tick();
    expect(store.maintenance).toHaveBeenCalledTimes(1);
    expect(store.fireSchedules).toHaveBeenCalledWith(['brief.daily', 'probe.sweep']);
    expect(store.claim).toHaveBeenCalledWith(3, 600);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(store.finish).toHaveBeenCalledWith('t1', 'done', { result: { checked: 4 }, errorCode: null, retryAt: null });
    expect(actions.executeReady).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ skipped: false, fired: 1, claimed: 1, executedActions: 2 });
  });

  it('passes a handler outcome on to the database', async () => {
    const retryAt = new Date('2026-11-02T13:00:00Z');
    for (const outcome of [
      { status: 'awaiting_approval', result: { proposed: 1 } },
      { status: 'awaiting_session' },
      { status: 'queued', errorCode: 'bridge_unavailable', retryAt },
      { status: 'failed', errorCode: 'bad_input' },
    ]) {
      const { scheduler, store } = fixture({ tasks: [task()], handlers: { 'probe.sweep': async () => outcome } });
      await scheduler.tick();
      expect(store.finish).toHaveBeenCalledWith('t1', outcome.status, { result: outcome.result ?? null, errorCode: outcome.errorCode ?? null, retryAt: outcome.retryAt ?? null });
    }
  });

  it('treats an unsupported outcome as a failure to retry, not as done', async () => {
    const { scheduler, store } = fixture({ tasks: [task()], handlers: { 'probe.sweep': async () => ({ status: 'sideways' }) } });
    await scheduler.tick();
    expect(store.finish).toHaveBeenCalledWith('t1', 'queued', expect.objectContaining({ errorCode: 'invalid_outcome' }));
  });

  it('retries a provider outage with a doubling backoff, capped', async () => {
    const outage = Object.assign(new Error('Overloaded'), { transient: true });
    for (const [attempts, minutes] of [[1, 5], [2, 10], [3, 20], [4, 30], [5, 30]]) {
      const { scheduler, store, clock } = fixture({ tasks: [task({ attempts })], handlers: { 'probe.sweep': async () => { throw outage; } } });
      await scheduler.tick();
      expect(store.finish).toHaveBeenCalledWith('t1', 'queued', { errorCode: 'provider_outage', retryAt: new Date(clock.getTime() + minutes * 60_000) });
    }
  });

  it('retries another failure twice, then stops', async () => {
    const broken = async () => { throw new Error('boom'); };
    const early = fixture({ tasks: [task({ attempts: 2 })], handlers: { 'probe.sweep': broken } });
    await early.scheduler.tick();
    expect(early.store.finish).toHaveBeenCalledWith('t1', 'queued', expect.objectContaining({ errorCode: 'handler_error' }));
    const last = fixture({ tasks: [task({ attempts: 3 })], handlers: { 'probe.sweep': broken } });
    await last.scheduler.tick();
    expect(last.store.finish).toHaveBeenCalledWith('t1', 'failed', { errorCode: 'handler_error', retryAt: null });
  });

  it('keeps a handler\'s own error code and replaces database codes with a safe one', async () => {
    const named = fixture({ tasks: [task()], handlers: { 'probe.sweep': async () => { throw Object.assign(new Error('x'), { code: 'ai_not_configured' }); } } });
    await named.scheduler.tick();
    expect(named.store.finish).toHaveBeenCalledWith('t1', 'queued', expect.objectContaining({ errorCode: 'ai_not_configured' }));
    const database = fixture({ tasks: [task()], handlers: { 'probe.sweep': async () => { throw Object.assign(new Error('x'), { code: '40001' }); } } });
    await database.scheduler.tick();
    expect(database.store.finish).toHaveBeenCalledWith('t1', 'queued', expect.objectContaining({ errorCode: 'handler_error' }));
  });

  it('never logs an error message, only which task failed and why', async () => {
    const { scheduler, logs } = fixture({ tasks: [task()], handlers: { 'probe.sweep': async () => { throw new Error('Patient Jane Doe asked about her medication'); } } });
    await scheduler.tick();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual({ event: 'hub_agent_task_error', task_id: 't1', agent: 'platform_engineer', kind: 'probe.sweep', code: 'handler_error', transient: false, attempts: 1 });
    expect(logs.join()).not.toMatch(/Jane|medication/);
  });

  it('stops a handler that never finishes so the clock cannot jam', async () => {
    let aborted = false;
    const hang = (_task, { signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); });
    const { scheduler, store } = fixture({ tasks: [task()], handlers: { 'probe.sweep': hang }, taskTimeoutMs: 20 });
    await scheduler.tick();
    expect(aborted).toBe(true);
    expect(store.finish).toHaveBeenCalledWith('t1', 'queued', expect.objectContaining({ errorCode: 'task_timeout' }));
    expect(await scheduler.tick()).toMatchObject({ skipped: false });
  });

  it('fails a task whose kind has no handler', async () => {
    const { scheduler, store, logs } = fixture({ tasks: [task({ kind: 'mystery.kind' })] });
    await scheduler.tick();
    expect(store.finish).toHaveBeenCalledWith('t1', 'failed', { errorCode: 'no_handler' });
    expect(JSON.parse(logs[0])).toMatchObject({ event: 'hub_agent_task_error', kind: 'mystery.kind', code: 'no_handler' });
  });

  it('extends the lease while a handler is still working', async () => {
    const slow = () => new Promise(resolve => setTimeout(() => resolve({}), 70));
    const { scheduler, store } = fixture({ tasks: [task()], handlers: { 'probe.sweep': slow }, heartbeatMs: 15 });
    await scheduler.tick();
    expect(store.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(store.heartbeat).toHaveBeenCalledWith('t1', 600);
  });

  it('never runs two ticks at once', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { scheduler, store } = fixture({ tasks: [task()], handlers: { 'probe.sweep': () => gate } });
    const first = scheduler.tick();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await scheduler.tick()).toMatchObject({ skipped: true });
    release({});
    await first;
    expect(store.claim).toHaveBeenCalledTimes(1);
  });

  it('lets one failing step fail alone', async () => {
    const { scheduler, store, logs } = fixture({ tasks: [task()], handlers: { 'probe.sweep': async () => ({}) } });
    store.maintenance.mockRejectedValue(Object.assign(new Error('db down'), { code: '57014' }));
    store.fireSchedules.mockRejectedValue(new Error('db down'));
    const summary = await scheduler.tick();
    expect(summary).toMatchObject({ fired: 0, claimed: 1 });
    expect(store.finish).toHaveBeenCalledWith('t1', 'done', expect.any(Object));
    expect(logs.map(line => JSON.parse(line).step)).toEqual(['maintenance', 'fire']);
    expect(logs.join()).not.toContain('db down');
  });

  it('runs claimed tasks side by side', async () => {
    const order = [];
    const handler = async current => { order.push(`start ${current.id}`); await new Promise(resolve => setTimeout(resolve, 20)); order.push(`end ${current.id}`); return {}; };
    const { scheduler } = fixture({ tasks: [task({ id: 'a' }), task({ id: 'b' })], handlers: { 'probe.sweep': handler } });
    await scheduler.tick();
    expect(order.slice(0, 2)).toEqual(['start a', 'start b']);
  });
});
