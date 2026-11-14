import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { analyticsDataOrigin, analyticsProperty, analyticsRanges, analyticsScope, countsOf, googleAnalyticsReader, websiteVisitors } from './google-analytics.mjs';
import { tokenUrl } from '../seo/search-console.mjs';
import { composeScorecard } from './compose.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const credentials = JSON.stringify({ type: 'service_account', private_key_id: 'abc123', private_key: pem, client_email: 'hub@caremetric-hub.iam.gserviceaccount.com' });
// The scorecard's own boundaries for the week of Monday 2026-10-26 (Eastern midnights), across the November daylight-saving change.
const window = { before: new Date('2026-10-19T04:00:00Z'), since: new Date('2026-10-26T04:00:00Z'), until: new Date('2026-11-02T05:00:00Z') };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const report = (current, previous) => ({ kind: 'analyticsData#runReport', dimensionHeaders: [{ name: 'dateRange' }], metricHeaders: [{ name: 'activeUsers', type: 'TYPE_INTEGER' }],
  rows: [...(current === null ? [] : [{ dimensionValues: [{ value: 'current' }], metricValues: [{ value: String(current) }] }]),
    ...(previous === null ? [] : [{ dimensionValues: [{ value: 'previous' }], metricValues: [{ value: String(previous) }] }])] });
const fakeGoogle = (answers = {}) => vi.fn(async (url, init) => {
  if (url === tokenUrl) return json({ access_token: 'ya29.synthetic-access-token-value', expires_in: 3600 });
  const id = /properties\/(\d+):runReport$/.exec(url)?.[1];
  const answer = answers[id] ?? report(120, 95);
  return typeof answer === 'number' ? json({ error: { message: 'secret detail from Google' } }, answer) : json(answer);
});

describe('Google Analytics reader', () => {
  it('reads a property as its number or properties/<number>, and nothing else', () => {
    expect(analyticsProperty('564318607')).toBe('564318607');
    expect(analyticsProperty(' properties/564318607 ')).toBe('564318607');
    for (const value of ['', null, 'G-6QJ870FNEV', 'properties/', '12', 'properties/abc']) expect(analyticsProperty(value)).toBeNull();
  });

  it('asks for the scorecard week and the week before in Eastern calendar days', () => {
    expect(analyticsRanges(window)).toEqual([
      { name: 'current', startDate: '2026-10-26', endDate: '2026-11-01' },
      { name: 'previous', startDate: '2026-10-19', endDate: '2026-10-25' },
    ]);
    expect(() => analyticsRanges({ ...window, since: window.until })).toThrow();
  });

  it('treats a period Google has no row for as unknown, never zero', () => {
    expect(countsOf(report(0, 7))).toEqual({ current: 0, previous: 7 });
    expect(countsOf(report(null, 7))).toEqual({ current: null, previous: 7 });
    expect(countsOf({})).toEqual({ current: null, previous: null });
    expect(() => countsOf({ rows: 'x' })).toThrow();
  });

  it('stays unconfigured without the key or a property, and makes no request', async () => {
    for (const options of [{ credentials: '', properties: { carebase: '564318607' } }, { credentials, properties: {} }, { credentials, properties: { carebase: 'G-6QJ870FNEV' } }]) {
      const fetchImpl = fakeGoogle();
      const reader = googleAnalyticsReader({ ...options, fetchImpl });
      expect(reader.configured).toBe(false);
      expect(await reader.read(window)).toEqual({ products: {} });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('signs in read-only and asks each property for active users only, with live settings', async () => {
    const fetchImpl = fakeGoogle({ 564318607: report(120, 95) });
    let property = '';
    const reader = googleAnalyticsReader({ credentials, properties: { carebase: () => property }, fetchImpl, clock: () => Date.parse('2026-11-02T13:00:00Z'), log: () => {} });
    expect(reader.configured).toBe(false);
    property = '564318607';
    expect(reader.configured).toBe(true);
    const result = await reader.read(window);
    expect(result.products).toEqual({ carebase: { state: 'read', visitors: 120, previous: 95 } });
    const [tokenCall, reportCall] = fetchImpl.mock.calls;
    expect(tokenCall[0]).toBe(tokenUrl);
    expect(tokenCall[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    const assertion = new URLSearchParams(tokenCall[1].body).get('assertion');
    const [header, claims, signature] = assertion.split('.');
    expect(JSON.parse(Buffer.from(claims, 'base64url'))).toMatchObject({ iss: 'hub@caremetric-hub.iam.gserviceaccount.com', scope: analyticsScope, aud: tokenUrl });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(reportCall[0]).toBe(`${analyticsDataOrigin}/v1beta/properties/564318607:runReport`);
    expect(reportCall[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(reportCall[1].body)).toEqual({ dateRanges: analyticsRanges(window), metrics: [{ name: 'activeUsers' }], keepEmptyRows: false });
  });

  it('keeps one failing property from hiding another and never logs what Google said', async () => {
    const lines = [];
    const fetchImpl = fakeGoogle({ 564318607: report(null, 40), 564321623: 403 });
    const reader = googleAnalyticsReader({ credentials, properties: { carebase: '564318607', 'caremetric-intel': '564321623' }, fetchImpl, log: line => lines.push(line) });
    const { products } = await reader.read(window);
    expect(products.carebase).toEqual({ state: 'partial', visitors: null, previous: 40 });
    expect(products['caremetric-intel']).toEqual({ state: 'unavailable', visitors: null, previous: null, error: 'analytics_not_permitted' });
    expect(lines.join('\n')).not.toMatch(/secret detail|ya29|PRIVATE KEY/);
  });

  it('marks every property unavailable when the sign-in is refused', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'invalid_grant' }, 400));
    const reader = googleAnalyticsReader({ credentials, properties: { carebase: '564318607' }, fetchImpl, log: () => {} });
    expect((await reader.read(window)).products.carebase).toMatchObject({ state: 'unavailable', error: 'analytics_token_refused' });
  });
});

describe('website visitors for the scorecard', () => {
  const nativeAnswer = { state: 'read', metric: 'anonymous_sessions', products: { carebase: { state: 'not_configured', visitors: null, previous: null },
    'caremetric-intel': { state: 'read', visitors: 300, previous: 250 } } };
  const native = (configured = true) => ({ configured, readiness: () => ({ declared: true, enabled: configured, signing: true }), read: vi.fn(async () => nativeAnswer) });

  it('keeps Intel on its own measurement and reads CareBase from Google Analytics', async () => {
    const fetchImpl = fakeGoogle({ 564318607: report(120, 95) });
    const analytics = googleAnalyticsReader({ credentials, properties: { carebase: '564318607', 'caremetric-intel': '564321623' }, fetchImpl });
    const own = native();
    const visitors = await websiteVisitors({ native: own, analytics }).read(window);
    expect(visitors).toEqual({ state: 'read', metric: 'anonymous_sessions', sources: { carebase: 'google_analytics' }, products: {
      carebase: { state: 'read', visitors: 120, previous: 95 }, 'caremetric-intel': { state: 'read', visitors: 300, previous: 250 } } });
    expect(fetchImpl.mock.calls.some(([url]) => url.includes('564321623'))).toBe(false);
    expect(websiteVisitors({ native: own, analytics }).readiness()).toEqual({ declared: true, enabled: true, signing: true });
  });

  it('reads Intel from Google Analytics when its own measurement is not set up', async () => {
    const analytics = googleAnalyticsReader({ credentials, properties: { 'caremetric-intel': '564321623' }, fetchImpl: fakeGoogle({ 564321623: report(80, 60) }) });
    const visitors = await websiteVisitors({ native: native(false), analytics }).read(window);
    expect(visitors.metric).toBe('visitors');
    expect(visitors.products['caremetric-intel']).toEqual({ state: 'read', visitors: 80, previous: 60 });
    expect(visitors.products.carebase.state).toBe('not_configured');
    expect(visitors.state).toBe('read');
  });

  it('says nothing is configured when neither source is', async () => {
    const visitors = await websiteVisitors({ native: native(false), analytics: googleAnalyticsReader({}) }).read(window);
    expect(visitors.state).toBe('not_configured');
  });

  it('labels Google Analytics figures in the scorecard and shows them as website visitors', async () => {
    const analytics = googleAnalyticsReader({ credentials, properties: { carebase: '564318607' }, fetchImpl: fakeGoogle({ 564318607: report(120, 95) }) });
    const visitors = await websiteVisitors({ native: native(), analytics }).read(window);
    const zero = { countyReports: 0, trialStarts: 0, activated: 0, delivered: 0, replies: 0, bounces: 0, complaints: 0, aiSpendCents: 0, byProduct: {} };
    const card = composeScorecard({ week: '2026-10-26', facts: { current: zero, previous: zero }, visitors });
    const text = JSON.stringify(card.blocks);
    expect(text).toContain('120 (last week 95)');
    expect(text).toContain('CareBase website visitors are Google Analytics active users');
  });
});
