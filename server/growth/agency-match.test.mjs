import { describe, expect, it, vi } from 'vitest';
import { growthRosterMatchFeature, matchCandidate, matchDailyDefault, matchHandlers, matchName, matchPlace, matchedRow, matchesPerRun, pageText,
  placesIn, publishedPhones } from './agency-match.mjs';
import { growthContactFinder } from './contacts.mjs';
import { rosterAgency } from './report-link.mjs';

const features = new Set([growthRosterMatchFeature]);
const now = () => new Date('2026-11-15T15:00:00Z');
const agency = (ccn, extra = {}) => ({ ccn, name: 'SUNRISE HOME HEALTH LLC', setting: 'home_health', city: 'Cleveland', state: 'OH', zip: '44113',
  county_fips: '39035', control_type: 'Proprietary', control_type_code: '4', certification_date: '2012-03-01', termination_date: null,
  change_of_ownership_date: null, signals: [], quality: null, volume: { data_year: '2023', medicare_patients: 300, county_fips: '39035', county_share: 0.05,
    county_rank: 7, county_providers: 60, state_share: null, state_rank: null, state_providers: null }, ...extra });
const answer = (matches, period = '2026Q3') => ({ contract: 'caremetric.marketing-feed.v1', action: 'agency_match', period, source_line: 's', matches });

describe('what a website publishes', () => {
  it('reads telephone numbers as ten digits, call links first, never a fax', () => {
    const html = `<header><a href="tel:+1-412-555-0100">Call us</a></header><p>Office: (412) 555-0111 &middot; Fax: 412.555.0122</p>
      <p>F: 412-555-0133</p><footer>Intake 1 (412) 555-0111 · Toll free 800-555-0144</footer><script>var x = "412-555-0155";</script>`;
    expect(publishedPhones(html)).toEqual(['4125550100', '4125550111', '8005550144']);
  });

  it('reads the postal addresses a page writes, with the city after the street', () => {
    const text = pageText(`<footer><address>Sunrise Home Health<br>123 Main St, Suite 200<br>Pittsburgh, PA 15213</address>
      <p>1700 Lakeside Ave Cleveland, Ohio 44114-1234</p><p>PO Box 9, Erie PA 16501</p><p>Dr. Jane Roe, MD 2</p></footer>`);
    expect(placesIn(text)).toEqual([
      { city: 'Pittsburgh', state: 'PA', zip: '15213' },
      { city: 'Cleveland', state: 'OH', zip: '44114' },
      { city: 'Erie', state: 'PA', zip: '16501' },
    ]);
    expect(placesIn('Serving West Virginia 26501 and more')).toEqual([{ city: null, state: 'WV', zip: '26501' }]);
    expect(placesIn('Call 412 555 0100 today')).toEqual([]);
    expect(placesIn('100 Market St. St. Louis, MO 63101')).toEqual([{ city: 'St. Louis', state: 'MO', zip: '63101' }]);
    expect(placesIn('St. Louis, MO 63101')).toEqual([{ city: 'St. Louis', state: 'MO', zip: '63101' }]);
    expect(placesIn('Serving Wheeling, WV 26003')).toEqual([{ city: 'Wheeling', state: 'WV', zip: '26003' }]);
  });

  it('keeps only the visible text of a page', () => {
    expect(pageText('<style>p{}</style><p>A &amp; B&nbsp;&#67;</p><!-- hidden 15213 --><noscript>x</noscript>')).toBe('A & B C');
  });
});

describe('where a prospect is', () => {
  it('takes its own website\'s address first', () => {
    expect(matchPlace([{ city: 'Cleveland', state: 'OH', zip: '44113' }], ['Home care in Pittsburgh, PA 15213'])).toEqual({ state: 'OH', city: 'Cleveland', zip: '44113' });
  });
  it('else an address in the Hub\'s evidence, the state of the discovery market it names, or the one state it names', () => {
    expect(matchPlace([], ['Visit us at 9 Elm Road, Erie, PA 16501.'])).toEqual({ state: 'PA', city: 'Erie', zip: '16501' });
    // Where discovery searched is not where the agency is: the state only, so only a published number can match it.
    expect(matchPlace([], ['Skilled nursing at home across Cleveland and Northeast Ohio.'])).toEqual({ state: 'OH', city: null, zip: null });
    expect(matchPlace([], ['Hospice care for families in Pittsburgh and the region.'])).toEqual({ state: 'PA', city: null, zip: null });
    expect(matchPlace([], ['Serving every county of Kentucky.'])).toEqual({ state: 'KY', city: null, zip: null });
  });
  it('places nothing when the evidence names no state, or several', () => {
    expect(matchPlace([], ['The best home health agency.'])).toBeNull();
    expect(matchPlace([], ['Offices in Ohio and Pennsylvania.'])).toBeNull();
    // A market whose state the evidence contradicts is not the place.
    expect(matchPlace([], ['Columbus, Georgia home care; Georgia licensed.'])).toEqual({ state: 'GA', city: null, zip: null });
  });
});

describe('what Intel is asked', () => {
  it('sends the name and the home page title as parts, the place and at most six numbers', () => {
    expect(matchName('Sunrise Home Health | Cleveland', 'Sunrise Home Health | Cleveland')).toBe('Sunrise Home Health | Cleveland');
    expect(matchName('sunrisehh.com', 'Sunrise Home Health')).toBe('sunrisehh.com | Sunrise Home Health');
    const prospect = { organizationId: 'org-1', name: 'Sunrise Home Health', domain: 'sunrisehh.com', evidence: [] };
    expect(matchCandidate(prospect, { phones: ['2165550101', '2165550102', '2165550103', '2165550104', '2165550105', '2165550106', '2165550107'],
      places: [{ city: 'Cleveland', state: 'OH', zip: '44113' }], title: 'Home | Sunrise Home Health' })).toEqual({
      key: 'org-1', name: 'Sunrise Home Health | Home | Sunrise Home Health', domain: 'sunrisehh.com', state: 'OH', city: 'Cleveland', zip: '44113',
      phones: ['2165550101', '2165550102', '2165550103', '2165550104', '2165550105', '2165550106'],
    });
    expect(matchCandidate(prospect, { phones: ['2165550101'], places: [], title: null })).toBeNull();
    expect(matchCandidate({ ...prospect, domain: 'odd-.example' }, { phones: [], places: [{ city: null, state: 'OH', zip: null }], title: null }))
      .toEqual({ key: 'org-1', name: 'Sunrise Home Health', domain: null, state: 'OH', phones: [] });
  });
});

describe('a match as a roster record', () => {
  it('becomes the roster\'s record, whose claim the report link reads', () => {
    const { row } = matchedRow({ key: 'org-1', ccn: '367001', matched_by: 'phone', reason: null, agency: agency('367001') }, '2026Q3', now());
    expect(row).toMatchObject({ ccn: '367001', setting: 'home_health', state: 'OH', city: 'Cleveland', excluded: false });
    expect(row.facts).not.toHaveProperty('phone');
    expect(rosterAgency([{ claim: row.claim }])).toEqual({ ccn: '367001', setting: 'hha' });
    expect(row.research).toMatch(/^Research only, not for outreach:/);
  });
  it('never takes CareMetric\'s own agency, one CMS shows closed, or an answer that does not hold together', () => {
    expect(matchedRow({ ccn: '398009', agency: agency('398009', { state: 'PA' }) }, '2026Q3', now())).toEqual({ reason: 'own_agency' });
    expect(matchedRow({ ccn: '367004', agency: agency('367004', { termination_date: '2025-01-01' }) }, '2026Q3', now())).toEqual({ reason: 'excluded' });
    expect(matchedRow({ ccn: '367001', agency: agency('367002') }, '2026Q3', now())).toEqual({ reason: 'not_found' });
    expect(matchedRow({ ccn: null, reason: 'ambiguous', agency: null }, '2026Q3', now())).toEqual({ reason: 'ambiguous' });
    expect(matchedRow({ ccn: '367001', agency: agency('367001') }, null, now())).toEqual({ reason: 'not_loaded' });
  });
});

function setup({ prospects = [
  { organizationId: 'org-1', name: 'Sunrise Home Health', domain: 'sunrisehh.com', evidence: [] },
  { organizationId: 'org-2', name: 'Lakeshore Hospice', domain: 'lakeshorehospice.org', evidence: ['Hospice care across Cleveland and Northeast Ohio.'] },
  { organizationId: 'org-3', name: 'Best Care', domain: 'bestcare.example', evidence: ['Caring for you.'] },
], listings = {
  'sunrisehh.com': { phones: ['2165550101'], places: [{ city: 'Cleveland', state: 'OH', zip: '44113' }], title: 'Sunrise Home Health', read: 2 },
  'lakeshorehospice.org': { phones: [], places: [], title: null, read: 1 },
  'bestcare.example': { phones: ['2165550199'], places: [], title: null, read: 1 },
}, matches = [
  { key: 'org-1', ccn: '367001', matched_by: 'phone', reason: null, agency: agency('367001') },
  { key: 'org-2', ccn: null, matched_by: null, reason: 'ambiguous', agency: null },
], daily = 40, marketed = ['caremetric-intel'], clockStep = 0 } = {}) {
  const store = {
    matchNext: vi.fn(async () => prospects),
    matchRecord: vi.fn(async (_org, data) => (data.outcome === 'matched' ? { matched: true, ccn: data.row.ccn } : { matched: false, reason: data.reason })),
  };
  const feed = { configured: true, agencyMatch: vi.fn(async () => answer(matches)) };
  const contacts = { configured: true, listing: vi.fn(async domain => listings[domain] ?? { phones: [], places: [], title: null, read: 0 }) };
  const growth = { store, contacts, roster: { feed, matchDaily: daily } };
  let time = 0;
  const clock = () => (time += clockStep);
  const run = (task = { id: 't', agent: { autonomy: 'propose' } }) => matchHandlers({ growth, features, marketed, clock })['growth.match'](task, { now });
  return { store, feed, contacts, growth, run };
}

describe('growth.match', () => {
  it('reads each prospect\'s site, asks Intel once, and attaches a match as a roster record', async () => {
    const { store, feed, contacts, run } = setup();
    const { result } = await run();
    expect(store.matchNext).toHaveBeenCalledWith(matchesPerRun, 40);
    expect(contacts.listing).toHaveBeenCalledTimes(3);
    // One request for every prospect with a place; the one the evidence does not place is not sent.
    expect(feed.agencyMatch).toHaveBeenCalledTimes(1);
    expect(feed.agencyMatch.mock.calls[0][0].candidates).toEqual([
      { key: 'org-1', name: 'Sunrise Home Health', domain: 'sunrisehh.com', state: 'OH', city: 'Cleveland', zip: '44113', phones: ['2165550101'] },
      { key: 'org-2', name: 'Lakeshore Hospice', domain: 'lakeshorehospice.org', state: 'OH', phones: [] },
    ]);
    const [org, data] = store.matchRecord.mock.calls.find(([id]) => id === 'org-1');
    expect(org).toBe('org-1');
    expect(data).toMatchObject({ outcome: 'matched', method: 'phone', period: '2026Q3', row: { ccn: '367001', setting: 'home_health' } });
    expect(store.matchRecord).toHaveBeenCalledWith('org-2', { outcome: 'unmatched', reason: 'ambiguous' });
    expect(store.matchRecord).toHaveBeenCalledWith('org-3', { outcome: 'unmatched', reason: 'no_place' });
    // The numbers the sites publish go to Intel only: nothing recorded holds one.
    expect(JSON.stringify(store.matchRecord.mock.calls)).not.toMatch(/2165550/);
    expect(result).toEqual({ tried: 3, matched: 1, byPhone: 1, byName: 0, unmatched: { ambiguous: 1, no_place: 1 } });
  });

  it('never attaches CareMetric\'s own agency', async () => {
    const { store, run } = setup({ matches: [{ key: 'org-1', ccn: '398009', matched_by: 'phone', reason: null, agency: agency('398009', { state: 'PA' }) }] });
    await run();
    expect(store.matchRecord).toHaveBeenCalledWith('org-1', { outcome: 'unmatched', reason: 'own_agency' });
    expect(store.matchRecord.mock.calls.some(([, data]) => data.outcome === 'matched')).toBe(false);
  });

  it('puts prospects back for an hour when the feed cannot answer, and fails the run when Intel refuses the request', async () => {
    const busy = setup();
    busy.feed.agencyMatch = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'feed_rate_limited', transient: true }); });
    expect((await busy.run()).result).toMatchObject({ stopped: 'feed_rate_limited' });
    expect(busy.store.matchRecord).toHaveBeenCalledWith('org-1', { outcome: 'unmatched', reason: 'retry' });
    const refused = setup();
    refused.feed.agencyMatch = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'feed_request_refused', transient: false }); });
    await expect(refused.run()).rejects.toMatchObject({ code: 'feed_request_refused' });
    expect(refused.store.matchRecord).toHaveBeenCalledWith('org-2', { outcome: 'unmatched', reason: 'retry' });
  });

  it('records a match the database refuses as an invalid record rather than trying it again every hour', async () => {
    const { store, run } = setup();
    store.matchRecord = vi.fn(async (_org, data) => {
      if (data.outcome === 'matched') throw Object.assign(new Error('bad'), { code: '22023' });
      return { matched: false, reason: data.reason };
    });
    const { result } = await run();
    expect(store.matchRecord).toHaveBeenCalledWith('org-1', { outcome: 'unmatched', reason: 'invalid_record' });
    expect(result.unmatched.invalid_record).toBe(1);
  });

  it('reads no more websites once the run\'s time is spent, and hands the rest out again', async () => {
    const prospects = Array.from({ length: 6 }, (_, i) => ({ organizationId: `org-${i}`, name: 'Sunrise Home Health', domain: 'sunrisehh.com', evidence: [] }));
    const { store, contacts, run } = setup({ clockStep: 70_000, prospects, matches: [] });
    await run();
    // The first four sites are read together; the next group would start past the run's two minutes.
    expect(contacts.listing).toHaveBeenCalledTimes(4);
    expect(store.matchRecord).toHaveBeenCalledWith('org-4', { outcome: 'unmatched', reason: 'retry' });
    expect(store.matchRecord).toHaveBeenCalledWith('org-5', { outcome: 'unmatched', reason: 'retry' });
  });

  it('hands a prospect whose website could not be read out again, instead of asking Intel without its numbers', async () => {
    const { store, contacts, feed, run } = setup();
    contacts.listing.mockImplementation(async domain => { if (domain === 'sunrisehh.com') throw new Error('timeout'); return { phones: [], places: [], title: null, read: 0 }; });
    const { result } = await run();
    expect(store.matchRecord).toHaveBeenCalledWith('org-1', { outcome: 'unmatched', reason: 'site_unreadable' });
    expect(feed.agencyMatch.mock.calls.flatMap(([arg]) => arg.candidates).map(c => c.key)).not.toContain('org-1');
    expect(result.unmatched.site_unreadable).toBe(1);
  });

  it('does nothing in Observe, without the feed or the feature, when Intel is not marketed, or with a daily number of 0', async () => {
    expect((await setup().run({ id: 't', agent: { autonomy: 'observe' } })).result).toEqual({ skipped: 'observe_only' });
    const unconfigured = setup();
    unconfigured.feed.configured = false;
    expect((await unconfigured.run()).result).toEqual({ skipped: 'feed_not_configured' });
    expect((await setup({ marketed: ['carebase'] }).run()).result).toEqual({ skipped: 'not_marketed' });
    const off = setup({ daily: 0 });
    expect((await off.run()).result).toEqual({ skipped: 'daily_number_zero' });
    expect(off.store.matchNext).not.toHaveBeenCalled();
    const unset = setup({ daily: null });
    await unset.run();
    expect(unset.store.matchNext).toHaveBeenCalledWith(matchesPerRun, matchDailyDefault);
    expect(matchHandlers({ growth: setup().growth, features: new Set() })).toEqual({});
  });
});

describe('the contact finder\'s listing', () => {
  const page = body => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  it('reads the numbers, addresses and title a site publishes on its contact pages, within robots.txt', async () => {
    const pages = {
      'https://sunrisehh.com/robots.txt': new Response('User-agent: *\nDisallow: /about', { status: 200, headers: { 'content-type': 'text/plain' } }),
      'https://sunrisehh.com/': page('<title>Sunrise Home Health | Cleveland</title><body><a href="tel:2165550101">Call</a></body>'),
      'https://sunrisehh.com/contact': page('<p>1700 Lakeside Ave, Cleveland, OH 44113</p><p>Fax: 216-555-0109</p>'),
      'https://sunrisehh.com/about': page('<p>(216) 555-0177</p>'),
    };
    const fetchImpl = vi.fn(async url => pages[url] ?? new Response('Not found', { status: 404 }));
    const finder = growthContactFinder({ fetchImpl, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
    expect(await finder.listing('sunrisehh.com')).toEqual({ phones: ['2165550101'], places: [{ city: 'Cleveland', state: 'OH', zip: '44113' }],
      title: 'Sunrise Home Health | Cleveland', read: 4 });
    expect(fetchImpl.mock.calls.map(([url]) => url)).not.toContain('https://sunrisehh.com/about');
    expect(await finder.listing('not a domain')).toEqual({ phones: [], places: [], title: null, read: 0 });
  });
});
