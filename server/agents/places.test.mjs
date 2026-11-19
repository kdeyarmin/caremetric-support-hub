import { describe, expect, it } from 'vitest';
import { countyPlace, placeName, slugWords } from './places.mjs';

// One real name of each form Intel's geography uses (the Census names of the 3,235 geographies, by state).
const names = [
  ['Allegheny County', 'PA', 'Allegheny County, PA'],
  ['Charles City County', 'VA', 'Charles City County, VA'],
  ['Richmond County', 'VA', 'Richmond County, VA'],
  ['Richmond city', 'VA', 'Richmond City, VA'],
  ['Alexandria city', 'VA', 'Alexandria City, VA'],
  ['St. Louis city', 'MO', 'St. Louis City, MO'],
  ['Baltimore city', 'MD', 'Baltimore City, MD'],
  ['Carson City', 'NV', 'Carson City, NV'],
  ['Orleans Parish', 'LA', 'Orleans Parish, LA'],
  ['Juneau City and Borough', 'AK', 'Juneau City and Borough, AK'],
  ['Yukon-Koyukuk Census Area', 'AK', 'Yukon-Koyukuk Census Area, AK'],
  ['Anchorage Municipality', 'AK', 'Anchorage Municipality, AK'],
  ['Fairbanks North Star Borough', 'AK', 'Fairbanks North Star Borough, AK'],
  ['Lower Connecticut River Valley Planning Region', 'CT', 'Lower Connecticut River Valley Planning Region, CT'],
  ['Doña Ana County', 'NM', 'Doña Ana County, NM'],
  ['Adjuntas Municipio', 'PR', 'Adjuntas Municipio, PR'],
  ['Mayagüez Municipio', 'PR', 'Mayagüez Municipio, PR'],
  ['District of Columbia', 'DC', 'Washington, DC'],
  ['Guam', 'GU', 'Guam, GU'],
  ['Eastern District', 'AS', 'Eastern District, AS'],
  ['St. Croix Island', 'VI', 'St. Croix Island, VI'],
];

describe('countyPlace and placeName', () => {
  it.each(names)('writes %s (%s) as %s', (name, state, written) => {
    expect(placeName(name, state)).toBe(written);
  });

  it('never adds County to a name that has its own word, or none', () => {
    for (const [name, state] of names.filter(([name]) => !/County/.test(name))) expect(placeName(name, state), name).not.toContain('County');
  });

  it('keeps a Virginia independent city apart from the county of the same name', () => {
    expect(placeName('Richmond city', 'VA')).not.toBe(placeName('Richmond County', 'VA'));
    expect(placeName('Franklin city', 'VA')).toBe('Franklin City, VA');
    expect(placeName('Franklin County', 'VA')).toBe('Franklin County, VA');
    expect(slugWords(countyPlace('Richmond city', 'VA').label)).toBe('richmond-city');
    expect(slugWords(countyPlace('Richmond County', 'VA').label)).toBe('richmond-county');
  });

  it("gives a bare name its state's word", () => {
    expect(placeName('Allegheny', 'PA')).toBe('Allegheny County, PA');
    expect(placeName('Orleans', 'LA')).toBe('Orleans Parish, LA');
    expect(placeName('Capitol', 'CT')).toBe('Capitol Planning Region, CT');
    expect(placeName('Adjuntas', 'PR')).toBe('Adjuntas Municipio, PR');
  });

  it('returns the pieces: the name, the word and both together', () => {
    expect(countyPlace('Doña Ana County', 'NM')).toEqual({ base: 'Doña Ana', kind: 'County', label: 'Doña Ana County' });
    expect(countyPlace('Richmond city', 'VA')).toEqual({ base: 'Richmond', kind: 'City', label: 'Richmond City' });
    expect(countyPlace('District of Columbia', 'DC')).toEqual({ base: 'Washington', kind: null, label: 'Washington' });
    expect(countyPlace('yukon-koyukuk census area', 'AK')).toMatchObject({ kind: 'Census Area', label: 'yukon-koyukuk Census Area' });
  });

  it('reads a curly apostrophe, keeps accents and drops anything else', () => {
    expect(countyPlace('Manu’a District', 'AS').label).toBe("Manu'a District");
    expect(countyPlace('Doña <b>Ana</b> County 3', 'NM').label).toBe('Doña bAnab County');
    expect(countyPlace('  Prince   George’s  County ', 'MD').label).toBe("Prince George's County");
  });

  it('refuses a missing name, one that is only a word, and a missing or malformed state in placeName', () => {
    for (const name of ['', '   ', null, undefined, '12345', 'County']) expect(countyPlace(name, 'PA'), String(name)).toBeNull();
    expect(placeName('Allegheny County', undefined)).toBeNull();
    expect(placeName('Allegheny County', 'pa')).toBeNull();
    expect(placeName('Allegheny County', 'PENN')).toBeNull();
  });
});

describe('slugWords', () => {
  it('folds accents to their letters and joins words with hyphens', () => {
    expect(slugWords('Doña Ana County')).toBe('dona-ana-county');
    expect(slugWords('Mayagüez Municipio')).toBe('mayaguez-municipio');
    expect(slugWords("Prince George's County")).toBe('prince-george-s-county');
    expect(slugWords('St. Louis City')).toBe('st-louis-city');
    expect(slugWords('')).toBe('');
  });
});
