import { afterEach, describe, expect, it, vi } from 'vitest';
import { careCompareUrl, displayName, facilityQuery, matchesFacility, nameTokens, rosterAllowanceReserve, rosterChoices, rosterClaim, rosterDiscovery,
  rosterSearchLimit, rosterSignals, searchable, tradingName } from './roster-discovery.mjs';
import { rosterPlan } from './playbook.mjs';
import { screenIdentifiers } from '../agents/concierge/screen.mjs';

const moment = new Date('2026-11-13T15:00:00Z');
const window = { since: '2025-05-14', today: '2026-11-13' };
const facility = (ccn, extra = {}) => ({ ccn, name: 'VALLEY HOSPICE', setting: 'hospice', city: 'Philadelphia', state: 'PA', certification_date: '2010-05-01',
  termination_date: null, change_of_ownership_date: null, signals: [], ...extra });
const site = (domain, title, claim = 'Compassionate hospice care for families in Philadelphia.', path = '/') => ({ name: title, domain, url: `https://${domain}${path}`, claim });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('which facilities the roster offers', () => {
  it('prefers a recent change of ownership or new certification, and never a terminated or closed agency', () => {
    expect(rosterSignals(facility('391501', { change_of_ownership_date: '2026-03-01' }), window)).toEqual([{ kind: 'change_of_ownership', date: '2026-03-01' }]);
    expect(rosterSignals(facility('391502', { certification_date: '2025-09-15' }), window)).toEqual([{ kind: 'newly_certified', date: '2025-09-15' }]);
    // Certified long ago, or changed owners before the window: nothing recent.
    expect(rosterSignals(facility('391503', { change_of_ownership_date: '2024-12-31' }), window)).toEqual([]);
    expect(rosterSignals(facility('391504', { certification_date: '2025-09-15', termination_date: '2026-10-01' }), window)).toEqual([]);
    expect(rosterSignals(facility('391505', { certification_date: '2025-09-15', signals: [{ type: 'closed', date: null }] }), window)).toEqual([]);
    // A date after today is a data error, not a signal.
    expect(rosterSignals(facility('391506', { certification_date: '2027-01-01' }), window)).toEqual([]);
  });

  it('orders the most recent change first, then Pennsylvania and its neighbours, once per CCN, inside the market states only', () => {
    const states = rosterPlan('caremetric-intel').states;
    expect(states.slice(0, 3)).toEqual(['PA', 'OH', 'MD']);
    expect(rosterPlan('carebase')).toBeNull();
    const items = [
      facility('057001', { state: 'CA', setting: 'home_health', certification_date: '2026-06-01' }),
      facility('367001', { state: 'OH', setting: 'home_health', change_of_ownership_date: '2026-06-01' }),
      facility('391501', { change_of_ownership_date: '2026-06-01' }),
      facility('391501', { change_of_ownership_date: '2026-06-01' }),
      facility('391502', { certification_date: '2025-06-01', change_of_ownership_date: '2026-09-30' }),
      facility('391503', { certification_date: '2025-07-01' }),
      facility('391504'),
      facility('501501', { state: 'VT', certification_date: '2026-10-01' }),
    ];
    const chosen = rosterChoices(items, { ...window, states });
    expect(chosen.map(entry => entry.item.ccn)).toEqual(['391502', '391501', '367001', '057001', '391503']);
    expect(chosen[0].signals.map(found => found.kind)).toEqual(['change_of_ownership', 'newly_certified']);
  });
});

describe('matching an agency to its own website', () => {
  const valley = facility('391501', { change_of_ownership_date: '2026-03-01' });

  it('reads the trading name and the words that tell the agency apart', () => {
    expect(tradingName('KEYSTONE HOLDINGS LLC DBA SUNRISE HOME HEALTH')).toBe('SUNRISE HOME HEALTH');
    expect(tradingName('SUNRISE HOME HEALTH, INC. D/B/A SUNRISE CARE')).toBe('SUNRISE CARE');
    expect(displayName('AMEDISYS HOME HEALTH OF PITTSBURGH')).toBe('Amedisys Home Health of Pittsburgh');
    expect(displayName("ST. LUKE'S VNA HOME CARE LLC")).toBe("St. Luke's VNA Home Care LLC");
    expect(nameTokens({ ...valley, name: 'AMEDISYS HOME HEALTH OF PITTSBURGH', city: 'Pittsburgh' })).toEqual(['amedisys']);
    expect(nameTokens({ ...valley, name: 'HOSPICE OF CENTRAL PENNSYLVANIA' })).toEqual([]);
    expect(searchable({ ...valley, name: 'HOME HEALTH CARE OF PHILADELPHIA, INC' })).toBe(false);
    expect(searchable({ ...valley, name: 'ABC HOME HEALTH' })).toBe(false);
    expect(searchable(valley)).toBe(true);
    expect(facilityQuery(valley)).toBe('Valley Hospice Philadelphia PA');
    expect(facilityQuery({ ...valley, name: 'GOLDEN YEARS LLC', setting: 'home_health', city: 'PITTSBURGH' })).toBe('Golden Years home health Pittsburgh PA');
  });

  it('accepts the agency\'s own site, a chain\'s site, and a site named after the trading name', () => {
    expect(matchesFacility(valley, site('valleyhospice.org', 'Valley Hospice | Philadelphia'))).toBe(true);
    expect(matchesFacility(valley, site('www.valleyhospice.org', 'Home', 'We serve families across Philadelphia.'))).toBe(true);
    expect(matchesFacility(valley, { ...site('valleyhospice.org', 'Home', 'Hospice and palliative care.'), domain: 'valleyhospice.org', url: 'https://www.valleyhospice.org/about' })).toBe(true);
    const amedisys = facility('397001', { name: 'AMEDISYS HOME HEALTH OF PITTSBURGH', setting: 'home_health', city: 'Pittsburgh' });
    expect(matchesFacility(amedisys, site('amedisys.com', 'Amedisys | Home Health, Hospice and Personal Care', 'Home health care near you.'))).toBe(true);
    expect(matchesFacility(amedisys, site('pittsburgh.amedisys.com', 'Amedisys Pittsburgh', 'Skilled home health.'))).toBe(true);
    const sunrise = facility('397002', { name: 'KEYSTONE HOLDINGS LLC DBA SUNRISE HOME HEALTH', setting: 'home_health' });
    expect(matchesFacility(sunrise, site('sunrisehomehealthpa.com', 'Sunrise Home Health', 'Home health in Philadelphia.'))).toBe(true);
  });

  it('rejects directories, listings, government and social sites, other businesses and pages that only mention the agency', () => {
    for (const host of ['hospicedirectory.org', 'caring.com', 'medicare.gov', 'facebook.com', 'valleyhospice.reviews.example', 'npino.com', 'valley-hospice-jobs.com']) {
      expect(matchesFacility(valley, site(host, 'Valley Hospice in Philadelphia, PA'))).toBe(false);
    }
    // The name appears only in the title of someone else's page.
    expect(matchesFacility(valley, site('phillynews.com', 'Valley Hospice opens a new office'))).toBe(false);
    // A business with the same word in its name that says nothing about care.
    expect(matchesFacility(valley, site('valleyfarms.com', 'Valley Farms Market', 'Fresh produce in Philadelphia.'))).toBe(false);
    // A three-letter name is too short to check against a domain.
    expect(matchesFacility(facility('391509', { name: 'ACE HOSPICE' }), site('placehospice.com', 'Place Hospice'))).toBe(false);
    // Not https, a port, or an address on another host.
    expect(matchesFacility(valley, { ...site('valleyhospice.org', 'Valley Hospice'), url: 'http://valleyhospice.org/' })).toBe(false);
    expect(matchesFacility(valley, { ...site('valleyhospice.org', 'Valley Hospice'), url: 'https://valleyhospice.org:8443/' })).toBe(false);
    expect(matchesFacility(valley, { ...site('valleyhospice.org', 'Valley Hospice'), url: 'https://elsewhere.example/valleyhospice' })).toBe(false);
    expect(matchesFacility({ ...valley, name: 'HOSPICE OF PHILADELPHIA' }, site('hospiceofphiladelphia.org', 'Hospice of Philadelphia'))).toBe(false);
  });

  it('records public CMS facts that the identifier screen never mistakes for personal data, sourced to Care Compare', () => {
    const both = facility('391501', { certification_date: '2025-09-15', change_of_ownership_date: '2026-03-01' });
    const claim = rosterClaim(both, rosterSignals(both, window), '2026Q3');
    expect(claim).toBe('CMS lists Valley Hospice (CMS certification number 391501) as a Medicare-certified hospice in Philadelphia, PA in its Provider of Services file for 2026Q3. '
      + 'Medicare certified it on 2025-09-15. CMS records a change of ownership on 2026-03-01. Its website was matched to this listing by name and place.');
    expect(careCompareUrl(both)).toBe('https://www.medicare.gov/care-compare/details/hospice/391501');
    expect(careCompareUrl({ ...both, ccn: '397001', setting: 'home_health' })).toBe('https://www.medicare.gov/care-compare/details/home-health/397001');
    expect(screenIdentifiers(`${claim} ${careCompareUrl(both)}`).flagged).toBe(false);
    const home = facility('397001', { setting: 'home_health', city: null, change_of_ownership_date: '2026-03-01' });
    expect(rosterClaim(home, rosterSignals(home, window), null)).toContain('as a Medicare-certified home health agency in PA in its Provider of Services file.');
  });
});

describe('the roster step of the daily discovery run', () => {
  const hospices = Array.from({ length: 15 }, (_, index) => facility(String(391501 + index), {
    name: `${['ALPHA', 'BRAVO', 'CEDAR', 'DOVE', 'EMBER', 'FIELD', 'GROVE', 'HARBOR', 'IRIS', 'JUNIPER', 'KINDRED', 'LAUREL', 'MAPLE', 'NORTHSTAR', 'OAKWOOD'][index]} HOSPICE`,
    change_of_ownership_date: `2026-${String(10 - (index % 9)).padStart(2, '0')}-01` }));
  const setup = ({ items = hospices, searchedToday = 0, due = null, search = null, research = {}, feed = {}, store = {} } = {}) => {
    const roster = vi.fn(async ({ chowSince, cursor }) => ({ period: '2026Q3', items: chowSince && !cursor ? items : [], nextCursor: null, skipped: 0 }));
    const growth = {
      roster: { configured: true, roster, ...feed },
      research: { configured: true, search: search ?? vi.fn(async (_product, { query }) => {
        const word = query.split(' ')[0].toLowerCase();
        return [site('hospicedirectory.org', `${query} - directory`), site(`${word}hospice.org`, `${query.split(' ').slice(0, 2).join(' ')} | Hospice care`)];
      }), ...research },
      store: { discover: vi.fn(async (_product, rows) => rows.length), rosterPending: vi.fn(async ccns => ({ due: due ?? ccns, searchedToday })),
        rosterSearched: vi.fn(async () => undefined), ...store },
    };
    return growth;
  };
  const run = (growth, options = {}) => rosterDiscovery({ growth, marketed: ['caremetric-intel'], moment, ...options });

  it('does nothing at all unless the feed, its switch, the search provider and the roster memory are there and Intel is marketed', async () => {
    const growth = setup();
    for (const changed of [{ ...growth, roster: undefined }, { ...growth, roster: { ...growth.roster, configured: false } },
      { ...growth, research: { configured: false, search: growth.research.search } }, { ...growth, store: { discover: growth.store.discover } }]) {
      expect(await run(changed)).toBeNull();
    }
    expect(await run(growth, { marketed: ['carebase'] })).toBeNull();
    expect(growth.roster.roster).not.toHaveBeenCalled();
    expect(growth.research.search).not.toHaveBeenCalled();
  });

  it('reads recent changes of ownership and new certifications in the market states, and records the agencies matched to their own sites', async () => {
    const growth = setup({ items: hospices.slice(0, 2) });
    const result = await run(growth);
    expect(result).toEqual({ period: '2026Q3', facilities: 2, recent: 2, due: 2, searched: 2, matched: 2, recorded: 2 });
    const queries = growth.roster.roster.mock.calls.map(([query]) => query);
    expect(queries).toEqual([
      expect.objectContaining({ states: rosterPlan('caremetric-intel').states, settings: ['home_health', 'hospice'], chowSince: '2025-05-14', limit: 500, cursor: null }),
      expect.objectContaining({ certifiedSince: '2025-05-14', limit: 500, cursor: null }),
    ]);
    // The most recent change first: Alpha changed owners on October 1, Bravo on September 1.
    expect(growth.research.search.mock.calls.map(([product, options]) => [product, options.query])).toEqual([
      ['caremetric-intel', 'Alpha Hospice Philadelphia PA'], ['caremetric-intel', 'Bravo Hospice Philadelphia PA']]);
    expect(growth.store.discover.mock.calls[0]).toEqual(['caremetric-intel', [
      { name: 'Alpha Hospice', domain: 'alphahospice.org', url: 'https://www.medicare.gov/care-compare/details/hospice/391501',
        claim: 'CMS lists Alpha Hospice (CMS certification number 391501) as a Medicare-certified hospice in Philadelphia, PA in its Provider of Services file for 2026Q3. CMS records a change of ownership on 2026-10-01. Its website was matched to this listing by name and place.' },
      { name: 'Alpha Hospice', domain: 'alphahospice.org', url: 'https://alphahospice.org/', claim: 'Compassionate hospice care for families in Philadelphia.' },
    ]]);
    expect(growth.store.rosterSearched.mock.calls).toEqual([['391501', true], ['391502', true]]);
    // Counts and the CMS quarter only: no name, domain or address.
    expect(JSON.stringify(result)).not.toMatch(/hospice|Bravo|\.org/i);
  });

  it('remembers an agency with no site found, and does not search one the database says was searched already', async () => {
    const search = vi.fn(async () => [site('hospicedirectory.org', 'Directory'), site('unrelatedfarm.com', 'A farm', 'Fresh produce.')]);
    const growth = setup({ items: hospices.slice(0, 3), search, due: ['391501', '391503'] });
    expect(await run(growth)).toMatchObject({ recent: 3, due: 2, searched: 2, matched: 0, recorded: 0 });
    expect(growth.store.rosterPending).toHaveBeenCalledWith(['391501', '391502', '391503']);
    expect(growth.store.rosterSearched.mock.calls).toEqual([['391501', false], ['391503', false]]);
    expect(growth.store.discover).not.toHaveBeenCalled();
  });

  it('spends no search on a name a domain could never be checked against', async () => {
    const growth = setup({ items: [facility('391501', { name: 'HOSPICE OF PHILADELPHIA', certification_date: '2026-01-01' }), facility('391502', { certification_date: '2026-01-01' })] });
    expect(await run(growth)).toMatchObject({ facilities: 2, recent: 2, due: 1, searched: 1 });
    expect(growth.store.rosterPending).toHaveBeenCalledWith(['391502']);
  });

  it('makes at most ten searches an Eastern day, counting what an earlier run that day already searched', async () => {
    const growth = setup();
    expect(await run(growth)).toMatchObject({ recent: 15, due: 15, searched: rosterSearchLimit });
    expect(growth.research.search).toHaveBeenCalledTimes(rosterSearchLimit);
    const again = setup({ searchedToday: 7 });
    expect((await run(again)).searched).toBe(3);
    const full = setup({ searchedToday: 12 });
    expect((await run(full)).searched).toBe(0);
    expect(full.research.search).not.toHaveBeenCalled();
    // An answer that does not say how many were searched today allows none.
    const unknown = setup({ store: { rosterPending: vi.fn(async ccns => ({ due: ccns })) } });
    expect((await run(unknown)).searched).toBe(0);
  });

  it('stops when the run\'s time is spent, before reading the roster or between searches', async () => {
    const early = setup();
    expect(await run(early, { spent: () => true })).toMatchObject({ searched: 0, stopped: 'time' });
    expect(early.roster.roster).not.toHaveBeenCalled();
    let searches = 0;
    const growth = setup({ search: vi.fn(async () => { searches++; return []; }) });
    expect(await run(growth, { spent: () => searches >= 3 })).toMatchObject({ searched: 3, stopped: 'time' });
    expect(growth.store.rosterSearched).toHaveBeenCalledTimes(3);
  });

  it('gives way when the search provider says less than a quarter of its allowance is left', async () => {
    let left = 1000;
    const growth = setup({ research: { allowance: () => ({ limit: 2000, left, days: 30 }) } });
    growth.research.search = vi.fn(async () => { left -= 300; return []; });
    expect(await run(growth)).toMatchObject({ searched: 2, stopped: 'search_allowance' });
    left = 2000 * rosterAllowanceReserve - 1;
    const low = setup({ research: { allowance: () => ({ limit: 2000, left, days: 30 }) } });
    expect(await run(low)).toEqual({ facilities: 0, recent: 0, due: 0, searched: 0, matched: 0, recorded: 0, stopped: 'search_allowance' });
    expect(low.roster.roster).not.toHaveBeenCalled();
  });

  it('waits the search provider\'s pace before every search', async () => {
    vi.useFakeTimers();
    const growth = setup({ items: hospices.slice(0, 3) });
    const pending = run(growth, { pace: 1100 });
    await vi.advanceTimersByTimeAsync(1099);
    expect(growth.research.search).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(growth.research.search).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2200);
    expect((await pending).searched).toBe(3);
  });

  it('never fails the run: a feed, search or database failure ends the roster step with its code; an abort still stops the run', async () => {
    const feed = setup({ feed: { roster: vi.fn(async () => { throw Object.assign(new Error('The CMS roster could not be read.'), { code: 'feed_invalid_signature' }); }) } });
    expect(await run(feed)).toEqual({ facilities: 0, recent: 0, due: 0, searched: 0, matched: 0, recorded: 0, stopped: 'feed_invalid_signature' });
    let calls = 0;
    const search = setup({ search: vi.fn(async (_product, { query }) => { if (++calls === 2) throw Object.assign(new Error('Research unavailable'), { transient: true }); return [site(`${query.split(' ')[0].toLowerCase()}hospice.org`, query)]; }) });
    expect(await run(search)).toMatchObject({ searched: 1, matched: 1, stopped: 'search_unavailable' });
    expect(search.store.rosterSearched).toHaveBeenCalledTimes(1);
    const missing = setup({ store: { rosterPending: vi.fn(async () => { throw Object.assign(new Error('function does not exist'), { code: '42883' }); }) } });
    expect(await run(missing)).toMatchObject({ searched: 0, stopped: 'database_not_ready' });
    const broken = setup({ store: { rosterSearched: vi.fn(async () => { throw Object.assign(new Error('deadlock'), { code: '40P01' }); }) } });
    expect(await run(broken)).toMatchObject({ searched: 1, stopped: 'roster_failed' });
    // A business the database refuses (its domain shape) is skipped; the search is still remembered.
    const refused = setup({ items: hospices.slice(0, 1), store: { discover: vi.fn(async () => { throw Object.assign(new Error('Invalid discovery'), { code: '22023' }); }) } });
    expect(await run(refused)).toEqual({ period: '2026Q3', facilities: 1, recent: 1, due: 1, searched: 1, matched: 1, recorded: 0 });
    expect(refused.store.rosterSearched).toHaveBeenCalledWith('391501', true);
    // A customer's site adds nothing: counted as matched, not recorded.
    const customer = setup({ items: hospices.slice(0, 1), store: { discover: vi.fn(async () => 0) } });
    expect(await run(customer)).toMatchObject({ matched: 1, recorded: 0 });
    const controller = new AbortController();
    const aborted = setup({ search: vi.fn(async () => { controller.abort(new Error('lease lost')); throw new Error('aborted'); }) });
    await expect(run(aborted, { signal: controller.signal })).rejects.toThrow();
  });
});
