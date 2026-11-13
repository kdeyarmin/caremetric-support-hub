import { describe, expect, it, vi } from 'vitest';
import { choosePerson, growthPeopleFeature, ownerPeople, peopleHandlers, titleRank } from './people.mjs';

const features = new Set([growthPeopleFeature]);
const candidate = { id: 'org-1', domain: 'valleyhospice.org', name: 'Valley Hospice', product: 'caremetric-intel', ccns: ['391501'] };

describe('choosing the person to write to', () => {
  it('ranks deciding titles and prefers someone CMS lists as an owner', () => {
    expect(titleRank('Owner and Administrator')).toBe(0);
    expect(titleRank('Director of Business Development')).toBe(4);
    expect(titleRank('Registered Nurse')).toBe(Infinity);
    const found = [{ ref: 'a', firstName: 'Sam', title: 'Director of Business Development' }, { ref: 'b', firstName: 'Jane', title: 'Clinical Manager' }, { ref: 'c', firstName: 'Lee', title: 'Nurse' }];
    expect(choosePerson(found).ref).toBe('a');
    expect(choosePerson(found, [{ name: 'Jane Doe' }]).ref).toBe('b');
    expect(choosePerson([{ ref: 'c', firstName: 'Lee', title: 'Nurse' }])).toBeNull();
    expect(ownerPeople({ owners: [{ name: 'Jane Doe', kind: 'individual', role: 'Operational/Managerial Control' }, { name: 'Holdings LLC', kind: 'organization' }] }))
      .toEqual([{ name: 'Jane Doe', title: 'Operational/Managerial Control', source: 'cms_owners', sourceUrl: 'https://www.caremetricintel.com/data-use' }]);
  });
});

function setup({ provider = null, feed = null, reserve = true } = {}) {
  const store = {
    peopleCandidates: vi.fn(async () => [candidate]),
    peopleRecord: vi.fn(async (_org, people) => people.map((person, i) => ({ id: `person-${i}`, source: person.source, providerRef: person.providerRef ?? null }))),
    enrichmentReserve: vi.fn(async () => reserve),
    enrichedContact: vi.fn(async () => ({ found: true, contactId: 'c1' })),
  };
  const growth = { store, people: { provider }, roster: { feed } };
  return { store, run: (task = { agent: { autonomy: 'propose' } }) => peopleHandlers({ growth, features, marketed: ['caremetric-intel'] })['growth.people'](task) };
}

describe('growth.people', () => {
  const provider = { configured: true, provider: 'apollo',
    search: vi.fn(async () => [{ ref: 'p1', firstName: 'Jane', lastName: 'D***', title: 'Administrator' }]),
    enrich: vi.fn(async () => ({ email: 'jane@valleyhospice.org', name: 'Jane Doe', title: 'Administrator' })) };
  const feed = { configured: true, agencyFacts: vi.fn(async () => ({ agencies: [{ ccn: '391501', owners: [{ name: 'Jane Doe', kind: 'individual', role: 'Owner' }] }] })) };

  it('records CMS owners and found people, then spends one reserved credit on the chosen person\'s verified address', async () => {
    const { store, run } = setup({ provider, feed });
    expect((await run()).result).toEqual({ searched: 1, people: 2, found: 1, noCredit: 0 });
    expect(feed.agencyFacts).toHaveBeenCalledWith(expect.objectContaining({ ccns: ['391501'] }));
    expect(store.peopleRecord.mock.calls[0][1]).toEqual([
      expect.objectContaining({ name: 'Jane Doe', source: 'cms_owners' }), { name: 'Jane D***', title: 'Administrator', source: 'apollo', providerRef: 'p1' }]);
    expect(store.enrichmentReserve).toHaveBeenCalledWith(1);
    expect(store.enrichedContact).toHaveBeenCalledWith('person-1', 'jane@valleyhospice.org', 'Jane Doe');
  });

  it('spends nothing past the owner\'s daily number, and records CMS owners without any contact-data service', async () => {
    const capped = setup({ provider, feed, reserve: false });
    expect((await capped.run()).result).toMatchObject({ noCredit: 1, found: 0 });
    expect(capped.store.enrichedContact).not.toHaveBeenCalled();
    const ownersOnly = setup({ feed });
    expect((await ownersOnly.run()).result).toMatchObject({ searched: 1, people: 1, found: 0 });
    expect(ownersOnly.store.enrichmentReserve).not.toHaveBeenCalled();
  });

  it('does nothing in Observe, without a source, or without the feature', async () => {
    expect((await setup({ provider }).run({ agent: { autonomy: 'observe' } })).result).toEqual({ skipped: 'observe_only' });
    expect((await setup().run()).result).toEqual({ skipped: 'no_source' });
    expect(peopleHandlers({ growth: { store: {} }, features: new Set() })).toEqual({});
  });
});
