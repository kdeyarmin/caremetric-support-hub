import { describe, expect, it, vi } from 'vitest';
import { choosePerson, growthPeopleFeature, growthPeopleFinderFeature, mergePeople, ownerPeople, ownerRank, peopleHandlers, publishedAddress, titleRank } from './people.mjs';

const features = new Set([growthPeopleFeature, growthPeopleFinderFeature]);
const agency = { ccn: '391501', name: 'Valley Hospice', city: 'Harrisburg', state: 'PA', zip: '17110', phone: '7175550100', setting: 'hospice' };
const candidate = { id: 'org-1', domain: 'valleyhospice.org', name: 'Valley Hospice', product: 'caremetric-intel', ccns: ['391501'], agencies: [agency] };

describe('choosing the person to write to', () => {
  it('ranks deciding titles and CMS roles', () => {
    expect(titleRank('Owner and Administrator')).toBe(0);
    expect(titleRank('Director of Business Development')).toBe(4);
    expect(titleRank('Registered Nurse')).toBe(Infinity);
    expect([ownerRank('5% or Greater Direct Ownership Interest'), ownerRank('Corporate Officer'), ownerRank('Operational/Managerial Control'), ownerRank('Board Member')])
      .toEqual([0, 1, 2, 5]);
    expect(ownerPeople({ owners: [{ name: 'Jane Doe', kind: 'individual', role: 'Operational/Managerial Control' }, { name: 'Holdings LLC', kind: 'organization' }] }))
      .toEqual([{ name: 'Jane Doe', title: 'Operational/Managerial Control', source: 'cms_owners', sourceUrl: 'https://www.caremetricintel.com/data-use' }]);
  });

  it('treats one name from several sources as one person, and writes to the one who decides most', () => {
    const people = mergePeople([
      { name: 'Sam Lee', title: 'Director of Business Development', source: 'website' },
      { name: 'Jane Doe', title: 'Administrator', source: 'website', sourceUrl: 'https://valleyhospice.org/team' },
      { name: 'Jane A Doe', title: 'Operations Manager', source: 'npi_registry' },
      { name: 'JANE DOE', title: '5% or Greater Direct Ownership Interest', source: 'cms_owners' },
      { name: 'Pat Kim', title: 'Registered Nurse', source: 'website' },
      { name: 'Holdings', title: 'Owner', source: 'cms_owners' },
    ]);
    expect(people.map(person => [person.name, person.title, person.rank, person.sources])).toEqual([
      ['Jane Doe', 'Administrator', 0, 3], ['Sam Lee', 'Director of Business Development', 4, 1], ['Pat Kim', 'Registered Nurse', Infinity, 1]]);
    expect(choosePerson(people).name).toBe('Jane Doe');
    expect(choosePerson(people.slice(2))).toBeNull();
    // A published address belongs to a person only by a full shape of their name, on the business's own domain.
    expect(publishedAddress([{ email: 'sam@valleyhospice.org' }, { email: 'slee@valleyhospice.org', sourceUrl: 'https://valleyhospice.org/team' }], people, 'valleyhospice.org'))
      .toMatchObject({ email: 'slee@valleyhospice.org', person: { name: 'Sam Lee' } });
    expect(publishedAddress([{ email: 'pkim@valleyhospice.org' }], people, 'valleyhospice.org')).toBeNull();
  });
});

function setup({ mode = 'verify', team = { people: [], addresses: [] }, officials = [], check = { result: 'verified', email: 'jane.doe@valleyhospice.org' }, reserve = true, feed = undefined, available = true, featureSet = features } = {}) {
  const store = {
    peopleCandidates: vi.fn(async () => [candidate]),
    peopleRecord: vi.fn(async (_org, people) => people.map((person, i) => ({ id: `person-${i}`, source: person.source }))),
    enrichmentReserve: vi.fn(async () => reserve),
    personAddress: vi.fn(async () => ({ found: true, contactId: 'c1' })),
  };
  const registry = { officials: vi.fn(async () => officials) };
  const mailbox = { check: vi.fn(async () => check), available: () => available };
  const contacts = { team: vi.fn(async () => team) };
  const roster = { feed: feed === undefined ? { configured: true, agencyFacts: vi.fn(async () => ({ agencies: [{ ccn: '391501', owners: [{ name: 'Jane Doe', kind: 'individual', role: 'Owner' }] }] })) } : feed };
  const growth = { store, contacts, roster, people: { mode: () => mode, registry, mailbox } };
  return { store, registry, mailbox, contacts, run: (task = { agent: { autonomy: 'propose' } }) => peopleHandlers({ growth, features: featureSet, marketed: ['caremetric-intel'] })['growth.people'](task) };
}

describe('growth.people', () => {
  // John's published address is his first name only: too common to tie to him without the mail server, but it shows the business's shape.
  const team = { people: [{ name: 'Jane Doe', title: 'Administrator', sourceUrl: 'https://valleyhospice.org/team' }, { name: 'John Smith', title: 'Director of Nursing', sourceUrl: 'https://valleyhospice.org/team' }],
    addresses: [{ email: 'john@valleyhospice.org', sourceUrl: 'https://valleyhospice.org/team' }] };

  it('records who CMS, the NPI registry and the website name, and keeps an address the business publishes, free', async () => {
    const { store, registry, mailbox, run } = setup({ team: { people: team.people.slice(0, 1), addresses: [{ email: 'jdoe@valleyhospice.org', sourceUrl: 'https://valleyhospice.org/team' }] },
      officials: [{ name: 'Sam Lee', title: 'Owner', source: 'npi_registry', sourceUrl: 'https://npiregistry.cms.hhs.gov/provider-view/1578017406' }] });
    expect((await run()).result).toEqual({ searched: 1, people: 3, found: 1, published: 1, verified: 0, noCredit: 0, unreachable: 0 });
    expect(registry.officials).toHaveBeenCalledWith(agency, expect.anything());
    expect(store.peopleRecord.mock.calls[0][1]).toEqual([
      { name: 'Jane Doe', title: 'Administrator', source: 'website', sourceUrl: 'https://valleyhospice.org/team' },
      expect.objectContaining({ name: 'Jane Doe', source: 'cms_owners' }), expect.objectContaining({ name: 'Sam Lee', source: 'npi_registry' })]);
    expect(store.personAddress).toHaveBeenCalledWith('person-0', 'jdoe@valleyhospice.org', 'Jane Doe', 'published', 'https://valleyhospice.org/team');
    expect(store.enrichmentReserve).not.toHaveBeenCalled();
    expect(mailbox.check).not.toHaveBeenCalled();
  });

  it('otherwise asks the mail server about the chosen person\'s usual addresses, the business\'s own shape first, for one reserved check', async () => {
    const { store, mailbox, run } = setup({ team });
    expect((await run()).result).toMatchObject({ searched: 1, found: 1, verified: 1 });
    expect(store.enrichmentReserve).toHaveBeenCalledWith(1);
    const [domain, guesses] = mailbox.check.mock.calls[0];
    expect(domain).toBe('valleyhospice.org');
    expect(guesses[0]).toBe('jane@valleyhospice.org');
    expect(guesses).toContain('jane.doe@valleyhospice.org');
    expect(guesses).toHaveLength(6);
    expect(store.personAddress).toHaveBeenCalledWith('person-0', 'jane.doe@valleyhospice.org', 'Jane Doe', 'mail_server', null);
  });

  it('keeps nothing the mail server did not confirm, and counts a server it could not reach', async () => {
    for (const check of [{ result: 'catch_all' }, { result: 'rejected' }, { result: 'unknown', reason: 'blocked' }]) {
      const { store, run } = setup({ team, check });
      expect((await run()).result).toMatchObject({ searched: 1, found: 0 });
      expect(store.personAddress).not.toHaveBeenCalled();
    }
    expect((await setup({ team, check: { result: 'unreachable' } }).run()).result).toMatchObject({ unreachable: 1, found: 0 });
  });

  it('never guesses unless the owner chose it, and asks nothing while the mail check rests or past the day\'s number', async () => {
    for (const options of [{ mode: 'published' }, { mode: 'none' }, { available: false }]) {
      const { store, mailbox, run } = setup({ team, ...options });
      expect((await run()).result).toMatchObject({ searched: 1, found: 0 });
      expect(mailbox.check).not.toHaveBeenCalled();
      expect(store.enrichmentReserve).not.toHaveBeenCalled();
    }
    const capped = setup({ team, reserve: false });
    expect((await capped.run()).result).toMatchObject({ searched: 0, noCredit: 1 });
    // Nothing is recorded, so the business is not marked searched and is looked at again once checks return.
    expect(capped.store.peopleRecord).not.toHaveBeenCalled();
    expect(capped.mailbox.check).not.toHaveBeenCalled();
  });

  it('records CMS owners only before the finder\'s migration, and does nothing in Observe or without the feature', async () => {
    const before = setup({ team, featureSet: new Set([growthPeopleFeature]) });
    expect((await before.run()).result).toMatchObject({ searched: 1, people: 1, found: 0 });
    expect(before.contacts.team).not.toHaveBeenCalled();
    expect(before.registry.officials).not.toHaveBeenCalled();
    expect(before.store.peopleRecord.mock.calls[0][1]).toEqual([expect.objectContaining({ source: 'cms_owners' })]);
    expect((await setup().run({ agent: { autonomy: 'observe' } })).result).toEqual({ skipped: 'observe_only' });
    expect((await setup({ feed: null, featureSet: new Set([growthPeopleFeature]) }).run()).result).toEqual({ skipped: 'no_source' });
    expect(peopleHandlers({ growth: { store: {} }, features: new Set() })).toEqual({});
  });
});
