import { describe, expect, it, vi } from 'vitest';
import { agencyOfficials, npiRegistry, personCase, sameName } from './npi-registry.mjs';

const record = ({ number = '1578017406', name = 'VALLEY HOSPICE, INC', phone = '717-555-0100', state = 'PA', first = 'JANE', last = 'DOE', title = 'Administrator', other = [], status = 'A' } = {}) => ({
  number, enumeration_type: 'NPI-2', other_names: other.map(organization_name => ({ organization_name })),
  basic: { organization_name: name, status, authorized_official_first_name: first, authorized_official_last_name: last, authorized_official_middle_name: 'A',
    authorized_official_title_or_position: title, authorized_official_telephone_number: '7175550199' },
  addresses: [{ address_purpose: 'MAILING', state: 'TX', telephone_number: '555-555-5555' }, { address_purpose: 'LOCATION', state, telephone_number: phone, postal_code: '171101123' }],
});
const agency = { name: 'Valley Hospice', city: 'Harrisburg', state: 'PA', zip: '17110', phone: '7175550100', setting: 'hospice' };

describe('NPI registry officials', () => {
  it('matches names by their distinctive words', () => {
    expect(sameName('VALLEY HOSPICE, INC', 'Valley Hospice')).toBe(true);
    expect(sameName('Hospice of Central Pennsylvania', 'Central Pennsylvania Hospice')).toBe(true);
    expect(sameName('Sunrise Home Health', 'Home Health')).toBe(false);
    expect(sameName('Valley Hospice', 'Mountain Hospice')).toBe(false);
    expect(personCase("MARY O'NEIL-SMITH")).toBe("Mary O'Neil-Smith");
  });

  it('keeps the official of the record that is the agency\'s, by its CMS telephone number or its name, and never a telephone number', () => {
    const officials = agencyOfficials([
      record(),
      record({ number: '1111111111', name: 'OTHER CARE LLC', phone: '7175550100', first: 'SAM', last: 'LEE', title: 'Owner' }),
      record({ number: '2222222222', name: 'UNRELATED HOME HEALTH', phone: '7175550000', first: 'PAT', last: 'KIM' }),
      record({ number: '3333333333', name: 'VALLEY HOSPICE', state: 'OH', first: 'OHIO', last: 'PERSON' }),
      record({ number: '4444444444', name: 'HOLDINGS LLC', phone: '7175559999', other: ['Valley Hospice'], first: 'RAY', last: 'DBA' }),
      record({ number: '5555555555', status: 'D', first: 'GONE', last: 'AWAY' }),
    ], agency);
    expect(officials).toEqual([
      { name: 'Jane A Doe', title: 'Administrator', source: 'npi_registry', sourceUrl: 'https://npiregistry.cms.hhs.gov/provider-view/1578017406' },
      { name: 'Sam A Lee', title: 'Owner', source: 'npi_registry', sourceUrl: 'https://npiregistry.cms.hhs.gov/provider-view/1111111111' },
      { name: 'Ray A Dba', title: 'Administrator', source: 'npi_registry', sourceUrl: 'https://npiregistry.cms.hhs.gov/provider-view/4444444444' },
    ]);
    expect(JSON.stringify(officials)).not.toMatch(/555/);
  });

  it('takes a record by any number the agency\'s own website publishes, for an agency placed by its site', () => {
    const placed = { name: 'Valley Hospice LLC', city: 'Harrisburg', state: 'PA', zip: '17110', phones: ['7175550111', '717-555-0100'], setting: 'hospice' };
    expect(agencyOfficials([record({ name: 'RIVER CARE INC', first: 'SAM', last: 'LEE' })], placed).map(person => person.name)).toEqual(['Sam A Lee']);
    expect(agencyOfficials([record({ name: 'RIVER CARE INC', phone: '7175550999', first: 'SAM', last: 'LEE' })], placed)).toEqual([]);
    expect(agencyOfficials([record({ phone: '7175550999' })], placed).map(person => person.name)).toEqual(['Jane A Doe']);
    expect(agencyOfficials([record({ name: 'RIVER CARE INC' })], { ...placed, phones: [] })).toEqual([]);
  });

  it('searches organizations at the agency\'s ZIP code for its kind of care, at one fixed address', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result_count: 1, results: [record()] })));
    expect(await npiRegistry({ fetchImpl }).officials(agency)).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://npiregistry.cms.hhs.gov/api/');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ version: '2.1', enumeration_type: 'NPI-2', taxonomy_description: 'Hospice', limit: '200', postal_code: '17110' });
    expect(init.redirect).toBe('error');
    await npiRegistry({ fetchImpl }).officials({ ...agency, zip: null, setting: 'home_health' });
    expect(Object.fromEntries(new URL(fetchImpl.mock.calls[1][0]).searchParams)).toMatchObject({ taxonomy_description: 'Home Health', city: 'Harrisburg', state: 'PA' });
  });

  it('asks nothing without a place, reads registry errors as none, and fails with a code', async () => {
    const unused = vi.fn();
    expect(await npiRegistry({ fetchImpl: unused }).officials({ name: 'Valley Hospice', state: 'PA' })).toEqual([]);
    expect(unused).not.toHaveBeenCalled();
    expect(await npiRegistry({ fetchImpl: async () => new Response(JSON.stringify({ Errors: [{ description: 'No valid search criteria' }] })) }).officials(agency)).toEqual([]);
    await expect(npiRegistry({ fetchImpl: async () => new Response('busy', { status: 503 }) }).officials(agency)).rejects.toMatchObject({ code: 'npi_unavailable', transient: true });
  });
});
