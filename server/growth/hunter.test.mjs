import { describe, expect, it, vi } from 'vitest';
import { huntOwners, hunterAddress, hunterCompanyFinder, hunterFinder, hunterPerson, screenAgencies } from './hunter.mjs';
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

describe('screening Hunter\'s queue', () => {
  it('looks up every agency whoever owns it, and skips only one whose site is a page builder\'s (no mailbox of its own)', () => {
    const out = screenAgencies([{ id: 'a', domain: 'maylathhealth.com', ccns: ['398041'] }, { id: 'b', domain: 'crossroadshospice.com', ccns: ['391679'] },
      { id: 'c', domain: 'deermeadowshomehealth.weebly.com', ccns: ['398121'] }, { id: 'd', domain: null }, { id: 'e', domain: 'noccn.example', ccns: [] }]);
    expect(out.kept.map(agency => agency.id)).toEqual(['a', 'b', 'e']);
    expect(out.screened).toEqual({ no_website_of_its_own: 2 });
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

describe('Hunter\'s company search for the roster', () => {
  it('asks by the company\'s name for one result, with the key in a header, and answers the domain Hunter knows', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { data: { domain: 'WWW.ValleyHospice.org', organization: 'Valley Hospice', emails: [] } }));
    const finder = hunterCompanyFinder({ apiKey: 'secret-key', fetchImpl });
    expect(finder.configured).toBe(true);
    expect(await finder.find({ name: ' valley  hospice ' })).toEqual({ result: 'found', domain: 'valleyhospice.org', organization: 'Valley Hospice' });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://api.hunter.io/v2/domain-search?company=valley+hospice&limit=1');
    expect(String(url)).not.toContain('secret-key');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { 'x-api-key': 'secret-key' } });
  });

  it('says not found, refused or error, and never names a malformed domain', async () => {
    const answer = async response => hunterCompanyFinder({ apiKey: 'k', fetchImpl: async () => response }).find({ name: 'Valley Hospice' });
    expect(await answer(reply(200, { data: { domain: null } }))).toEqual({ result: 'not_found' });
    expect(await answer(reply(200, { data: { domain: 'not a domain' } }))).toEqual({ result: 'not_found' });
    expect(await answer(reply(401, {}))).toEqual({ result: 'refused' });
    expect(await answer(reply(400, {}))).toEqual({ result: 'not_found' });
    expect(await answer(reply(503, {}))).toEqual({ result: 'error' });
    expect(await hunterCompanyFinder({ apiKey: 'k', fetchImpl: async () => { throw new Error('reset'); } }).find({ name: 'Valley Hospice' })).toEqual({ result: 'error' });
    expect(await hunterCompanyFinder({ apiKey: '' }).find({ name: 'Valley Hospice' })).toEqual({ result: 'refused' });
    expect(hunterCompanyFinder({ apiKey: '' }).configured).toBe(false);
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
    return { store, finder };
  }

  it('asks about the agencies the database names that a batch would take, one person each, records what it found as Hunter\'s, and stops at the run\'s number', async () => {
    const { store, finder } = setup();
    // The company-owned agency is looked up like any other (owner, 2026-11-27: no agency is off limits); only the page builder's site is skipped.
    expect(await huntOwners({ store, finder, features: new Set([feature]) })).toEqual({ asked: 2, found: 1, notFound: 1, refused: 0, errors: 0,
      screened: { no_website_of_its_own: 1 } });
    expect(store.hunterNext).toHaveBeenCalledWith(20);
    expect(store.hunterBegin.mock.calls).toEqual([['o5', 'p5'], ['o2', 'p2']]);
    expect(finder.find.mock.calls.map(([q]) => [q.name, q.domain])).toEqual([['Cora Chain', 'chain.example'], ['DOROTHY MAYLATH', 'maylathhealth.com']]);
    expect(store.personAddress).toHaveBeenCalledWith('p2', 'dmaylath@maylathhealth.com', 'DOROTHY MAYLATH', 'hunter', null);
    expect(store.hunterFinish.mock.calls).toEqual([['l-o5', 'not_found'], ['l-o2', 'found']]);
  });

  it('stops when the day\'s lookups are used or the key is refused, counts an address the database will not take as not found, and does nothing undeclared', async () => {
    const capped = setup({ begin: () => null });
    expect(await huntOwners({ store: capped.store, finder: capped.finder, features: [feature] })).toMatchObject({ asked: 0, found: 0 });
    expect(capped.finder.find).not.toHaveBeenCalled();
    const refused = setup({ answers: { 'maylathhealth.com': { result: 'refused' } } });
    expect(await huntOwners({ store: refused.store, finder: refused.finder, features: [feature], limit: 3 })).toMatchObject({ asked: 2, refused: 1 });
    const taken = setup({ saved: { found: false, reason: 'taken' } });
    // Maylath's address is one the database will not take (already a contact): counted as not found.
    expect(await huntOwners({ store: taken.store, finder: taken.finder, features: [feature], limit: 2 })).toMatchObject({ asked: 2, found: 0, notFound: 2 });
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
    expect(out.result).toEqual({ searched: 0, hunter: { asked: 2, found: 1, notFound: 1, refused: 0, errors: 0, screened: { no_website_of_its_own: 1 } } });
  });

  it('keeps Hunter\'s searches for the state launches once Pennsylvania is Instantly\'s', async () => {
    const { store, finder } = setup();
    const growth = { store: { ...store, peopleCandidates: vi.fn(async () => []) }, roster: { feed: feedOf() },
      people: { mode: 'verify', hunter: finder, handedOver: ['PA'], registry: { officials: vi.fn(async () => []) } } };
    const handlers = peopleHandlers({ growth, features: new Set(['platform.agents.growth-people.v1', 'platform.agents.growth-people-finder.v1', feature]), marketed: () => ['caremetric-intel'] });
    const out = await handlers['growth.people']({ agent: { autonomy: 'act' } });
    expect(out.result).toEqual({ searched: 0, hunter: { skipped: 'instantly' } });
    expect(store.hunterNext).not.toHaveBeenCalled();
  });
});
