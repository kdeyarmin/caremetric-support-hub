import { describe, expect, it } from 'vitest';
import { countyIndex, countyWord, launchTargets } from './segment.mjs';
import { nursingHomeRow } from './cms.mjs';

const home = (ccn, extra = {}) => ({ ccn, setting: 'nursing_home', name: `Home ${ccn}`, city: 'Akron', zip: '44301', county: 'Summit', ownership: 'For profit - Corporation',
  beds: 100, inHospital: false, chainId: null, chainName: null, chainSize: null, ...extra });
const agency = (ccn, extra = {}) => ({ ccn, name: `Agency ${ccn}`, setting: 'home_health', city: 'Akron', state: 'OH', zip: '44301', county_fips: '39153',
  control_type: 'Proprietary', termination_date: null, signals: [], volume: { medicare_patients: 50 }, ...extra });
const counties = [{ county_fips: '39153', county_name: 'Summit County', state: 'OH' }, { county_fips: '42021', county_name: 'Cambria County', state: 'PA' },
  { county_fips: '42013', county_name: 'Blair County', state: 'PA' }];
const byCcn = rows => Object.fromEntries(rows.map(row => [row.ccn, row]));

describe('which campaign each facility belongs in', () => {
  it('reads CMS\'s nursing home rows', () => {
    const row = nursingHomeRow({ cms_certification_number_ccn: '365005', provider_name: 'EDITH LANE OF CINCINNATI', citytown: 'CINCINNATI', state: 'OH',
      zip_code: '45211', countyparish: 'Hamilton', ownership_type: 'For profit - Corporation', number_of_certified_beds: '167',
      provider_resides_in_hospital: 'N', chain_name: 'ARCADIA CARE', chain_id: '42', number_of_facilities_in_chain: '25' }, 'OH');
    expect(row).toMatchObject({ ccn: '365005', name: 'Edith Lane Of Cincinnati', city: 'Cincinnati', beds: 167, chainName: 'Arcadia Care', chainSize: 25, inHospital: false });
    expect(nursingHomeRow({ cms_certification_number_ccn: '365005', provider_name: 'X', state: 'PA' }, 'OH')).toBeNull();
    expect(nursingHomeRow({ provider_name: 'No CCN', state: 'OH' }, 'OH')).toBeNull();
  });

  it('writes each county as the copy does and finds its FIPS code', () => {
    expect(countyWord('Summit County')).toBe('Summit');
    expect(countyWord('Orleans Parish')).toBe('Orleans');
    const index = countyIndex(counties);
    expect(index.fips('summit')).toBe('39153');
    expect(index.fips('Summit County')).toBe('39153');
    expect(index.name('39153')).toBe('Summit');
  });

  it('sorts nursing homes: hospitals and governments out, local ones local, one email per chain and per group', () => {
    const rows = byCcn(launchTargets({ counties, nursingHomes: [
      home('360001', { inHospital: true }),
      home('360002', { ownership: 'Government - County' }),
      home('360003', { chainId: '7', chainName: 'Big Chain', chainSize: 40, beds: 80 }),
      home('360004', { chainId: '7', chainName: 'Big Chain', chainSize: 40, beds: 200 }),
      home('360005', { chainId: '9', chainName: 'Small Group', chainSize: 3 }),
      home('360006', { chainId: '9', chainName: 'Small Group', chainSize: 3, beds: 50 }),
      home('360007'),
      home('390001', { county: 'Blair', chainId: '7', chainName: 'Big Chain', chainSize: 40, beds: 500 }),
    ] }));
    expect(rows['360001']).toMatchObject({ hold: 'hospital_based' });
    expect(rows['360002']).toMatchObject({ hold: 'government' });
    // The chain's largest building outside the owner's local counties represents it.
    expect(rows['360004']).toMatchObject({ segment: 'chain', hold: null, chainName: 'Big Chain', countyFips: '39153', county: 'Summit' });
    expect(rows['360003']).toMatchObject({ segment: 'chain', hold: 'same_chain' });
    expect(rows['360005']).toMatchObject({ segment: 'regional', hold: null });
    expect(rows['360006']).toMatchObject({ segment: 'regional', hold: 'same_group' });
    expect(rows['360007']).toMatchObject({ segment: 'snf', hold: null, size: 100 });
    // A building in a local county gets the local email, whatever chain runs it.
    expect(rows['390001']).toMatchObject({ segment: 'local', hold: null, countyFips: '42013' });
  });

  it('sorts agencies: closed and his own unlisted, his home county, national chains, governments and repeated names out', () => {
    const rows = launchTargets({ counties, now: new Date('2026-11-28T00:00:00Z'), agencies: [
      agency('361001', { name: 'Valley Home Health', volume: { medicare_patients: 30 } }),
      agency('361002', { name: 'Valley Home Health', setting: 'hospice', volume: { medicare_patients: 90 } }),
      agency('361003', { name: 'BAYADA Home Health Care' }),
      agency('361004', { control_type: 'Government - State/County' }),
      agency('421005', { county_fips: '42021' }),
      agency('361006', { termination_date: '2026-01-01' }),
      agency('398009'),
      agency('361007', { name: 'Comfort Hospice', setting: 'hospice' }),
    ] });
    const by = byCcn(rows);
    expect(by['361002']).toMatchObject({ segment: 'agency', hold: null, setting: 'hospice', county: 'Summit', size: 90 });
    expect(by['361001']).toMatchObject({ hold: 'same_name' });
    expect(by['361003']).toMatchObject({ hold: 'national_chain' });
    expect(by['361004']).toMatchObject({ hold: 'government' });
    expect(by['421005']).toMatchObject({ hold: 'home_area' });
    expect(by['361007']).toMatchObject({ hold: null, setting: 'hospice' });
    expect(by['361006']).toBeUndefined();
    expect(by['398009']).toBeUndefined();
  });
});
