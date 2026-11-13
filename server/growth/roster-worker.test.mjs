import { expect, it, vi } from 'vitest';
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
  states = ['PA'], daily = 25, research = true } = {}) {
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
