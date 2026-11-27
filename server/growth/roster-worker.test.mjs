import { describe, expect, it, vi } from 'vitest';
import { growthHandlers, growthAutonomyFeature } from './worker.mjs';
import { rosterLookupsPerRun } from './roster.mjs';

const features = new Set([growthAutonomyFeature]);
const now = () => new Date('2026-11-13T15:00:00Z');
const item = (ccn, extra = {}) => ({ ccn, name: 'VALLEY HOSPICE, INC.', setting: 'hospice', city: 'Philadelphia', state: 'PA', zip: '19103',
  county_fips: '42101', control_type: 'Voluntary nonprofit, private', control_type_code: '2', certification_date: '2010-05-01',
  termination_date: null, change_of_ownership_date: null, signals: [], contact: { address: '9 Elm Road', phone: '2155550199' }, ...extra });
const page = (items, next = null, period = '2026Q3') => ({ contract: 'caremetric.marketing-feed.v1', action: 'roster', period, source_line: 's', items, next_cursor: next });
const target = { ccn: '391501', name: 'Valley Hospice, Inc.', setting: 'hospice', city: 'Philadelphia', state: 'PA', facts: { phone: '2155550199' } };

function setup({ sync = { period: null, states: [], cursor: null, complete: false, syncedAt: null }, pages = [page([item('391501')])], targets = [target],
  search = async () => [{ domain: 'valleyhospice.org', url: 'https://valleyhospice.org/', name: 'Valley Hospice | Philadelphia', claim: 'Hospice care in Philadelphia.' }],
  found = { email: 'info@valleyhospice.org', sourceUrl: 'https://valleyhospice.org/contact', phoneSeen: true,
    site: { url: 'https://valleyhospice.org/', claim: "The organization's own home page. Title: Valley Hospice." } },
  states = ['PA'], daily = 25, research = true, sites = null } = {}) {
  const queue = [...targets];
  const store = {
    rosterSyncState: vi.fn(async () => sync),
    rosterUpsert: vi.fn(async (_period, rows) => rows.length),
    rosterSyncSave: vi.fn(async () => ({})),
    rosterNext: vi.fn(async () => (queue.length ? [queue.shift()] : [])),
    rosterResolved: vi.fn(async (_ccn, data) => (data.outcome === 'graduated' ? { graduated: true, organizationId: 'org', contactReady: true } : { graduated: false })),
    recordContact: vi.fn(async (_id, email) => ({ found: Boolean(email) })),
  };
  const feed = { configured: true, paceMs: 0, roster: vi.fn(async () => pages.shift() ?? page([])) };
  const growth = { store, roster: { feed, states, daily }, research: { configured: research, paceMs: 0, search: vi.fn(search) },
    ...(sites ? { sites: { configured: true, paceMs: 0, find: vi.fn(sites) } } : {}),
    contacts: { configured: true, find: vi.fn(async () => found) } };
  const run = (task = { id: 't', agent: { autonomy: 'propose' } }) => growthHandlers({ growth, features, marketed: ['caremetric-intel'] })['growth.roster'](task, { now });
  return { store, feed, growth, run };
}

it('reads the roster for the owner\'s states, ranks it, and graduates an agency whose own site shows its CMS telephone number', async () => {
  const { store, feed, growth, run } = setup();
  const { result } = await run();
  expect(feed.roster).toHaveBeenCalledWith(expect.objectContaining({ states: ['PA'], cursor: null }));
  const [period, rows] = store.rosterUpsert.mock.calls[0];
  expect(period).toBe('2026Q3');
  expect(rows[0]).toMatchObject({ ccn: '391501', name: 'Valley Hospice, Inc.', facts: { phone: '2155550199' } });
  expect(store.rosterSyncSave).toHaveBeenCalledWith(expect.objectContaining({ period: '2026Q3', states: ['PA'], cursor: '', complete: true, restart: true }));
  expect(growth.research.search).toHaveBeenCalledWith('caremetric-intel', expect.objectContaining({ query: 'valley hospice Philadelphia PA', count: 10 }));
  expect(growth.contacts.find).toHaveBeenCalledWith('valleyhospice.org', expect.objectContaining({ phone: '2155550199' }));
  expect(store.rosterResolved).toHaveBeenCalledWith('391501', { outcome: 'graduated', domain: 'valleyhospice.org', confirmation: 'phone',
    evidence: [{ url: 'https://valleyhospice.org/', claim: "The organization's own home page. Title: Valley Hospice." }] });
  expect(store.recordContact).toHaveBeenCalledWith('org', 'info@valleyhospice.org', 'https://valleyhospice.org/contact');
  expect(result).toMatchObject({ period: '2026Q3', read: { pages: 1, rows: 1 }, looked: 1, graduated: 1, contacts: 1 });
});

it('reads each open agency\'s HHVBP adjustment and Hospice Care Index 25 at a time and ranks with them; a refusal ranks the rest without', async () => {
  const items = Array.from({ length: 30 }, (_, i) => item(String(391600 + i)));
  const closed = item('391599', { termination_date: '2026-01-01' });
  const { store, growth, run } = setup({ pages: [page([...items, closed])], targets: [] });
  growth.roster.feed.agencyFacts = vi.fn(async ({ ccns }) => ({ agencies: ccns.map(ccn => ({ ccn, owners: [], hhvbp: { paymentAdjustmentPct: -2.4, paymentYear: 2026 }, hospice_care_index: null })) }));
  const { result } = await run();
  expect(growth.roster.feed.agencyFacts.mock.calls.map(([args]) => args.ccns.length)).toEqual([25, 5]);
  expect(growth.roster.feed.agencyFacts.mock.calls.flatMap(([args]) => args.ccns)).not.toContain('391599');
  const rows = store.rosterUpsert.mock.calls[0][1];
  expect(rows.find(row => row.ccn === '391600')).toMatchObject({ facts: { hhvbpAdjustmentPct: -2.4, hhvbpPaymentYear: '2026' } });
  expect(rows.find(row => row.ccn === '391600').reasons).toContain('Medicare pay cut of 2% or more (HHVBP)');
  expect(result.read).toMatchObject({ pages: 1, rows: 31, facts: 2 });

  const refused = setup({ pages: [page(items)], targets: [] });
  refused.growth.roster.feed.agencyFacts = vi.fn(async () => { throw Object.assign(new Error('no'), { code: 'feed_refused' }); });
  const outcome = await refused.run();
  expect(refused.growth.roster.feed.agencyFacts).toHaveBeenCalledTimes(1);
  expect(refused.store.rosterUpsert.mock.calls[0][1]).toHaveLength(30);
  expect(refused.store.rosterUpsert.mock.calls[0][1][0].facts.hhvbpAdjustmentPct).toBeUndefined();
  expect(outcome.result.read).toMatchObject({ pages: 1, rows: 30, factsStopped: 'feed_refused' });
});

it('does not read the roster again within the week, and starts over when the states change', async () => {
  const fresh = { period: '2026Q3', states: ['PA'], cursor: null, complete: true, syncedAt: '2026-11-12T00:00:00Z' };
  const kept = setup({ sync: fresh, targets: [] });
  await kept.run();
  expect(kept.feed.roster).not.toHaveBeenCalled();
  const changed = setup({ sync: fresh, states: ['PA', 'OH'], targets: [] });
  await changed.run();
  expect(changed.feed.roster).toHaveBeenCalledWith(expect.objectContaining({ states: ['PA', 'OH'], cursor: null }));
  expect(changed.store.rosterSyncSave).toHaveBeenCalledWith(expect.objectContaining({ restart: true }));
});

it('continues an unfinished read from its cursor, and restarts it when CMS publishes a new quarter part-way', async () => {
  const partial = { period: '2026Q2', states: ['PA'], cursor: '391501', complete: false, syncedAt: null };
  const { feed, store, run } = setup({ sync: partial, pages: [page([item('397001')], null, '2026Q3'), page([item('391501')], null, '2026Q3')], targets: [] });
  await run();
  expect(feed.roster.mock.calls[0][0]).toMatchObject({ cursor: '391501' });
  // The new quarter's first page is read again from the start, and only it is saved.
  expect(feed.roster.mock.calls[1][0]).toMatchObject({ cursor: null });
  expect(store.rosterUpsert).toHaveBeenCalledTimes(1);
  expect(store.rosterSyncSave).toHaveBeenCalledWith(expect.objectContaining({ period: '2026Q3', restart: true, complete: true }));
});

it('leaves an agency unresolved when no result is its site, or the site cannot be confirmed as its own', async () => {
  const none = setup({ search: async () => [] });
  expect((await none.run()).result).toMatchObject({ looked: 1, graduated: 0, unresolved: 1 });
  expect(none.store.rosterResolved).toHaveBeenCalledWith('391501', { outcome: 'unresolved', reason: 'no_site' });
  const other = setup({ found: { email: null, phoneSeen: false, site: { url: 'https://valleyhospice.org/', claim: 'Title: Valley Plumbing. Drains in Ohio.' } } });
  await other.run();
  expect(other.store.rosterResolved).toHaveBeenCalledWith('391501', { outcome: 'unresolved', reason: 'not_confirmed' });
  expect(other.store.recordContact).not.toHaveBeenCalled();
});

it('a search that fails puts the agency back for an hour and ends the run\'s look-ups', async () => {
  const { store, run } = setup({ targets: [target, { ...target, ccn: '391502' }], search: async () => { throw Object.assign(new Error('x'), { code: 'research_unavailable', transient: true }); } });
  expect((await run()).result).toMatchObject({ looked: 1, unresolved: 1 });
  expect(store.rosterResolved).toHaveBeenCalledWith('391501', { outcome: 'unresolved', reason: 'retry' });
  expect(store.rosterNext).toHaveBeenCalledTimes(1);
});

it('looks up a few agencies a run, within the owner\'s daily number, and none without search', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ ...target, ccn: `39150${i}` }));
  const { store, run } = setup({ targets: many });
  expect((await run()).result.looked).toBe(rosterLookupsPerRun);
  expect(store.rosterNext).toHaveBeenCalledWith(1, 25);
  const off = setup({ research: false });
  expect((await off.run()).result).toMatchObject({ looked: 0 });
  expect(off.store.rosterNext).not.toHaveBeenCalled();
  const zero = setup({ daily: 0 });
  await zero.run();
  expect(zero.store.rosterNext).not.toHaveBeenCalled();
});

it('does nothing in Observe, without states, without the feed, or when Intel is not being marketed', async () => {
  expect((await setup().run({ id: 't', agent: { autonomy: 'observe' } })).result).toEqual({ skipped: 'observe_only' });
  expect((await setup({ states: [] }).run()).result).toEqual({ skipped: 'no_states' });
  const unconfigured = setup();
  unconfigured.feed.configured = false;
  expect((await unconfigured.run()).result).toEqual({ skipped: 'roster_not_configured' });
  const { growth } = setup();
  const handler = growthHandlers({ growth, features, marketed: ['carebase'] })['growth.roster'];
  expect((await handler({ id: 't', agent: { autonomy: 'propose' } }, { now })).result).toEqual({ skipped: 'not_marketed' });
  // Without the growth autonomy feature the task is not offered at all.
  expect(growthHandlers({ growth, features: new Set() })['growth.roster']).toBeUndefined();
});

it('fails the run on a first page Intel refuses outright, and keeps what it read when a later page fails', async () => {
  const refused = setup();
  refused.feed.roster = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'feed_not_permitted', transient: false }); });
  await expect(refused.run()).rejects.toMatchObject({ code: 'feed_not_permitted' });
  const later = setup({ pages: [page([item('391501')], '391501')] });
  later.feed.roster = vi.fn().mockResolvedValueOnce(page([item('391501')], '391501')).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'feed_rate_limited', transient: true }));
  const { result } = await later.run();
  expect(result).toMatchObject({ read: { pages: 1 }, stopped: 'feed_rate_limited', looked: 0 });
});

it('searches by the agency\'s CMS telephone number when its name finds no confirmed site, and accepts only a site that shows that number', async () => {
  const named = [{ domain: 'valleyhealthpartners.com', url: 'https://valleyhealthpartners.com/', name: 'Valley Health Partners', claim: 'Primary care in Philadelphia.' }];
  const byNumber = [
    { domain: 'yelp.com', url: 'https://www.yelp.com/biz/valley', name: 'Valley Hospice - Yelp', claim: 'Call 215-555-0199.' },
    { domain: 'valleyhospicecare.org', url: 'https://valleyhospicecare.org/contact', name: 'Contact us', claim: 'Call us at (215) 555-0199.' },
  ];
  const search = vi.fn(async (_product, { query }) => (query.startsWith('"') ? byNumber : named));
  const own = { email: 'info@valleyhospicecare.org', sourceUrl: 'https://valleyhospicecare.org/contact', phoneSeen: true, site: { url: 'https://valleyhospicecare.org/', claim: 'Valley Hospice Care.' } };
  const { store, growth, run } = setup({ search, sync: { period: '2026Q3', states: ['PA'], cursor: null, complete: true, syncedAt: '2026-11-12T00:00:00Z' } });
  growth.contacts.find = vi.fn(async domain => (domain === 'valleyhospicecare.org' ? own : { email: null, phoneSeen: false, site: { url: `https://${domain}/`, claim: 'Primary care.' } }));
  const { result } = await run();
  expect(search.mock.calls.map(([, request]) => request.query)).toEqual(['valley hospice Philadelphia PA', '"215-555-0199"']);
  expect(growth.contacts.find.mock.calls.map(([domain]) => domain)).toEqual(['valleyhealthpartners.com', 'valleyhospicecare.org']);
  expect(store.rosterResolved).toHaveBeenCalledWith('391501', expect.objectContaining({ outcome: 'graduated', domain: 'valleyhospicecare.org', confirmation: 'phone' }));
  expect(result).toMatchObject({ looked: 1, graduated: 1, byPhone: 1 });
});

it('leaves the agency unresolved when no site found by its number shows it, and makes no second search without a number', async () => {
  const search = vi.fn(async (_product, { query }) => (query.startsWith('"')
    ? [{ domain: 'otherhospice.org', url: 'https://otherhospice.org/', name: 'Other Hospice', claim: 'Hospice in Philadelphia.' }] : []));
  const { store, growth, run } = setup({ search, sync: { period: '2026Q3', states: ['PA'], cursor: null, complete: true, syncedAt: '2026-11-12T00:00:00Z' } });
  growth.contacts.find = vi.fn(async () => ({ email: null, phoneSeen: false, site: { url: 'https://otherhospice.org/', claim: 'Other Hospice.' } }));
  expect((await run()).result).toMatchObject({ looked: 1, graduated: 0, unresolved: 1 });
  expect(store.rosterResolved).toHaveBeenCalledWith('391501', { outcome: 'unresolved', reason: 'no_site' });
  const plain = setup({ targets: [{ ...target, facts: {} }], search: vi.fn(async () => []), sync: { period: '2026Q3', states: ['PA'], cursor: null, complete: true, syncedAt: '2026-11-12T00:00:00Z' } });
  await plain.run();
  expect(plain.growth.research.search).toHaveBeenCalledTimes(1);
});

describe('Hunter after Brave (owner, 2026-11-27)', () => {
  const fresh = { period: '2026Q3', states: ['PA'], cursor: null, complete: true, syncedAt: '2026-11-12T00:00:00Z' };
  const own = { email: 'info@valleyhospice.org', sourceUrl: 'https://valleyhospice.org/contact', phoneSeen: true, site: { url: 'https://valleyhospice.org/', claim: 'Valley Hospice.' } };

  it('asks Hunter only when Brave finds no confirmed site, and graduates the site Hunter names once its pages confirm it', async () => {
    const graduatedByBrave = setup({ sync: fresh, sites: async () => ({ result: 'found', domain: 'other.example' }) });
    expect((await graduatedByBrave.run()).result).toMatchObject({ graduated: 1 });
    expect(graduatedByBrave.growth.sites.find).not.toHaveBeenCalled();

    const { store, growth, run } = setup({ sync: fresh, search: async () => [], sites: async () => ({ result: 'found', domain: 'valleyhospice.org', organization: 'Valley Hospice' }) });
    growth.contacts.find = vi.fn(async () => own);
    const { result } = await run();
    expect(growth.sites.find).toHaveBeenCalledWith(expect.objectContaining({ name: 'valley hospice' }));
    expect(store.rosterResolved).toHaveBeenCalledWith('391501', expect.objectContaining({ outcome: 'graduated', domain: 'valleyhospice.org', confirmation: 'phone' }));
    expect(result).toMatchObject({ looked: 1, graduated: 1, byHunter: 1 });
  });

  it('keeps a site Hunter names out unless its pages confirm it, never reads a directory, and never reads a site twice', async () => {
    const wrong = setup({ sync: fresh, search: async () => [], sites: async () => ({ result: 'found', domain: 'valleyplumbing.example' }),
      found: { email: null, phoneSeen: false, site: { url: 'https://valleyplumbing.example/', claim: 'Valley Plumbing. Drains in Ohio.' } } });
    expect((await wrong.run()).result).toMatchObject({ graduated: 0, unresolved: 1 });
    expect(wrong.store.rosterResolved).toHaveBeenCalledWith('391501', { outcome: 'unresolved', reason: 'not_confirmed' });
    const directory = setup({ sync: fresh, search: async () => [], sites: async () => ({ result: 'found', domain: 'yelp.com' }) });
    await directory.run();
    expect(directory.growth.contacts.find).not.toHaveBeenCalled();
    expect(directory.store.rosterResolved).toHaveBeenCalledWith('391501', { outcome: 'unresolved', reason: 'no_site' });
    // Brave's own choice was read and did not confirm: Hunter naming the same domain does not read it again.
    const same = setup({ sync: fresh, targets: [{ ...target, facts: {} }], sites: async () => ({ result: 'found', domain: 'valleyhospice.org' }),
      found: { email: null, phoneSeen: false, site: { url: 'https://valleyhospice.org/', claim: 'Valley Plumbing. Drains in Ohio.' } } });
    await same.run();
    expect(same.growth.contacts.find).toHaveBeenCalledTimes(1);
  });

  it('when Brave cannot search, Hunter alone decides; when neither can answer, the agency is tried again and the run stops', async () => {
    const braveDown = async () => { throw Object.assign(new Error('x'), { code: 'research_unavailable', transient: true }); };
    const byHunter = setup({ sync: fresh, search: braveDown, sites: async () => ({ result: 'found', domain: 'valleyhospice.org' }) });
    byHunter.growth.contacts.find = vi.fn(async () => own);
    expect((await byHunter.run()).result).toMatchObject({ graduated: 1, byHunter: 1 });
    const nothing = setup({ sync: fresh, search: braveDown, sites: async () => ({ result: 'not_found' }) });
    await nothing.run();
    expect(nothing.store.rosterResolved).toHaveBeenCalledWith('391501', { outcome: 'unresolved', reason: 'no_site' });
    for (const sites of [null, async () => ({ result: 'refused' }), async () => ({ result: 'error' })]) {
      const stuck = setup({ sync: fresh, targets: [target, { ...target, ccn: '391502' }], search: braveDown, sites });
      expect((await stuck.run()).result).toMatchObject({ looked: 1, unresolved: 1 });
      expect(stuck.store.rosterResolved).toHaveBeenCalledWith('391501', { outcome: 'unresolved', reason: 'retry' });
      expect(stuck.store.rosterNext).toHaveBeenCalledTimes(1);
    }
  });

  it('looks agencies up with Hunter alone when Brave is not set up', async () => {
    const { growth, run } = setup({ sync: fresh, research: false, sites: async () => ({ result: 'found', domain: 'valleyhospice.org' }) });
    growth.contacts.find = vi.fn(async () => own);
    expect((await run()).result).toMatchObject({ looked: 1, graduated: 1, byHunter: 1 });
    expect(growth.research.search).not.toHaveBeenCalled();
  });
});
