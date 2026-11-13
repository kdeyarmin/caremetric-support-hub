import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { marketingFeed, marketingFeedContract, marketingFeedSignature, marketingFeedUrl, readRoster } from './roster.mjs';

const secret = 'synthetic-roster-secret-that-must-not-leak-0123456789';
const at = Date.parse('2026-11-13T15:00:00Z');
const facility = (ccn, extra = {}) => ({ ccn, name: 'VALLEY HOSPICE', setting: 'hospice', city: 'Philadelphia', state: 'PA', zip: '19103', county_fips: '42101',
  control_type: 'Voluntary nonprofit, private', control_type_code: '2', certification_date: '2025-09-01', termination_date: null,
  change_of_ownership_date: null, signals: [], ...extra });
const answer = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const page = (items, next = null, period = '2026Q3') => ({ contract: marketingFeedContract, action: 'roster', period, source_line: 'Source: CareMetric analytics.', items, next_cursor: next });
const client = (fetchImpl, options = {}) => marketingFeed({ secret, fetchImpl, now: () => at, ...options });

afterEach(() => vi.restoreAllMocks());

describe('the CMS roster client', () => {
  it('signs exactly the bytes it sends, as Intel\'s feed documents: v1= and the HMAC-SHA256 of "<timestamp>.<body>"', async () => {
    const fetchImpl = vi.fn(async () => answer(page([facility('391501')])));
    await client(fetchImpl).roster({ states: ['PA', 'OH'], settings: ['home_health', 'hospice'], certifiedSince: '2025-05-14', limit: 500 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://www.caremetricintel.com/api/hub/marketing-feed');
    expect(url).toBe(marketingFeedUrl);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-CareMetric-Timestamp']).toBe('1794582000');
    const expected = `v1=${createHmac('sha256', secret).update(`1794582000.${init.body}`, 'utf8').digest('hex')}`;
    expect(init.headers['X-CareMetric-Signature']).toBe(expected);
    expect(init.headers['X-CareMetric-Signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(marketingFeedSignature(secret, '1794582000', init.body)).toBe(expected);
    expect(JSON.parse(init.body)).toEqual({ action: 'roster', states: ['PA', 'OH'], settings: ['home_health', 'hospice'], certified_since: '2025-05-14', limit: 500 });
    // The secret travels only as the signature.
    expect(JSON.stringify(init)).not.toContain(secret);
  });

  it('sends the cursor and the change-of-ownership filter when given, and nothing it was not given', async () => {
    const fetchImpl = vi.fn(async () => answer(page([])));
    await client(fetchImpl).roster({ states: ['PA'], chowSince: '2025-05-14', cursor: '391501', limit: 100 });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ action: 'roster', states: ['PA'], chow_since: '2025-05-14', cursor: '391501', limit: 100 });
  });

  it('reads the facilities, keeps the ones in the contract\'s shape and counts the rest', async () => {
    const fetchImpl = vi.fn(async () => answer(page([facility('391501'), facility('bad'), { ...facility('397001'), setting: 'nursing_home' }, facility('397002', { city: null, signals: undefined })], '397002')));
    const result = await client(fetchImpl).roster({ states: ['PA'] });
    expect(result).toMatchObject({ period: '2026Q3', nextCursor: '397002', skipped: 2 });
    expect(result.items.map(item => item.ccn)).toEqual(['391501', '397002']);
    expect(result.items[1]).toMatchObject({ city: null, signals: [], termination_date: null });
  });

  it('is configured only with the switch on and a secret of at least 32 characters, and then sends nothing', async () => {
    const fetchImpl = vi.fn();
    let enabled = true;
    const live = marketingFeed({ secret, enabled: () => enabled, fetchImpl });
    expect(live.configured).toBe(true);
    expect(live.readiness()).toEqual({ enabled: true, signing: true });
    enabled = false;
    expect(live.configured).toBe(false);
    await expect(live.roster({ states: ['PA'] })).rejects.toMatchObject({ code: 'feed_off' });
    for (const short of ['', undefined, 'x'.repeat(31)]) {
      const feed = marketingFeed({ secret: short, fetchImpl });
      expect(feed.configured).toBe(false);
      expect(feed.readiness()).toEqual({ enabled: true, signing: false });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names a refusal by Intel\'s own error code, with a fixed message that holds no secret and nothing Intel said', async () => {
    const log = ['log', 'info', 'warn', 'error', 'debug'].map(name => vi.spyOn(console, name).mockImplementation(() => {}));
    const cases = [
      [answer({ error: 'invalid_signature', message: `bad signature for ${secret}` }, 401), 'feed_invalid_signature', false],
      [answer({ error: 'expired_timestamp', message: 'clock' }, 401), 'feed_expired_timestamp', false],
      [answer({ error: 'not_configured', message: 'unset' }, 503), 'feed_not_configured', true],
      [answer({ error: 'not_ready', message: 'no POS file' }, 503), 'feed_not_ready', true],
      [answer({ message: 'Too many requests' }, 429, { 'Retry-After': '30' }), 'feed_rate_limited', true],
      [answer({ error: 'something new', message: 'private words' }, 500), 'feed_unavailable', true],
      [answer('<html>proxy error</html>', 502), 'feed_unavailable', true],
    ];
    for (const [response, code, transient] of cases) {
      const error = await client(vi.fn(async () => response)).roster({ states: ['PA'] }).catch(caught => caught);
      expect(error, code).toMatchObject({ code, transient, message: 'The CMS roster could not be read.' });
      expect(JSON.stringify({ ...error, message: error.message }), code).not.toMatch(new RegExp(`${secret}|private words|proxy error|no POS file`));
    }
    const network = await client(vi.fn(async () => { throw new TypeError(`connect ECONNREFUSED ${secret}`); })).roster({ states: ['PA'] }).catch(caught => caught);
    expect(network).toMatchObject({ code: 'feed_unavailable', transient: true, message: 'The CMS roster could not be read.' });
    for (const spy of log) expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an answer that is not the roster contract or is too large, and gives up after its time limit', async () => {
    for (const body of [{ ...page([]), contract: 'caremetric.other.v1' }, { ...page([]), action: 'county_figures' }, { items: [] }, 'not json']) {
      await expect(client(vi.fn(async () => answer(body))).roster({ states: ['PA'] })).rejects.toMatchObject({ code: 'feed_response_invalid' });
    }
    await expect(client(vi.fn(async () => answer(page([]), 200, { 'Content-Length': '2000000' }))).roster({ states: ['PA'] })).rejects.toMatchObject({ code: 'feed_response_too_large' });
    const huge = JSON.stringify(page([])).replace('"items":[]', `"items":[],"padding":"${'x'.repeat(1_100_000)}"`);
    await expect(client(vi.fn(async () => answer(huge))).roster({ states: ['PA'] })).rejects.toMatchObject({ code: 'feed_response_too_large' });
    const hanging = vi.fn((_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
    await expect(client(hanging, { timeoutMs: 20 }).roster({ states: ['PA'] })).rejects.toMatchObject({ code: 'feed_timeout', transient: true });
  });

  it('passes the caller\'s abort through instead of naming it a feed failure', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason)); controller.abort(new Error('run stopped')); }));
    await expect(client(fetchImpl).roster({ states: ['PA'], signal: controller.signal })).rejects.toThrow('run stopped');
  });
});

describe('reading every page', () => {
  const feedOf = pages => {
    const roster = vi.fn(async ({ cursor }) => pages[cursor ?? 'first']);
    return { roster };
  };

  it('follows the cursor to the last page, keeping the filters on every page', async () => {
    const feed = feedOf({ first: { period: '2026Q3', items: [facility('050001')], nextCursor: '050001', skipped: 0 },
      '050001': { period: '2026Q3', items: [facility('391501')], nextCursor: '391501', skipped: 1 },
      '391501': { period: '2026Q3', items: [facility('397001')], nextCursor: null, skipped: 0 } });
    const read = await readRoster(feed, { states: ['PA'], certifiedSince: '2025-05-14' });
    expect(read).toMatchObject({ period: '2026Q3', pages: 3, skipped: 1, complete: true });
    expect(read.items.map(item => item.ccn)).toEqual(['050001', '391501', '397001']);
    expect(feed.roster.mock.calls.map(([query]) => [query.cursor, query.certifiedSince])).toEqual([[null, '2025-05-14'], ['050001', '2025-05-14'], ['391501', '2025-05-14']]);
  });

  it('stops at the page limit, when the run\'s time is spent, and when a cursor does not move on', async () => {
    const endless = { roster: vi.fn(async ({ cursor }) => ({ period: '2026Q3', items: [facility(String(Number(cursor ?? 100000) + 1))], nextCursor: String(Number(cursor ?? 100000) + 1), skipped: 0 })) };
    expect(await readRoster(endless, { states: ['PA'] }, { maxPages: 2 })).toMatchObject({ pages: 2, complete: false });
    let calls = 0;
    expect(await readRoster(endless, { states: ['PA'] }, { maxPages: 4, spent: () => calls++ >= 1 })).toMatchObject({ pages: 1, complete: false });
    const stuck = { roster: vi.fn(async () => ({ period: '2026Q3', items: [], nextCursor: '391501', skipped: 0 })) };
    expect(await readRoster(stuck, { states: ['PA'] }, { maxPages: 4 })).toMatchObject({ pages: 2, complete: false });
  });
});
