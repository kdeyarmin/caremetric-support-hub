import { describe, expect, it } from 'vitest';
import { segments } from '../creative/copy.mjs';
import { careSettingText, catalogBlocks, catalogGuidance, catalogNumbers, featuresText, focusFor, productFeatures } from './features.mjs';
import { products } from './facts.mjs';
import { textProblems } from './validate.mjs';

const intel = productFeatures['caremetric-intel'];

describe('CareMetric Intel\'s published feature catalog', () => {
  it('holds every feature Intel publishes, by area, with why each part matters and the data behind it', () => {
    const total = intel.areas.reduce((sum, area) => sum + area.features.length, 0);
    expect(total).toBe(intel.publishedCount);
    expect(total).toBeGreaterThanOrEqual(90);
    expect(intel.areas.map(area => area.name)).toEqual(expect.arrayContaining(['Healthcare marketing CRM', 'Daily field work', 'Expenses, mileage and reimbursement',
      'Referral and admission tracking', 'Prospecting and targeting', 'Market and territory research', 'Public data library', 'Competitor intelligence', 'Manager and team tools']));
    expect(intel.areas.every(area => area.intro && area.features.every(feature => feature.name && feature.does))).toBe(true);
    expect(intel.pillars).toHaveLength(12);
    expect(intel.pillars.every(pillar => pillar.title && pillar.why && pillar.area)).toBe(true);
    expect(intel.data.map(family => family.family)).toEqual(['Providers', 'Facilities', 'Medicare use & share', 'Demographics', 'Payers & Medicare Advantage',
      'Community need', 'Competitors', 'Your results']);
    // The manager view is the site's own section, never a pillar read twice.
    expect(intel.managers.map(item => item.name)).toEqual(['Focus the work before the week starts', 'See how the team is spending its effort', 'Keep referrals part of the review']);
    expect(intel.data.every(family => family.includes.length && family.source && family.question && family.decision && family.limit)).toBe(true);
    expect(intel.sources.features).toBe('https://www.caremetricintel.com/features');
    expect(intel.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('describes every care setting the fact sheet names, in the site\'s words', () => {
    // The primary audience is exactly the fact sheet's five (owner decision 2026-11-16); the other settings the site describes are
    // secondary markets, kept apart so a prompt never treats them as targets.
    const settings = intel.settings.map(setting => setting.name.toLowerCase());
    expect(settings).toEqual(segments['caremetric-intel']);
    for (const setting of settings) expect(products.intel.forWhom.toLowerCase()).toContain(setting);
    expect(intel.otherSettings.map(setting => setting.name)).toEqual(expect.arrayContaining(['Physician practices & clinics', 'Behavioral health', 'Rehabilitation & therapy', 'Diagnostics, dialysis & DME']));
    expect(featuresText('caremetric-intel')).toMatch(/Also served \(secondary markets: [^)]*\):\n- Physician practices & clinics:/);
    expect(careSettingText('caremetric-intel', 'hospitals')).toContain('post-discharge Medicare spending');
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
      'not a promise of referrals', 'The 30-day trial includes Pro features in one county', 'Site finder', 'Public data library']) expect(text).toContain(phrase);
    // The AI apps and CRM Intel connects to are written generically. The count of its datasets is the site's own, approved by the owner
    // on 2026-11-16 (facts.mjs `dataFigures`), so drafts about Intel may state it (validate.mjs allowedNumbers).
    expect(text).not.toMatch(/ChatGPT|Claude|HubSpot/);
    expect(text).toContain('150+ public healthcare datasets');
    expect(text).toContain('More than 150 public healthcare datasets');
    expect(intel.edits.join('\n')).not.toMatch(/count of Intel's datasets/);
    expect(catalogNumbers('intel').has('150:dataset')).toBe(true);
    expect(featuresText('intel')).toBe(text);
    expect(featuresText('advisors')).toBe('');
  });

  it('leads a planned brief with the part of Intel its text is about, else the next in turn, never twice in one plan', () => {
    expect(focusFor('caremetric-intel', 'Which competitors gained market share?', 0).title).toBe('Know the competition');
    expect(focusFor('caremetric-intel', 'Referrals and admissions by source', 0).title).toBe('Connect effort to outcomes');
    const titles = intel.pillars.map(pillar => pillar.title);
    expect([0, 1, 2].map(turn => focusFor('caremetric-intel', 'A tip for the week', turn).title)).toEqual(titles.slice(0, 3));
    expect(focusFor('caremetric-intel', 'A tip for the week', 0, new Set([titles[0]])).title).toBe(titles[1]);
    expect(focusFor('caremetric-intel', 'Which competitors gained market share?', 0, new Set(['Know the competition'])).title).toBe(titles[0]);
    expect(focusFor('advisors', 'anything', 0)).toBeNull();
  });

  it('never leads a brief with email campaigns, even when the plan names them (owner direction 2026-11-12)', () => {
    const email = intel.pillars.find(pillar => /email campaigns/i.test(pillar.area));
    expect(email).toBeTruthy();
    expect(focusFor('caremetric-intel', 'Send an email campaign to your referral sources', 0).title).not.toBe(email.title);
    const led = new Set(Array.from({ length: intel.pillars.length * 2 }, (_, turn) => focusFor('caremetric-intel', 'A tip for the week', turn).title));
    expect(led.has(email.title)).toBe(false);
    expect(led.size).toBe(intel.pillars.length - 3);
    // Even with every other part used this week, the next brief does not fall back to email.
    const others = new Set(intel.pillars.filter(pillar => pillar !== email).map(pillar => pillar.title));
    expect(focusFor('caremetric-intel', 'A tip for the week', 3, others).title).not.toBe(email.title);
  });

  it('never leads a brief with expense tracking: Intel is a marketing workspace, not a compliance product (owner direction 2026-11-14)', () => {
    const expenses = intel.pillars.find(pillar => /expenses, mileage/i.test(pillar.area));
    expect(expenses).toBeTruthy();
    expect(focusFor('caremetric-intel', 'Log the lunch against the Stark limit', 0).title).not.toBe(expenses.title);
    const led = new Set(Array.from({ length: intel.pillars.length * 2 }, (_, turn) => focusFor('caremetric-intel', 'A tip for the week', turn).title));
    expect(led.has(expenses.title)).toBe(false);
    // Field activity, which logs expenses among much else, still leads.
    expect(led.has(intel.pillars.find(pillar => /field activity/i.test(pillar.area)).title)).toBe(true);
    const others = new Set(intel.pillars.filter(pillar => pillar !== expenses).map(pillar => pillar.title));
    expect(focusFor('caremetric-intel', 'A tip for the week', 3, others).title).not.toBe(expenses.title);
  });

  it('never leads a brief with the pre-visit card and spoken debrief: AI is text only in what the team writes (owner direction 2026-11-16)', () => {
    const spoken = intel.pillars.find(pillar => /spoken debrief/i.test(pillar.area));
    expect(spoken).toBeTruthy();
    expect(focusFor('caremetric-intel', 'Walk into the visit prepared, then debrief', 0).title).not.toBe(spoken.title);
    const led = new Set(Array.from({ length: intel.pillars.length * 2 }, (_, turn) => focusFor('caremetric-intel', 'A tip for the week', turn).title));
    expect(led.has(spoken.title)).toBe(false);
    // The field-visit pillar still leads, and so do the other new ones.
    for (const title of ['Give every visit a purpose', 'Answer referrals faster', 'Find where to grow next']) expect(led.has(title), title).toBe(true);
    expect(focusFor('caremetric-intel', 'How fast do you answer referrals?', 0).title).toBe('Answer referrals faster');
    expect(focusFor('caremetric-intel', 'Where should the next office open? Try the Site finder', 0).title).toBe('Find where to grow next');
  });

  it('tells every catalog prompt that one feature never stands for the product', () => {
    expect(catalogGuidance).toMatch(/Never let one feature stand for the whole product/);
    expect(catalogGuidance).toMatch(/email campaigns are one feature on two plans, never the point of the product/);
  });
});

const carebase = productFeatures.carebase;

describe('CareMetric CareBase\'s published capabilities', () => {
  it('holds every capability by area with the plan it needs, why it matters, the newest tools, the lifecycle, the roles and the chapters', () => {
    const total = carebase.areas.reduce((sum, area) => sum + area.capabilities.length, 0);
    expect(total).toBe(carebase.publishedCount);
    expect(carebase.areas).toHaveLength(carebase.publishedAreas);
    expect(total).toBeGreaterThanOrEqual(100);
    expect(carebase.areas.every(area => area.capabilities.length === area.count && area.name && area.intro && area.plan)).toBe(true);
    expect(carebase.areas.map(area => area.name)).toEqual(expect.arrayContaining(['Resident care & daily operations', 'Staff training & learning', 'Medication management & eMAR',
      'Survey readiness, safety & quality', 'Workforce, credentials & scheduling', 'Resident billing & payments']));
    expect(carebase.pillars.map(pillar => pillar.title)).toEqual(expect.arrayContaining(['Prepare for your next survey', 'Spend less on required education', 'Spend less time chasing records', 'Pennsylvania is built into the workflow']));
    // The chapter cards that follow "What sets it apart" on the home page are chapters, not reasons to choose it.
    expect(carebase.pillars.filter(pillar => carebase.chapters.some(chapter => chapter.title === pillar.title))).toEqual([]);
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
    // The prompt names the plan or add-on each area needs, and the site's own notes on eMAR and AI drafts.
    for (const phrase of ['Survey Day Mode', 'Medication authorization & pass-meds roster', '[eMAR add-on · facility activation required]', '[Workforce add-on]',
      'a documented switch to CareBase as the official medication administration record', 'Copilot actions require human approval', 'What each role sees and does',
      '55 Pa. Code Chapter 2800', 'Compliance and survey outcomes depend on']) expect(text).toContain(phrase);
    expect(text).toContain(`${carebase.publishedCount} capabilities in ${carebase.publishedAreas} areas.`);
    expect(carebase.edits.length).toBeGreaterThan(0);
  });

  it('leads a CareBase brief with what its text is about, else the next in turn', () => {
    expect(focusFor('carebase', 'Annual in-service hours for your staff', 0).title).toBe('Spend less on required education');
    expect(focusFor('carebase', 'Dementia hours under Chapter 2800', 0).title).toBe('Pennsylvania is built into the workflow');
    expect(focusFor('carebase', 'After a hospital return: reassessment and support-plan review', 0).title).toBe('The next step stays connected to the record');
    expect(focusFor('carebase', 'Courses drafted from your own policies, approved by a named reviewer', 0).title).toBe('Training prepared for you. AI reviewed by people.');
    expect(focusFor('carebase', 'One flat price per facility, whatever your headcount', 0).title).toBe('A price based on your facility, not your headcount');
    const titles = carebase.pillars.map(pillar => pillar.title);
    expect([0, 1].map(turn => focusFor('carebase', 'A tip for the week', turn).title)).toEqual(titles.slice(0, 2));
  });

  it('gives each request only the catalogs of the products it is about, each once and cached', () => {
    expect(catalogBlocks(['carebase'])).toEqual([{ text: featuresText('carebase'), cache: true }]);
    expect(catalogBlocks(['intel', 'caremetric-intel', 'carebase', 'advisors']).map(block => block.text)).toEqual([featuresText('caremetric-intel'), featuresText('carebase')]);
    expect(catalogBlocks([])).toEqual([]);
  });
});
