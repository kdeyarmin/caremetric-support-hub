import { describe, expect, it, vi } from 'vitest';
import { briefHandlers, briefParts, figureSentence, figuresFor, growthBriefFeature } from './brief.mjs';
import { draftMessage } from './draft.mjs';
import { researchOnlyPrefix } from './roster.mjs';

const county = { county_fips: '42003', county_name: 'Allegheny County', state: 'PA', figures: [
  { key: 'home_health_agencies_in_county', label: 'Home health agencies located in the county', value: 48, unit: 'count', short_source: 'CMS Post-Acute Care Utilization, 2023', setting: 'home_health' },
  { key: 'hospices_in_county', label: 'Hospices located in the county', value: 21, unit: 'count', short_source: 'CMS Post-Acute Care Utilization, 2023', setting: 'hospice' },
  { key: 'nursing_homes_in_county', label: 'Nursing homes located in the county', value: 70, unit: 'count', short_source: 'CMS, 2023', setting: 'nursing_home' },
  { key: 'medicare_advantage_share', label: 'Medicare Advantage share of beneficiaries', value: 0.552, unit: 'fraction', short_source: 'CMS Medicare Monthly Enrollment, 2026', setting: 'general' },
] };
const evidence = [
  { id: 'e1', claim: 'Valley Home Health serves Allegheny and Butler counties from two offices.', sourceUrl: 'https://valleyhh.org/about', observedAt: '2026-11-10T00:00:00Z' },
  { id: 'e2', claim: 'Valley Home Health is hiring a community liaison. (job listing dated 2026-11-01)', sourceUrl: 'https://www.indeed.com/viewjob?jk=1', observedAt: '2026-11-12T00:00:00Z' },
  { id: 'e3', claim: `${researchOnlyPrefix} 312 Medicare patients, rank 9 of 48 in Allegheny County.`, sourceUrl: 'https://www.caremetricintel.com/data-use', observedAt: '2026-11-12T00:00:00Z' },
];
const output = {
  summary: 'Valley Home Health is a family-owned home health agency serving Allegheny and Butler counties.', serviceArea: 'Allegheny and Butler counties', ownership: 'Family-owned',
  triggers: [{ fact: 'It is hiring a community liaison.', sourceUrl: 'https://www.indeed.com/viewjob?jk=1', date: '2026-11-01' },
    { fact: 'It opened a third office.', sourceUrl: 'https://made-up.example.org/', date: '2026-10-01' }],
  leaders: [{ name: 'Jane Doe', title: 'Administrator' }, { name: 'Someone Invented', title: 'Owner' }],
  pains: [{ question: 'Do you know which physicians in Butler County certify the most home health patients?', capability: 'Physician certifications' },
    { question: 'With 312 patients and a 4.1% share, are you ninth for a reason?', capability: 'Market share' }],
  angle: 'referral_sources', angleReason: 'Ranked 9 of 48 with a new liaison to equip.',
  hook: 'Valley Home Health is hiring a community liaison for its Allegheny and Butler teams.', hookSourceUrl: 'https://www.indeed.com/viewjob?jk=1',
  countyFact: 'home_health_agencies_in_county', fit: 88, fitReasons: ['Independent, mid-sized, hiring a liaison'], questions: ['Who leads marketing?'], needsHuman: false,
};

describe('the county figures an agency may be told', () => {
  it('keeps its own setting\'s figures and the general ones, never another setting\'s, as sentences with their source', () => {
    const home = figuresFor(county, 'home_health');
    expect(home.map(figure => figure.key)).toEqual(['home_health_agencies_in_county', 'medicare_advantage_share']);
    expect(home[0].sentence).toBe('48 home health agencies located in Allegheny County (CMS Post-Acute Care Utilization, 2023).');
    expect(home[1].sentence).toBe('Medicare Advantage share of beneficiaries in Allegheny County: 55.2% (CMS Medicare Monthly Enrollment, 2026).');
    expect(figuresFor(county, 'hospice').map(figure => figure.key)).toEqual(['hospices_in_county', 'medicare_advantage_share']);
    // An older Intel that labels no setting: a figure naming another setting is left out.
    const unlabeled = { ...county, figures: county.figures.map(({ setting, ...figure }) => figure) };
    expect(figuresFor(unlabeled, 'hospice').map(figure => figure.key)).toEqual(['hospices_in_county', 'medicare_advantage_share']);
    // A nursing home is told its own setting's figures, never an agency's (owner decision 2026-11-16).
    expect(figuresFor(county, 'nursing_home').map(figure => figure.key)).toEqual(['nursing_homes_in_county', 'medicare_advantage_share']);
    expect(figuresFor(unlabeled, 'nursing_home').map(figure => figure.key)).toEqual(['nursing_homes_in_county', 'medicare_advantage_share']);
    expect(figureSentence({ label: 'Standardized Medicare home health spending per FFS beneficiary', value: 1234.4, unit: 'usd_per_beneficiary' }, 'Erie County'))
      .toBe('Standardized Medicare home health spending per FFS beneficiary in Erie County: $1,234 per beneficiary.');
  });

  it('names the county where a billing count says "the county\'s", never after "located in other counties"', () => {
    // Intel's labels for the three billing counts (home health, hospice, skilled nursing), as production sent them on 2026-11-16.
    const billing = (label, value) => figureSentence({ label, value, unit: 'count', short_source: 'CMS Market Saturation and Utilization, 2025' }, 'Dallas County');
    expect(billing('Home health agencies billing for the county\'s Medicare FFS beneficiaries, including agencies located in other counties', 232))
      .toBe('232 home health agencies billing for Dallas County\'s Medicare FFS beneficiaries, including agencies located in other counties (CMS Market Saturation and Utilization, 2025).');
    expect(billing('Hospices billing for the county\'s Medicare FFS beneficiaries, including hospices located in other counties', 41))
      .toBe('41 hospices billing for Dallas County\'s Medicare FFS beneficiaries, including hospices located in other counties (CMS Market Saturation and Utilization, 2025).');
    expect(billing('Skilled nursing facilities billing for the county\'s Medicare FFS beneficiaries, including facilities located in other counties', 1250))
      .toBe('1,250 skilled nursing facilities billing for Dallas County\'s Medicare FFS beneficiaries, including facilities located in other counties (CMS Market Saturation and Utilization, 2025).');
    // A label that names no county still takes it at the end.
    expect(billing('Medicare beneficiaries', 400000)).toBe('400,000 Medicare beneficiaries in Dallas County (CMS Market Saturation and Utilization, 2025).');
  });
});

describe('the brief\'s two parts', () => {
  const parts = briefParts(output, { evidence, countyFigures: figuresFor(county, 'home_health'), people: [{ name: 'Jane Doe', title: 'Administrator' }], intel: { position: { county_rank: 9 } }, setting: 'home_health' });
  it('gives the writer only what a citable source states: never the agency\'s own figures, never a source it was not given', () => {
    expect(parts.writer.pains.map(pain => pain.question)).toEqual(['Do you know which physicians in Butler County certify the most home health patients?']);
    expect(parts.writer.triggers).toEqual([{ fact: 'It is hiring a community liaison.', sourceUrl: 'https://www.indeed.com/viewjob?jk=1', date: '2026-11-01' }]);
    expect(parts.writer.hook).toEqual({ sentence: output.hook, sourceUrl: 'https://www.indeed.com/viewjob?jk=1' });
    expect(parts.writer.countyFact).toEqual({ key: 'home_health_agencies_in_county', claim: '48 home health agencies located in Allegheny County (CMS Post-Acute Care Utilization, 2023).', source: 'CMS Post-Acute Care Utilization, 2023' });
    expect(parts.writer.angle).toBe('referral_sources');
    expect(JSON.stringify(parts.writer)).not.toMatch(/312|4\.1|ninth|rank/i);
  });
  it('keeps the team\'s part: fit, reasons, Intel\'s data and only the leaders the sources named', () => {
    expect(parts.research).toMatchObject({ fit: 88, angleReason: 'Ranked 9 of 48 with a new liaison to equip.', intel: { position: { county_rank: 9 } },
      leaders: [{ name: 'Jane Doe', title: 'Administrator' }], dropped: { triggers: 1, hook: false } });
  });
  it('drops a hook that states the agency\'s own figures or cites a page it was not given', () => {
    const own = briefParts({ ...output, hook: 'Valley Home Health ranks 9th of 48 agencies in Allegheny County.' }, { evidence, countyFigures: [], people: [], setting: 'home_health' });
    expect(own.writer.hook).toBeNull();
    const elsewhere = briefParts({ ...output, hookSourceUrl: 'https://made-up.example.org/' }, { evidence, countyFigures: [], people: [], setting: 'home_health' });
    expect(elsewhere.writer.hook).toBeNull();
  });
  it('keeps the people its sources name out of the writer part: the email addresses the agency, never a person', () => {
    const named = briefParts({ ...output,
      summary: 'Valley Home Health is a family-owned home health agency serving Allegheny and Butler counties. Its sources name Jane Doe as Administrator.',
      ownership: 'Owned by Jane  Doe and her family.', hook: 'Jane Doe leads Valley Home Health.' },
    { evidence, countyFigures: [], people: [{ name: 'Jane Doe', title: 'Administrator' }], setting: 'home_health' });
    expect(named.writer.summary).toBe('Valley Home Health is a family-owned home health agency serving Allegheny and Butler counties.');
    expect(named.writer.ownership).toBe('');
    expect(named.writer.hook).toBeNull();
    // The agency's own name is not a person's, and the team still sees who leads it.
    expect(named.research.leaders).toEqual([{ name: 'Jane Doe', title: 'Administrator' }]);
    // An initial or a title never splits a sentence, so neither leaves the name, nor a stray "Dr.", behind.
    const initial = briefParts({ ...output, summary: 'Valley Home Health is family-owned. Jane A. Doe is its president. Dr. John Roe is its medical director.' },
      { evidence, countyFigures: [], people: [{ name: 'Jane A. Doe', title: 'President' }, { name: 'John Roe', title: 'Medical Director' }], setting: 'home_health' });
    expect(initial.writer.summary).toBe('Valley Home Health is family-owned.');
  });

  it('keeps the agency\'s own rating, rank or share out of the writer part even with no number the check would catch', () => {
    const parts = briefParts({ ...output, summary: 'Valley Home Health has a 4.5-star quality rating.', serviceArea: 'It ranks ninth in Erie County.',
      ownership: 'It is the third-largest agency in the county.' }, { evidence, countyFigures: [], people: [], setting: 'home_health' });
    expect([parts.writer.summary, parts.writer.serviceArea, parts.writer.ownership]).toEqual(['', '', '']);
  });
});

describe('growth.brief', () => {
  const setup = ({ enabled = true, pick = { id: 'o1', organizationId: 'g1', product: 'caremetric-intel', fit: 82, stage: 'qualified', name: 'Valley Home Health', domain: 'valleyhh.org',
    agencies: [{ ccn: '397001', name: 'VALLEY HOME HEALTH', setting: 'home_health', city: 'Pittsburgh', state: 'PA', countyFips: '42003' }], evidence, people: [{ name: 'Jane Doe', title: 'Administrator', source: 'website' }] } } = {}) => {
    const store = { briefNext: vi.fn(async () => pick), briefSave: vi.fn(async () => ({ version: 1 })), discover: vi.fn(async rows => rows.length) };
    const feed = { configured: true, agencyBrief: vi.fn(async () => ({ found: true, brief: { setting: 'home_health', county: { fips: '42003', name: 'Allegheny County', state: 'PA' }, year: '2024',
      position: { patients: 312, county_share: 0.041, county_rank: 9, county_providers: 48 }, history: [], competitors: [], figures: [], hospitals: [], ratings: [], moves: [] } })),
      countyFigures: vi.fn(async () => ({ counties: [county] })) };
    const model = { configured: true,
      research: vi.fn(async () => ({ outcome: 'completed', text: 'Valley Home Health is hiring a community liaison. https://www.indeed.com/viewjob?jk=1',
        sources: [{ url: 'https://www.indeed.com/viewjob?jk=1' }], searches: 2, fetches: 1, costCents: 9 })),
      run: vi.fn(async (_task, request) => (request.promptVersion.startsWith('research')
        ? { outcome: 'completed', output: { facts: [{ claim: 'Valley Home Health is hiring a community liaison.', url: 'https://www.indeed.com/viewjob?jk=1', kind: 'hiring', date: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10) }] } }
        : { outcome: 'completed', model: 'claude-opus-5-5', costCents: 14, output })) };
    const growth = { store, roster: { feed }, briefs: { enabled, perDay: 25, cents: 60 } };
    const run = (task = { id: 't', agent: { autonomy: 'propose' } }) => briefHandlers({ growth, model, features: new Set([growthBriefFeature]), marketed: ['caremetric-intel'] })['growth.brief'](task);
    return { store, feed, model, run };
  };

  it('gathers Intel\'s data and the county\'s figures for the agency\'s setting, researches dated triggers, and writes the brief on the quality tier', async () => {
    const { store, feed, model, run } = setup();
    const { result } = await run();
    expect(store.briefNext).toHaveBeenCalledWith(25);
    expect(feed.agencyBrief).toHaveBeenCalledWith(expect.objectContaining({ ccn: '397001' }));
    expect(feed.countyFigures).toHaveBeenCalledWith(expect.objectContaining({ countyFips: ['42003'] }));
    expect(store.discover).toHaveBeenCalledWith('caremetric-intel', [expect.objectContaining({ url: 'https://www.indeed.com/viewjob?jk=1' })]);
    const synthesis = model.run.mock.calls.find(([, request]) => request.promptVersion === 'brief.2')[1];
    expect(synthesis).toMatchObject({ tier: 'quality', effort: 'high', timeoutMs: 120_000 });
    // The write-up holds what is left of the brief's 60 cents after the research (9 cents of search here).
    expect(synthesis.ceilingCents).toBeGreaterThan(0);
    expect(synthesis.ceilingCents).toBeLessThanOrEqual(51);
    const sent = JSON.parse(synthesis.user);
    expect(sent.countyFigures.map(figure => figure.key)).toEqual(['home_health_agencies_in_county', 'medicare_advantage_share']);
    expect(sent.intel.position.county_rank).toBe(9);
    expect(sent.evidence.find(item => item.claim.startsWith(researchOnlyPrefix)).teamOnly).toBe(true);
    const [opportunity, saved] = store.briefSave.mock.calls[0];
    expect(opportunity).toBe('o1');
    expect(saved).toMatchObject({ model: 'claude-opus-5-5', promptVersion: 'brief.2', costCents: 23, research: { fit: 88, intel: { position: { county_rank: 9 } } } });
    expect(JSON.stringify(saved.writer)).not.toMatch(/312|county_rank/);
    expect(result).toEqual({ briefed: 1, version: 1, facts: 1, triggers: 1, hook: true, countyFact: true, intel: true, cents: 23 });
  });

  it('briefs a nursing home found on the web as a nursing home: no market report to ask for, never an agency\'s figures', async () => {
    const { store, feed, model, run } = setup({ pick: { id: 'o2', organizationId: 'g2', product: 'caremetric-intel', fit: 80, stage: 'qualified',
      name: 'Maple Ridge Nursing and Rehabilitation Center', domain: 'mapleridge.example.org', agencies: [], evidence, people: [] } });
    await run();
    expect(feed.agencyBrief).not.toHaveBeenCalled();
    const sent = JSON.parse(model.run.mock.calls.find(([, request]) => request.promptVersion === 'brief.2')[1].user);
    expect(sent.agency.setting).toBe('nursing home');
    expect(sent.countyFigures).toEqual([]);
    expect(store.briefSave.mock.calls[0][1].writer.setting).toBe('nursing_home');
  });

  it('writes the brief when Intel\'s shares carry every digit of a fraction, which the identifier screen read as a card number', async () => {
    const h = setup();
    // 12 / 912 is 0.013157894736842105 in JSON: its digits pass the card number check, so before 2026-11-16 the brief was skipped.
    h.feed.agencyBrief.mockResolvedValueOnce({ found: true, brief: { setting: 'home_health', county: { fips: '42003', name: 'Allegheny County', state: 'PA' }, year: '2024',
      position: { patients: 12, county_share: 12 / 912, county_rank: 30, county_providers: 48 }, history: [{ data_year: '2023', patients: 15, county_share: 15 / 912, county_rank: 28 }],
      competitors: [{ name: 'Another agency', patients: 120, share: 120 / 912, is_agency: false }], figures: [], hospitals: [], ratings: [], moves: [] } });
    const { result } = await h.run();
    expect(result).toMatchObject({ briefed: 1, intel: true });
    const sent = JSON.parse(h.model.run.mock.calls.find(([, request]) => request.promptVersion === 'brief.2')[1].user);
    expect(sent.intel.position).toEqual({ patients: 12, county_share: 0.0132, county_rank: 30, county_providers: 48 });
    expect(sent.intel.history[0].county_share).toBe(0.0164);
    expect(sent.intel.competitors[0].share).toBe(0.1316);
  });

  it('does nothing when off, in Observe, or with nobody to brief', async () => {
    expect((await setup({ enabled: false }).run()).result).toEqual({ skipped: 'off' });
    expect((await setup().run({ id: 't', agent: { autonomy: 'observe' } })).result).toEqual({ skipped: 'observe_only' });
    const none = setup({ pick: null });
    expect((await none.run()).result).toEqual({ briefed: 0 });
    expect(none.model.run).not.toHaveBeenCalled();
  });
});

describe('a first email written from the brief', () => {
  const now = new Date().toISOString();
  const o = { id: 'opp', organization_id: 'org', product: 'caremetric-intel', name: 'Valley Home Health', domain: 'valleyhh.org', stage: 'qualified', touches: 0, contact_id: 'c1', memory: {},
    policy: { approved_claim: 'Intel shows every referral source in your county.', experiment_enabled: false, max_touches: 3 },
    evidence: [{ id: 'e1', claim: 'Valley Home Health serves Allegheny and Butler counties.', source_url: 'https://valleyhh.org/about', confidence: 'high', observed_at: now },
      { id: 'e2', claim: 'Valley Home Health is hiring a community liaison. (job listing dated 2026-11-01)', source_url: 'https://www.indeed.com/viewjob?jk=1', confidence: 'low', observed_at: now }] };
  const brief = { setting: 'home_health', summary: 'A family-owned home health agency in Allegheny and Butler counties.', triggers: [{ fact: 'It is hiring a community liaison.', sourceUrl: 'https://www.indeed.com/viewjob?jk=1', date: '2026-11-01' }],
    pains: [{ question: 'Do you know which physicians certify the most home health patients in Butler County?', capability: 'Physician certifications' }], angle: 'referral_sources',
    hook: { sentence: 'Valley Home Health is hiring a community liaison.', sourceUrl: 'https://www.indeed.com/viewjob?jk=1' },
    countyFact: { key: 'home_health_agencies_in_county', claim: '48 home health agencies located in Allegheny County (CMS Post-Acute Care Utilization, 2023).', source: 'CMS' }, briefVersion: 2 };
  const body = 'I saw Valley Home Health is hiring a community liaison. Allegheny County has 48 home health agencies, by CMS\'s count.\n\nDo you know which physicians certify the most home health patients in Butler County?\n\nhttps://www.caremetricintel.com/market-review';
  const draft = { subject: 'Your new liaison\'s first map', body, citations: ['e2', 'county'], needsHuman: false };
  const work = { kind: 'outreach', action: 'Write.', success: 'A reply.' };

  it('reads the brief, may state its county figure, cites the agency\'s evidence only, leads with its angle and writes on the quality tier', async () => {
    const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: draft })) };
    const result = await draftMessage({ opportunity: o, work, task: { id: 't' }, model, brief, quality: true });
    expect(result).toBeTruthy();
    const [, request] = model.run.mock.calls[0];
    expect(request).toMatchObject({ tier: 'quality', effort: 'high', maxTokens: 6000, timeoutMs: 120_000, promptVersion: 'growth.15' });
    const input = JSON.parse(request.user);
    expect(input.brief).toMatchObject({ hook: brief.hook.sentence, hookSourceId: 'e2', angle: 'referral_sources' });
    expect(input.sources.find(source => source.id === 'county').claim).toBe(brief.countyFact.claim);
    expect(input.focus).toBe('referral sources');
    expect(result.citations).toEqual(['e2']);
    expect(result.arms).toMatchObject({ angle: 'referral_sources', angle_by: 'brief' });
  });

  it('in the experiment\'s holdout, tells the writer the hashed angle it records, never the brief\'s', async () => {
    const seen = [];
    const differs = item => item.arms.angle_by === 'hash' && item.arms.angle !== 'referral_sources';
    for (let i = 0; i < 200 && !seen.some(differs); i += 1) {
      const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: draft })) };
      const opportunity = { ...o, id: `opp-${i}`, organization_id: `org-${i}`, policy: { ...o.policy, experiment_enabled: true } };
      const result = await draftMessage({ opportunity, work, task: { id: 't' }, model, brief });
      if (result) seen.push({ arms: result.arms, input: JSON.parse(model.run.mock.calls[0][1].user) });
    }
    // A holdout whose hashed angle is not the brief's, so the test tells the two apart.
    const holdout = seen.find(differs);
    expect(holdout).toBeTruthy();
    expect(holdout.input.brief.angle).toBe(holdout.arms.angle);
    for (const item of seen.filter(entry => entry.arms.angle_by === 'brief')) expect(item.input.brief.angle).toBe('referral_sources');
  });

  it('gives a nursing home only a county figure for nursing homes, never one from a brief written for an agency', async () => {
    const home = { ...o, name: 'Maple Ridge Nursing and Rehabilitation Center', domain: 'mapleridge.example.org',
      evidence: [{ id: 'e1', claim: 'Maple Ridge Nursing and Rehabilitation Center admits patients from Allegheny County hospitals.', source_url: 'https://mapleridge.example.org/about', confidence: 'high', observed_at: now }] };
    const sources = async given => {
      const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: { ...draft, citations: ['e1'] } })) };
      await draftMessage({ opportunity: home, work, task: { id: 't' }, model, brief: given });
      return JSON.parse(model.run.mock.calls[0][1].user).sources.map(source => source.id);
    };
    expect(await sources(brief)).toEqual(['e1']);
    const ownFigure = { ...brief, setting: 'nursing_home', countyFact: { key: 'nursing_homes_in_county', claim: '70 nursing homes located in Allegheny County (CMS, 2023).', source: 'CMS' } };
    expect(await sources(ownFigure)).toEqual(['e1', 'county']);
    // And an agency never reads a nursing home's.
    const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: draft })) };
    await draftMessage({ opportunity: o, work, task: { id: 't' }, model, brief: ownFigure });
    expect(JSON.parse(model.run.mock.calls[0][1].user).sources.map(source => source.id)).toEqual(['e1', 'e2']);
  });

  it('refuses a draft that cites only the county figure', async () => {
    const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: { ...draft, citations: ['county'] } })) };
    expect(await draftMessage({ opportunity: o, work, task: { id: 't' }, model, brief })).toBeNull();
  });

  it('has a reader score the first email and rewrites it once around its weakest sentence when the score is under 4', async () => {
    const better = { ...draft, subject: 'Your liaison\'s first referral map' };
    const run = vi.fn(async (_task, request) => {
      if (request.promptVersion === 'critic.2') return { outcome: 'completed', output: JSON.parse(request.user).email.subject === better.subject
        ? { specific: 4, relevant: 4, clearAsk: 5, wouldReply: 4, weakestSentence: '' }
        : { specific: 2, relevant: 3, clearAsk: 4, wouldReply: 2, weakestSentence: 'Do you know which physicians certify the most home health patients in Butler County?' } };
      return { outcome: 'completed', output: request.promptVersion.endsWith('-c') ? better : draft };
    });
    const result = await draftMessage({ opportunity: o, work, task: { id: 't' }, model: { configured: true, run }, brief, critic: true });
    expect(result.subject).toBe(better.subject);
    expect(result.arms).toMatchObject({ critic: '4', rewritten: '1' });
    const rewrite = run.mock.calls.find(([, request]) => request.promptVersion === 'growth.15-c')[1];
    expect(JSON.parse(rewrite.user).fix).toMatch(/scored this email 2 of 5.*certify the most home health patients in Butler County/);
    // What the reader said on both reads travels with the draft, to be recorded beside it.
    expect(result.review).toEqual({ promptVersion: 'critic.2', outcome: 'kept',
      first: { specific: 2, relevant: 3, clearAsk: 4, wouldReply: 2, weakest: 'Do you know which physicians certify the most home health patients in Butler County?' },
      rewrite: { specific: 4, relevant: 4, clearAsk: 5, wouldReply: 4, weakest: '' } });
  });

  it('records what became of the rewrite: not needed, scored lower, failed its checks', async () => {
    const reader = scores => ({ outcome: 'completed', output: { specific: 3, relevant: 3, clearAsk: 3, weakestSentence: '  The last line.  ', ...scores } });
    const reviewOf = async (reads, rewritten = draft) => {
      let read = 0;
      const run = vi.fn(async (_task, request) => (request.promptVersion === 'critic.2' ? reader(reads[read++])
        : { outcome: 'completed', output: request.promptVersion.endsWith('-c') ? rewritten : draft }));
      return draftMessage({ opportunity: o, work, task: { id: 't' }, model: { configured: true, run }, brief, critic: true });
    };
    const good = await reviewOf([{ wouldReply: 4 }]);
    expect(good.review).toEqual({ promptVersion: 'critic.2', outcome: 'not_needed', rewrite: null,
      first: { specific: 3, relevant: 3, clearAsk: 3, wouldReply: 4, weakest: 'The last line.' } });
    const lower = await reviewOf([{ wouldReply: 3 }, { wouldReply: 2 }]);
    expect(lower.subject).toBe(draft.subject);
    expect(lower.arms).toMatchObject({ critic: '3' });
    expect(lower.arms.rewritten).toBeUndefined();
    expect(lower.review).toMatchObject({ outcome: 'scored_lower', first: { wouldReply: 3 }, rewrite: { wouldReply: 2 } });
    const failed = await reviewOf([{ wouldReply: 2 }], { ...draft, citations: ['nowhere'] });
    expect(failed.review).toMatchObject({ outcome: 'failed_checks', rewrite: null });
    expect(failed.review.problem).toMatch(/^[a-z_]+$/);
    // A rewrite refused for its words comes back without an answer, but it is a failed check, not the model's silence.
    const worded = await reviewOf([{ wouldReply: 2 }], { ...draft, body: `${draft.body} Ask your financial auditor.` });
    expect(worded.review).toMatchObject({ outcome: 'failed_checks', problem: 'vocabulary', rewrite: null });
    expect(worded.subject).toBe(draft.subject);
    let read = 0;
    const silent = vi.fn(async (_task, request) => (request.promptVersion === 'critic.2' ? reader([{ wouldReply: 2 }][read++])
      : request.promptVersion.endsWith('-c') ? { outcome: 'failed', output: null } : { outcome: 'completed', output: draft }));
    const unanswered = await draftMessage({ opportunity: o, work, task: { id: 't' }, model: { configured: true, run: silent }, brief, critic: true });
    expect(unanswered.review).toMatchObject({ outcome: 'no_answer', rewrite: null });
    expect(unanswered.review).not.toHaveProperty('problem');
  });
});

describe('the sweep and the brief', () => {
  const now = new Date().toISOString();
  const base = { product: 'caremetric-intel', stage: 'qualified', owner_agent: 'marketing_manager', internal: false, next_at: '2026-01-01T00:00:00Z', touches: 0, work: [], events: [],
    version: 4, contact_id: 'contact', contact_version: 7, eligibility: 'permitted', memory: {}, assessed_at: now, policy: { version: 9, approved_claim: 'Intel shows referral sources.' },
    evidence: [{ id: 'source', source_url: 'https://example.org', claim: 'A hospice in Erie.', observed_at: now }] };
  const sweep = async ({ brief = null, enabled = true, qualityWriter = false, critic = false, extra = [], reviewRecord = vi.fn(async () => true),
    items = [{ ...base, id: 'a', organization_id: 'ga' }] } = {}) => {
    const { growthHandlers } = await import('./worker.mjs');
    const store = { snapshot: vi.fn(async () => ({ total: items.length, items })), plan: vi.fn(async () => 'work'), draft: vi.fn(async () => ({ id: 'message', status: 'draft' })), propose: vi.fn(),
      briefWriter: vi.fn(async () => brief), reviewRecord };
    const email = { subject: 'Referral sources in Erie', body: 'Which hospitals send you the most patients? Reply and I will send the steps.', citations: ['source'], needsHuman: false };
    const model = { configured: true, run: vi.fn(async (_task, request) => ({ outcome: 'completed', output: request.promptVersion === 'critic.2'
      ? { specific: 3, relevant: 4, clearAsk: 4, wouldReply: 4, weakestSentence: 'Reply and I will send the steps.' } : email })) };
    const growth = { store, model, signingReady: true, hash: x => x, unsubscribeToken: () => 'token', briefs: { enabled, qualityWriter, critic } };
    const outcome = await growthHandlers({ growth, model, features: new Set([growthBriefFeature, ...extra]), marketed: ['caremetric-intel'] })['growth.pipeline']({ id: 'task', agent: { autonomy: 'propose' }, kind: 'growth.pipeline' });
    return { store, model, outcome };
  };
  it('holds a first email for its brief for a day while briefs are on, and writes as before when they are off', async () => {
    const waiting = await sweep();
    expect(waiting.model.run).not.toHaveBeenCalled();
    expect(waiting.outcome.result).toMatchObject({ drafted: 0, held: { brief_pending: 1 } });
    const off = await sweep({ enabled: false });
    expect(off.outcome.result).toMatchObject({ drafted: 1 });
    expect(off.model.run.mock.calls[0][1].tier).toBeUndefined();
  });
  it('writes at most one first email on the top model a sweep, from its brief', async () => {
    const brief = { angle: 'referral_sources', summary: 'A hospice in Erie.' };
    const { model, outcome } = await sweep({ brief, qualityWriter: true, items: [{ ...base, id: 'a', organization_id: 'ga' }, { ...base, id: 'b', organization_id: 'gb' }] });
    expect(model.run.mock.calls.filter(([, request]) => request.tier === 'quality')).toHaveLength(1);
    expect(outcome.result).toMatchObject({ drafted: 1, held: { top_model_later: 1 } });
  });
  it('records the reader\'s review beside the proposed email once the diagnostics feature is declared, and never in the message itself', async () => {
    const brief = { angle: 'referral_sources', summary: 'A hospice in Erie.' };
    const { growthDiagnosticsFeature } = await import('./worker.mjs');
    const before = await sweep({ brief, critic: true });
    expect(before.store.draft.mock.calls[0][2]).not.toHaveProperty('review');
    expect(before.store.reviewRecord).not.toHaveBeenCalled();
    const after = await sweep({ brief, critic: true, extra: [growthDiagnosticsFeature] });
    expect(after.store.draft.mock.calls[0][2]).not.toHaveProperty('review');
    expect(after.store.propose).toHaveBeenCalledWith('task', 'message');
    expect(after.store.reviewRecord).toHaveBeenCalledWith('message', { promptVersion: 'critic.2', outcome: 'not_needed', rewrite: null,
      first: { specific: 3, relevant: 4, clearAsk: 4, wouldReply: 4, weakest: 'Reply and I will send the steps.' } });
    // A review the database refuses never holds the email: it is counted.
    const refused = await sweep({ brief, critic: true, extra: [growthDiagnosticsFeature], reviewRecord: vi.fn(async () => { throw Object.assign(new Error('Invalid review'), { code: '22023' }); }) });
    expect(refused.store.propose).toHaveBeenCalledWith('task', 'message');
    expect(refused.outcome.result).toMatchObject({ drafted: 1, unreviewed: 1 });
  });
});
