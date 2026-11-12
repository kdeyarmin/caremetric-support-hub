import { describe, expect, it } from 'vitest';
import { segments } from '../creative/copy.mjs';
import { careSettingText, catalogBlocks, catalogGuidance, featuresText, focusFor, productFeatures } from './features.mjs';
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
    expect(featuresText('intel')).toBe(text);
    expect(featuresText('advisors')).toBe('');
  });

  it('leads a planned brief with the part of Intel its text is about, else the next in turn, never twice in one plan', () => {
    expect(focusFor('caremetric-intel', 'Log the lunch against the Stark limit', 0).title).toBe('Spend with compliance in view');
    expect(focusFor('caremetric-intel', 'Which competitors gained market share?', 0).title).toBe('Know the competition');
    expect(focusFor('caremetric-intel', 'Referrals and admissions by source', 0).title).toBe('Connect effort to outcomes');
    const titles = intel.pillars.map(pillar => pillar.title);
    expect([0, 1, 2].map(turn => focusFor('caremetric-intel', 'A tip for the week', turn).title)).toEqual(titles.slice(0, 3));
    expect(focusFor('caremetric-intel', 'A tip for the week', 0, new Set([titles[0]])).title).toBe(titles[1]);
    expect(focusFor('caremetric-intel', 'Log the lunch against the Stark limit', 0, new Set(['Spend with compliance in view'])).title).toBe(titles[0]);
    expect(focusFor('advisors', 'anything', 0)).toBeNull();
  });

  it('never leads a brief with email campaigns, even when the plan names them (owner direction 2026-11-12)', () => {
    const email = intel.pillars.find(pillar => /email campaigns/i.test(pillar.area));
    expect(email).toBeTruthy();
    expect(focusFor('caremetric-intel', 'Send an email campaign to your referral sources', 0).title).not.toBe(email.title);
    const led = new Set(Array.from({ length: intel.pillars.length * 2 }, (_, turn) => focusFor('caremetric-intel', 'A tip for the week', turn).title));
    expect(led.has(email.title)).toBe(false);
    expect(led.size).toBe(intel.pillars.length - 1);
    // Even with every other part used this week, the next brief does not fall back to email.
    const others = new Set(intel.pillars.filter(pillar => pillar !== email).map(pillar => pillar.title));
    expect(focusFor('caremetric-intel', 'A tip for the week', 3, others).title).not.toBe(email.title);
  });

  it('tells every catalog prompt that one feature never stands for the product', () => {
    expect(catalogGuidance).toMatch(/Never let one feature stand for the whole product/);
    expect(catalogGuidance).toMatch(/email campaigns are one feature on two plans, never the point of the product/);
  });
});

const carebase = productFeatures.carebase;

describe('CareMetric CareBase\'s published capabilities', () => {
  it('holds every capability by module, why it matters, the newest tools, the lifecycle, the roles and the chapters', () => {
    const total = carebase.modules.reduce((sum, module) => sum + module.capabilities.length, 0);
    expect(total).toBe(carebase.publishedCount);
    expect(carebase.modules.every(module => module.capabilities.length === module.count)).toBe(true);
    expect(carebase.modules.map(module => module.name)).toEqual(expect.arrayContaining(['Training & compliance core', 'Resident care, clinical & operations', 'Survey, safety & facility', 'Credentials & workforce']));
    expect(carebase.pillars.map(pillar => pillar.title)).toEqual(expect.arrayContaining(['Prepare for your next survey', 'Spend less on required education', 'Spend less time chasing records', 'Medication authorization roster']));
    expect(carebase.newest.map(item => item.name)).toEqual(expect.arrayContaining(['Survey Day Mode']));
    expect(carebase.lifecycle.length).toBeGreaterThanOrEqual(5);
    expect(carebase.roles.map(item => item.role)).toEqual(expect.arrayContaining(['Facility manager', 'Trainer', 'Employee', 'Surveyor']));
    expect(carebase.chapters.map(item => item.chapter)).toEqual(['55 Pa. Code Chapter 2600', '55 Pa. Code Chapter 2800']);
    expect(carebase.faq.length).toBeGreaterThanOrEqual(20);
    expect(carebase.faq.some(item => /how much does it cost/i.test(item.question))).toBe(false);
  });

  it('offers no demo or sales call, names no other product, keeps the vocabulary and the site\'s own caveats', () => {
    const text = featuresText('carebase');
    expect(text).not.toMatch(/\bdemo\b|sales call/i);
    const problems = textProblems(text, { product: 'carebase' });
    for (const code of ['competitor_named', 'vocabulary', 'call_offer']) expect(problems).not.toContain(code);
    for (const phrase of ['Survey Day Mode', 'Medication authorization roster', 'not a prediction of survey results', 'What each role sees and does', '55 Pa. Code Chapter 2800']) expect(text).toContain(phrase);
    expect(carebase.edits.length).toBeGreaterThan(0);
  });

  it('leads a CareBase brief with what its text is about, else the next in turn', () => {
    expect(focusFor('carebase', 'Annual in-service hours for your staff', 0).title).toBe('Spend less on required education');
    expect(focusFor('carebase', 'Who can give insulin today?', 0).title).toBe('Medication authorization roster');
    const titles = carebase.pillars.map(pillar => pillar.title);
    expect([0, 1].map(turn => focusFor('carebase', 'A tip for the week', turn).title)).toEqual(titles.slice(0, 2));
  });

  it('gives each request only the catalogs of the products it is about, each once and cached', () => {
    expect(catalogBlocks(['carebase'])).toEqual([{ text: featuresText('carebase'), cache: true }]);
    expect(catalogBlocks(['intel', 'caremetric-intel', 'carebase', 'advisors']).map(block => block.text)).toEqual([featuresText('caremetric-intel'), featuresText('carebase')]);
    expect(catalogBlocks([])).toEqual([]);
  });
});
