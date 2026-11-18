import { describe, expect, it, vi } from 'vitest';
import { adsConfig, adsFeature, adsTeam, monthLeft } from './index.mjs';
import { handoverFeature } from '../handover.mjs';

// Ad campaign launch handed over (20261115200000_autonomy_handover.sql): campaigns approved by the database under the owner's step are
// launched live with their first ad from approved creative, within the owner's monthly number and daily ad-set limit.
const monday = () => new Date('2026-11-16T14:20:00Z');
const task = over => ({ id: 't1', agentKey: 'social_manager', kind: 'ads.plan', sourceKind: 'schedule', agent: { autonomy: 'propose' }, ...over });
const settingsOf = values => key => ({ 'ads.monthly_budget_cents': 90000, 'ads.meta_audience_id': '1234567', ...values })[key];
const googlePlan = { headlines: ['Referral sources in one place', 'Plan visits by county', 'Free county report'], descriptions: ['CareMetric Intel brings territory analysis and a marketing CRM into one place.', 'Start with the free county report.'],
  keywords: ['home health crm', 'hospice marketing', 'home health marketing software', 'referral source tracking', 'hospice referral tracking'].map(text => ({ text, match: 'PHRASE' })), negatives: ['jobs'] };
const token = 'e'.repeat(64);
const metaAsset = '33333333-3333-4333-8333-333333333333';
const linkedinAsset = '44444444-4444-4444-8444-444444444444';
const asset = (platform, over = {}) => ({ id: platform === 'meta' ? metaAsset : linkedinAsset, token, product: 'caremetric-intel', platform,
  placement: platform === 'meta' ? 'meta.feed_square' : 'linkedin.single_image', kind: 'static', headline: 'Territory plans from Medicare data',
  primaryText: 'CareMetric Intel brings targeted marketing and territory analysis into one place for your team.', description: 'Free trial', cta: 'Start free trial',
  landingUrl: `https://www.caremetricintel.com/?utm_source=meta&utm_medium=paid&utm_campaign=creative-1&utm_content=${metaAsset}`, ...over });
const trusted = { autonomy: 'act', config: { auto_approve_kinds: ['social.campaign_create', 'social.google_campaign'] } };

function setup({ values = {}, googleConfigured = false, approved = platform => [asset(platform)], reservation = (id, execution, daily) => ({ reserved: true, dailyBudgetCents: daily }),
  trust = true, live = [metaAsset, linkedinAsset], adFails = false, startFails = false, googleRefuses = false, handover = true, now = monday } = {}) {
  const store = {
    socialCampaignProposed: vi.fn(async () => false), proposeAction: vi.fn(async input => ({ id: `a-${input.targetId}`, created: true, status: 'auto_approved' })),
    actionTrusted: vi.fn(async () => trust), adsLaunchReserve: vi.fn(async (...args) => reservation(...args)), adsLaunchRelease: vi.fn(async () => true),
    creativeLiveAssets: vi.fn(async () => live.map(id => ({ id, platform: id === metaAsset ? 'meta' : 'linkedin', status: 'live' }))),
  };
  const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
  const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: googlePlan })) };
  const meta = { configured: { ads: true, pages: true }, createCampaign: vi.fn(async () => ({ campaignId: '601', adsetId: '602' })), startCampaign: vi.fn(async () => ({ started: true })),
    createAd: vi.fn(async () => { if (adFails) throw Object.assign(new Error('refused'), { code: 'meta_invalid_request' }); return { id: '603', creativeId: '604' }; }) };
  const linkedin = { configured: { ads: true, page: true }, createCampaign: vi.fn(async () => ({ campaignGroupId: '701', campaignId: '702' })),
    startCampaign: vi.fn(async () => { if (startFails) throw Object.assign(new Error('unknown'), { code: 'linkedin_unavailable' }); return { started: true }; }),
    createAd: vi.fn(async () => ({ id: '703', postId: 'urn:li:share:7100000000000000020' })) };
  const googleClient = { configured: googleConfigured, createSearchCampaign: vi.fn(async ({ live: running }) => {
    if (running && googleRefuses) throw Object.assign(new Error('refused'), { code: 'google_invalid_request' });
    return { campaign: 'customers/1/campaigns/5' };
  }) };
  const creative = { approved: vi.fn(async ({ platform }) => approved(platform)), live: vi.fn(async () => true) };
  const team = adsTeam({ ads: () => adsConfig({}, settingsOf(values)), features: new Set(handover ? [adsFeature, handoverFeature] : [adsFeature]), googleClient });
  const handlers = team.handlers({ store, notifier, model, meta, linkedin, social: { maxDailyBudgetCents: 0 }, marketed: ['caremetric-intel'], creative, publicOrigin: 'https://help.caremetric.ai', log: () => {} });
  const executors = team.executors({ meta, linkedin, social: { maxDailyBudgetCents: 0 }, notifier, store, creative, publicOrigin: 'https://help.caremetric.ai', log: () => {}, now });
  return { store, notifier, meta, linkedin, googleClient, creative, handlers, executors };
}

describe('the monthly plan with ad campaign launch handed over', () => {
  it('gives each campaign its first ad from approved creative and shares the month\'s number among those starting on their own', async () => {
    const h = setup();
    const done = await h.handlers['ads.plan'](task({ agent: trusted }), { now: monday });
    const proposals = h.store.proposeAction.mock.calls.map(([item]) => item);
    expect(proposals.map(item => item.targetId)).toEqual(['linkedin:caremetric-intel:2026-11', 'meta:caremetric-intel:2026-11', 'google:caremetric-intel:2026-11']);
    // LinkedIn and Meta launch live (approved creative fits both); Google is emailed as before (no API), so it takes no share.
    expect(proposals[0].input).toMatchObject({ dailyBudgetCents: 1500, firstAd: { creativeAssetId: linkedinAsset, imageUrl: `https://help.caremetric.ai/api/creative/a/${token}.png`, callToAction: 'SIGN_UP' } });
    expect(proposals[1].input).toMatchObject({ dailyBudgetCents: 1500, audienceId: '1234567', firstAd: { creativeAssetId: metaAsset } });
    expect(proposals[1].preview).toContain('You handed ad campaign launch over, so it starts on its own');
    expect(proposals[1].preview).toContain('runs until 2026-11-30');
    expect(proposals[1].preview).toContain('shared by the 2 campaigns starting on their own this month');
    expect(proposals[2].input.dailyBudgetCents).toBe(3000);
    expect(proposals[2].preview).toContain('the Google Ads API is not set up, so it is emailed to you as an import file, paused, as before');
    expect(done).toMatchObject({ status: 'done', result: { proposed: 3, automatic: 3 } });
    expect(h.notifier.send.mock.calls[0][0].subject).toBe('Paid ads: 3 new campaigns starting on their own');
    // With the Google Ads API set up, the search campaign takes a share too.
    const online = setup({ googleConfigured: true });
    await online.handlers['ads.plan'](task({ agent: trusted }), { now: monday });
    expect(online.store.proposeAction.mock.calls.map(([item]) => item.input.dailyBudgetCents)).toEqual([1000, 1000, 1000]);
  });

  it('plans as before without approved creative that fits, without the hand-over in the database, or without the owner\'s trust', async () => {
    const bare = setup({ approved: platform => [asset(platform, { primaryText: 'We guarantee results.' })] });
    await bare.handlers['ads.plan'](task({ agent: trusted }), { now: monday });
    const [linkedin, meta] = bare.store.proposeAction.mock.calls.map(([item]) => item);
    expect(meta.input.firstAd).toBeUndefined();
    expect(meta.input.dailyBudgetCents).toBe(3000);
    expect(meta.preview).toContain('none of your approved creative fits it yet, so it is created paused with no ads');
    expect(linkedin.preview).toContain('created as a draft with no ads');
    // The hand-over not in the database (a trusted agent notwithstanding), or the agent not trusted with campaigns: the owner's way.
    for (const [h, agent] of [[setup({ handover: false }), trusted], [setup(), { autonomy: 'propose' }], [setup(), { autonomy: 'act', config: { auto_approve_kinds: ['social.post'] } }]]) {
      await h.handlers['ads.plan'](task({ agent }), { now: monday });
      const proposals = h.store.proposeAction.mock.calls.map(([item]) => item);
      expect(proposals).toHaveLength(3);
      expect(proposals.every(item => item.input.firstAd === undefined && !item.preview.includes('handed ad campaign launch over'))).toBe(true);
      expect(proposals.map(item => item.input.dailyBudgetCents)).toEqual([3000, 3000, 3000]);
      expect(h.creative.approved).not.toHaveBeenCalled();
    }
  });
});

describe('launching a campaign approved under the hand-over', () => {
  const metaInput = { platform: 'meta', product: 'caremetric-intel', name: 'CareMetric Intel retargeting 2026-11', dailyBudgetCents: 1500, audienceId: '1234567',
    firstAd: { name: 'Intel retargeting · creative 33333333', message: 'CareMetric Intel brings targeted marketing and territory analysis into one place for your team.', headline: 'Territory plans from Medicare data',
      description: 'Free trial', link: `https://www.caremetricintel.com/?utm_source=meta&utm_medium=paid&utm_campaign=creative-1&utm_content=${metaAsset}`,
      callToAction: 'SIGN_UP', imageUrl: `https://help.caremetric.ai/api/creative/a/${token}.png`, creativeAssetId: metaAsset } };
  const auto = (input, over = {}) => ({ id: 'a9', kind: 'social.campaign_create', agentKey: 'social_manager', taskId: 't1', targetId: 'meta:caremetric-intel:2026-11', input, autoApproved: true, execution: 2, ...over });

  it('launches a Meta campaign live: reserved, created paused to its month\'s end, its first ad put in, then started', async () => {
    const h = setup();
    const result = await h.executors['social.campaign_create'](auto(metaInput));
    expect(result).toEqual({ created: true, campaignId: '601', adsetId: '602', adId: '603', launched: true, dailyBudgetCents: 1500, endsOn: '2026-11-30' });
    expect(h.store.actionTrusted).toHaveBeenCalledWith('a9', 2);
    expect(h.store.adsLaunchReserve).toHaveBeenCalledWith('a9', 2, 1500, 500, 15);
    expect(h.meta.createCampaign).toHaveBeenCalledWith({ name: metaInput.name, dailyBudgetCents: 1500, lifetimeBudgetCents: 22500, audienceId: '1234567', startAt: '2026-11-16T14:20:00.000Z', endAt: '2026-12-01T04:59:59.000Z' });
    expect(h.meta.createAd.mock.calls[0][0]).toMatchObject({ adsetId: '602', message: metaInput.firstAd.message, imageUrl: metaInput.firstAd.imageUrl, callToAction: 'SIGN_UP' });
    expect(h.creative.live).toHaveBeenCalledWith(metaAsset, '603');
    expect(h.meta.startCampaign).toHaveBeenCalledWith({ campaignId: '601', adsetId: '602' });
    expect(h.meta.createAd.mock.invocationCallOrder[0]).toBeLessThan(h.meta.startCampaign.mock.invocationCallOrder[0]);
    expect(h.notifier.send.mock.calls[0][0].subject).toBe('New Meta campaign started: CareMetric Intel retargeting 2026-11');
  });

  it('starts with less, or paused, when the month\'s number is nearly used, and never above the limits', async () => {
    const lowered = setup({ reservation: () => ({ reserved: true, dailyBudgetCents: 600 }) });
    expect((await lowered.executors['social.campaign_create'](auto(metaInput))).dailyBudgetCents).toBe(600);
    expect(lowered.meta.createCampaign.mock.calls[0][0]).toMatchObject({ dailyBudgetCents: 600, lifetimeBudgetCents: 9000 });
    const used = setup({ reservation: () => ({ reserved: false, reason: 'monthly_budget_used' }) });
    expect(await used.executors['social.campaign_create'](auto(metaInput))).toEqual({ created: true, campaignId: '601', adsetId: '602', launched: false, reason: 'monthly_budget_used' });
    expect(used.meta.createCampaign).toHaveBeenCalledWith({ name: metaInput.name, dailyBudgetCents: 1500, audienceId: '1234567' });
    expect(used.meta.createAd).not.toHaveBeenCalled();
    expect(used.meta.startCampaign).not.toHaveBeenCalled();
    expect(used.notifier.send.mock.calls[0][0].body).toContain('Too little of this month\'s number is left');
    // A daily budget above what the month's number now allows is refused before anything is created or reserved.
    const smaller = setup({ values: { 'ads.monthly_budget_cents': 30000 } });
    await expect(smaller.executors['social.campaign_create'](auto(metaInput))).rejects.toMatchObject({ code: 'budget_changed' });
    expect(smaller.store.adsLaunchReserve).not.toHaveBeenCalled();
  });

  it('falls back to a paused campaign with no ads when its creative is no longer approved, and gives the share back when the ad is refused', async () => {
    const retired = setup({ live: [] });
    expect(await retired.executors['social.campaign_create'](auto(metaInput))).toMatchObject({ created: true, launched: false, reason: 'no_approved_creative' });
    expect(retired.store.adsLaunchReserve).not.toHaveBeenCalled();
    const refused = setup({ adFails: true });
    expect(await refused.executors['social.campaign_create'](auto(metaInput))).toMatchObject({ created: true, launched: false, reason: 'meta_invalid_request' });
    expect(refused.store.adsLaunchRelease).toHaveBeenCalledWith('a9', 2);
    expect(refused.meta.startCampaign).not.toHaveBeenCalled();
  });

  it('keeps the share reserved and asks the owner to look when starting is not confirmed', async () => {
    const linkedinInput = { platform: 'linkedin', product: 'caremetric-intel', name: 'Intel prospecting', dailyBudgetCents: 1500, firstAd: { ...metaInput.firstAd, creativeAssetId: linkedinAsset } };
    const h = setup({ startFails: true });
    expect(await h.executors['social.campaign_create'](auto(linkedinInput, { targetId: 'linkedin:caremetric-intel:2026-11' })))
      .toEqual({ created: true, campaignGroupId: '701', campaignId: '702', adId: '703', launched: false, reason: 'linkedin_unavailable' });
    expect(h.store.adsLaunchReserve).toHaveBeenCalledWith('a9', 2, 1500, 1000, 15);
    expect(h.linkedin.createCampaign.mock.calls[0][0]).toMatchObject({ dailyBudgetCents: 1500, totalBudgetCents: 22500, endAt: '2026-12-01T04:59:59.000Z', startAt: '2026-11-16T15:20:00.000Z' });
    expect(h.linkedin.createAd.mock.calls[0][0]).toMatchObject({ adsetId: '702', headline: metaInput.firstAd.headline });
    expect(h.meta.createAd).not.toHaveBeenCalled();
    expect(h.store.adsLaunchRelease).not.toHaveBeenCalled();
    expect(h.notifier.send.mock.calls.at(-1)[0].subject).toBe('Check the new LinkedIn campaign: Intel prospecting');
  });

  it('refuses an automatic approval the owner no longer hands over, or one the database does not declare', async () => {
    const held = setup({ trust: false });
    await expect(held.executors['social.campaign_create'](auto(metaInput))).rejects.toMatchObject({ code: 'approval_required' });
    expect(held.meta.createCampaign).not.toHaveBeenCalled();
    await expect(setup({ handover: false }).executors['social.campaign_create'](auto(metaInput))).rejects.toMatchObject({ code: 'approval_required' });
    // The owner's own approval works as before: paused, no ads, nothing reserved.
    const owner = setup();
    expect(await owner.executors['social.campaign_create'](auto(metaInput, { autoApproved: false }))).toEqual({ created: true, campaignId: '601', adsetId: '602' });
    expect(owner.store.adsLaunchReserve).not.toHaveBeenCalled();
  });

  it('uses the committed reservation as the total cap and keeps a too-short Google window paused', async () => {
    const input = { product: 'caremetric-intel', name: 'Intel search', dailyBudgetCents: 1000, finalUrl: 'https://www.caremetricintel.com/market-review', plan: googlePlan };
    const execution = { id: 'g1', kind: 'social.google_campaign', input, autoApproved: true, execution: 1 };
    const bounded = setup({ googleConfigured: true, reservation: () => ({ reserved: true, dailyBudgetCents: 1000, days: 10, committedCents: 10000 }) });
    await bounded.executors['social.google_campaign'](execution);
    expect(bounded.googleClient.createSearchCampaign.mock.calls[0][0]).toMatchObject({ totalBudgetCents: 10000 });
    const late = setup({ googleConfigured: true, now: () => new Date('2026-11-29T14:20:00Z') });
    expect(await late.executors['social.google_campaign'](execution)).toMatchObject({ launched: false, reason: 'window_too_short' });
    expect(late.store.adsLaunchReserve).not.toHaveBeenCalled();
    expect(late.googleClient.createSearchCampaign.mock.calls[0][0].live).toBeUndefined();
  });

  it('alerts the owner and preserves the budget when Google creation is unconfirmed', async () => {
    const h = setup({ googleConfigured: true });
    h.googleClient.createSearchCampaign.mockRejectedValueOnce(Object.assign(new Error('unknown'), { code: 'google_unconfirmed' }));
    const input = { product: 'caremetric-intel', name: 'Intel search', dailyBudgetCents: 1000, finalUrl: 'https://www.caremetricintel.com/market-review', plan: googlePlan };
    await expect(h.executors['social.google_campaign']({ id: 'g1', kind: 'social.google_campaign', input, autoApproved: true, execution: 1 })).rejects.toMatchObject({ code: 'google_unconfirmed' });
    expect(h.googleClient.createSearchCampaign).toHaveBeenCalledTimes(1);
    expect(h.store.adsLaunchRelease).not.toHaveBeenCalled();
    expect(h.notifier.send).toHaveBeenCalledTimes(1);
    expect(h.notifier.send.mock.calls[0][0]).toMatchObject({ severity: 'warning', subject: 'Check the new Google search campaign: Intel search' });
    expect(h.notifier.send.mock.calls[0][0].body).toContain('may already be running');
  });

  it('launches a Google search campaign running to its month\'s end through the API, and otherwise as before', async () => {
    const input = { product: 'caremetric-intel', name: 'Intel search', dailyBudgetCents: 1000, finalUrl: 'https://www.caremetricintel.com/county-report', plan: googlePlan };
    const google = (over = {}) => ({ id: 'g1', kind: 'social.google_campaign', agentKey: 'social_manager', input, autoApproved: true, execution: 1, ...over });
    const online = setup({ googleConfigured: true });
    expect(await online.executors['social.google_campaign'](google())).toEqual({ created: true, campaign: 'customers/1/campaigns/5', launched: true, dailyBudgetCents: 1000, endsOn: '2026-11-30' });
    expect(online.googleClient.createSearchCampaign.mock.calls[0][0]).toMatchObject({ dailyBudgetCents: 1000, totalBudgetCents: 15000, startDate: '2026-11-16', live: true, endDate: '2026-11-30' });
    const refused = setup({ googleConfigured: true, googleRefuses: true });
    expect(await refused.executors['social.google_campaign'](google())).toMatchObject({ created: true, launched: false, reason: 'google_refused_live' });
    expect(refused.store.adsLaunchRelease).toHaveBeenCalledWith('g1', 1);
    expect(refused.googleClient.createSearchCampaign.mock.calls[1][0].live).toBeUndefined();
    // Without the Google Ads API, launching live is not possible: the import file is emailed, paused, as before, and nothing is reserved.
    const offline = setup();
    expect(await offline.executors['social.google_campaign'](google())).toEqual({ exported: true, launched: false, reason: 'google_not_configured' });
    expect(offline.store.adsLaunchReserve).not.toHaveBeenCalled();
  });
});

describe('the month a live campaign runs in', () => {
  it('counts the days left, Eastern, and ends at the last second of the month', () => {
    expect(monthLeft(new Date('2026-11-16T14:20:00Z'))).toEqual({ month: '2026-11', days: 15, lastDay: '2026-11-30', endsAt: new Date('2026-12-01T04:59:59Z') });
    expect(monthLeft(new Date('2026-07-01T03:30:00Z'))).toEqual({ month: '2026-06', days: 1, lastDay: '2026-06-30', endsAt: new Date('2026-07-01T03:59:59Z') });
    expect(monthLeft(new Date('2027-02-01T12:00:00Z')).days).toBe(28);
  });
});
