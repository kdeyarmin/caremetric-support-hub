import { describe, expect, it, vi } from 'vitest';
import { actionExecutor } from '../actions.mjs';
import { agentTeam } from '../index.mjs';
import { creativeExecutors } from './executor.mjs';
import { creativeConfig, creativeFeature, creativeTeam } from './index.mjs';
import { creativeHandlers } from './tasks.mjs';
import { kit, syntheticPng } from './fixtures.mjs';

const kinds = ['creative.plan', 'creative.refresh', 'creative.render', 'creative.report', 'creative.request'];
const briefId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const now = () => new Date('2026-11-09T14:30:00Z'); // Monday 09:30 Eastern
const task = (kind, over = {}) => ({ id: 't1', agentKey: 'creative_director', kind, attempts: 1, sourceKind: 'schedule', requestKey: 'x', agent: { autonomy: 'propose', config: {} }, payload: {}, ...over });
const brief = { id: briefId, product: 'caremetric-intel', goal: 'Drive trials', audience: 'Marketing leaders at hospitals', offerCode: null, platforms: ['meta'], formats: ['static'], videoLengths: [], angle: '', source: 'owner', status: 'open', revisionNote: '' };
const fullKit = { product: 'caremetric-intel', ...kit, logoFileId: null, screenshots: [], requiredDisclaimers: [], bannedPhrases: [], captionsDefault: true };
const copyOf = (hook, layout = 'checklist') => ({ hook, layout, headline: 'Territory plans from public data', primaryText: 'CareMetric Intel brings targeted marketing and territory analysis into one place.',
  description: 'Free trial', cta: 'Start free trial', altText: 'A checklist on a light background',
  overlay: { kicker: '', stat: '', statLabel: '', statSource: '', quote: '', quoteSource: '', offerLine: '', checklist: ['Territory analysis', 'A marketing CRM', 'Referrals in one place'], screenshotId: '', beats: [] } });

function harness({ autonomy = 'propose', model = null, marketed = null, claimed = [] } = {}) {
  let next = 0;
  const queue = [...claimed];
  const store = {
    // Everything a handler may call. None of these hands an asset over, retires one or marks one live.
    creativePlanInputs: vi.fn(async () => [{ ref: 'social.post:a1', source: 'social.plan', product: 'caremetric-intel', platform: 'facebook', pillar: 'capability', text: 'See your territory.' }]),
    creativeBriefCreate: vi.fn(async () => ({ id: briefId, created: true, status: 'open' })),
    creativeBriefContext: vi.fn(async () => ({ brief, brandKit: fullKit, parent: null, learnings: [], recentHeadlines: [] })),
    creativeBriefFinish: vi.fn(async () => true),
    creativeDraftsSave: vi.fn(async (_, __, rows) => rows.map((row, index) => ({ id: `d${index}`, status: row.compliance.verdict === 'block' ? 'blocked' : 'draft', created: true }))),
    creativeRenderClaim: vi.fn(async () => ({ claimed: queue.length ? [queue.shift()] : [], renderedToday: 1, cap: 40 })),
    creativeRenderJobs: vi.fn(async () => []), creativeRenderJob: vi.fn(async () => true),
    creativeRenderFinish: vi.fn(async () => ({ changed: true })),
    creativeReady: vi.fn(async () => []), creativeAssetProposed: vi.fn(async () => true), creativeBrandFile: vi.fn(async () => syntheticPng()),
    creativeLiveAssets: vi.fn(async () => []), creativeOpenTargets: vi.fn(async () => []), creativePerformanceSave: vi.fn(async () => 0), creativeLearningsSave: vi.fn(async () => 0),
    creativeLeads: vi.fn(async () => []), creativeBriefFacts: vi.fn(async () => ({ waiting: 0, learnings: [] })),
    proposeAction: vi.fn(async () => ({ id: `a${++next}`, status: 'proposed', created: true })), enqueue: vi.fn(async () => `task-${++next}`),
    notificationCount: vi.fn(async () => 0), startRun: vi.fn(async () => 'r'), finishRun: vi.fn(async () => undefined),
    creativeHandoff: vi.fn(), creativeRetire: vi.fn(), creativeMarkLive: vi.fn(),
  };
  const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
  const handlers = creativeHandlers({ store, notifier, model, settings: { dailyRenderCap: 40, videoProvider: 'internal' }, publicOrigin: 'https://help.caremetric.ai', marketed, log: () => {} });
  return { store, notifier, handlers, task: (kind, over) => task(kind, { agent: { autonomy, config: {} }, ...over }) };
}
const modelOf = () => ({ configured: true, run: vi.fn(async (_, request) => request.schema.required.includes('concept')
  ? { outcome: 'completed', output: { concept: { bigIdea: 'See the territory', angle: 'territory', visualDirection: 'checklist', landingPageId: 'intel-pricing' }, hero: copyOf('proof') } }
  : { outcome: 'completed', output: { variants: [copyOf('problem', 'headline'), copyOf('curiosity', 'headline'), { ...copyOf('offer', 'headline'), headline: 'Guaranteed referrals for your agency' }] } }) });

// Settings → Creative, as hub-settings `get` answers (the defaults unless given).
const settingsOf = (values = {}) => key => ({ 'creative.enabled': false, 'creative.daily_render_cap': 40, 'creative.video_provider': 'internal', ...values })[key];

describe('registration', () => {
  it('registers when the database declares the feature, and works only while Settings → Creative turns it on', async () => {
    const features = new Set([creativeFeature]);
    expect(creativeTeam({ creative: creativeConfig({}, settingsOf({ 'creative.enabled': true })), features: new Set() }).enabled()).toBe(false);
    expect(Object.keys(creativeTeam({ creative: creativeConfig({}, settingsOf({ 'creative.enabled': true })), features: new Set() }).handlers({}))).toEqual([]);
    // Read on each use: switching it in Settings applies without a restart.
    let on = false;
    const team = creativeTeam({ creative: () => creativeConfig({}, settingsOf({ 'creative.enabled': on })), features });
    const handlers = team.handlers({ store: {}, notifier: {}, model: null });
    expect(Object.keys(handlers).sort()).toEqual(kinds);
    expect(team.enabled()).toBe(false);
    expect(await handlers['creative.render'](task('creative.render'), { now })).toEqual({ result: { skipped: 'creative_off' } });
    on = true;
    expect(team.enabled()).toBe(true);
  });

  it('reads Settings → Creative with safe defaults, and HeyGen only with its key', () => {
    expect(creativeConfig({})).toEqual({ enabled: false, dailyRenderCap: 40, countySnapshotsPerWeek: 3, visionReview: false, visionMinScore: 3, videoProvider: 'internal', heygenKey: '' });
    expect(creativeConfig({}, settingsOf({ 'creative.vision_review': true, 'creative.vision_min_score': 4 }))).toMatchObject({ visionReview: true, visionMinScore: 4 });
    expect(creativeConfig({}, settingsOf({ 'creative.vision_review': 'yes', 'creative.vision_min_score': 9 }))).toMatchObject({ visionReview: false, visionMinScore: 3 });
    expect(creativeConfig({}, settingsOf({ 'creative.county_snapshots_per_week': 0 })).countySnapshotsPerWeek).toBe(0);
    expect(creativeConfig({}, settingsOf({ 'creative.county_snapshots_per_week': 9 })).countySnapshotsPerWeek).toBe(3);
    expect(creativeConfig({}, settingsOf({ 'creative.daily_render_cap': 12, 'creative.video_provider': 'heygen' })).videoProvider).toBe('internal');
    expect(creativeConfig({ HUB_HEYGEN_API_KEY: 'k'.repeat(20) }, settingsOf({ 'creative.daily_render_cap': 12, 'creative.video_provider': 'heygen' }))).toMatchObject({ dailyRenderCap: 12, videoProvider: 'heygen' });
    expect(creativeConfig({}, settingsOf({ 'creative.daily_render_cap': -1 })).dailyRenderCap).toBe(40);
    expect(creativeConfig({}, settingsOf({ 'creative.daily_render_cap': 0 })).dailyRenderCap).toBe(0);
    // The old variables are not read.
    expect(creativeConfig({ HUB_CREATIVE_ENABLED: 'true' }).enabled).toBe(false);
  });

  it('wires into the AI team when the database has it, with its executors, and its status follows the setting', () => {
    const store = { creativeHandoff: vi.fn(), creativeRetire: vi.fn(), creativeApproved: vi.fn(), creativeMarkLive: vi.fn(), enqueue: vi.fn() };
    const base = { store, enabled: false, features: new Set([creativeFeature]), sms: null, email: null, ownerEmail: '', publicOrigin: 'https://help.caremetric.ai' };
    let enabled = false;
    const team = agentTeam({ ...base, creative: () => creativeConfig({}, settingsOf({ 'creative.enabled': enabled })) });
    expect(team.scheduler.kinds().filter(kind => kind.startsWith('creative.'))).toEqual(kinds);
    const without = agentTeam({ ...base, features: new Set(), creative: creativeConfig({}, settingsOf({ 'creative.enabled': true })) });
    expect(without.scheduler.kinds().filter(kind => kind.startsWith('creative.'))).toEqual([]);
  });
});

describe('the work', () => {
  it('turns plan output into briefs and queues drafting, writing nothing in Observe', async () => {
    const { store, handlers, task: make } = harness({ model: modelOf() });
    const done = await handlers['creative.plan'](make('creative.plan'), { now });
    expect(done.result).toMatchObject({ inputs: 1, briefs: 1 });
    expect(store.creativeBriefCreate).toHaveBeenCalledWith(expect.objectContaining({ product: 'caremetric-intel', platforms: ['meta'], formats: ['static', 'video'], source: 'social.plan', planRef: 'social.post:a1' }));
    expect(store.enqueue).toHaveBeenCalledWith('creative_director', 'creative.request', `creative:brief:${briefId}`, expect.objectContaining({ payload: { briefId } }));
    const observed = harness({ autonomy: 'observe', model: modelOf() });
    expect((await observed.handlers['creative.plan'](observed.task('creative.plan'), { now })).result.skipped).toBe('observe_only');
    expect(observed.store.creativeBriefCreate).not.toHaveBeenCalled();
  });

  it('aims Intel briefs at every kind of organization Intel is for, keeping the one a plan item names', async () => {
    const { store, handlers, task: make } = harness({ model: modelOf() });
    store.creativePlanInputs.mockResolvedValue([
      { ref: 'social.post:a1', source: 'social.plan', product: 'caremetric-intel', platform: 'facebook', pillar: 'capability', text: 'See your territory.' },
      { ref: 'social.post:a2', source: 'social.plan', product: 'caremetric-intel', platform: 'linkedin', pillar: 'tip', text: 'Plan the week by county.' },
      { ref: 'social.post:a3', source: 'social.plan', product: 'caremetric-intel', platform: 'facebook', pillar: 'resource', text: 'How hospital liaisons plan their visits.' },
      { ref: 'social.post:a4', source: 'social.plan', product: 'caremetric-intel', platform: 'linkedin', pillar: 'offer', text: 'The Founders Sale.' },
    ]);
    await handlers['creative.plan'](make('creative.plan'), { now });
    const audiences = store.creativeBriefCreate.mock.calls.map(([brief]) => brief.audience);
    expect(audiences).toHaveLength(4);
    expect(new Set(audiences).size).toBe(4);
    expect(audiences.filter(audience => /home health|hospice/.test(audience)).length).toBeLessThanOrEqual(2);
    expect(store.creativeBriefCreate.mock.calls.find(([brief]) => brief.planRef === 'social.post:a3')[0].audience).toMatch(/ at hospitals$/);
    // Each brief also leads with a different part of what Intel does.
    const focuses = store.creativeBriefCreate.mock.calls.map(([brief]) => /^Feature focus: ([^(]+) \(/.exec(brief.angle)?.[1]);
    expect(focuses.every(Boolean)).toBe(true);
    expect(new Set(focuses).size).toBe(4);
  });

  it('drafts a brief: concept on the quality tier, variants on the draft tier, every word checked, a failing variant blocked', async () => {
    const model = modelOf();
    const { store, handlers, task: make } = harness({ model });
    const done = await handlers['creative.request'](make('creative.request', { payload: { briefId } }), { now });
    expect(model.run.mock.calls.map(([, request]) => request.tier)).toEqual(['quality', 'draft']);
    expect(done.result).toMatchObject({ briefId, variants: 4 });
    const rows = store.creativeDraftsSave.mock.calls[0][2];
    expect(rows.map(row => row.hookType)).toEqual(['proof', 'problem', 'curiosity', 'offer']);
    expect(rows.find(row => row.hookType === 'offer').compliance.verdict).toBe('block');
    expect(rows.find(row => row.hookType === 'proof').compliance.verdict).not.toBe('block');
    expect(rows[0].landingBase).toBe('https://www.caremetricintel.com/#pricing');
    expect(store.creativeBriefFinish).toHaveBeenLastCalledWith(briefId, 'done', { variants: 4, drafts: 3, blocked: 1 });
    expect(store.proposeAction).not.toHaveBeenCalled();
  });

  it('leaves a brief for a product the owner does not market', async () => {
    const { store, handlers, task: make } = harness({ model: modelOf(), marketed: ['carebase'] });
    expect((await handlers['creative.request'](make('creative.request', { payload: { briefId } }), { now })).result.skipped).toBe('product_not_marketed');
    expect(store.creativeBriefFinish).toHaveBeenCalledWith(briefId, 'skipped', { reason: 'product_not_marketed' });
  });

  it('renders and proposes a passing asset, blocks a failing one before rendering, and never hands anything over itself', async () => {
    const passing = { id: assetId, product: 'caremetric-intel', platform: 'meta', placement: 'meta.feed_square', kind: 'static', layout: 'checklist', width: 1080, height: 1080,
      variantLabel: 'A', hookType: 'proof', ...copyOf('proof'), overlay: copyOf('proof').overlay, offerCode: null, brandKit: fullKit, landingUrl: 'https://www.caremetricintel.com/?utm_content=x' };
    const failing = { ...passing, id: '33333333-3333-4333-8333-333333333333', headline: 'Guaranteed referrals' };
    const { store, notifier, handlers, task: make } = harness({ claimed: [passing, failing] });
    const done = await handlers['creative.render'](make('creative.render'), { now });
    expect(done.result).toMatchObject({ rendered: 1, proposed: 1, blocked: 1 });
    expect(store.creativeRenderFinish).toHaveBeenCalledWith(failing.id, 'blocked', null, null, expect.objectContaining({ verdict: 'block' }), {});
    const ready = store.creativeRenderFinish.mock.calls.find(([id, outcome]) => id === assetId && outcome === 'ready');
    expect(ready[3]).toBe('image/png');
    expect(Buffer.isBuffer(ready[2])).toBe(true);
    const proposed = store.proposeAction.mock.calls[0][0];
    expect(proposed).toMatchObject({ kind: expect.stringMatching(/^creative\.asset(_review)?$/), targetKind: 'creative_asset', targetId: assetId });
    expect(proposed.preview).toContain('Compliance:');
    expect(store.creativeAssetProposed).toHaveBeenCalledWith(assetId, 'a1');
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'creative:ready:2026-11-09' }));
    expect(store.creativeHandoff).not.toHaveBeenCalled();
    expect(store.creativeMarkLive).not.toHaveBeenCalled();
  }, 60_000);

  it('queues images blocked only by checks this release corrects once, with the review on or off, before rendering', async () => {
    for (const visionReview of [true, false]) {
      const h = harness();
      h.store.creativeRenderRequeue = vi.fn(async () => 3);
      const handlers = creativeHandlers({ store: h.store, notifier: h.notifier, model: null, settings: { dailyRenderCap: 40, videoProvider: 'internal', visionReview },
        publicOrigin: 'https://help.caremetric.ai', log: () => {} });
      const done = await handlers['creative.render'](h.task('creative.render'), { now });
      expect(h.store.creativeRenderRequeue).toHaveBeenCalledWith(visionReview);
      expect(done.result.requeued).toBe(3);
    }
    // A database without the operation renders as before.
    const plain = await harness().handlers['creative.render'](task('creative.render'), { now });
    expect(plain.result.requeued).toBeUndefined();
  });

  it('has a model look at each finished image while the review is on: a visible defect blocks it, a weak one warns, an unreviewed one warns', async () => {
    const asset = { id: assetId, product: 'caremetric-intel', platform: 'meta', placement: 'meta.feed_square', kind: 'static', layout: 'checklist', width: 1080, height: 1080,
      variantLabel: 'A', hookType: 'proof', ...copyOf('proof'), overlay: copyOf('proof').overlay, offerCode: null, brandKit: fullKit, landingUrl: 'https://www.caremetricintel.com/?utm_content=x' };
    const review = output => ({ configured: true, run: vi.fn(async () => (output instanceof Error ? Promise.reject(output) : { outcome: 'completed', output })) });
    const go = async (model, visionReview = true) => {
      const h = harness({ claimed: [asset] });
      const handlers = creativeHandlers({ store: h.store, notifier: h.notifier, model, settings: { dailyRenderCap: 40, videoProvider: 'internal', visionReview, visionMinScore: 3 },
        publicOrigin: 'https://help.caremetric.ai', log: () => {} });
      const done = await handlers['creative.render'](h.task('creative.render'), { now });
      return { ...h, done, finish: h.store.creativeRenderFinish.mock.calls.find(([id]) => id === assetId) };
    };
    const ok = { textSeen: 'x', defects: [], score: 4, reader: 'Clear.', fix: 'None.' };

    const cut = await go(review({ ...ok, defects: [{ kind: 'text_cut_off', where: 'the checklist' }] }));
    expect(cut.done.result).toMatchObject({ blocked: 1, proposed: 0 });
    expect(cut.finish[1]).toBe('blocked');
    expect(cut.finish[4]).toMatchObject({ verdict: 'block', review: { score: 4, defects: [{ kind: 'text_cut_off', where: 'the checklist' }] } });
    expect(cut.store.proposeAction).not.toHaveBeenCalled();

    const weak = await go(review({ ...ok, score: 2 }));
    expect(weak.finish[1]).toBe('ready');
    expect(weak.finish[4]).toMatchObject({ verdict: 'warn', review: { score: 2 } });
    expect(weak.store.proposeAction.mock.calls[0][0].kind).toBe('creative.asset_review');

    const failed = await go(review(Object.assign(new Error('x'), { code: 'ai_unavailable', transient: true })));
    expect(failed.finish[4].reasons.map(item => item.rule)).toContain('vision_unreviewed');
    expect(failed.store.proposeAction.mock.calls[0][0].kind).toBe('creative.asset_review');

    // On with no model to look: shown with a warning, never passed unseen (a pass could be approved on its own).
    const unconfigured = await go({ configured: false, run: vi.fn() });
    expect(unconfigured.finish[4]).toMatchObject({ verdict: 'warn', review: { skipped: 'model_not_configured' } });
    expect(unconfigured.store.proposeAction.mock.calls[0][0].kind).toBe('creative.asset_review');

    const model = review(ok);
    const off = await go(model, false);
    expect(model.run).not.toHaveBeenCalled();
    expect(off.finish[4].review).toBeUndefined();
    // The rendered PNG itself is what the model was shown.
    const seen = review(ok);
    const shown = await go(seen);
    expect(seen.run.mock.calls[0][1].images[0].data).toBe(Buffer.from(shown.finish[2]).toString('base64'));
  }, 60_000);

  it('renders a product whose brand kit is blank in its own brand theme', async () => {
    const blank = { product: 'carebase', logoFileId: null, screenshots: [], requiredDisclaimers: [], bannedPhrases: [], captionsDefault: true };
    const asset = { id: assetId, product: 'carebase', platform: 'meta', placement: 'meta.feed_square', kind: 'static', layout: 'headline', width: 1080, height: 1080,
      variantLabel: 'A', hookType: 'proof', ...copyOf('proof', 'headline'), headline: 'Training records in one place',
      primaryText: 'CareMetric CareBase keeps staff training, resident records and survey documentation in one place.', offerCode: null, brandKit: blank, landingUrl: 'https://cmcarebase.com/?utm_content=x' };
    const { store, handlers, task: make } = harness({ claimed: [asset] });
    expect((await handlers['creative.render'](make('creative.render'), { now })).result).toMatchObject({ rendered: 1, blocked: 0 });
    const ready = store.creativeRenderFinish.mock.calls.find(([id, outcome]) => id === assetId && outcome === 'ready');
    expect(ready[4].reasons.filter(item => item.level === 'block')).toEqual([]);
  }, 60_000);

  it('proposes retiring tired creative (never retires it) and briefs new variants of winners', async () => {
    const tired = '44444444-4444-4444-8444-444444444444';
    const link = id => `https://www.caremetricintel.com/?utm_source=meta&utm_medium=paid&utm_campaign=creative-1&utm_content=${id}`;
    const meta = { configured: { ads: true }, adsOverview: vi.fn(async () => ({
      ads: [{ id: 'ad1', copy: { link: link(assetId) } }, { id: 'ad2', copy: { link: link(tired) } }],
      current: [{ adId: 'ad1', impressions: 4000, clicks: 120, spendCents: 4000, frequency: 2 }, { adId: 'ad2', impressions: 4000, clicks: 40, spendCents: 6000, frequency: 3.6 }],
      previous: [{ adId: 'ad1', impressions: 4000, clicks: 110, spendCents: 4000, frequency: 1.5 }, { adId: 'ad2', impressions: 4000, clicks: 80, spendCents: 4000, frequency: 2 }],
    })) };
    const live = [assetId, tired].map(id => ({ id, product: 'caremetric-intel', platform: 'meta', placement: 'meta.feed_square', kind: 'static', layout: 'headline', hookType: 'proof', headline: 'H', variantLabel: 'A', status: 'live' }));
    const store = harness().store;
    store.creativeLiveAssets.mockResolvedValue(live);
    const handlers = creativeHandlers({ store, notifier: { send: vi.fn(async () => [{ delivery: 'sent' }]) }, meta, settings: {}, log: () => {} });
    const done = await handlers['creative.refresh'](task('creative.refresh'), { now });
    expect(done.result).toMatchObject({ assets: 2, retired: 1, refreshed: 1 });
    expect(store.proposeAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'creative.retire', targetId: tired }));
    expect(store.creativeBriefCreate).toHaveBeenCalledWith(expect.objectContaining({ source: 'refresh', parentAssetId: assetId }));
    expect(store.creativeRetire).not.toHaveBeenCalled();
  });

  it('reports weekly with learnings, once per week unless the owner asks', async () => {
    const { store, notifier, handlers, task: make } = harness();
    await handlers['creative.report'](make('creative.report'), { now });
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'creative:report:2026-11-09' }));
    store.notificationCount.mockResolvedValue(1);
    expect((await handlers['creative.report'](make('creative.report'), { now })).result.skipped).toBe('already_sent');
  });
});

describe('no side effect without an approved action', () => {
  const execution = (over = {}) => ({ id: 'act1', kind: 'creative.asset', targetKind: 'creative_asset', targetId: assetId, input: { assetId }, autoApproved: false, execution: 1, ...over });

  it('hands over only what the database confirms for the execution it started', async () => {
    const store = { creativeHandoff: vi.fn(async () => ({ handedOver: true, assetId })), creativeRetire: vi.fn(async () => ({ retired: true, assetId })) };
    const run = creativeExecutors({ store });
    expect(await run['creative.asset'](execution())).toEqual({ handedOver: true, assetId, already: false });
    expect(store.creativeHandoff).toHaveBeenCalledWith('act1', 1);
    store.creativeHandoff.mockResolvedValueOnce({ handedOver: false, reason: 'approval_required' });
    await expect(run['creative.asset'](execution({ autoApproved: true }))).rejects.toMatchObject({ code: 'approval_required' });
    await expect(run['creative.asset_review'](execution({ kind: 'creative.asset_review', autoApproved: true }))).rejects.toMatchObject({ code: 'auto_approved_refused' });
    await expect(run['creative.asset'](execution({ input: { assetId: 'other' } }))).rejects.toMatchObject({ code: 'invalid_creative_action' });
    expect(await run['creative.retire'](execution({ kind: 'creative.retire' }))).toEqual({ retired: true, assetId, already: false });
  });

  it('never runs an executor for an action the database did not start (nobody approved it)', async () => {
    const executor = vi.fn(async () => ({}));
    const store = { beginExecution: vi.fn(async () => null), completeExecution: vi.fn(), readyActions: vi.fn(async () => [{ id: 'act1', kind: 'creative.asset' }]) };
    const actions = actionExecutor({ store, executors: { 'creative.asset': executor }, log: () => {} });
    expect(await actions.executeOne('act1', { kind: 'creative.asset' })).toEqual({ executed: false, failed: false, skipped: true });
    await actions.executeReady();
    expect(executor).not.toHaveBeenCalled();
    expect(store.completeExecution).not.toHaveBeenCalled();
  });
});

describe('county snapshots', () => {
  const counties = [{ countyFips: '42003', state: 'PA', agencies: 9 }, { countyFips: '42101', state: 'PA', agencies: 7 }];
  const answer = { counties: [
    { county_fips: '42003', county_name: 'Allegheny', state: 'PA', figures: [{ key: 'medicare_beneficiaries', label: 'x', value: 250000, unit: 'count', data_year: '2026', period: '2026-06',
      dataset: 'CMS Medicare Monthly Enrollment', source_line: 's', short_source: 'CMS Medicare Monthly Enrollment, 2026' }] },
    { county_fips: '42101', county_name: 'Philadelphia', state: 'PA', figures: [] },
  ] };
  const setup = ({ perWeek = 3, configured = true, fail = false } = {}) => {
    const h = harness({ model: modelOf() });
    h.store.creativeDataCounties = vi.fn(async () => counties);
    const feed = { configured, countyFigures: vi.fn(async () => { if (fail) throw Object.assign(new Error('x'), { code: 'feed_unavailable', transient: true }); return answer; }) };
    const handlers = creativeHandlers({ store: h.store, notifier: h.notifier, model: modelOf(), feed, settings: { dailyRenderCap: 40, videoProvider: 'internal', countySnapshotsPerWeek: perWeek },
      publicOrigin: 'https://help.caremetric.ai', log: () => {} });
    return { ...h, handlers, feed };
  };

  it('opens one brief for each county the data can picture, within the week\'s number, keyed to the county and week', async () => {
    const { handlers, store, feed, task: make } = setup();
    const done = await handlers['creative.plan'](make('creative.plan'), { now });
    expect(store.creativeDataCounties).toHaveBeenCalledWith(3, '2026-11-09T05:00:00.000Z');
    expect(feed.countyFigures).toHaveBeenCalledWith({ countyFips: ['42003', '42101'] });
    const opened = store.creativeBriefCreate.mock.calls.map(([item]) => item).filter(item => item.source === 'data.county');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ requestKey: 'data:county:42003:2026-11-09', facts: { stat: '250,000', statSource: 'CMS Medicare Monthly Enrollment, 2026' } });
    expect(done.result.snapshots).toBe(1);
  });

  it('opens none while the number is 0, the feed is not set up or cannot answer', async () => {
    for (const options of [{ perWeek: 0 }, { configured: false }, { fail: true }]) {
      const { handlers, store, task: make } = setup(options);
      const done = await handlers['creative.plan'](make('creative.plan'), { now });
      expect(store.creativeBriefCreate.mock.calls.some(([item]) => item.source === 'data.county')).toBe(false);
      expect(done.result.snapshots).toBeUndefined();
    }
  });

  it('says why a run opened no snapshot', async () => {
    const reasons = [];
    for (const options of [{ perWeek: 0 }, { configured: false }, { fail: true }]) {
      const { handlers, task: make } = setup(options);
      reasons.push((await handlers['creative.plan'](make('creative.plan'), { now })).result.snapshotsSkipped);
    }
    expect(reasons).toEqual(['off', 'feed_not_configured', 'feed_unavailable']);
  });

  it('pictures every county of the roster\'s states, each about one care setting, and sends agencies to their own market report', async () => {
    const h = harness({ model: modelOf() });
    // Forest County has no agency located in it: it comes from Intel's county list. Erie has only hospices on the roster.
    h.store.creativeDataCountiesAll = vi.fn(async () => [{ countyFips: '42053', state: 'PA', agencies: 0, homeHealth: 0, hospice: 0, lastSetting: 'home_health' },
      { countyFips: '42049', state: 'PA', agencies: 4, homeHealth: 0, hospice: 4, lastSetting: null }]);
    const figure = (key, value, setting, unit = 'count') => ({ key, label: key, value, unit, setting, data_year: '2024', period: '2024', dataset: 'CMS', source_line: 's', short_source: `CMS ${key}, 2024` });
    const feed = { configured: true,
      counties: vi.fn(async () => ({ counties: [{ county_fips: '42049', county_name: 'Erie', state: 'PA' }, { county_fips: '42053', county_name: 'Forest', state: 'PA' }] })),
      countyFigures: vi.fn(async () => ({ counties: [
        { county_fips: '42053', county_name: 'Forest', state: 'PA', figures: [figure('home_health_agencies_billing', 9, 'home_health'), figure('hospices_billing', 6, 'hospice')] },
        { county_fips: '42049', county_name: 'Erie', state: 'PA', figures: [figure('home_health_top3_share', 0.61, 'home_health', 'fraction'), figure('hospice_top3_share', 0.72, 'hospice', 'fraction')] },
      ] })) };
    const handlers = creativeHandlers({ store: h.store, notifier: h.notifier, model: modelOf(), feed, states: () => ['PA'],
      settings: { dailyRenderCap: 40, videoProvider: 'internal', countySnapshotsPerWeek: 3 }, publicOrigin: 'https://help.caremetric.ai', log: () => {} });
    const done = await handlers['creative.plan'](h.task('creative.plan'), { now });
    expect(feed.counties).toHaveBeenCalledWith({ states: ['PA'] });
    expect(h.store.creativeDataCountiesAll).toHaveBeenCalledWith(3, '2026-11-09T05:00:00.000Z', [{ countyFips: '42049', state: 'PA' }, { countyFips: '42053', state: 'PA' }]);
    expect(done.result.snapshots).toBe(2);
    const opened = new Map(h.store.creativeBriefCreate.mock.calls.map(([item]) => item).filter(item => item.source === 'data.county').map(item => [item.facts.countyFips, item]));
    // Forest was pictured for home health last time, so hospice now; Erie has only hospices, so hospice.
    expect(opened.get('42053')).toMatchObject({ facts: { setting: 'hospice', stat: '6', statLabel: 'hospices billed Medicare for Forest County, PA residents', landing: 'intel-market-review' },
      audience: 'Owners, administrators and marketers at hospices serving Forest County, PA' });
    expect(opened.get('42049')).toMatchObject({ facts: { setting: 'hospice', figure: 'hospice_top3_share', stat: '72%',
      statLabel: 'of the Medicare patients of Erie County, PA hospices went to the 3 largest' } });
    for (const item of opened.values()) expect(`${item.goal} ${item.angle}`).not.toMatch(/home health/i);
  });

  it('sends a snapshot\'s drafts to the free market report, whatever page the concept chose', async () => {
    const snapshotBrief = { ...brief, source: 'data.county', facts: { stat: '9', statLabel: 'home health agencies billed Medicare for Forest County, PA residents', statSource: 'CMS, 2024',
      dataYear: '2024', place: 'Forest County, PA', setting: 'home_health', landing: 'intel-market-review' } };
    const { store, task: make } = setup();
    store.creativeBriefContext.mockResolvedValue({ brief: snapshotBrief, brandKit: fullKit, parent: null, learnings: [], recentHeadlines: [] });
    const withModel = creativeHandlers({ store, notifier: { send: vi.fn() }, model: modelOf(), settings: { dailyRenderCap: 40, videoProvider: 'internal' }, publicOrigin: 'https://help.caremetric.ai', log: () => {} });
    await withModel['creative.request'](make('creative.request', { payload: { briefId } }), { now });
    expect(store.creativeDraftsSave.mock.calls[0][2].every(row => row.landingBase === 'https://www.caremetricintel.com/market-review')).toBe(true);
  });

  it('draws every draft of a snapshot brief as the data\'s figure, and the model\'s own numbers block it', async () => {
    const snapshotBrief = { ...brief, source: 'data.county', facts: { stat: '250,000', statLabel: 'people on Medicare in Allegheny County, PA', statSource: 'CMS Medicare Monthly Enrollment, 2026',
      dataYear: '2026', place: 'Allegheny County, PA' } };
    const { handlers, store, task: make } = setup();
    store.creativeBriefContext.mockResolvedValue({ brief: snapshotBrief, brandKit: fullKit, parent: null, learnings: [], recentHeadlines: [] });
    const model = modelOf();
    const withModel = creativeHandlers({ store, notifier: { send: vi.fn() }, model, settings: { dailyRenderCap: 40, videoProvider: 'internal' }, publicOrigin: 'https://help.caremetric.ai', log: () => {} });
    await withModel['creative.request'](make('creative.request', { payload: { briefId } }), { now });
    expect(JSON.parse(model.run.mock.calls[0][1].user).data).toEqual({ place: 'Allegheny County, PA', figure: '250,000 people on Medicare in Allegheny County, PA', source: 'CMS Medicare Monthly Enrollment, 2026' });
    const rows = store.creativeDraftsSave.mock.calls[0][2];
    expect(rows.every(row => row.layout === 'stat' && row.overlay.stat === '250,000' && row.overlay.statSource === 'CMS Medicare Monthly Enrollment, 2026')).toBe(true);
    // The plain hero passes; the variant promising referrals is blocked as before.
    expect(rows.some(row => row.compliance.verdict !== 'block')).toBe(true);
    void handlers;
  });

  // Review 2026-11-17: every county snapshot was blocked at render, because the render read the code-printed figure as a number the fact
  // sheet does not state. It now checks a snapshot as the draft was checked, against its brief's data.
  it('renders a snapshot\'s stat image against its brief\'s data, and still blocks a figure that differs from it', async () => {
    const facts = { stat: '72%', statLabel: 'of the Medicare patients of Erie County, PA hospices went to the 3 largest', statSource: 'CMS post-acute utilization, 2024',
      dataYear: '2024', place: 'Erie County, PA', setting: 'hospice', landing: 'intel-market-review' };
    const asset = { id: assetId, briefId, product: 'caremetric-intel', platform: 'meta', placement: 'meta.feed_square', kind: 'static', layout: 'stat', width: 1080, height: 1080,
      variantLabel: 'A', hookType: 'curiosity', headline: 'How crowded is your county?', primaryText: 'See where your hospice stands in its county, from public Medicare data.',
      description: 'Free market report', cta: 'Get the report', altText: `County snapshot: ${facts.stat} ${facts.statLabel}. Source: ${facts.statSource}.`,
      overlay: { kicker: '', stat: facts.stat, statLabel: facts.statLabel, statSource: facts.statSource, quote: '', quoteSource: '', offerLine: '', checklist: [], screenshotId: '', beats: [] },
      offerCode: null, brandKit: fullKit, landingUrl: 'https://www.caremetricintel.com/market-review?utm_content=x' };
    const changed = { ...asset, id: '33333333-3333-4333-8333-333333333333', overlay: { ...asset.overlay, stat: '73%' } };
    const { store, handlers, task: make } = harness({ claimed: [asset, changed] });
    store.creativeBriefContext.mockResolvedValue({ brief: { ...brief, source: 'data.county', facts }, brandKit: fullKit, parent: null, learnings: [], recentHeadlines: [] });
    const done = await handlers['creative.render'](make('creative.render'), { now });
    expect(store.creativeBriefContext).toHaveBeenCalledWith(briefId);
    expect(done.result).toMatchObject({ rendered: 1, proposed: 1, blocked: 1 });
    expect(store.creativeRenderFinish).toHaveBeenCalledWith(asset.id, 'ready', expect.any(Buffer), 'image/png', expect.anything(), expect.anything());
    const blocked = store.creativeRenderFinish.mock.calls.find(([id]) => id === changed.id);
    expect(blocked[1]).toBe('blocked');
    expect(blocked[4].reasons.map(item => item.rule)).toContain('data_figure');
  }, 60_000);
});
