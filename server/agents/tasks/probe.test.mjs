import { describe, expect, it, vi } from 'vitest';
import { checkTarget, probeHandlers, summarizeSweep } from './probe.mjs';

const carebase = { key: 'carebase', label: 'CareBase', url: 'https://cmcarebase.com/health' };
const hub = { key: 'hub', label: 'Support Hub', url: 'https://hub.example.test/api/health' };
const answer = (status = 200, body = 'ok') => vi.fn(async () => new Response(status === 204 ? null : body, { status }));
const hang = vi.fn((url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));

describe('checking one product', () => {
  it('passes on any 2xx and drops the body', async () => {
    for (const status of [200, 204]) {
      expect(await checkTarget(carebase, { fetchImpl: answer(status) }), String(status)).toMatchObject({ ok: true, statusCode: status, failure: null });
    }
  });

  it('asks for the page the way a monitor should, with nothing of ours attached', async () => {
    const fetchImpl = answer();
    await checkTarget(carebase, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://cmcarebase.com/health');
    expect(options).toEqual({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { accept: expect.any(String), 'user-agent': 'CareMetric-Hub-Probe/1' } });
  });

  it('counts a redirect as a failure instead of following it', async () => {
    expect(await checkTarget(carebase, { fetchImpl: answer(302) })).toMatchObject({ ok: false, statusCode: 302, failure: 'redirect' });
  });

  it('counts an error status as a failure', async () => {
    for (const status of [404, 500, 503]) {
      expect(await checkTarget(carebase, { fetchImpl: answer(status) }), String(status)).toMatchObject({ ok: false, statusCode: status, failure: 'status' });
    }
  });

  it('reports no answer at all as a network failure with status 0', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await checkTarget(carebase, { fetchImpl })).toMatchObject({ ok: false, statusCode: 0, failure: 'network' });
  });

  it('gives up after the time limit', async () => {
    expect(await checkTarget(carebase, { fetchImpl: hang, limitMs: 20 })).toMatchObject({ ok: false, statusCode: 0, failure: 'timeout' });
  });

  it('reads at most a few kilobytes of an endless body, then cancels it', async () => {
    let cancelled = false;
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) { sent += 1024; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    expect(await checkTarget(carebase, { fetchImpl })).toMatchObject({ ok: true, statusCode: 200 });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(16 * 1024);
  });

  it('treats a body that stalls after the headers as a timeout', async () => {
    const stalled = new ReadableStream({ pull() { return new Promise(() => {}); } });
    const fetchImpl = vi.fn(async () => new Response(stalled, { status: 200 }));
    expect(await checkTarget(carebase, { fetchImpl, limitMs: 30 })).toMatchObject({ ok: false, statusCode: 200, failure: 'timeout' });
  });

  it('measures how long it took', async () => {
    const times = [1000, 1042.4];
    expect((await checkTarget(carebase, { fetchImpl: answer(), clock: () => times.shift() })).latencyMs).toBe(42);
  });
});

describe('summarizing a sweep', () => {
  const row = (target, check) => ({ target, check: { ok: true, statusCode: 200, failure: null, latencyMs: 100, ...check } });
  it('says everything answered and how slow the slowest was', () => {
    expect(summarizeSweep([row(hub, { latencyMs: 120 }), row(carebase, { latencyMs: 480 })])).toBe('All 2 products answered, the slowest in 480 ms.');
  });
  it('names each product that did not, in plain words', () => {
    expect(summarizeSweep([row(hub, {}), row(carebase, { ok: false, failure: 'status', statusCode: 503 })])).toBe('CareBase returned 503. 1 of 2 answered.');
    expect(summarizeSweep([row(hub, { ok: false, failure: 'timeout', statusCode: 0 }), row(carebase, { ok: false, failure: 'network', statusCode: 0 })]))
      .toBe('Support Hub timed out; CareBase could not be reached. 0 of 2 answered.');
  });
});

const fixture = ({ outcomes = {}, fetchImpl = answer(), targets = [hub, carebase], limitMs = 50 } = {}) => {
  const store = {
    probeRecord: vi.fn(async ({ targetKey }) => outcomes[targetKey] ?? { target: targetKey, state: 'up', transition: 'none', failures: 0, incident: 0, taskId: null }),
    startRun: vi.fn(async () => 'run-1'),
    finishRun: vi.fn(async () => undefined),
    proposeAction: vi.fn(async () => ({ id: 'a1', status: 'auto_approved', requestKey: 'k', created: true })),
  };
  const notifier = { send: vi.fn(async ({ severity }) => (severity === 'urgent' ? [{ channel: 'sms', delivery: 'sent' }, { channel: 'email', delivery: 'sent' }] : [{ channel: 'email', delivery: 'sent' }])) };
  const logs = [];
  return { store, notifier, logs, handlers: probeHandlers({ store, notifier, targets, fetchImpl, limitMs, log: line => logs.push(line) }) };
};
const task = (overrides = {}) => ({ id: 't1', agentKey: 'platform_engineer', kind: 'probe.sweep', attempts: 1, payload: {}, agent: { autonomy: 'act' }, ...overrides });
const at = iso => ({ now: () => new Date(iso) });

describe('the health sweep', () => {
  it('checks every product once and reports each result under the task\'s agent', async () => {
    const fetchImpl = vi.fn(async url => new Response('x', { status: url.includes('cmcarebase') ? 503 : 200 }));
    const { handlers, store } = fixture({ fetchImpl });
    const { result } = await handlers['probe.sweep'](task(), at('2026-11-02T14:30:00Z'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.probeRecord.mock.calls.map(([call]) => call)).toEqual([
      { targetKey: 'hub', ok: true, statusCode: 200, latencyMs: expect.any(Number), failure: null, threshold: 2, agentKey: 'platform_engineer' },
      { targetKey: 'carebase', ok: false, statusCode: 503, latencyMs: expect.any(Number), failure: 'status', threshold: 2, agentKey: 'platform_engineer' },
    ]);
    expect(result).toMatchObject({ checked: 2, answered: 1, failing: [{ target: 'carebase', failure: 'status', statusCode: 503 }], transitions: [] });
  });

  it('keeps nothing a product said', async () => {
    const { handlers } = fixture({ fetchImpl: answer(200, 'SECRET-BODY-TEXT patient data') });
    const { result } = await handlers['probe.sweep'](task(), at('2026-11-02T14:30:00Z'));
    expect(JSON.stringify(result)).not.toMatch(/SECRET|patient/);
  });

  it('lists the incidents it opened and closed', async () => {
    const outcomes = { carebase: { target: 'carebase', state: 'down', transition: 'down', failures: 2, incident: 4, taskId: 'x' } };
    const { handlers } = fixture({ outcomes, fetchImpl: answer(500) });
    const { result } = await handlers['probe.sweep'](task(), at('2026-11-02T14:30:00Z'));
    expect(result.transitions).toEqual([{ target: 'carebase', transition: 'down', incident: 4 }]);
  });

  it('records a run only for a sweep that saw something, plus one in the first minutes of each hour', async () => {
    const quiet = fixture();
    await quiet.handlers['probe.sweep'](task(), at('2026-11-02T14:30:00Z'));
    expect(quiet.store.startRun).not.toHaveBeenCalled();

    const pulse = fixture();
    await pulse.handlers['probe.sweep'](task(), at('2026-11-02T14:02:00Z'));
    expect(pulse.store.startRun).toHaveBeenCalledWith('t1', 'none', 'probe.1');
    expect(pulse.store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, expect.stringMatching(/^All 2 products answered, the slowest in \d+ ms\.$/), null);
  });

  it('records a run for a failed check or a change of state', async () => {
    const failing = fixture({ fetchImpl: answer(503) });
    await failing.handlers['probe.sweep'](task(), at('2026-11-02T14:30:00Z'));
    expect(failing.store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, expect.stringContaining('returned 503'), null);

    const recovered = fixture({ outcomes: { hub: { target: 'hub', state: 'up', transition: 'recovered', failures: 0, incident: 2, taskId: 'r' } } });
    await recovered.handlers['probe.sweep'](task(), at('2026-11-02T14:30:00Z'));
    expect(recovered.store.startRun).toHaveBeenCalledTimes(1);
  });

  it('still succeeds when the run row cannot be written, and says so without a message', async () => {
    const { handlers, store, logs } = fixture({ fetchImpl: answer(503) });
    store.startRun.mockRejectedValue(Object.assign(new Error('connection to db.private.example:5432 refused'), { code: '57P01' }));
    const { result } = await handlers['probe.sweep'](task(), at('2026-11-02T14:30:00Z'));
    expect(result.checked).toBe(2);
    expect(logs).toEqual([JSON.stringify({ event: 'hub_agent_run_unrecorded', agent: 'platform_engineer', kind: 'probe.sweep' })]);
  });

  it('lets the scheduler retry when the database fails', async () => {
    const { handlers, store } = fixture();
    store.probeRecord.mockRejectedValueOnce(new Error('boom'));
    await expect(handlers['probe.sweep'](task(), at('2026-11-02T14:30:00Z'))).rejects.toThrow('boom');
  });

  it('records nothing once the scheduler has stopped it', async () => {
    const controller = new AbortController();
    const { handlers, store } = fixture({ fetchImpl: hang });
    const pending = handlers['probe.sweep'](task(), { signal: controller.signal, now: () => new Date('2026-11-02T14:30:00Z') });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'task_timeout', transient: true });
    expect(store.probeRecord).not.toHaveBeenCalled();
  });
});

const incidentPayload = (overrides = {}) => ({ target: 'carebase', incident: 3, since: '2026-11-02T14:05:00Z', failures: 2, statusCode: 503, failure: 'status', flapping: false, ...overrides });
const incidentTask = (payload = incidentPayload(), overrides = {}) => task({ kind: 'probe.incident', payload, ...overrides });

describe('an incident', () => {
  it('texts and emails the owner once per incident, in plain words', async () => {
    const { handlers, notifier } = fixture();
    const { result } = await handlers['probe.incident'](incidentTask(), at('2026-11-02T14:11:00Z'));
    expect(notifier.send).toHaveBeenCalledTimes(1);
    const call = notifier.send.mock.calls[0][0];
    expect(call).toMatchObject({ severity: 'urgent', subject: 'CareBase is down', dedupeKey: 'probe.incident:carebase:3', agentKey: 'platform_engineer', taskId: 't1' });
    expect(call.body).toContain('CareBase has not passed 2 health checks in a row. The last check answered with status 503.');
    expect(call.body).toContain('The first failed check was at Nov 2, 9:05 AM Eastern.');
    expect(call.body).toContain('Nothing has been restarted or changed');
    expect(call.body).not.toMatch(/https?:/);
    expect(result).toMatchObject({ severity: 'urgent', delivery: ['sms:sent', 'email:sent'], action: 'recorded' });
  });

  it('records the incident as an action on the product', async () => {
    const { handlers, store } = fixture();
    await handlers['probe.incident'](incidentTask(), at('2026-11-02T14:11:00Z'));
    expect(store.proposeAction).toHaveBeenCalledWith({
      taskId: 't1', kind: 'incident.open', targetKind: 'probe_target', targetId: 'carebase:3', preview: 'CareBase is down',
      input: { target: 'carebase', incident: 3, since: '2026-11-02T14:05:00Z', failures: 2, statusCode: 503, failure: 'status', flapping: false },
    });
  });

  it('describes a product that did not answer at all', async () => {
    const { handlers, notifier } = fixture();
    await handlers['probe.incident'](incidentTask(incidentPayload({ failure: 'timeout', statusCode: 0 })), at('2026-11-02T14:11:00Z'));
    expect(notifier.send.mock.calls[0][0].body).toContain('The last check did not answer within 8 seconds.');
  });

  it('sends a product that keeps relapsing by email only', async () => {
    const { handlers, notifier } = fixture();
    await handlers['probe.incident'](incidentTask(incidentPayload({ flapping: true })), at('2026-11-02T14:11:00Z'));
    expect(notifier.send.mock.calls[0][0]).toMatchObject({ severity: 'warning', subject: 'CareBase is unstable again' });
    expect(notifier.send.mock.calls[0][0].body).toContain('within half an hour of its last recovery');
  });

  it('does not page the owner about something that began hours ago', async () => {
    const { handlers, notifier } = fixture();
    await handlers['probe.incident'](incidentTask(), at('2026-11-02T18:00:00Z'));
    expect(notifier.send.mock.calls[0][0]).toMatchObject({ severity: 'warning', subject: 'CareBase was down' });
    expect(notifier.send.mock.calls[0][0].body).toContain('reached you late');
  });

  it('still tells the owner when the agent is observe-only, but proposes no action', async () => {
    const { handlers, notifier, store } = fixture();
    const { result } = await handlers['probe.incident'](incidentTask(incidentPayload(), { agent: { autonomy: 'observe' } }), at('2026-11-02T14:11:00Z'));
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(store.proposeAction).not.toHaveBeenCalled();
    expect(result.action).toBe('observe_only');
  });

  it('accepts the database refusing an observe-only agent, and no other refusal', async () => {
    const refused = fixture();
    refused.store.proposeAction.mockRejectedValue(Object.assign(new Error('observe-only'), { code: '42501' }));
    expect((await refused.handlers['probe.incident'](incidentTask(incidentPayload(), { agent: undefined }), at('2026-11-02T14:11:00Z'))).result.action).toBe('observe_only');

    const broken = fixture();
    broken.store.proposeAction.mockRejectedValue(Object.assign(new Error('down'), { code: '57P01' }));
    await expect(broken.handlers['probe.incident'](incidentTask(), at('2026-11-02T14:11:00Z'))).rejects.toThrow('down');
  });

  it('retries when a provider refuses the alert, so an outage is not left without one, and counts only sent and already-sent as told', async () => {
    const { handlers, notifier, store } = fixture();
    // The text was refused (a temporary 429, say) while the email went: the notifier reports it instead of throwing.
    notifier.send.mockResolvedValue([{ channel: 'sms', delivery: 'failed' }, { channel: 'email', delivery: 'sent' }]);
    const error = await handlers['probe.incident'](incidentTask(), at('2026-11-02T14:11:00Z')).catch(thrown => thrown);
    expect(error).toMatchObject({ code: 'notification_failed', transient: true });
    expect(store.proposeAction).toHaveBeenCalledTimes(1);

    // The retry finds the email already sent and the text sent now: the task is done.
    notifier.send.mockResolvedValue([{ channel: 'sms', delivery: 'sent' }, { channel: 'email', delivery: 'duplicate', original: 'sent' }]);
    expect((await handlers['probe.incident'](incidentTask(), at('2026-11-02T14:16:00Z'))).result).toMatchObject({ delivery: ['sms:sent', 'email:duplicate'] });

    // A channel that is switched off, or a send that may or may not have gone, is not retried: that could send twice.
    for (const delivery of ['suppressed', 'unknown']) {
      notifier.send.mockResolvedValue([{ channel: 'email', delivery }]);
      await expect(handlers['probe.incident'](incidentTask(), at('2026-11-02T14:11:00Z')), delivery).resolves.toBeDefined();
    }
  });

  it('retries a recovery note the same way', async () => {
    const { handlers, notifier } = fixture();
    notifier.send.mockResolvedValue([{ channel: 'email', delivery: 'failed' }]);
    const recovery = task({ kind: 'probe.recovery', payload: { target: 'hub', incident: 2, downSince: '2026-11-02T14:05:00Z', recoveredAt: '2026-11-02T14:35:00Z' } });
    await expect(handlers['probe.recovery'](recovery)).rejects.toMatchObject({ code: 'notification_failed', transient: true });
  });

  it('alerts before it records, so a failure to record never silences the alert', async () => {
    const { handlers, store, notifier } = fixture();
    const order = [];
    notifier.send.mockImplementation(async () => { order.push('notify'); return []; });
    store.proposeAction.mockImplementation(async () => { order.push('propose'); return {}; });
    await handlers['probe.incident'](incidentTask(), at('2026-11-02T14:11:00Z'));
    expect(order).toEqual(['notify', 'propose']);
  });

  it('retries when the alert cannot be recorded, and proposes nothing yet', async () => {
    const { handlers, store, notifier } = fixture();
    notifier.send.mockRejectedValue(new Error('database down'));
    await expect(handlers['probe.incident'](incidentTask(), at('2026-11-02T14:11:00Z'))).rejects.toThrow('database down');
    expect(store.proposeAction).not.toHaveBeenCalled();
  });

  it('refuses a task that names a product it does not probe, and sends nothing', async () => {
    const { handlers, notifier } = fixture();
    for (const payload of [incidentPayload({ target: 'somewhere-else' }), incidentPayload({ target: undefined }), incidentPayload({ target: { url: 'https://evil.example.test' } })]) {
      await expect(handlers['probe.incident'](incidentTask(payload), at('2026-11-02T14:11:00Z'))).rejects.toMatchObject({ code: 'unknown_target' });
    }
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('refuses a task with no incident number', async () => {
    const { handlers } = fixture();
    for (const incident of [undefined, 0, -1, 1.5, '3']) {
      await expect(handlers['probe.incident'](incidentTask(incidentPayload({ incident })), at('2026-11-02T14:11:00Z')), String(incident)).rejects.toMatchObject({ code: 'invalid_payload' });
    }
  });
});

const recoveryTask = (payload = {}, overrides = {}) => task({ kind: 'probe.recovery', payload: { target: 'carebase', incident: 3, downSince: '2026-11-02T14:05:00Z', recoveredAt: '2026-11-02T14:20:00Z', statusCode: 200, ...payload }, ...overrides });

describe('a recovery', () => {
  it('emails the owner that the product is back, and for how long it was down', async () => {
    const { handlers, notifier } = fixture();
    const { result } = await handlers['probe.recovery'](recoveryTask());
    expect(notifier.send).toHaveBeenCalledWith({
      severity: 'info', subject: 'CareBase is answering again', dedupeKey: 'probe.recovery:carebase:3', agentKey: 'platform_engineer', taskId: 't1',
      body: 'CareBase passed its health check again at Nov 2, 9:20 AM Eastern.\n\nIt first failed at Nov 2, 9:05 AM Eastern, about 15 minutes earlier.',
    });
    expect(result).toMatchObject({ delivery: ['email:sent'], action: 'recorded' });
  });

  it('closes the incident record', async () => {
    const { handlers, store } = fixture();
    await handlers['probe.recovery'](recoveryTask());
    expect(store.proposeAction).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1', kind: 'incident.resolve', targetKind: 'probe_target', targetId: 'carebase:3', preview: 'CareBase is answering again' }));
  });

  it('copes with a recovery that does not know when the outage began', async () => {
    const { handlers, notifier } = fixture();
    await handlers['probe.recovery'](recoveryTask({ downSince: null }));
    expect(notifier.send.mock.calls[0][0].body).toContain('It had been reported down.');
  });

  it('says one minute rather than zero for a very short outage', async () => {
    const { handlers, notifier } = fixture();
    await handlers['probe.recovery'](recoveryTask({ recoveredAt: '2026-11-02T14:05:10Z' }));
    expect(notifier.send.mock.calls[0][0].body).toContain('about 1 minute earlier');
  });

  it('refuses an unknown product', async () => {
    const { handlers, notifier } = fixture();
    await expect(handlers['probe.recovery'](recoveryTask({ target: 'nope' }))).rejects.toMatchObject({ code: 'unknown_target' });
    expect(notifier.send).not.toHaveBeenCalled();
  });
});
