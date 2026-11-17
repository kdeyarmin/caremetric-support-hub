import { describe, expect, it, vi } from 'vitest';
import { choosePerson, growthPeopleFeature, growthPeopleFinderFeature, mergePeople, ownerPeople, ownerRank, peopleHandlers, placedAgencies, publishedAddress, titleRank } from './people.mjs';

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

function setup({ mode = 'verify', team = { people: [], addresses: [] }, officials = [], check = { result: 'verified', email: 'jane.doe@valleyhospice.org' }, reserve = true, feed = undefined, available = true, featureSet = features, saved = { found: true, contactId: 'c1' }, org = candidate, listing = undefined } = {}) {
  const store = {
    peopleCandidates: vi.fn(async () => [org]),
    peopleRecord: vi.fn(async (_org, people) => people.map((person, i) => ({ id: `person-${i}`, source: person.source }))),
    enrichmentReserve: vi.fn(async () => reserve),
    personAddress: vi.fn(async () => saved),
  };
  const registry = { officials: vi.fn(async () => officials) };
  const mailbox = { check: vi.fn(async () => check), available: () => available };
  const contacts = { team: vi.fn(async () => team), ...(listing === undefined ? {} : { listing: vi.fn(async () => listing) }) };
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
    expect((await run()).result).toEqual({ searched: 1, people: 3, found: 1, published: 1, verified: 0, permitted: 0, noCredit: 0, unreachable: 0 });
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

  it('counts an address the database permitted on its own under the owner\'s hand-over, and one waiting for the owner as before', async () => {
    // The hand-over is decided in the database (20261115200000_autonomy_handover.sql); the task only records what it found and counts the answer.
    const handedOver = setup({ team, saved: { found: true, contactId: 'c1', eligibility: 'permitted' } });
    expect((await handedOver.run()).result).toMatchObject({ found: 1, verified: 1, permitted: 1 });
    expect(handedOver.store.personAddress).toHaveBeenCalledWith('person-0', 'jane.doe@valleyhospice.org', 'Jane Doe', 'mail_server', null);
    const waiting = setup({ team, saved: { found: true, contactId: 'c1', eligibility: 'review' } });
    expect((await waiting.run()).result).toMatchObject({ found: 1, permitted: 0 });
    // A guess the mail server did not confirm never reaches the database, hand-over or not.
    const unconfirmed = setup({ team, check: { result: 'catch_all' }, saved: { found: true, contactId: 'c1', eligibility: 'permitted' } });
    expect((await unconfirmed.run()).result).toMatchObject({ found: 0, permitted: 0 });
    expect(unconfirmed.store.personAddress).not.toHaveBeenCalled();
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

describe('an agency not matched to its Medicare record (2026-11-17)', () => {
  const web = { id: 'org-2', domain: 'rivercare.example', name: 'River Care', product: 'caremetric-intel', ccns: [], agencies: [] };
  const listing = { phones: ['4125550100', '4125550101'], places: [{ city: 'Pittsburgh', state: 'PA', zip: '15213' }], title: 'River Care | Home care in Pittsburgh' };
  const official = { name: 'Sam Lee', title: 'Administrator', source: 'npi_registry', sourceUrl: 'https://npiregistry.cms.hhs.gov/provider-view/1578017406' };

  it('places it where its own website\'s postal address does, with the numbers the site publishes, hospice first when its name says so', () => {
    expect(placedAgencies(web, listing)).toEqual([
      { name: 'River Care', state: 'PA', city: 'Pittsburgh', zip: '15213', phones: ['4125550100', '4125550101'], setting: 'home_health' },
      { name: 'River Care', state: 'PA', city: 'Pittsburgh', zip: '15213', phones: ['4125550100', '4125550101'], setting: 'hospice' }]);
    expect(placedAgencies({ ...web, name: 'River Hospice' }, listing).map(agency => agency.setting)).toEqual(['hospice', 'home_health']);
    // A state alone, or no address on the site, places nothing: a search snippet or a discovery market is not where the agency is.
    expect(placedAgencies(web, { ...listing, places: [{ city: null, state: 'PA', zip: null }] })).toEqual([]);
    expect(placedAgencies(web, { phones: listing.phones, places: [] })).toEqual([]);
    expect(placedAgencies({ ...web, name: '' }, listing)).toEqual([]);
  });

  it('asks the NPI registry where its site places it, stops at the first record that is its own, and records the official', async () => {
    const { store, registry, contacts, run } = setup({ org: web, listing, officials: [official], check: { result: 'verified', email: 'slee@rivercare.example' } });
    const { result } = await run();
    expect(contacts.listing).toHaveBeenCalledWith('rivercare.example', expect.anything());
    expect(registry.officials).toHaveBeenCalledTimes(1);
    expect(registry.officials.mock.calls[0][0]).toMatchObject({ name: 'River Care', zip: '15213', phones: ['4125550100', '4125550101'], setting: 'home_health' });
    expect(store.peopleRecord.mock.calls[0][1]).toEqual([expect.objectContaining({ name: 'Sam Lee', source: 'npi_registry' })]);
    expect(result).toMatchObject({ searched: 1, byPlace: 1, found: 1 });
    // Neither kind of care is its record: both asked, nobody named from the registry.
    const none = setup({ org: web, listing });
    const nobody = (await none.run()).result;
    expect(nobody).toMatchObject({ searched: 1, people: 0 });
    expect(nobody).not.toHaveProperty('byPlace');
    expect(none.registry.officials).toHaveBeenCalledTimes(2);
  });

  it('never reads the site for the registry when the agency is matched, or when the site gives no address', async () => {
    const matched = setup({ listing });
    await matched.run();
    expect(matched.contacts.listing).not.toHaveBeenCalled();
    expect(matched.registry.officials).toHaveBeenCalledWith(agency, expect.anything());
    const unplaced = setup({ org: web, listing: { phones: listing.phones, places: [] } });
    expect((await unplaced.run()).result).not.toHaveProperty('byPlace');
    expect(unplaced.registry.officials).not.toHaveBeenCalled();
    // A site that cannot be read leaves the website's own names to the finder.
    const unread = setup({ org: web, listing, team: { people: [{ name: 'Pat Kim', title: 'Owner', sourceUrl: 'https://rivercare.example/about' }], addresses: [] } });
    unread.contacts.listing.mockRejectedValueOnce(new Error('timeout'));
    expect((await unread.run()).result).toMatchObject({ searched: 1, people: 1 });
  });
});

describe('an address the verification service confirmed (2026-11-17)', () => {
  const team = { people: [{ name: 'Jane Doe', title: 'Administrator', sourceUrl: 'https://valleyhospice.org/team' }], addresses: [] };
  it('records it as found by the service, with no page, and counts it', async () => {
    const { store, run } = setup({ team, check: { result: 'verified', email: 'jdoe@valleyhospice.org', via: 'service' } });
    const { result } = await run();
    expect(store.personAddress).toHaveBeenCalledWith(expect.any(String), 'jdoe@valleyhospice.org', 'Jane Doe', 'service', null);
    expect(result).toMatchObject({ found: 1, verified: 1, byService: 1, answers: { verified: 1 } });
    // The mail server's own confirmation is recorded as before, and no service count appears.
    const own = setup({ team });
    const mine = (await own.run()).result;
    expect(own.store.personAddress).toHaveBeenCalledWith(expect.any(String), 'jane.doe@valleyhospice.org', 'Jane Doe', 'mail_server', null);
    expect(mine).not.toHaveProperty('byService');
  });
});

describe('the next decision-maker (2026-11-16)', () => {
  const team = { people: [{ name: 'Jane Doe', title: 'Administrator', sourceUrl: 'https://valleyhospice.org/team' }, { name: 'Sam Lee', title: 'Director of Business Development', sourceUrl: 'https://valleyhospice.org/team' }],
    addresses: [] };
  it('asks about the next person who decides, for one more reserved check, when the server refuses every shape of the first one\'s name', async () => {
    const { store, mailbox, run } = setup({ team });
    mailbox.check.mockResolvedValueOnce({ result: 'rejected' }).mockResolvedValueOnce({ result: 'verified', email: 'slee@valleyhospice.org' });
    const { result } = await run();
    expect(mailbox.check).toHaveBeenCalledTimes(2);
    expect(mailbox.check.mock.calls[1][1]).toContain('slee@valleyhospice.org');
    expect(store.enrichmentReserve).toHaveBeenCalledTimes(2);
    expect(store.personAddress).toHaveBeenCalledWith(expect.any(String), 'slee@valleyhospice.org', 'Sam Lee', 'mail_server', null);
    expect(result).toMatchObject({ found: 1, verified: 1, answers: { rejected: 1, verified: 1 } });
  });
  it('never asks again after a catch-all or an unanswered server, nor without a credit for it', async () => {
    for (const check of [{ result: 'catch_all' }, { result: 'unknown', reason: 'temporary' }]) {
      const { mailbox, run } = setup({ team, check });
      expect((await run()).result).toMatchObject({ found: 0, answers: { [check.result]: 1 } });
      expect(mailbox.check).toHaveBeenCalledTimes(1);
    }
    const { store, mailbox, run } = setup({ team, check: { result: 'rejected' } });
    store.enrichmentReserve.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await run()).result).toMatchObject({ found: 0, answers: { rejected: 1 } });
    expect(mailbox.check).toHaveBeenCalledTimes(1);
  });
});
