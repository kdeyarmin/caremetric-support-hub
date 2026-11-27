import { describe, expect, it, vi } from 'vitest';
import { huntOwners, hunterAddress, hunterFinder, hunterPerson, screenAgencies } from './hunter.mjs';
import { peopleHandlers } from './people.mjs';

const feature = 'platform.agents.growth-hunter.v1';
const found = (email, extra = {}) => ({ email, score: 95, accept_all: false, sources: [], verification: { status: 'valid' }, ...extra });
const reply = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });

describe('which address Hunter gives is kept', () => {
  it('only a valid, well-scored address on the agency\'s own domain, published somewhere when the domain accepts everything', () => {
    expect(hunterAddress(found('DMaylath@MaylathHealth.com'), 'maylathhealth.com')).toBe('dmaylath@maylathhealth.com');
    expect(hunterAddress(found('jane@mail.agency.example'), 'agency.example')).toBe('jane@mail.agency.example');
    expect(hunterAddress(found('jane@gmail.com'), 'agency.example')).toBeNull();
    expect(hunterAddress(found('jane@notagency.example'), 'agency.example')).toBeNull();
    expect(hunterAddress(found('jane@agency.example', { verification: { status: 'accept_all' } }), 'agency.example')).toBeNull();
    expect(hunterAddress(found('jane@agency.example', { score: 79 }), 'agency.example')).toBeNull();
    expect(hunterAddress(found('jane@agency.example', { accept_all: true }), 'agency.example')).toBeNull();
    expect(hunterAddress(found('lisad@agency.example', { accept_all: true, sources: [{ uri: 'https://agency.example/contact' }] }), 'agency.example')).toBe('lisad@agency.example');
    expect(hunterAddress({ email: null }, 'agency.example')).toBeNull();
  });

  it('looks up the person whose role decides most, never one whose role does not decide', () => {
    expect(hunterPerson([{ id: 'p1', name: 'Pat Nurse', title: 'Director of Nursing', source: 'website' },
      { id: 'p2', name: 'DOROTHY MAYLATH', title: '5% OR GREATER DIRECT OWNERSHIP INTEREST', source: 'cms_owners' }])).toEqual({ id: 'p2', name: 'DOROTHY MAYLATH', title: '5% OR GREATER DIRECT OWNERSHIP INTEREST' });
    expect(hunterPerson([{ id: 'p3', name: 'Lisa Deornellas', title: 'Executive Director', source: 'website' }])).toMatchObject({ id: 'p3' });
    expect(hunterPerson([{ id: 'p4', name: 'Pat Nurse', title: 'Director of Nursing', source: 'website' }, { id: 'p5', name: 'Sam Seller', title: 'Marketing', source: 'website' }])).toBeNull();
    expect(hunterPerson([])).toBeNull();
  });
});

describe('screening Hunter\'s queue as a batch screens it', () => {
  it('keeps an agency with a website of its own whose CMS owners are all people, and says why it left the others', () => {
    const facts = new Map([['398041', { owners: [{ name: 'DOROTHY MAYLATH', kind: 'individual' }] }], ['391713', { owners: [{ name: 'DOROTHY MAYLATH', kind: 'individual' }] }],
      ['391679', { owners: [{ name: 'GEORGE FARMER', kind: 'individual' }, { name: 'CROSSROADS HOSPICE HOLDINGS', kind: 'organization' }] }], ['398999', { owners: [] }]]);
    const out = screenAgencies([{ id: 'a', domain: 'maylathhealth.com', ccns: ['398041', '391713'] }, { id: 'b', domain: 'crossroadshospice.com', ccns: ['391679'] },
      { id: 'c', domain: 'deermeadowshomehealth.weebly.com', ccns: ['398121'] }, { id: 'd', domain: 'quiet.example', ccns: ['398999'] }, { id: 'e', domain: 'nofacts.example', ccns: ['398888'] },
      { id: 'f', domain: 'noccn.example', ccns: [] }], facts);
    expect(out.kept.map(agency => agency.id)).toEqual(['a']);
    expect(out.screened).toEqual({ owned_by_organization: 1, no_website_of_its_own: 1, owners_unknown: 3 });
  });
});

describe('Hunter\'s Email Finder', () => {
  it('asks by name and domain with the key in a header, never the address, and reads its answer', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { data: found('dmaylath@maylathhealth.com') }));
    const finder = hunterFinder({ apiKey: 'secret-key', fetchImpl });
    expect(finder.configured).toBe(true);
    expect(await finder.find({ name: ' DOROTHY  MAYLATH ', domain: 'MaylathHealth.com' })).toEqual({ result: 'found', email: 'dmaylath@maylathhealth.com', score: 95 });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://api.hunter.io/v2/email-finder?domain=maylathhealth.com&full_name=DOROTHY+MAYLATH');
    expect(String(url)).not.toContain('secret-key');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { 'x-api-key': 'secret-key' } });
  });

  it('says not found, refused or error without guessing, and is not configured without a key', async () => {
    const answer = async (response) => hunterFinder({ apiKey: 'k', fetchImpl: async () => response }).find({ name: 'Jane Doe', domain: 'agency.example' });
    expect(await answer(reply(200, { data: { email: null } }))).toEqual({ result: 'not_found' });
    expect(await answer(reply(200, { data: found('jane@agency.example', { accept_all: true }) }))).toEqual({ result: 'not_found' });
    expect(await answer(reply(401, { errors: [] }))).toEqual({ result: 'refused' });
    expect(await answer(reply(451, { errors: [] }))).toEqual({ result: 'not_found' });
    expect(await answer(reply(429, { errors: [] }))).toEqual({ result: 'error' });
    expect(await answer({ status: 200, ok: true, text: async () => 'not json' })).toEqual({ result: 'error' });
    expect(await hunterFinder({ apiKey: 'k', fetchImpl: async () => { throw new Error('reset'); } }).find({ name: 'Jane Doe', domain: 'agency.example' })).toEqual({ result: 'error' });
    expect(hunterFinder({ apiKey: '  ' }).configured).toBe(false);
  });
});

describe('a run\'s lookups', () => {
  const agencies = [
    { id: 'o1', name: 'No decider', domain: 'nodecider.example', ccns: ['391001'], people: [{ id: 'p0', name: 'Pat Nurse', title: 'Director of Nursing', source: 'website' }] },
    { id: 'o5', name: 'Chain', domain: 'chain.example', ccns: ['391005'], people: [{ id: 'p5', name: 'Cora Chain', title: 'Owner', source: 'website' }] },
    { id: 'o6', name: 'Hosted', domain: 'hosted.weebly.com', ccns: ['391006'], people: [{ id: 'p6', name: 'Hal Host', title: 'Owner', source: 'website' }] },
    { id: 'o2', name: 'Maylath', domain: 'maylathhealth.com', ccns: ['398041', '391713'], people: [{ id: 'p2', name: 'DOROTHY MAYLATH', title: '5% OR GREATER DIRECT OWNERSHIP INTEREST', source: 'cms_owners' }] },
    { id: 'o3', name: 'Rehab', domain: 'athomerehabllc.com', ccns: ['397786'], people: [{ id: 'p3', name: 'Jennifer Guglielmi', title: 'CEO', source: 'npi_registry' }] },
    { id: 'o4', name: 'Later', domain: 'later.example', ccns: ['391004'], people: [{ id: 'p4', name: 'Ann Owner', title: 'Owner', source: 'website' }] },
  ];
  const person = name => ({ name, kind: 'individual', role: '5% OR GREATER DIRECT OWNERSHIP INTEREST' });
  const ownersByCcn = { '391001': [person('Pat Owner')], '391005': [person('Cora Chain'), { name: 'NATIONAL HOSPICE HOLDINGS LLC', kind: 'organization', role: '5% OR GREATER INDIRECT OWNERSHIP INTEREST' }],
    '391006': [person('Hal Host')], '398041': [person('DOROTHY MAYLATH')], '391713': [person('DOROTHY MAYLATH')], '397786': [person('JENNIFER GUGLIELMI')], '391004': [person('Ann Owner')] };
  const feedOf = () => ({ configured: true, agencyFacts: vi.fn(async ({ ccns }) => ({ agencies: ccns.filter(ccn => ownersByCcn[ccn]).map(ccn => ({ ccn, owners: ownersByCcn[ccn] })) })) });
  function setup({ begin = id => `l-${id}`, answers = { 'maylathhealth.com': { result: 'found', email: 'dmaylath@maylathhealth.com' }, 'athomerehabllc.com': { result: 'not_found' } },
    saved = { found: true } } = {}) {
    const store = { hunterNext: vi.fn(async () => agencies), hunterBegin: vi.fn(async org => begin(org)), hunterFinish: vi.fn(async () => true),
      personAddress: vi.fn(async () => saved) };
    const finder = { configured: true, find: vi.fn(async ({ domain }) => answers[domain] ?? { result: 'not_found' }) };
    return { store, finder, feed: feedOf() };
  }

  it('asks about the agencies the database names that a batch would take, one person each, records what it found as Hunter\'s, and stops at the run\'s number', async () => {
    const { store, finder, feed } = setup();
    expect(await huntOwners({ store, finder, feed, features: new Set([feature]) })).toEqual({ asked: 2, found: 1, notFound: 1, refused: 0, errors: 0,
      screened: { owned_by_organization: 1, no_website_of_its_own: 1 } });
    expect(store.hunterNext).toHaveBeenCalledWith(20);
    // The CMS owners of every agency with a website of its own, in one request, before any lookup; never the hosted one's.
    expect(feed.agencyFacts).toHaveBeenCalledTimes(1);
    expect(feed.agencyFacts.mock.calls[0][0].ccns).toEqual(['391001', '391005', '398041', '391713', '397786', '391004']);
    expect(store.hunterBegin).not.toHaveBeenCalledWith('o5', 'p5');
    expect(store.hunterBegin.mock.calls).toEqual([['o2', 'p2'], ['o3', 'p3']]);
    expect(finder.find.mock.calls.map(([q]) => [q.name, q.domain])).toEqual([['DOROTHY MAYLATH', 'maylathhealth.com'], ['Jennifer Guglielmi', 'athomerehabllc.com']]);
    expect(store.personAddress).toHaveBeenCalledWith('p2', 'dmaylath@maylathhealth.com', 'DOROTHY MAYLATH', 'hunter', null);
    expect(store.hunterFinish.mock.calls).toEqual([['l-o2', 'found'], ['l-o3', 'not_found']]);
  });

  it('stops when the day\'s lookups are used or the key is refused, counts an address the database will not take as not found, and does nothing undeclared', async () => {
    const capped = setup({ begin: () => null });
    expect(await huntOwners({ store: capped.store, finder: capped.finder, feed: capped.feed, features: [feature] })).toMatchObject({ asked: 0, found: 0 });
    expect(capped.finder.find).not.toHaveBeenCalled();
    const refused = setup({ answers: { 'maylathhealth.com': { result: 'refused' } } });
    expect(await huntOwners({ store: refused.store, finder: refused.finder, feed: refused.feed, features: [feature], limit: 3 })).toMatchObject({ asked: 1, refused: 1 });
    const taken = setup({ saved: { found: false, reason: 'taken' } });
    expect(await huntOwners({ store: taken.store, finder: taken.finder, feed: taken.feed, features: [feature], limit: 1 })).toMatchObject({ asked: 1, found: 0, notFound: 1 });
    // Without the feed's owners nobody is looked up.
    const blind = setup();
    expect(await huntOwners({ store: blind.store, finder: blind.finder, feed: { configured: false }, features: [feature] })).toMatchObject({ asked: 0, skipped: 'feed' });
    expect(blind.store.hunterBegin).not.toHaveBeenCalled();
    expect(taken.store.hunterFinish).toHaveBeenCalledWith('l-o2', 'not_found');
    expect(await huntOwners({ store: taken.store, finder: taken.finder, features: [] })).toBeNull();
    expect(await huntOwners({ store: taken.store, finder: { configured: false }, features: [feature] })).toBeNull();
  });

  it('runs at the start of the people step, whatever else the step finds to do', async () => {
    const { store, finder } = setup();
    const growth = { store: { ...store, peopleCandidates: vi.fn(async () => []) }, roster: { feed: feedOf() },
      people: { mode: 'verify', hunter: finder, registry: { officials: vi.fn(async () => []) } } };
    const handlers = peopleHandlers({ growth, features: new Set(['platform.agents.growth-people.v1', 'platform.agents.growth-people-finder.v1', feature]), marketed: () => ['caremetric-intel'] });
    const out = await handlers['growth.people']({ agent: { autonomy: 'act' } });
    expect(out.result).toEqual({ searched: 0, hunter: { asked: 2, found: 1, notFound: 1, refused: 0, errors: 0, screened: { owned_by_organization: 1, no_website_of_its_own: 1 } } });
  });
});
