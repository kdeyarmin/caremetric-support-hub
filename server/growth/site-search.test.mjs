import { describe, expect, it, vi } from 'vitest';
import { growthReachFeature } from './reach.mjs';
import { candidateSites, siteSearchHandlers, siteSearchInput, siteSearchPromptVersion, sitesPerRun } from './site-search.mjs';

const target = { ccn: '397001', name: 'Valley Home Health', setting: 'home_health', city: 'Pittsburgh', state: 'PA', zip: '15201',
  facts: { phone: '4125550100', patients: 312, countyShare: 0.04 }, rank: 70, reason: 'no_site' };
const ownSite = { phoneSeen: true, site: { url: 'https://valleyhh.org/', claim: 'Valley Home Health serves Pittsburgh, PA.' }, email: 'info@valleyhh.org', sourceUrl: 'https://valleyhh.org/contact' };

function setup({ enabled = true, autonomy = 'propose', features = new Set([growthReachFeature]), answer = 'https://www.valleyhh.org\nhttps://www.yelp.com/biz/valley',
  read = ownSite, record = async (_ccn, data) => (data.outcome === 'graduated' ? { graduated: true, organizationId: 'org', contactReady: true } : { graduated: false }),
  targets = [target], perDay = 10, cents = 12, contactsConfigured = true } = {}) {
  const store = { rosterSiteNext: vi.fn(async () => targets), rosterSiteRecord: vi.fn(record), recordContact: vi.fn(async () => ({ found: true })) };
  const contacts = { configured: contactsConfigured, find: vi.fn(async () => read) };
  const model = { configured: true, research: vi.fn(async () => ({ outcome: 'completed', text: answer, sources: [], searches: 2, fetches: 1, costCents: 6 })) };
  const growth = { store, contacts, roster: { siteResearch: { enabled: () => enabled, perDay: () => perDay, cents: () => cents } } };
  const handlers = siteSearchHandlers({ growth, model, features, marketed: ['caremetric-intel'] });
  const run = () => handlers['growth.sites']({ id: 'task', agent: { autonomy } });
  return { store, contacts, model, handlers, run };
}

describe('candidate websites from a web search', () => {
  it('keeps at most two operator hosts the answer names, in its order, without www, and never a directory or a government page', () => {
    expect(candidateSites('https://www.valleyhh.org/about\nhttps://www.yelp.com/biz/valley\nvalleyhomehealth.com\nthird.org')).toEqual(['valleyhh.org', 'valleyhomehealth.com']);
    expect(candidateSites('https://www.facebook.com/valley\nhttps://www.medicare.gov/care-compare\nhttps://www.indeed.com/cmp/valley')).toEqual([]);
    expect(candidateSites('none')).toEqual([]);
    expect(candidateSites('https://valleyhh.org and https://valleyhh.org/contact')).toEqual(['valleyhh.org']);
  });

  it('never reads a sentence as a site: only a written-out address, or a line that is nothing but a domain (the Nov 24 measurement)', () => {
    // What the answers stored as sites on 2026-11-25: "apparently.https", "string.none", "sometimes.odd", "feeltheadvantage.com.results".
    expect(candidateSites('The site is apparently.https://www.valleyhh.org/ but the string.none of it was clear. Sometimes.odd')).toEqual(['valleyhh.org']);
    expect(candidateSites('I could not confirm feeltheadvantage.com.Results were mixed.\nnone')).toEqual([]);
    expect(candidateSites('1. valleyhh.org\n- www.valleyhomehealth.com.')).toEqual(['valleyhh.org', 'valleyhomehealth.com']);
    expect(candidateSites('See [their site](https://valleyhh.org/about), or www.valleyhomehealth.com')).toEqual(['valleyhh.org', 'valleyhomehealth.com']);
    expect(siteSearchPromptVersion).toBe('sites.2');
  });

  it('tells the search only the agency\'s public record: name, city, state, setting and its Medicare telephone number', () => {
    expect(siteSearchInput(target)).toEqual({ agency: { name: 'Valley Home Health', city: 'Pittsburgh', state: 'PA', setting: 'home health', phone: '4125550100' } });
    expect(siteSearchInput({ ...target, setting: 'hospice' }).agency.setting).toBe('hospice');
  });
});

describe('growth.sites', () => {
  it('is registered only once the database declares stage 3 and the store can hand agencies out', () => {
    expect(setup({ features: new Set() }).handlers).toEqual({});
    expect(Object.keys(setup().handlers)).toEqual(['growth.sites']);
  });

  it('does nothing while the switch is off, in Observe, or without a model or the contact finder', async () => {
    for (const options of [{ enabled: false }, { autonomy: 'observe' }, { contactsConfigured: false }]) {
      const { store, model, run } = setup(options);
      const { result } = await run();
      expect(result.skipped).toBeTruthy();
      expect(store.rosterSiteNext).not.toHaveBeenCalled();
      expect(model.research).not.toHaveBeenCalled();
    }
  });

  it('graduates a site the code confirms through the roster\'s own path, within the day\'s number and the cost ceiling, and records its contact', async () => {
    const { store, contacts, model, run } = setup();
    const { result } = await run();
    expect(store.rosterSiteNext).toHaveBeenCalledWith(sitesPerRun, 10);
    const [, request] = model.research.mock.calls[0];
    expect(request).toMatchObject({ promptVersion: siteSearchPromptVersion, tools: ['web_search', 'web_fetch'], ceilingCents: 12 });
    expect(JSON.parse(request.user)).toEqual(siteSearchInput(target));
    expect(request.user).not.toMatch(/312|countyShare|0\.04/);
    expect(contacts.find).toHaveBeenCalledTimes(1);
    expect(contacts.find).toHaveBeenCalledWith('valleyhh.org', expect.objectContaining({ phone: '4125550100' }));
    expect(store.rosterSiteRecord).toHaveBeenCalledWith('397001', { outcome: 'graduated', domain: 'valleyhh.org', confirmation: 'phone',
      evidence: [{ url: 'https://valleyhh.org/', claim: 'Valley Home Health serves Pittsburgh, PA.' }] });
    expect(store.recordContact).toHaveBeenCalledWith('org', 'info@valleyhh.org', 'https://valleyhh.org/contact');
    expect(result).toMatchObject({ searched: 1, graduated: 1, suggested: 0 });
  });

  it('keeps a site it cannot confirm only as a suggestion, never as the agency\'s website', async () => {
    const elsewhere = { phoneSeen: false, site: { url: 'https://valleyhh.org/', claim: 'Valley Home Health serves Austin, Texas.' } };
    const { store, contacts, run } = setup({ read: elsewhere, answer: 'https://valleyhh.org\nhttps://valleyhomecare.net' });
    const { result } = await run();
    expect(contacts.find).toHaveBeenCalledTimes(2);
    expect(store.rosterSiteRecord).toHaveBeenCalledTimes(1);
    expect(store.rosterSiteRecord).toHaveBeenCalledWith('397001', { outcome: 'unresolved', suggestions: ['valleyhh.org', 'valleyhomecare.net'] });
    expect(store.recordContact).not.toHaveBeenCalled();
    expect(result).toMatchObject({ searched: 1, graduated: 0, suggested: 1 });
  });

  it('confirms a site a page of which names the agency, its town and its state, asking the finder to judge every page and read a locations page', async () => {
    const footerOnly = { phoneSeen: false, judged: 'name', site: { url: 'https://valleyhh.org/', claim: 'Title: Welcome. Opening text: Care that comes to you.' },
      email: 'info@valleyhh.org', sourceUrl: 'https://valleyhh.org/contact' };
    const { store, contacts, run } = setup({ read: footerOnly });
    const { result } = await run();
    const [, options] = contacts.find.mock.calls[0];
    expect(options.morePaths).toEqual(['/locations', '/our-locations', '/office-locations']);
    expect(options.judge('<footer>Valley Home Health · Pittsburgh, PA 15201</footer>')).toBe('name');
    expect(options.judge('<footer>Valley Home Health · Austin, TX 78701</footer>')).toBeNull();
    expect(store.rosterSiteRecord).toHaveBeenCalledWith('397001', expect.objectContaining({ outcome: 'graduated', domain: 'valleyhh.org', confirmation: 'name' }));
    expect(result).toMatchObject({ graduated: 1 });
  });

  it('reads a candidate that redirects to another host as that host, once, and never a directory it redirects to', async () => {
    const reads = {
      'valleyhh.org': { email: null, reason: 'none', movedTo: 'valleyhomehealth.com', phoneSeen: false },
      'valleyhomehealth.com': ownSite,
    };
    const { store, contacts, run } = setup({ answer: 'https://valleyhh.org' });
    contacts.find.mockImplementation(async domain => reads[domain]);
    await run();
    expect(contacts.find.mock.calls.map(call => call[0])).toEqual(['valleyhh.org', 'valleyhomehealth.com']);
    expect(store.rosterSiteRecord).toHaveBeenCalledWith('397001', expect.objectContaining({ outcome: 'graduated', domain: 'valleyhomehealth.com', confirmation: 'phone' }));

    const toDirectory = setup({ answer: 'https://valleyhh.org' });
    toDirectory.contacts.find.mockImplementation(async () => ({ email: null, reason: 'none', movedTo: 'www.yelp.com', phoneSeen: false }));
    await toDirectory.run();
    expect(toDirectory.contacts.find).toHaveBeenCalledTimes(1);
    expect(toDirectory.store.rosterSiteRecord).toHaveBeenCalledWith('397001', { outcome: 'unresolved', suggestions: ['valleyhh.org'] });
  });

  it('reads no directory the search names, and records that nothing was found', async () => {
    const { store, contacts, run } = setup({ answer: 'https://www.yelp.com/biz/valley\nhttps://www.caring.com/valley' });
    const { result } = await run();
    expect(contacts.find).not.toHaveBeenCalled();
    expect(store.rosterSiteRecord).toHaveBeenCalledWith('397001', { outcome: 'unresolved', suggestions: [] });
    expect(result).toMatchObject({ searched: 1, none: 1 });
  });

  it('a site the database refuses (shared by three agencies without the telephone number) stays a suggestion; a lookup that took the agency wins', async () => {
    const byName = { phoneSeen: false, site: { url: 'https://valleyhh.org/', claim: 'Valley Home Health, home health care in Pittsburgh, PA.' } };
    const shared = setup({ read: byName, answer: 'https://valleyhh.org', record: async (_ccn, data) => (data.outcome === 'graduated' ? { graduated: false, reason: 'shared_host' } : { graduated: false }) });
    await shared.run();
    expect(shared.store.rosterSiteRecord.mock.calls.map(([, data]) => data)).toEqual([
      expect.objectContaining({ outcome: 'graduated', confirmation: 'name' }), { outcome: 'unresolved', suggestions: ['valleyhh.org'] }]);
    const taken = setup({ answer: 'https://valleyhh.org', record: async (_ccn, data) => (data.outcome === 'graduated' ? { graduated: false, reason: 'changed' } : { graduated: false }) });
    await taken.run();
    expect(taken.store.rosterSiteRecord.mock.calls.at(-1)[1]).toEqual({ outcome: 'unresolved', suggestions: [] });
  });

  it('a search the model could not finish records nothing, so the agency is handed out again after the hour', async () => {
    const { store, model, run } = setup();
    model.research.mockResolvedValueOnce({ outcome: 'budget_exhausted' });
    const { result } = await run();
    expect(store.rosterSiteRecord).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual({ budget_exhausted: 1 });
  });
});
