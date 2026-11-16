import { describe, expect, it } from 'vitest';
import { countyBrief, countySnapshot, figureOrders, formatFigure, placeName, settingFor, snapshotLanding, withFacts } from './data.mjs';
import { checkCopy, checkData, withoutFigure } from './compliance.mjs';

const figure = (key, value, extra = {}) => ({ key, label: key, value, unit: 'count', data_year: '2026', period: '2026-06', dataset: 'CMS Medicare Monthly Enrollment',
  source_line: 'Source: CareMetric analytics derived from public CMS data.', short_source: 'CMS Medicare Monthly Enrollment, 2026', ...extra });
const county = (figures, extra = {}) => ({ county_fips: '42003', county_name: 'Allegheny', state: 'PA', figures, ...extra });

describe('county snapshots', () => {
  it('names the place as people write it', () => {
    expect(placeName('Allegheny', 'PA')).toBe('Allegheny County, PA');
    expect(placeName('Orleans Parish', 'LA')).toBe('Orleans Parish, LA');
    expect(placeName('Capitol Planning Region', 'CT')).toBe('Capitol Planning Region, CT');
    expect(placeName('', 'PA')).toBeNull();
  });

  it('prints a figure only when it is true to the data and fits: no zeros, no decline shown as growth', () => {
    expect(formatFigure(12345.4, 'count')).toBe('12,345');
    expect(formatFigure(0.523, 'share')).toBe('52%');
    expect(formatFigure(0.081, 'growth')).toBe('+8%');
    expect(formatFigure(-0.02, 'growth')).toBeNull();
    expect(formatFigure(6.14, 'percent')).toBe('6.1%');
    expect(formatFigure(0, 'count')).toBeNull();
    expect(formatFigure(0.001, 'share')).toBeNull();
    expect(formatFigure(Number.NaN, 'count')).toBeNull();
  });

  it('takes the setting\'s figure in turn, else the next one the county has, with its label and short source', () => {
    const snapshot = countySnapshot(county([figure('beneficiaries_85_plus', 31000), figure('hospice_users', 0, { setting: 'hospice' })]), 0, 'home_health');
    expect(snapshot).toMatchObject({ setting: 'home_health', countyFips: '42003', place: 'Allegheny County, PA', figure: 'beneficiaries_85_plus', stat: '31,000',
      statLabel: 'Medicare beneficiaries aged 85+ in Allegheny County, PA', statSource: 'CMS Medicare Monthly Enrollment, 2026', dataYear: '2026', landing: snapshotLanding });
    // A turn that asks for hospice users, zero here, takes the next figure the county has.
    expect(countySnapshot(county([figure('beneficiaries_85_plus', 31000), figure('hospice_users', 0, { setting: 'hospice' })]), figureOrders.hospice.indexOf('hospice_users'), 'hospice').figure)
      .toBe('beneficiaries_85_plus');
    expect(countySnapshot(county([figure('hospice_users', 0)]), 0)).toBeNull();
    expect(countySnapshot(county([figure('beneficiaries_85_plus', 31000)], { county_fips: '4200' }), 0)).toBeNull();
  });

  it('keeps each snapshot to one care setting: its own figures and the county\'s people, never another setting\'s', () => {
    for (const setting of ['home_health', 'hospice']) {
      const other = setting === 'home_health' ? 'hospice' : 'home_health';
      expect(figureOrders[setting].some(key => key.startsWith(other === 'hospice' ? 'hospice' : 'home_health'))).toBe(false);
    }
    expect(figureOrders.home_health.slice(0, 2)).toEqual(['home_health_top3_share', 'home_health_agencies_billing']);
    expect(figureOrders.hospice.slice(0, 2)).toEqual(['hospice_top3_share', 'hospices_billing']);
    const both = county([figure('home_health_users', 4100, { setting: 'home_health' }), figure('hospice_users', 900, { setting: 'hospice' })]);
    for (let turn = 0; turn < 12; turn += 1) {
      expect(countySnapshot(both, turn, 'hospice').figure).toBe('hospice_users');
      expect(countySnapshot(both, turn, 'home_health').figure).toBe('home_health_users');
    }
    // A figure the feed tags with another setting is never shown under this one, whatever its key.
    expect(countySnapshot(county([figure('home_health_users', 4100, { setting: 'hospice' })]), 0, 'home_health')).toBeNull();
    // With nothing for its setting, the snapshot shows the other setting's figure rather than none, and says so.
    expect(countySnapshot(county([figure('hospices_billing', 6, { setting: 'hospice' })]), 0, 'home_health')).toMatchObject({ setting: 'hospice', figure: 'hospices_billing' });
  });

  it('says what the concentration and billing figures are: agencies located in the county, and agencies paid for its residents', () => {
    const erie = { county_fips: '42049', county_name: 'Erie', state: 'PA' };
    expect(countySnapshot({ ...erie, figures: [figure('home_health_top3_share', 0.614, { unit: 'fraction', setting: 'home_health' })] }, 0, 'home_health'))
      .toMatchObject({ stat: '61%', statLabel: 'of the Medicare patients of Erie County, PA home health agencies went to the 3 largest' });
    expect(countySnapshot({ ...erie, figures: [figure('hospices_billing', 14, { setting: 'hospice' })] }, 0, 'hospice'))
      .toMatchObject({ stat: '14', statLabel: 'hospices billed Medicare for Erie County, PA residents' });
    // Pennsylvania's longest county name still fits the image.
    expect(countySnapshot({ county_fips: '42097', county_name: 'Northumberland', state: 'PA', figures: [figure('home_health_top3_share', 0.5, { unit: 'fraction', setting: 'home_health' })] }, 0, 'home_health').statLabel.length)
      .toBeLessThanOrEqual(100);
  });

  it('chooses the setting a county has agencies in, else the one it was not pictured with last, else by turn', () => {
    expect(settingFor({ homeHealth: 3, hospice: 0 }, 1)).toBe('home_health');
    expect(settingFor({ homeHealth: 0, hospice: 2 }, 0)).toBe('hospice');
    expect(settingFor({ homeHealth: 3, hospice: 2, lastSetting: 'hospice' }, 1)).toBe('home_health');
    expect(settingFor({ homeHealth: 0, hospice: 0, lastSetting: 'home_health' }, 0)).toBe('hospice');
    expect([settingFor({}, 0), settingFor({}, 1)]).toEqual(['home_health', 'hospice']);
    expect(settingFor(undefined, 2)).toBe('home_health');
  });

  it('opens one brief per county and week, and draws every variant as the figure', () => {
    const snapshot = countySnapshot(county([figure('medicare_beneficiaries', 250000)]), 0);
    const brief = countyBrief(snapshot, '2026-11-16');
    expect(brief).toMatchObject({ product: 'caremetric-intel', source: 'data.county', requestKey: 'data:county:42003:2026-11-16', formats: ['static'], facts: snapshot });
    expect(brief.audience).toBe('Owners, administrators and marketers at home health agencies serving Allegheny County, PA');
    expect(brief.audience).not.toMatch(/patient|condition|diagnos/i);
    expect(brief.goal).toMatch(/free market report for their own agency/);
    expect(countyBrief({ ...snapshot, setting: 'hospice' }, '2026-11-16').angle).toMatch(/^County snapshot, hospice only:/);
    const drawn = withFacts({ layout: 'headline', headline: 'H', overlay: { stat: '99', statLabel: 'made up', statSource: '', kicker: 'k' } }, snapshot);
    expect(drawn).toMatchObject({ layout: 'stat', overlay: { stat: '250,000', statLabel: snapshot.statLabel, statSource: snapshot.statSource, kicker: 'k' } });
    expect(withFacts({ layout: 'headline' }, null)).toEqual({ layout: 'headline' });
  });
});

describe('figure checks', () => {
  const snapshot = countySnapshot(county([figure('medicare_beneficiaries', 250000)]), 0);
  const copy = extra => withFacts({ layout: 'stat', headline: 'Know your county\'s market', primaryText: 'See who lives and gets care near you.', description: '', cta: 'Get the report',
    altText: 'A county figure', overlay: {}, ...extra }, snapshot);

  it('accepts the data\'s figure with words around it, and the data\'s year', () => {
    expect(checkData({ copy: copy(), facts: snapshot })).toEqual([]);
    expect(checkData({ copy: copy({ primaryText: 'Medicare enrollment as of 2026.' }), facts: snapshot })).toEqual([]);
  });

  it('refuses a changed figure, a number the model wrote, and a figure without its source', () => {
    const changed = copy();
    changed.overlay.stat = '260,000';
    expect(checkData({ copy: changed, facts: snapshot }).map(item => item.rule)).toEqual(['data_figure']);
    expect(checkData({ copy: copy({ headline: '3 in 10 agencies miss this' }), facts: snapshot }).map(item => item.rule)).toEqual(['data_number']);
    expect(checkCopy({ product: 'caremetric-intel', platform: 'meta', copy: { layout: 'stat', headline: 'A plain headline about the work', overlay: { stat: '12', statLabel: 'things', statSource: '' } } })
      .some(item => item.rule === 'stat_source')).toBe(true);
    // The copy rules read the words around the figure, not the code-printed figure.
    expect(withoutFigure(copy()).overlay).toMatchObject({ stat: '', statLabel: '', statSource: '' });
  });
});
