import { describe, expect, it } from 'vitest';
import { screenIdentifiers } from '../agents/concierge/screen.mjs';
import {
  chooseSite, confirmsSite, displayName, distinctiveWords, phonesIn, pressureFacts, pressureWeights, rankTarget, researchOnlyPrefix, resolutionQuery, rosterClaim,
  rosterRow, rosterStates, statesNamed,
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

  it('ranks agencies under pressure first and the county leader last (owner decision 2026-11-17)', () => {
    const w = pressureWeights;
    const base = rankTarget(item(), now).rank;
    // A small share of a crowded county: + the competitive county's 5 and the small share's weight.
    expect(rankTarget(item({ volume: { county_share: 0.03, county_rank: 9, county_providers: 14 } }), now))
      .toMatchObject({ rank: base + 5 + w.smallShare, reasons: ['Competitive county', 'Small share of a crowded county'] });
    // A small share where few agencies compete is no sign of pressure.
    expect(rankTarget(item({ volume: { county_share: 0.03, county_rank: 4, county_providers: 6 } }), now).rank).toBe(base);
    // The county leader comes last, but not the only agency in its county.
    expect(rankTarget(item({ volume: { county_share: 0.4, county_rank: 1, county_providers: 6 } }), now))
      .toMatchObject({ rank: base + w.countyLeader, reasons: ['Leads its county'] });
    expect(rankTarget(item({ volume: { county_share: 1, county_rank: 1, county_providers: 1 } }), now).rank).toBe(base);
    // A Medicare pay cut under HHVBP, and a deeper one.
    expect(rankTarget(item(), now, { hhvbpAdjustmentPct: -0.8 })).toMatchObject({ rank: base + w.hhvbpCut, reasons: ['Medicare pay cut (HHVBP)'] });
    expect(rankTarget(item(), now, { hhvbpAdjustmentPct: -3.2 })).toMatchObject({ rank: base + w.hhvbpDeepCut, reasons: ['Medicare pay cut of 2% or more (HHVBP)'] });
    expect(rankTarget(item(), now, { hhvbpAdjustmentPct: 1.5 }).rank).toBe(base);
    // Stars: low ones up, the top rating a little down; the middle changes nothing.
    expect(rankTarget(item({ quality: { care_star_rating: 2.5, data_year: '2026' } }), now)).toMatchObject({ rank: base + w.lowStars, reasons: ['Low quality star rating'] });
    expect(rankTarget(item({ quality: { care_star_rating: 5, data_year: '2026' } }), now)).toMatchObject({ rank: base + w.topStars, reasons: ['Top quality star rating'] });
    expect(rankTarget(item({ quality: { care_star_rating: 3.5, data_year: '2026' } }), now).rank).toBe(base);
    // A low Hospice Care Index.
    expect(rankTarget(item(), now, { hospiceCareIndex: 6 })).toMatchObject({ rank: base + w.lowCareIndex, reasons: ['Low Hospice Care Index'] });
    expect(rankTarget(item(), now, { hospiceCareIndex: 9 }).rank).toBe(base);
  });

  it('puts an agency under pressure ahead of its county leader with otherwise the same record, and never above a new owner', () => {
    const volume = { medicare_patients: 400, county_providers: 14 };
    const pressed = rankTarget(item({ volume: { ...volume, county_share: 0.03, county_rank: 11 } }), now, { hhvbpAdjustmentPct: -2.5 });
    const leader = rankTarget(item({ volume: { ...volume, county_share: 0.35, county_rank: 1 } }), now, { hhvbpAdjustmentPct: 1.1 });
    expect(pressed.rank).toBeGreaterThan(leader.rank);
    expect(pressed.rank - leader.rank).toBe(pressureWeights.smallShare + pressureWeights.hhvbpDeepCut - pressureWeights.countyLeader);
    // Each pressure weight stays below a new owner's 20, so a change of ownership still leads among otherwise equal agencies.
    for (const [key, weight] of Object.entries(pressureWeights)) if (!/Below|AtMost|AtLeast|Among|crowded/.test(key)) expect(Math.abs(weight)).toBeLessThan(20);
    // The clamp holds with every term at once.
    expect(rankTarget(item({ certification_date: '2026-01-15', change_of_ownership_date: '2026-03-01', control_type: 'Proprietary',
      quality: { care_star_rating: 1.5, data_year: '2026' }, volume: { ...volume, county_share: 0.01, county_rank: 12 } }), now,
      { hhvbpAdjustmentPct: -5, hospiceCareIndex: 3 }).rank).toBe(100);
  });

  it('keeps the new figures as research facts only, never in the claim or the research line', () => {
    const row = rosterRow(item({ volume: { data_year: '2024', medicare_patients: 300, county_fips: '42101', county_share: 0.031, county_rank: 9,
      county_providers: 14, state_share: 0.004, state_rank: 120, state_providers: 410 } }), '2026Q3', now,
      { ccn: '391501', owners: [], hhvbp: { totalPerformanceScore: 41.2, paymentAdjustmentPct: -1.4, paymentYear: 2026 }, hospice_care_index: { score: 6, period: '2023' } });
    expect(row.facts).toMatchObject({ countyShare: 0.031, stateShare: 0.004, stateRank: 120, stateProviders: 410, hhvbpAdjustmentPct: -1.4,
      hhvbpPaymentYear: '2026', hospiceCareIndex: 6 });
    expect(row.reasons).toEqual(expect.arrayContaining(['Small share of a crowded county', 'Medicare pay cut (HHVBP)', 'Low Hospice Care Index']));
    for (const text of [row.claim, row.research]) expect(text).not.toMatch(/HHVBP|Care Index|share|0\.031|-1\.4|120th/i);
    expect(JSON.stringify(row.facts).length).toBeLessThan(4000);
    // Malformed or missing facts add nothing.
    expect(pressureFacts(null)).toEqual({});
    expect(pressureFacts({ hhvbp: { paymentAdjustmentPct: 'x' }, hospice_care_index: { score: 42 } })).toEqual({});
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

  it('reads a state in full or before a ZIP code, never a bare code that is also a word', () => {
    const page = text => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
    expect(statesNamed(page('Care in West Virginia, OH 43215.'))).toEqual(new Set(['WV', 'OH']));
    expect(statesNamed(page('West Virginia and West Virginia again'))).toEqual(new Set(['WV']));
    expect(statesNamed(page('Come in or call me, oh hi, ok?'))).toEqual(new Set());
    expect(statesNamed(page('9 Elm Road, Philadelphia, PA 19103-1234'))).toEqual(new Set(['PA']));
  });

  it('needs the agency\'s place on the domain path too, and never takes a page that places it in another state', () => {
    const page = claim => ({ phoneSeen: false, site: { url: 'https://valleyhospice.org/', claim } });
    const inDomain = { inDomain: 1 };
    // The domain carries the name and the page says hospice, but nothing places it: a same-named hospice elsewhere could match.
    expect(confirmsSite(target(), page('Title: Valley Hospice. Opening text: Compassionate hospice care.'), inDomain)).toBeNull();
    expect(confirmsSite(target(), page('Title: Valley Hospice. Opening text: Hospice care across Pennsylvania.'), inDomain)).toBe('name');
    // The city alone, on a page that names another state, is another town of that name.
    const columbus = target({ city: 'Columbus', state: 'GA' });
    expect(confirmsSite(columbus, page('Title: Valley Hospice. Opening text: Hospice care in Columbus, Ohio.'))).toBeNull();
    expect(confirmsSite(columbus, page('Title: Valley Hospice. Opening text: Hospice care in Columbus.'))).toBe('name');
    expect(confirmsSite(columbus, page('Title: Valley Hospice. Opening text: Hospice care in Columbus, Georgia and Phenix City, Alabama.'))).toBe('name');
    // A bare state code that is an ordinary word places nothing ("in" is not Indiana).
    expect(confirmsSite(target({ city: 'Muncie', state: 'IN' }), page('Title: Valley Hospice. Opening text: Hospice care in your home.'))).toBeNull();
    // A town named for a state is the agency's city, not another state.
    expect(confirmsSite(target({ city: 'Washington', state: 'PA' }), page('Title: Valley Hospice. Opening text: Hospice care in Washington.'))).toBe('name');
  });

  it('refuses a page about some other organization, or no page at all', () => {
    const other = { phoneSeen: false, site: { url: 'https://valleyhospice.org/', claim: "The organization's own home page. Title: Valley Plumbing. Opening text: Drains in Ohio." } };
    expect(confirmsSite(target(), other)).toBeNull();
    expect(confirmsSite(target(), { email: null })).toBeNull();
  });
});

describe("CareMetric's own agency", () => {
  it('is never a prospect', async () => {
    const { rankTarget, ownAgencies } = await import('./roster.mjs');
    expect(ownAgencies.has('398009')).toBe(true);
    expect(rankTarget({ ccn: '398009', state: 'PA', name: 'PENN HOME HEALTH, INC', setting: 'home_health' })).toMatchObject({ excluded: true, rank: 0 });
  });
});
