import { describe, expect, it } from 'vitest';
import { countyBrief, countySnapshot, figureOrder, formatFigure, placeName, withFacts } from './data.mjs';
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

  it('takes the week\'s figure in turn, else the next one the county has, with its label and short source', () => {
    const snapshot = countySnapshot(county([figure('beneficiaries_85_plus', 31000), figure('hospice_users', 0)]), 0);
    expect(snapshot).toMatchObject({ countyFips: '42003', place: 'Allegheny County, PA', figure: 'beneficiaries_85_plus', stat: '31,000',
      statLabel: 'Medicare beneficiaries aged 85+ in Allegheny County, PA', statSource: 'CMS Medicare Monthly Enrollment, 2026', dataYear: '2026' });
    // Turn 2 asks for hospice users, which is zero here: the next figure the county has in turn is used.
    expect(countySnapshot(county([figure('beneficiaries_85_plus', 31000), figure('hospice_users', 0)]), figureOrder.indexOf('hospice_users')).figure).toBe('beneficiaries_85_plus');
    expect(countySnapshot(county([figure('hospice_users', 0)]), 0)).toBeNull();
    expect(countySnapshot(county([figure('beneficiaries_85_plus', 31000)], { county_fips: '4200' }), 0)).toBeNull();
  });

  it('opens one brief per county and week, and draws every variant as the figure', () => {
    const snapshot = countySnapshot(county([figure('medicare_beneficiaries', 250000)]), 0);
    const brief = countyBrief(snapshot, '2026-11-16');
    expect(brief).toMatchObject({ product: 'caremetric-intel', source: 'data.county', requestKey: 'data:county:42003:2026-11-16', formats: ['static'], facts: snapshot });
    expect(brief.audience).not.toMatch(/patient|condition|diagnos/i);
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
