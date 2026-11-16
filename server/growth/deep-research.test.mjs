import { describe, expect, it, vi } from 'vitest';
import { growthResearchFeature, keptFacts, namesOrganization, researchHandlers, screenedNotes } from './deep-research.mjs';
import { triggerHost } from './playbook.mjs';

const sources = [{ url: 'https://valleyhospice.org/services' }, { url: 'https://www.philly-news.com/valley-hospice-opens' }, { url: 'https://www.yelp.com/biz/valley' }];
describe('keeping researched facts', () => {
  it('keeps facts on addresses the tools returned, on the organization\'s site or another operator-like host, with no identifiers', () => {
    const facts = [
      { claim: 'Valley Hospice serves Philadelphia and Bucks counties.', url: 'https://valleyhospice.org/services' },
      { claim: 'Valley Hospice opened a Bucks County office this year.', url: 'https://www.philly-news.com/valley-hospice-opens' },
      { claim: 'Valley Hospice has four stars on a review site.', url: 'https://www.yelp.com/biz/valley' },
      { claim: 'Valley Hospice is hiring a community liaison.', url: 'https://valleyhospice.org/never-returned' },
      { claim: 'Call Jane at 215-555-0199 about referrals.', url: 'https://valleyhospice.org/services' },
    ];
    expect(keptFacts(facts, { sources, domain: 'valleyhospice.org' }).map(fact => fact.url)).toEqual(['https://valleyhospice.org/services', 'https://www.philly-news.com/valley-hospice-opens']);
  });
});

describe('dated triggers about the employer (2026-11-16)', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const jobSources = [...sources, { url: 'https://www.indeed.com/viewjob?jk=1' }, { url: 'https://www.indeed.com/viewjob?jk=2' }, { url: 'https://www.prnewswire.com/news/valley' }];
  it('keeps a recent job listing or news item that names the organization, as a dated trigger, never one about another employer', () => {
    const facts = [
      { claim: 'Valley Hospice is hiring a community liaison in Philadelphia.', url: 'https://www.indeed.com/viewjob?jk=1', kind: 'hiring', date: '2026-10-30' },
      { claim: 'Riverside Home Care is hiring a community liaison.', url: 'https://www.indeed.com/viewjob?jk=2', kind: 'hiring', date: '2026-11-01' },
      { claim: 'Valley Hospice was hiring a marketer.', url: 'https://www.indeed.com/viewjob?jk=2', kind: 'hiring', date: '2026-03-01' },
      { claim: 'Valley Hospice has a careers page on a job board.', url: 'https://www.indeed.com/viewjob?jk=2', kind: 'other', date: '2026-11-01' },
      { claim: 'Valley Hospice is hiring a nurse liaison.', url: 'https://www.indeed.com/viewjob?jk=2', kind: 'hiring', date: '' },
      { claim: 'Valley Hospice opened a Bucks County office.', url: 'https://www.prnewswire.com/news/valley', kind: 'expansion', date: '2026-09-15' },
      { claim: 'Valley Hospice serves Philadelphia and Bucks counties.', url: 'https://valleyhospice.org/services', kind: 'place', date: '2026-11-02' },
    ];
    expect(keptFacts(facts, { sources: jobSources, domain: 'valleyhospice.org', name: 'Valley Hospice, Inc.', now })).toEqual([
      { claim: 'Valley Hospice is hiring a community liaison in Philadelphia. (job listing dated 2026-10-30)', url: 'https://www.indeed.com/viewjob?jk=1' },
      { claim: 'Valley Hospice opened a Bucks County office. (news dated 2026-09-15)', url: 'https://www.prnewswire.com/news/valley' },
      { claim: 'Valley Hospice serves Philadelphia and Bucks counties. (dated 2026-11-02)', url: 'https://valleyhospice.org/services' },
    ]);
    expect(keptFacts(facts, { sources: jobSources, domain: 'valleyhospice.org', now }).map(fact => fact.url)).toEqual(['https://valleyhospice.org/services'], 'without the name no trigger is kept');
  });
  it('knows job boards and news sites, and an organization by its distinctive words', () => {
    expect(['www.indeed.com', 'acme.myworkdayjobs.com', 'jobs.example.org', 'careers-portal.example.com'].map(triggerHost)).toEqual(['jobs', 'jobs', 'jobs', 'jobs']);
    expect(['www.prnewswire.com', 'hospicenews.com'].map(triggerHost)).toEqual(['news', 'news']);
    expect(['valleyhospice.org', 'yelp.com'].map(triggerHost)).toEqual([null, null]);
    expect(namesOrganization('Valley Hospice is hiring.', 'VALLEY HOSPICE, INC.')).toBe(true);
    expect(namesOrganization('A hospice in the valley region is hiring.', 'Valley Forge Hospice')).toBe(false);
  });
  it('drops a line of the notes that holds an identifier and keeps the rest', () => {
    expect(screenedNotes('Valley Hospice serves Philadelphia.\nContact 123-45-6789 for records.\nIt is hiring a liaison.')).toEqual({
      notes: 'Valley Hospice serves Philadelphia.\nIt is hiring a liaison.', dropped: 1 });
  });
});

function setup({ enabled = true, pick = { id: 'o1', organizationId: 'g1', product: 'caremetric-intel', fit: 60, name: 'Valley Hospice', domain: 'valleyhospice.org' } } = {}) {
  const store = { researchNext: vi.fn(async () => pick), discover: vi.fn(async rows => rows.length) };
  const model = { configured: true,
    research: vi.fn(async () => ({ outcome: 'completed', text: 'Valley Hospice serves Philadelphia. https://valleyhospice.org/services', sources, searches: 2, fetches: 1, costCents: 4.2 })),
    run: vi.fn(async () => ({ outcome: 'completed', output: { facts: [{ claim: 'Valley Hospice serves Philadelphia and Bucks counties.', url: 'https://valleyhospice.org/services' }] } })) };
  const growth = { store, deepResearch: { enabled, perDay: 5, cents: 30 } };
  return { store, model, run: (task = { agent: { autonomy: 'propose' } }) => researchHandlers({ growth, model, features: new Set([growthResearchFeature]), marketed: ['caremetric-intel'] })['growth.research'](task) };
}

describe('growth.research', () => {
  it('researches one prospect with the web tools under the owner\'s ceiling, then keeps checked facts as evidence', async () => {
    const { store, model, run } = setup();
    expect((await run()).result).toEqual({ researched: 1, facts: 1, searches: 2, fetches: 1, cents: 4.2 });
    expect(store.researchNext).toHaveBeenCalledWith(5);
    expect(model.research.mock.calls[0][1]).toMatchObject({ tools: ['web_search', 'web_fetch'], ceilingCents: 30, maxRounds: 3 });
    expect(model.run.mock.calls[0][1]).toMatchObject({ tier: 'fast', promptVersion: 'research.2-x' });
    expect(store.discover).toHaveBeenCalledWith('caremetric-intel', [{ name: 'Valley Hospice', domain: 'valleyhospice.org', url: 'https://valleyhospice.org/services', claim: 'Valley Hospice serves Philadelphia and Bucks counties.' }]);
  });
  it('keeps researching past a note line that holds an identifier, and asks for dated triggers', async () => {
    const { store, model, run } = setup();
    model.research.mockResolvedValueOnce({ outcome: 'completed', text: 'Valley Hospice serves Philadelphia. https://valleyhospice.org/services\nSSN 123-45-6789 seen on a page.', sources, searches: 2, fetches: 1, costCents: 4.2 });
    expect((await run()).result).toEqual({ researched: 1, facts: 1, droppedLines: 1, searches: 2, fetches: 1, cents: 4.2 });
    expect(JSON.parse(model.run.mock.calls[0][1].user).notes).not.toMatch(/6789/);
    expect(store.discover).toHaveBeenCalled();
    expect(model.research.mock.calls[0][1].system[0].text).toMatch(/job listing for a marketer, community liaison, business development or sales role/);
  });
  it('does nothing when off, in Observe, or with nobody to research', async () => {
    expect((await setup({ enabled: false }).run()).result).toEqual({ skipped: 'off' });
    expect((await setup().run({ agent: { autonomy: 'observe' } })).result).toEqual({ skipped: 'observe_only' });
    const none = setup({ pick: null });
    expect((await none.run()).result).toEqual({ researched: 0 });
    expect(none.model.research).not.toHaveBeenCalled();
  });
});
