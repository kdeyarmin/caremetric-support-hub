import { describe, expect, it, vi } from 'vitest';
import { acceptedEmail, choosePerson, corporateRank, domainFits, facilityRank, findPerson, hunterSearch, npiOfficials, properName } from './people.mjs';

const entry = (value, position, extra = {}) => {
  const [first, last] = value.split('@')[0].split('.');
  return { value, type: 'personal', confidence: 95, first_name: first, last_name: last ?? 'Doe', position, verification: { status: 'valid' }, sources: [], ...extra };
};
const json = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body), body: null });

describe('the business\'s own domain and its people', () => {
  it('keeps a domain that carries the facility\'s name or is filed under it, never a directory', () => {
    expect(domainFits('Edith Lane of Cincinnati', 'edithlane.com')).toBe(true);
    expect(domainFits('Arcadia Care', 'arcadiacare.com')).toBe(true);
    expect(domainFits('Valley Hospice', 'vh-care.org', 'Valley Hospice Inc')).toBe(true);
    expect(domainFits('Valley Hospice', 'acme.com', 'Acme Corp')).toBe(false);
    expect(domainFits('Valley Hospice', 'valleyhospice.wixsite.com')).toBe(false);
    expect(domainFits('Valley Hospice', 'medicare.gov')).toBe(false);
  });

  it('keeps an address only on the domain and checked', () => {
    expect(acceptedEmail(entry('jane.doe@valley.org', 'Administrator'), 'valley.org')).toBe('jane.doe@valley.org');
    expect(acceptedEmail(entry('jane.doe@gmail.com', 'Administrator'), 'valley.org')).toBeNull();
    expect(acceptedEmail(entry('jane.doe@valley.org', 'Administrator', { confidence: 70 }), 'valley.org')).toBeNull();
    expect(acceptedEmail(entry('jane.doe@valley.org', 'Administrator', { verification: { status: 'accept_all' } }), 'valley.org')).toBeNull();
    expect(acceptedEmail(entry('jane.doe@valley.org', 'Administrator', { verification: { status: 'accept_all' }, sources: [{ uri: 'x' }] }), 'valley.org')).toBe('jane.doe@valley.org');
    expect(acceptedEmail(entry('jane.doe@valley.org', 'Administrator', { verification: { status: 'invalid' } }), 'valley.org')).toBeNull();
  });

  it('writes a name in capitals as people write it', () => {
    expect(properName('MARY MCDONALD-SMITH')).toBe('Mary McDonald-Smith');
    expect(properName('jo o\'neil')).toBe('Jo O\'Neil');
    expect(properName('DeShawn Lee')).toBe('DeShawn Lee');
  });

  it('ranks a facility\'s and a head office\'s people as Pennsylvania\'s were chosen', () => {
    expect(facilityRank('Nursing Home Administrator')).toBe(2);
    expect(facilityRank('Director of Admissions')).toBe(4);
    expect(facilityRank('Director of Dietary')).toBe(Infinity);
    expect(corporateRank('Vice President of Business Development')).toBe(1);
    expect(corporateRank('Chief Marketing Officer')).toBe(0);
    expect(corporateRank('Vice President')).toBe(Infinity);
    expect(corporateRank('President')).toBe(3);
    const people = [entry('ann.one@x.org', 'Director of Nursing'), entry('bob.two@x.org', 'Executive Director'), entry('cara.three@x.org', 'Administrator')];
    expect(choosePerson(people, { domain: 'x.org' })).toMatchObject({ email: 'cara.three@x.org', rank: 2 });
    const corporate = [entry('dan.ceo@x.org', 'CEO'), entry('eve.vp@x.org', 'VP of Marketing'), entry('fay.coo@x.org', 'Chief Operating Officer')];
    expect(choosePerson(corporate, { domain: 'x.org', corporate: true })).toMatchObject({ email: 'eve.vp@x.org' });
    expect(choosePerson([entry('info@x.org', 'Administrator', { type: 'generic' })], { domain: 'x.org' })).toBeNull();
  });
});

describe('looking one facility\'s person up', () => {
  const hunter = answers => ({ configured: true, company: vi.fn(async ({ name }) => answers.company[name] ?? { result: 'not_found', charged: 0 }),
    person: vi.fn(async ({ name }) => answers.person?.[name] ?? { result: 'not_found', charged: 0 }) });

  it('takes the decider Hunter lists on the facility\'s domain', async () => {
    const h = hunter({ company: { 'Valley Hospice': { result: 'found', domain: 'valleyhospice.org', organization: 'Valley Hospice', charged: 1,
      emails: [entry('mary.smith@valleyhospice.org', 'Owner')] } } });
    const found = await findPerson({ name: 'Valley Hospice', segment: 'agency' }, { hunter: h, state: 'OH' });
    expect(found).toMatchObject({ status: 'found', email: 'mary.smith@valleyhospice.org', firstName: 'Mary', lastName: 'Smith', title: 'Owner', source: 'hunter_domain', searches: 1 });
  });

  it('looks up an owner CMS lists when nobody on the domain decides', async () => {
    const h = hunter({ company: { 'Valley Hospice': { result: 'found', domain: 'valleyhospice.org', charged: 1, emails: [entry('nurse.one@valleyhospice.org', 'RN')] } },
      person: { 'JOHN Q PUBLIC': { result: 'found', email: 'john@valleyhospice.org', charged: 1 } } });
    const found = await findPerson({ name: 'Valley Hospice', segment: 'agency', ccn: '361001' },
      { hunter: h, state: 'OH', owners: [{ name: 'JOHN Q PUBLIC', kind: 'individual', role: '5% OR GREATER DIRECT OWNERSHIP INTEREST' }] });
    expect(found).toMatchObject({ status: 'found', email: 'john@valleyhospice.org', personName: 'John Q Public', firstName: 'John', lastName: 'Public', source: 'hunter_finder', searches: 2 });
  });

  it('asks the NPI registry for a name when CMS lists no owner', async () => {
    const h = hunter({ company: { 'Edith Lane': { result: 'found', domain: 'edithlane.com', charged: 0, emails: [] } },
      person: { 'Ann Admin': { result: 'found', email: 'ann@edithlane.com', charged: 1 } } });
    const npi = { official: vi.fn(async () => ({ name: 'Ann Admin', title: 'Administrator' })) };
    const found = await findPerson({ name: 'Edith Lane', segment: 'snf', zip: '45211', city: 'Cincinnati' }, { hunter: h, npi, state: 'OH' });
    expect(found).toMatchObject({ status: 'found', email: 'ann@edithlane.com', title: 'Administrator' });
    expect(npi.official).toHaveBeenCalledWith(expect.objectContaining({ name: 'Edith Lane', state: 'OH', zip: '45211' }));
  });

  it('writes to a chain\'s head office, else its largest building\'s administrator', async () => {
    const corporate = hunter({ company: { 'Arcadia Care': { result: 'found', domain: 'arcadiacare.com', charged: 1, emails: [entry('lee.vp@arcadiacare.com', 'VP of Sales')] } } });
    expect(await findPerson({ name: 'Edith Lane', chainName: 'Arcadia Care', segment: 'chain' }, { hunter: corporate, state: 'OH' }))
      .toMatchObject({ email: 'lee.vp@arcadiacare.com' });
    const building = hunter({ company: { 'Arcadia Care': { result: 'found', domain: 'arcadiacare.com', charged: 1, emails: [entry('kim.it@arcadiacare.com', 'IT Manager')] },
      'Edith Lane': { result: 'found', domain: 'edithlane.com', charged: 1, emails: [entry('pat.adm@edithlane.com', 'Administrator')] } } });
    expect(await findPerson({ name: 'Edith Lane', chainName: 'Arcadia Care', segment: 'chain' }, { hunter: building, state: 'OH' }))
      .toMatchObject({ email: 'pat.adm@edithlane.com', searches: 2 });
  });

  it('refuses a domain that is not the facility\'s, stops at the state\'s searches and when Hunter refuses', async () => {
    const wrong = hunter({ company: { 'Valley Hospice': { result: 'found', domain: 'acme.com', organization: 'Acme', charged: 1, emails: [entry('a.b@acme.com', 'Owner')] } } });
    expect(await findPerson({ name: 'Valley Hospice', segment: 'agency' }, { hunter: wrong, state: 'OH' })).toMatchObject({ status: 'not_found', note: 'domain_mismatch' });
    const spent = hunter({ company: {} });
    expect(await findPerson({ name: 'Valley Hospice', segment: 'agency' }, { hunter: spent, state: 'OH', budget: () => 0 })).toEqual({ status: 'not_found', note: 'search_limit', searches: 0 });
    expect(spent.company).not.toHaveBeenCalled();
    const refused = hunter({ company: { 'Valley Hospice': { result: 'refused', charged: 0 } } });
    await expect(findPerson({ name: 'Valley Hospice', segment: 'agency' }, { hunter: refused, state: 'OH' })).rejects.toMatchObject({ code: 'hunter_refused' });
  });
});

describe('Hunter\'s and the NPI registry\'s requests', () => {
  it('sends the key in a header, never the URL, and counts a search only when Hunter returns an address', async () => {
    const fetchImpl = vi.fn(async () => json({ data: { domain: 'valley.org', organization: 'Valley', emails: [entry('a.b@valley.org', 'Owner')] } }));
    const answer = await hunterSearch({ apiKey: 'secret-key', fetchImpl }).company({ name: 'Valley Hospice' });
    expect(answer).toMatchObject({ result: 'found', domain: 'valley.org', charged: 1 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).not.toContain('secret-key');
    expect(init.headers['x-api-key']).toBe('secret-key');
    expect(String(url)).toContain('seniority=senior%2Cexecutive');
    const empty = await hunterSearch({ apiKey: 'k', fetchImpl: async () => json({ data: { domain: 'valley.org', emails: [] } }) }).company({ name: 'Valley' });
    expect(empty).toMatchObject({ result: 'found', charged: 0 });
    expect(await hunterSearch({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, body: null }) }).company({ name: 'Valley' })).toMatchObject({ result: 'refused' });
    expect(await hunterSearch({ apiKey: '' }).company({ name: 'Valley' })).toMatchObject({ result: 'refused' });
  });

  it('keeps the Email Finder\'s address only when checked', async () => {
    const finder = hunterSearch({ apiKey: 'k', fetchImpl: async () => json({ data: { email: 'jo@valley.org', score: 92, verification: { status: 'valid' } } }) });
    expect(await finder.person({ name: 'Jo Ann', domain: 'valley.org' })).toEqual({ result: 'found', email: 'jo@valley.org', charged: 1 });
    const weak = hunterSearch({ apiKey: 'k', fetchImpl: async () => json({ data: { email: 'jo@valley.org', score: 40, verification: { status: 'valid' } } }) });
    expect(await weak.person({ name: 'Jo Ann', domain: 'valley.org' })).toEqual({ result: 'not_found', charged: 1 });
  });

  it('takes the NPI registry\'s authorized official at the facility\'s ZIP code only', async () => {
    const fetchImpl = vi.fn(async () => json({ results: [
      { basic: { authorized_official_first_name: 'WRONG', authorized_official_last_name: 'PLACE' }, addresses: [{ address_purpose: 'LOCATION', postal_code: '100010000', city: 'NEW YORK' }] },
      { basic: { authorized_official_first_name: 'ANN', authorized_official_last_name: 'ADMIN', authorized_official_title_or_position: 'ADMINISTRATOR' },
        addresses: [{ address_purpose: 'LOCATION', postal_code: '452110000', city: 'CINCINNATI' }] }] }));
    expect(await npiOfficials({ fetchImpl }).official({ name: 'Edith Lane of Cincinnati LLC', state: 'OH', zip: '45211' })).toEqual({ name: 'ANN ADMIN', title: 'ADMINISTRATOR' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('organization_name=edith+lane+of+cincinnati*');
  });
});
