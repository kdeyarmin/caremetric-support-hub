import { describe, expect, it } from 'vitest';
import { screenIdentifiers } from '../agents/concierge/screen.mjs';
import {
  chooseSite, confirmsSite, displayName, distinctiveWords, phonesIn, rankTarget, researchOnlyPrefix, resolutionQuery, rosterClaim,
  rosterRow, rosterStates,
} from './roster.mjs';

const now = new Date('2026-11-13T12:00:00Z');
const item = (extra = {}) => ({
  ccn: '391501', name: 'VALLEY HOSPICE, INC.', setting: 'hospice', city: 'Philadelphia', state: 'PA', zip: '19103', county_fips: '42101',
  control_type: 'Voluntary nonprofit, private', control_type_code: '2', certification_date: '2010-05-01', termination_date: null,
  change_of_ownership_date: null, signals: [], ...extra,
});
const target = (extra = {}) => ({ ccn: '391501', name: 'Valley Hospice, Inc.', setting: 'hospice', city: 'Philadelphia', state: 'PA', facts: {}, ...extra });
const result = (domain, title, claim, path = '/') => ({ domain, url: `https://${domain}${path}`, name: title, claim });

describe('roster rows', () => {
  it('states the public record as a dated claim, and size and market only as a research line', () => {
    const row = rosterRow(item({ change_of_ownership_date: '2026-03-01',
      volume: { data_year: '2023', medicare_patients: 220, county_fips: '42101', county_share: 0.2, county_rank: 1, county_providers: 12 },
      contact: { address: '9 Elm Road', phone: '2155550199' } }), '2026Q3', now);
    expect(row).toMatchObject({ ccn: '391501', name: 'Valley Hospice, Inc.', setting: 'hospice', state: 'PA', county_fips: '42101', excluded: false });
    expect(row.claim).toBe('CMS Provider of Services file, 2026Q3: Valley Hospice, Inc. (CCN 391501) is a Medicare-certified hospice in Philadelphia, PA; certified May 1, 2010; ownership type: Voluntary nonprofit, private; change of ownership recorded March 1, 2026.');
    expect(row.research).toBe(`${researchOnlyPrefix} CMS post-acute utilization 2023: 220 Medicare fee-for-service patients; 1st of 12 agencies located in its county by patients.`);
    expect(row.facts).toMatchObject({ phone: '2155550199', address: '9 Elm Road', patients: 220, ownershipChanged: '2026-03-01' });
    // The identifier screen that guards every model call lets both lines through.
    expect(screenIdentifiers(row.claim).flagged).toBe(false);
    expect(screenIdentifiers(row.research).flagged).toBe(false);
  });

  it('has no research line when the feed knows neither size nor quality', () => {
    expect(rosterRow(item(), '2026Q3', now).research).toBeNull();
    expect(rosterClaim(item({ name: null, city: null }), '2026Q3')).toBe('CMS Provider of Services file, 2026Q3: CCN 391501 (CCN 391501) is a Medicare-certified hospice in PA; certified May 1, 2010; ownership type: Voluntary nonprofit, private.');
  });

  it('ranks new agencies and new owners first, government and very large ones last, and excludes closed ones', () => {
    const base = rankTarget(item(), now).rank;
    expect(rankTarget(item({ certification_date: '2026-01-15' }), now)).toMatchObject({ rank: base + 25, reasons: ['Newly certified (2026-01-15)'] });
    expect(rankTarget(item({ change_of_ownership_date: '2026-03-01' }), now).rank).toBe(base + 20);
    expect(rankTarget(item({ control_type: 'Government, county' }), now).rank).toBe(base - 15);
    expect(rankTarget(item({ volume: { medicare_patients: 400, county_providers: 12 } }), now).rank).toBe(base + 15);
    expect(rankTarget(item({ volume: { medicare_patients: 9000 } }), now).rank).toBe(base - 10);
    expect(rankTarget(item({ termination_date: '2026-06-01' }), now)).toMatchObject({ excluded: true, rank: 0 });
    expect(rankTarget(item({ signals: [{ type: 'closed', detected_in: '2026Q3', date: null, detail: null }] }), now).excluded).toBe(true);
    // A termination date still ahead is not a closure yet.
    expect(rankTarget(item({ termination_date: '2027-01-01' }), now).excluded).toBe(false);
  });

  it('keeps only states the feed knows, once each', () => {
    expect(rosterStates(['pa', ' OH', 'PA', 'ZZ', 7, null])).toEqual(['PA', 'OH']);
    expect(rosterStates('PA')).toEqual([]);
  });

  it('writes CMS names as people do', () => {
    expect(displayName('ANGELS OF CARE HOME HEALTH LLC')).toBe('Angels Of Care Home Health LLC');
    expect(displayName('Valley Hospice')).toBe('Valley Hospice');
    expect(distinctiveWords('ANGELS OF CARE HOME HEALTH LLC')).toEqual(['angels']);
    expect(distinctiveWords('HOME HEALTH CARE INC')).toEqual(['home', 'health', 'care']);
  });
});

describe('finding the agency\'s own website', () => {
  it('searches its name, place and setting', () => {
    expect(resolutionQuery(target())).toBe('valley hospice Philadelphia PA');
    expect(resolutionQuery(target({ name: 'Angels Of Care LLC', setting: 'home_health' }))).toBe('angels of care Philadelphia PA home health');
  });

  it('chooses the result whose domain and title carry the agency\'s name and place', () => {
    const rows = [
      result('valleyhospice.org', 'Valley Hospice | Compassionate care in Philadelphia', 'Hospice care across Philadelphia and nearby counties.'),
      result('hospicecare.example', 'Hospice care near you', 'Find a hospice in Pennsylvania.'),
    ];
    expect(chooseSite(target(), rows)).toMatchObject({ domain: 'valleyhospice.org', inDomain: 1 });
  });

  it('chooses nothing when no result carries the name, or two different sites are as likely', () => {
    expect(chooseSite(target(), [result('hospicecare.example', 'Hospice care near you', 'Find a hospice in Pennsylvania.')])).toBeNull();
    const twins = [
      result('valleyhospice.org', 'Valley Hospice', 'Hospice care in Philadelphia.'),
      result('valleyhospicepa.com', 'Valley Hospice', 'Hospice care in Philadelphia.'),
    ];
    expect(chooseSite(target(), twins)).toBeNull();
    // A directory never counts, however well it matches.
    expect(chooseSite(target(), [result('yelp.com', 'Valley Hospice - Philadelphia', 'Valley Hospice hospice Philadelphia')])).toBeNull();
  });
});

describe('confirming the site is the agency\'s', () => {
  it('trusts the agency\'s CMS telephone number on the site most', () => {
    expect(confirmsSite(target(), { phoneSeen: true, site: null })).toBe('phone');
    expect(phonesIn('Call (215) 555-0199 or <a href="tel:+1-215-555-0123">us</a>; fax 215.555.0100')).toEqual(new Set(['2155550199', '2155550123', '2155550100']));
    expect(phonesIn('Order 12155550199123')).toEqual(new Set());
  });

  it('accepts the agency\'s name and place on its home page', () => {
    const found = { phoneSeen: false, site: { url: 'https://valleyhospice.org/', claim: "The organization's own home page. Title: Valley Hospice. Opening text: Serving Philadelphia families since 2010." } };
    expect(confirmsSite(target(), found)).toBe('name');
  });

  it('refuses a page about some other organization, or no page at all', () => {
    const other = { phoneSeen: false, site: { url: 'https://valleyhospice.org/', claim: "The organization's own home page. Title: Valley Plumbing. Opening text: Drains in Ohio." } };
    expect(confirmsSite(target(), other)).toBeNull();
    expect(confirmsSite(target(), { email: null })).toBeNull();
  });
});
