import { describe, expect, it, vi } from 'vitest';
import { intelFeedFeature, intelFeedReader, intelFeedUrl } from './intel-feed.mjs';
import { leadSignature } from '../leads.mjs';

const key = 'feed-secret-0123456789abcdef0123456789';
const features = new Set([intelFeedFeature]);
const item = (ccn, extra = {}) => ({
  ccn, name: 'VALLEY HOSPICE', setting: 'hospice', city: 'Philadelphia', state: 'PA', zip: '19103', county_fips: '42101',
  control_type: 'Voluntary nonprofit, private', control_type_code: '2', certification_date: '2010-05-01', termination_date: null,
  change_of_ownership_date: null, signals: [], ...extra,
});
const page = (items, next = null, extra = {}) => ({ contract: 'caremetric.marketing-feed.v1', action: 'roster', period: '2026Q3',
  source_line: 'Source: CareMetric analytics derived from public CMS data.', items, next_cursor: next, ...extra });
const answer = (body, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const reader = (fetchImpl, options = {}) => intelFeedReader({ features, enabled: true, key, fetchImpl, now: () => 1794225600_000, ...options });

describe('Intel marketing feed reader', () => {
  it('signs exactly as Intel checks: the shared vector in Intel\'s tests/hubMarketingFeed.test.ts', () => {
    // The same secret, timestamp and body give the same header on both sides (Intel's marketingFeedSignature is leadSignature).
    expect(leadSignature(key, '1794225600', '{"action":"roster","states":["PA"]}'))
      .toBe('v1=a9c90fd353f87260d00dbd80105f867330a0f2eeebecb74ca620dd62ae645678');
  });

  it('posts a signed roster request to Intel\'s fixed address and reads the page, dropping fields it does not know', async () => {
    const fetchImpl = answer(page([item('391501', { contact: { address: '9 Elm Road', phone: '2155550199' }, quality: null, volume: null, future: 'kept out' })], '391501'));
    const result = await reader(fetchImpl).roster({ states: ['PA'] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(intelFeedUrl);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(init.body)).toEqual({ action: 'roster', states: ['PA'], limit: 500, include: ['contact', 'quality', 'volume'] });
    expect(init.headers['X-CareMetric-Timestamp']).toBe('1794225600');
    expect(init.headers['X-CareMetric-Signature']).toBe(leadSignature(key, '1794225600', init.body));
    expect(result.items[0]).toMatchObject({ ccn: '391501', contact: { phone: '2155550199' } });
    expect(result.items[0]).not.toHaveProperty('future');
    expect(result.next_cursor).toBe('391501');
  });

  it('passes the cursor of the previous page', async () => {
    const fetchImpl = answer(page([]));
    await reader(fetchImpl).roster({ states: ['PA', 'OH'], cursor: '391501' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ states: ['PA', 'OH'], cursor: '391501' });
  });

  it('is not configured without the migration, the setting or a long enough secret, and then makes no request', async () => {
    const fetchImpl = answer(page([]));
    for (const options of [{ features: new Set() }, { enabled: false }, { enabled: () => false }, { key: 'short' }]) {
      const feed = reader(fetchImpl, options);
      expect(feed.configured).toBe(false);
      await expect(feed.roster({ states: ['PA'] })).rejects.toMatchObject({ code: 'feed_not_configured' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reader(fetchImpl).readiness()).toEqual({ declared: true, enabled: true, signing: true });
  });

  it('maps Intel\'s answers to codes, transient where a later run may succeed', async () => {
    const cases = [[401, 'feed_not_permitted', false], [400, 'feed_request_refused', false], [429, 'feed_rate_limited', true],
      [503, 'feed_not_ready', true], [500, 'feed_unavailable', true]];
    for (const [status, code, transient] of cases) {
      await expect(reader(answer({ error: 'x', message: 'secret detail' }, status)).roster({ states: ['PA'] })).rejects.toMatchObject({ code, transient });
    }
    await expect(reader(vi.fn(async () => { throw new Error('network'); })).roster({ states: ['PA'] })).rejects.toMatchObject({ code: 'feed_unavailable', transient: true });
  });

  it('refuses an answer that is not the feed\'s, or too large', async () => {
    await expect(reader(answer({ contract: 'other', items: [] })).roster({ states: ['PA'] })).rejects.toMatchObject({ code: 'feed_response_invalid' });
    await expect(reader(answer(page([item('not a ccn')]))).roster({ states: ['PA'] })).rejects.toMatchObject({ code: 'feed_response_invalid' });
    const huge = vi.fn(async () => new Response('x'.repeat(2_100_000)));
    await expect(reader(huge).roster({ states: ['PA'] })).rejects.toMatchObject({ code: 'feed_response_too_large' });
  });

  it('reads county figures', async () => {
    const fetchImpl = answer({ contract: 'caremetric.marketing-feed.v1', action: 'county_figures', source_line: 's', not_found: [],
      counties: [{ county_fips: '42003', county_name: 'Allegheny', state: 'PA', figures: [{ key: 'medicare_beneficiaries', label: 'Medicare beneficiaries',
        value: 250000, unit: 'count', data_year: '2026', period: '2026-06', dataset: 'CMS Medicare Monthly Enrollment', source_line: 's' }] }] });
    const result = await reader(fetchImpl).countyFigures({ countyFips: ['42003'] });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ action: 'county_figures', county_fips: ['42003'] });
    expect(result.counties[0].figures[0]).toMatchObject({ key: 'medicare_beneficiaries', value: 250000 });
  });
});

describe('agency facts', () => {
  it('asks for up to 25 agencies\' owners and scores', async () => {
    const fetchImpl = answer({ contract: 'caremetric.marketing-feed.v1', action: 'agency_facts', source_line: 's', agencies: [{ ccn: '391501',
      owners: [{ name: 'Jane Doe', kind: 'individual', role: 'Owner', percentage: 60, data_year: '2026' }], hhvbp: null, hospice_care_index: { score: 8 } }] });
    const result = await reader(fetchImpl).agencyFacts({ ccns: ['391501'] });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ action: 'agency_facts', ccns: ['391501'] });
    expect(result.agencies[0].owners[0]).toMatchObject({ name: 'Jane Doe', kind: 'individual' });
  });
});

describe('releases and observances', () => {
  it('reads the releases Intel loaded recently and the observances starting soon', async () => {
    const releases = answer({ contract: 'caremetric.marketing-feed.v1', action: 'releases', source_line: 's', releases: [{ dataset: 'home_health_compare',
      title: 'Home Health Care Agencies', data_year: '2026', period_start: '2026-01-01', period_end: '2026-09-30', published: '2026-10-28', loaded: '2026-11-02' }] });
    expect((await reader(releases).releases({ sinceDays: 14 })).releases[0]).toMatchObject({ dataset: 'home_health_compare', loaded: '2026-11-02' });
    expect(JSON.parse(releases.mock.calls[0][1].body)).toEqual({ action: 'releases', since_days: 14 });
    const observances = answer({ contract: 'caremetric.marketing-feed.v1', action: 'observances', today: '2026-11-09', observances: [{ id: 'np-week',
      name: 'National Nurse Practitioner Week', category: 'people', audience: 'Nurse practitioners', sponsor: 'AANP', start: '2026-11-08', end: '2026-11-14', idea: 'Thank the NPs.' }] });
    expect((await reader(observances).observances()).observances[0].id).toBe('np-week');
    expect(JSON.parse(observances.mock.calls[0][1].body)).toEqual({ action: 'observances', days: 45 });
    await expect(reader(answer({ contract: 'caremetric.marketing-feed.v1', action: 'observances', today: 'x', observances: [] })).observances())
      .rejects.toMatchObject({ code: 'feed_response_invalid' });
  });
});
