import { describe, expect, it, vi } from 'vitest';
import { growthResearchFeature, keptFacts, researchHandlers } from './deep-research.mjs';

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
    expect(model.run.mock.calls[0][1]).toMatchObject({ tier: 'fast', promptVersion: 'research.1-x' });
    expect(store.discover).toHaveBeenCalledWith('caremetric-intel', [{ name: 'Valley Hospice', domain: 'valleyhospice.org', url: 'https://valleyhospice.org/services', claim: 'Valley Hospice serves Philadelphia and Bucks counties.' }]);
  });
  it('does nothing when off, in Observe, or with nobody to research', async () => {
    expect((await setup({ enabled: false }).run()).result).toEqual({ skipped: 'off' });
    expect((await setup().run({ agent: { autonomy: 'observe' } })).result).toEqual({ skipped: 'observe_only' });
    const none = setup({ pick: null });
    expect((await none.run()).result).toEqual({ researched: 0 });
    expect(none.model.research).not.toHaveBeenCalled();
  });
});
