import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { nativeVisitorReader, visitorMetricsFeature, visitorMetricsUrl } from './visitors.mjs';
import { scorecardHandlers, scorecardFeature } from './index.mjs';
import { marketingToolkit } from '../toolkit.mjs';

const key = 'synthetic-visitor-metrics-key-for-tests-only';
const features = new Set([visitorMetricsFeature]);
const now = Date.parse('2026-11-02T13:00:00Z');
const window = { before: new Date('2026-10-19T04:00:00Z'), since: new Date('2026-10-26T04:00:00Z'), until: new Date('2026-11-02T05:00:00Z') };
const answer = (changes = {}) => ({ version: 1, metric: 'anonymous_sessions', collectionStartedAt: '2026-10-01T00:00:00Z',
  current: { count: 100, complete: true }, previous: { count: 80, complete: true }, ...changes });
const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const setup = (options = {}) => {
  const fetchImpl = vi.fn(async () => response(answer()));
  const reader = nativeVisitorReader({ features, enabled: true, key, fetchImpl, now: () => now, ...options });
  return { reader, fetchImpl };
};
const intel = result => result.products['caremetric-intel'];

describe('native website session reader', () => {
  it('stays disconnected until the release, owner switch and dedicated signing key are present', async () => {
    for (const options of [{ features: new Set() }, { enabled: false }, { key: 'short' }]) {
      const { reader, fetchImpl } = setup(options);
      expect(reader.configured).toBe(false);
      expect((await reader.read(window)).state).toBe('not_configured');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    let enabled = false;
    const { reader } = setup({ enabled: () => enabled });
    expect(reader.configured).toBe(false);
    enabled = true;
    expect(reader.configured).toBe(true);
    expect(marketingToolkit({ visitorMetrics: reader }).find(row => row.key === 'visitor_conversion_analytics').configured).toBe(true);
  });

  it('uses the fixed origin, exact Eastern periods and a purpose-bound signature; zero is a valid measured count', async () => {
    const fetchImpl = vi.fn(async () => response(answer({ current: { count: 0, complete: true } })));
    const { reader } = setup({ fetchImpl });
    const result = await reader.read(window);
    expect(intel(result)).toEqual({ state: 'read', visitors: 0, previous: 80 });
    expect(result.products.carebase.state).toBe('not_configured');
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe(visitorMetricsUrl);
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(JSON.parse(request.body)).toEqual({ before: '2026-10-19T04:00:00.000Z', since: '2026-10-26T04:00:00.000Z', until: '2026-11-02T05:00:00.000Z' });
    const timestamp = request.headers['X-CareMetric-Timestamp'];
    expect(request.headers['X-CareMetric-Signature']).toBe(createHmac('sha256', key).update(`${timestamp}.visitor-metrics.${request.body}`).digest('hex'));
    expect(JSON.stringify([result, reader.readiness(), request.headers])).not.toContain(key);
  });

  it('leaves pre-collection and partial periods unknown rather than inventing historical zeroes', async () => {
    const { reader } = setup({ fetchImpl: async () => response(answer({ collectionStartedAt: '2026-10-22T00:00:00Z', previous: { count: 0, complete: false } })) });
    expect(intel(await reader.read(window))).toEqual({ state: 'partial', visitors: 100, previous: null });
    const fresh = setup({ fetchImpl: async () => response(answer({ collectionStartedAt: null,
      current: { count: null, complete: false }, previous: { count: null, complete: false } })) });
    expect(intel(await fresh.reader.read(window))).toEqual({ state: 'unavailable', visitors: null, previous: null });
    const falseCoverage = setup({ fetchImpl: async () => response(answer({ collectionStartedAt: '2026-10-30T00:00:00Z' })) });
    expect(await falseCoverage.reader.read(window)).toMatchObject({ state: 'unavailable', error: 'visitor_coverage_invalid' });
  });

  it('rejects malformed, unbounded and unexpected report data without exposing the response', async () => {
    for (const data of [answer({ current: { count: -1, complete: true } }), answer({ current: { count: '100', complete: true } }),
      answer({ current: { count: null, complete: true } }), answer({ current: { count: 1.5, complete: true } }), answer({ secret: key }),
      answer({ collectionStartedAt: '2030-01-01T00:00:00Z' })]) {
      const { reader } = setup({ fetchImpl: async () => response(data) });
      const result = await reader.read(window);
      expect(result.state).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain(key);
      expect(intel(result).visitors).toBeNull();
    }
    const oversized = setup({ fetchImpl: async () => new Response('x'.repeat(20_000)) });
    expect(await oversized.reader.read(window)).toMatchObject({ state: 'unavailable', error: 'visitor_response_too_large' });
  });

  it('preserves unavailable endpoints, permissions and timeouts separately from not configured', async () => {
    for (const status of [401, 403, 404, 503, 500]) {
      const { reader } = setup({ fetchImpl: async () => new Response(key, { status }) });
      const result = await reader.read(window);
      expect(result.state).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain(key);
    }
    const hung = setup({ fetchImpl: () => new Promise(() => {}), timeoutMs: 10 });
    expect(await hung.reader.read(window)).toMatchObject({ state: 'unavailable', error: 'visitor_timeout' });
    const controller = new AbortController();
    const pending = setup({ fetchImpl: () => new Promise(() => {}) }).reader.read({ ...window, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'visitor_aborted' });
  });

  it('refuses invalid report windows before requesting anything', async () => {
    const { reader, fetchImpl } = setup();
    for (const bounds of [{ ...window, before: new Date('invalid') }, { ...window, until: window.since },
      { ...window, before: new Date('2020-01-01') }, { ...window, until: new Date('2027-01-01') }]) {
      await expect(reader.read(bounds)).rejects.toMatchObject({ code: 'visitor_window_invalid' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('visitor source in the Monday scorecard', () => {
  const fixture = visitors => {
    const store = { scorecardFacts: async () => ({ products: [], aiSpendCents: 0 }), briefFacts: async () => ({ approvals: { count: 0 }, incidents: [] }),
      startRun: async () => 'run', finishRun: async () => undefined };
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    const log = vi.fn();
    const handlers = scorecardHandlers({ store, notifier, features: new Set([scorecardFeature]), searchConsole: null, sites: [], visitors, log });
    const run = signal => handlers['scorecard.weekly']({ id: 'visitor-scorecard', agentKey: 'chief_of_staff', sourceKind: 'owner' }, { now: () => new Date(now), signal });
    return { run, notifier, log };
  };

  it('passes the exact previous boundary and labels native counts as anonymous sessions', async () => {
    const visitors = vi.fn(async () => ({ state: 'read', metric: 'anonymous_sessions', products: {
      carebase: { state: 'not_configured' }, 'caremetric-intel': { state: 'read', visitors: 100, previous: 80 },
    } }));
    const { run, notifier } = fixture(visitors);
    await run();
    expect(visitors).toHaveBeenCalledWith(expect.objectContaining(window));
    const words = JSON.stringify(notifier.send.mock.calls[0][0].blocks);
    expect(words).toContain('Website sessions (anonymous tabs)');
    expect(words).toContain('100 (last week 80)');
    expect(words).toContain('not unique people or customer accounts');
  });

  it('reports an optional reader failure as unavailable and still sends the remaining figures', async () => {
    const { run, notifier, log } = fixture(async () => { throw new Error(key); });
    const outcome = await run();
    expect(outcome.result.sources.visitors).toBe('unavailable');
    expect(JSON.stringify(notifier.send.mock.calls[0][0].blocks)).toContain('Could not be read');
    expect(JSON.stringify([outcome, log.mock.calls])).not.toContain(key);
  });
});
