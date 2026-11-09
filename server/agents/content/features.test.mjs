import { describe, expect, it } from 'vitest';
import { segments } from '../creative/copy.mjs';
import { careSettingText, featuresText, focusFor, productFeatures } from './features.mjs';
import { products } from './facts.mjs';
import { textProblems } from './validate.mjs';

const intel = productFeatures['caremetric-intel'];

describe('CareMetric Intel\'s published feature catalog', () => {
  it('holds every feature Intel publishes, by area, with why each part matters and the data behind it', () => {
    const total = intel.areas.reduce((sum, area) => sum + area.features.length, 0);
    expect(total).toBe(intel.publishedCount);
    expect(total).toBeGreaterThanOrEqual(90);
    expect(intel.areas.map(area => area.name)).toEqual(expect.arrayContaining(['Healthcare marketing CRM', 'Daily field work', 'Expenses, mileage and reimbursement',
      'Referral and admission tracking', 'Prospecting and targeting', 'Market and territory research', 'Competitor intelligence', 'Manager and team tools']));
    expect(intel.areas.every(area => area.intro && area.features.every(feature => feature.name && feature.does))).toBe(true);
    expect(intel.pillars).toHaveLength(9);
    expect(intel.pillars.every(pillar => pillar.title && pillar.why && pillar.area)).toBe(true);
    expect(intel.data.map(family => family.family)).toEqual(['Providers', 'Facilities', 'Territories', 'Utilization & quality', 'Your results']);
    expect(intel.data.every(family => family.includes.length && family.source && family.question && family.decision && family.limit)).toBe(true);
    expect(intel.sources.features).toBe('https://www.caremetricintel.com/features');
    expect(intel.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('describes every care setting the fact sheet names, in the site\'s words', () => {
    const settings = intel.settings.map(setting => setting.name.toLowerCase());
    expect(settings).toEqual(segments['caremetric-intel']);
    for (const setting of settings) expect(products.intel.forWhom.toLowerCase()).toContain(setting);
    expect(careSettingText('caremetric-intel', 'hospitals')).toContain('hospital and post-acute utilization');
    expect(careSettingText('caremetric-intel', 'dental offices')).toBeNull();
    expect(careSettingText('carebase', 'hospitals')).toBeNull();
  });

  it('names no other product and keeps the team\'s vocabulary, so the team can repeat it', () => {
    const text = featuresText('caremetric-intel');
    for (const name of ['HCHB', 'Homecare Homebase', 'WellSky', 'Axxess', 'MatrixCare', 'Trella', 'Definitive Healthcare']) expect(text).not.toContain(name);
    expect(intel.edits.length).toBeGreaterThan(0);
    const problems = textProblems(text, { product: 'intel' });
    expect(problems).not.toContain('competitor_named');
    expect(problems).not.toContain('vocabulary');
    // The prompt carries the features, the data and its sources, and the site's own caveats.
    for (const phrase of ['Stark annual limit tracking', 'Competitor rankings', 'EMR report imports', 'County intelligence', 'NPPES', 'Care Compare', 'American Community Survey',
      'not a promise of referrals', 'The 14-day free trial includes everything Pro does, in one county.']) expect(text).toContain(phrase);
    expect(featuresText('carebase')).toBe('');
  });

  it('leads a planned brief with the part of Intel its text is about, else the next in turn, never twice in one plan', () => {
    expect(focusFor('caremetric-intel', 'Log the lunch against the Stark limit', 0).title).toBe('Spend with compliance in view');
    expect(focusFor('caremetric-intel', 'Which competitors gained market share?', 0).title).toBe('Know the competition');
    expect(focusFor('caremetric-intel', 'Referrals and admissions by source', 0).title).toBe('Connect effort to outcomes');
    const titles = intel.pillars.map(pillar => pillar.title);
    expect([0, 1, 2].map(turn => focusFor('caremetric-intel', 'A tip for the week', turn).title)).toEqual(titles.slice(0, 3));
    expect(focusFor('caremetric-intel', 'A tip for the week', 0, new Set([titles[0]])).title).toBe(titles[1]);
    expect(focusFor('caremetric-intel', 'Log the lunch against the Stark limit', 0, new Set(['Spend with compliance in view'])).title).toBe(titles[0]);
    expect(focusFor('carebase', 'anything', 0)).toBeNull();
  });
});
