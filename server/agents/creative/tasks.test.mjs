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

describe('registration', () => {
  it('registers nothing unless the database declares the feature and HUB_CREATIVE_ENABLED is exactly true', () => {
    const features = new Set([creativeFeature]);
    expect(creativeTeam({ creative: creativeConfig({ HUB_CREATIVE_ENABLED: 'true' }), features: new Set() }).enabled).toBe(false);
    expect(creativeTeam({ creative: creativeConfig({ HUB_CREATIVE_ENABLED: 'yes' }), features }).enabled).toBe(false);
    expect(creativeTeam({ creative: creativeConfig({}), features }).enabled).toBe(false);
    const team = creativeTeam({ creative: creativeConfig({ HUB_CREATIVE_ENABLED: 'true' }), features });
    expect(Object.keys(team.handlers({ store: {}, notifier: {}, model: null })).sort()).toEqual(kinds);
  });

  it('reads its settings with safe defaults', () => {
    expect(creativeConfig({})).toEqual({ enabled: false, dailyRenderCap: 40, videoProvider: 'internal', heygenKey: '' });
    expect(creativeConfig({ HUB_CREATIVE_DAILY_RENDER_CAP: '12', HUB_CREATIVE_VIDEO_PROVIDER: 'heygen' }).videoProvider).toBe('internal');
    expect(creativeConfig({ HUB_CREATIVE_DAILY_RENDER_CAP: '12', HUB_CREATIVE_VIDEO_PROVIDER: 'HeyGen', HUB_HEYGEN_API_KEY: 'k'.repeat(20) })).toMatchObject({ dailyRenderCap: 12, videoProvider: 'heygen' });
    expect(creativeConfig({ HUB_CREATIVE_DAILY_RENDER_CAP: '-1' }).dailyRenderCap).toBe(40);
    expect(creativeConfig({ HUB_CREATIVE_DAILY_RENDER_CAP: '0' }).dailyRenderCap).toBe(0);
  });

  it('wires into the AI team only with both switches, and its executors whenever the database has it', () => {
    const store = { creativeHandoff: vi.fn(), creativeRetire: vi.fn(), creativeApproved: vi.fn(), creativeMarkLive: vi.fn(), enqueue: vi.fn() };
    const base = { store, enabled: false, features: new Set([creativeFeature]), sms: null, email: null, ownerEmail: '', publicOrigin: 'https://help.caremetric.ai' };
    const off = agentTeam({ ...base, creative: creativeConfig({}) });
    expect(off.scheduler.kinds().filter(kind => kind.startsWith('creative.'))).toEqual([]);
    const on = agentTeam({ ...base, creative: creativeConfig({ HUB_CREATIVE_ENABLED: 'true' }) });
    expect(on.scheduler.kinds().filter(kind => kind.startsWith('creative.'))).toEqual(kinds);
    const without = agentTeam({ ...base, features: new Set(), creative: creativeConfig({ HUB_CREATIVE_ENABLED: 'true' }) });
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
