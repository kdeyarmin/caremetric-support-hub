import { describe, expect, it, vi } from 'vitest';
import { adsConfig, adsFeature, adsTeam, campaignWindow, flightBudget, leastFlightDays } from './index.mjs';
import { handoverFeature } from '../handover.mjs';

// Ad budget flights (Settings → Paid ads → "Run each month's campaign as a short flight", 2026-11-16): the month's number spent in one
// campaign over a few days at no less than the platform's least daily budget, ending on its own.
const monday = () => new Date('2026-11-16T14:20:00Z');
const task = over => ({ id: 't1', agentKey: 'social_manager', kind: 'ads.plan', sourceKind: 'schedule', agent: { autonomy: 'propose' }, ...over });
const settingsOf = values => key => ({ 'ads.monthly_budget_cents': 5000, 'ads.flight_days': 10, 'ads.meta_audience_id': '1234567', ...values })[key];
const googlePlan = { headlines: ['Referral sources in one place', 'Plan visits by county', 'Free market report'], descriptions: ['CareMetric Intel brings territory analysis and a marketing CRM into one place.', 'See where your agency stands.'],
  keywords: ['home health crm', 'hospice marketing', 'home health marketing software', 'referral source tracking', 'hospice referral tracking'].map(text => ({ text, match: 'PHRASE' })), negatives: ['jobs'] };
const token = 'e'.repeat(64);
const metaAsset = '33333333-3333-4333-8333-333333333333';
const asset = platform => ({ id: metaAsset, token, product: 'caremetric-intel', platform, placement: platform === 'meta' ? 'meta.feed_square' : 'linkedin.single_image', kind: 'static',
  headline: 'Where does your agency rank?', primaryText: 'CareMetric Intel shows your county\'s home health market from public data, free for your agency.', description: 'Free market report',
  cta: 'Get your report', landingUrl: `https://www.caremetricintel.com/market-review?utm_source=meta&utm_medium=paid&utm_campaign=creative-1&utm_content=${metaAsset}` });
const trusted = { autonomy: 'act', config: { auto_approve_kinds: ['social.campaign_create', 'social.google_campaign'] } };

function setup({ values = {}, linkedinConnected = true, metaConnected = true, googleConfigured = false, proposed = () => false, history = [], handover = false, status = 'proposed' } = {}) {
  const store = {
    socialCampaignProposed: vi.fn(async (kind, target) => proposed(target)), adsMonthCampaigns: vi.fn(async () => history), proposeAction: vi.fn(async input => ({ id: `a-${input.targetId}`, created: true, status })),
    actionTrusted: vi.fn(async () => true), adsLaunchReserve: vi.fn(async (id, execution, daily, least, days) => ({ reserved: true, dailyBudgetCents: daily, days })),
    adsLaunchRelease: vi.fn(async () => true), creativeLiveAssets: vi.fn(async () => [{ id: metaAsset, platform: 'meta', status: 'approved' }]),
  };
  const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
  const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: googlePlan })) };
  const meta = { configured: { ads: metaConnected, pages: true }, createCampaign: vi.fn(async () => ({ campaignId: '601', adsetId: '602' })), startCampaign: vi.fn(async () => ({ started: true })),
    createAd: vi.fn(async () => ({ id: '603', creativeId: '604' })) };
  const linkedin = { configured: { ads: linkedinConnected, page: true }, createCampaign: vi.fn(async () => ({ campaignGroupId: '701', campaignId: '702' })), startCampaign: vi.fn(async () => ({ started: true })) };
  const googleClient = { configured: googleConfigured, createSearchCampaign: vi.fn(async () => ({ campaign: 'customers/1/campaigns/5' })) };
  const creative = { approved: vi.fn(async ({ platform }) => (platform === 'meta' ? [asset('meta')] : [])), live: vi.fn(async () => true) };
  const team = adsTeam({ ads: () => adsConfig({}, settingsOf(values)), features: new Set(handover ? [adsFeature, handoverFeature] : [adsFeature]), googleClient });
  const handlers = team.handlers({ store, notifier, model, meta, linkedin, social: { maxDailyBudgetCents: 0 }, marketed: ['caremetric-intel'], creative, publicOrigin: 'https://help.caremetric.ai', log: () => {} });
  const executors = team.executors({ meta, linkedin, social: { maxDailyBudgetCents: 0 }, notifier, store, creative, publicOrigin: 'https://help.caremetric.ai', log: () => {}, now: monday });
  return { store, notifier, model, meta, linkedin, googleClient, creative, handlers, executors };
}

describe('a flight\'s budget', () => {
  it('spends the month\'s number over about the days asked, never below the platform\'s least a day, so a small number runs fewer days', () => {
    const fifty = { monthlyBudgetCents: 5000, maxDailyBudgetCents: 0, flightDays: 10 };
    expect(flightBudget(fifty, 'meta')).toEqual({ dailyBudgetCents: 500, days: 10 });
    expect(flightBudget(fifty, 'google')).toEqual({ dailyBudgetCents: 500, days: 10 });
    expect(flightBudget(fifty, 'linkedin')).toEqual({ dailyBudgetCents: 1000, days: 5 });
    expect(flightBudget({ ...fifty, monthlyBudgetCents: 90000 }, 'meta')).toEqual({ dailyBudgetCents: 9000, days: 10 });
    // Never past the month, nor above the daily ad-set limit; too few days, or a limit below the platform's least, is no flight.
    expect(flightBudget(fifty, 'meta', 4)).toEqual({ dailyBudgetCents: 500, days: 4 });
    expect(flightBudget(fifty, 'meta', leastFlightDays - 1)).toBeNull();
    expect(flightBudget({ ...fifty, maxDailyBudgetCents: 400 }, 'meta')).toBeNull();
    expect(flightBudget({ ...fifty, monthlyBudgetCents: 90000, maxDailyBudgetCents: 3000 }, 'meta')).toEqual({ dailyBudgetCents: 3000, days: 10 });
    expect(flightBudget({ ...fifty, monthlyBudgetCents: 2500 }, 'linkedin')).toBeNull();
    for (const off of [{ ...fifty, flightDays: 0 }, { ...fifty, monthlyBudgetCents: 0 }]) expect(flightBudget(off, 'meta')).toBeNull();
  });

  it('ends on its own after its last day, Eastern, and never past the month', () => {
    expect(campaignWindow(monday(), 10)).toMatchObject({ days: 10, lastDay: '2026-11-25', endsAt: new Date('2026-11-26T04:59:59.000Z') });
    expect(campaignWindow(monday(), 30)).toMatchObject({ days: 15, lastDay: '2026-11-30', endsAt: new Date('2026-12-01T04:59:59.000Z') });
    expect(campaignWindow(monday())).toMatchObject({ days: 15, lastDay: '2026-11-30' });
  });

  it('reads the setting: 3 to 30 days, anything else off', () => {
    for (const [value, days] of [[10, 10], [3, 3], [30, 30], [2, 0], [31, 0], [null, 0], ['10', 0]]) expect(adsConfig({}, settingsOf({ 'ads.flight_days': value })).flightDays, String(value)).toBe(days);
  });
});

describe('the monthly plan with flights on', () => {
  it('at $50 a month, which spread a thirtieth a day fits no platform, proposes one flight that can run', async () => {
    const spread = setup({ values: { 'ads.flight_days': null } });
    const nothing = await spread.handlers['ads.plan'](task(), { now: monday });
    expect(nothing.result).toMatchObject({ proposed: 0, skipped: { budget_too_small: 3 } });

    const h = setup();
    const done = await h.handlers['ads.plan'](task(), { now: monday });
    const proposals = h.store.proposeAction.mock.calls.map(([item]) => item);
    expect(proposals.map(item => [item.targetId, item.input.dailyBudgetCents, item.input.flightDays])).toEqual([['linkedin:caremetric-intel:2026-11', 1000, 5]]);
    expect(proposals[0].preview).toContain('A flight: $10.00 a day for 5 days ($50.00 of your monthly $50.00), then it ends on its own.');
    expect(proposals[0].preview).toContain('It ends on its own 5 days after it is created (today counted), so start it the day you approve it.');
    expect(done.result).toMatchObject({ proposed: 1, skipped: { flight_taken: 2 } });
    expect(h.model.run).not.toHaveBeenCalled();

    // LinkedIn not connected: Meta carries it, $5 a day for 10 days.
    const meta = setup({ linkedinConnected: false });
    await meta.handlers['ads.plan'](task(), { now: monday });
    expect(meta.store.proposeAction.mock.calls.map(([item]) => [item.targetId, item.input.dailyBudgetCents, item.input.flightDays])).toEqual([['meta:caremetric-intel:2026-11', 500, 10]]);
  });

  it('never a second campaign in a month that already has one, and never a Google flight without the API to end it', async () => {
    const taken = setup({ history: [{ kind: 'social.campaign_create', targetId: 'meta:caremetric-intel:2026-11', status: 'proposed', flight: true }] });
    const done = await taken.handlers['ads.plan'](task(), { now: monday });
    expect(taken.store.adsMonthCampaigns).toHaveBeenCalledWith('2026-11');
    expect(taken.store.socialCampaignProposed).not.toHaveBeenCalled();
    expect(taken.store.proposeAction).not.toHaveBeenCalled();
    expect(done.result.skipped).toMatchObject({ flight_this_month: 2 });

    const googleOnly = setup({ linkedinConnected: false, metaConnected: false });
    const none = await googleOnly.handlers['ads.plan'](task(), { now: monday });
    expect(googleOnly.store.proposeAction).not.toHaveBeenCalled();
    expect(none.result.skipped).toMatchObject({ flight_does_not_fit: 1 });
    const online = setup({ linkedinConnected: false, metaConnected: false, googleConfigured: true });
    await online.handlers['ads.plan'](task(), { now: monday });
    expect(online.store.proposeAction.mock.calls.map(([item]) => [item.kind, item.input.dailyBudgetCents, item.input.flightDays])).toEqual([['social.google_campaign', 500, 10]]);
  });

  it('counts a campaign made on a platform since disconnected, and a flight turned down, but not a proposal that never became a campaign', async () => {
    const plan = async options => { const h = setup(options); const done = await h.handlers['ads.plan'](task(), { now: monday });
      return { done, proposed: h.store.proposeAction.mock.calls.map(([item]) => [item.targetId, item.input.flightDays]) }; };
    // A LinkedIn flight was created, then LinkedIn was disconnected: no Meta flight beside it.
    const created = await plan({ linkedinConnected: false, history: [{ kind: 'social.campaign_create', targetId: 'linkedin:caremetric-intel:2026-11', status: 'executed', flight: true }] });
    expect(created.proposed).toEqual([]);
    expect(created.done.result.skipped).toMatchObject({ linkedin_not_connected: 1, flight_this_month: 2 });
    // So does a campaign paced over the month that was created before flights were switched on, and a flight the owner turned down.
    for (const item of [{ status: 'executed', flight: false }, { status: 'rejected', flight: true }, { status: 'approved', flight: true }]) {
      const result = await plan({ history: [{ kind: 'social.campaign_create', targetId: 'meta:caremetric-intel:2026-11', ...item }] });
      expect(result.proposed, JSON.stringify(item)).toEqual([]);
    }
    // A proposal paced over the month that was refused, turned down or is still waiting never became a campaign (it is refused when it is
    // created while flights are on), and a flight that failed or expired never ran: each leaves the month's flight free, on the same target.
    for (const item of [{ status: 'failed', flight: false }, { status: 'rejected', flight: false }, { status: 'proposed', flight: false }, { status: 'failed', flight: true }, { status: 'expired', flight: true }]) {
      const result = await plan({ linkedinConnected: false, history: [{ kind: 'social.campaign_create', targetId: 'meta:caremetric-intel:2026-11', ...item }] });
      expect(result.proposed, JSON.stringify(item)).toEqual([['meta:caremetric-intel:2026-11', 10]]);
    }
    // Flights off: the plan keeps its one-proposal-per-campaign rule and never reads the month's list.
    const spread = setup({ values: { 'ads.flight_days': null } });
    await spread.handlers['ads.plan'](task(), { now: monday });
    expect(spread.store.adsMonthCampaigns).not.toHaveBeenCalled();
    expect(spread.store.socialCampaignProposed).toHaveBeenCalled();
    // A list that could not be read proposes no flight.
    const unread = await plan({ history: null });
    expect(unread.proposed).toEqual([]);
    expect(unread.done.result).toEqual({ proposed: 0, skipped: { flight_history_unread: 1 } });
  });

  it('under the hand-over, prefers the campaign that would start on its own with approved creative', async () => {
    const h = setup({ handover: true, status: 'auto_approved' });
    await h.handlers['ads.plan'](task({ agent: trusted }), { now: monday });
    // LinkedIn has no approved creative that fits, Meta does: Meta carries the flight and starts on its own.
    const [only, ...rest] = h.store.proposeAction.mock.calls.map(([item]) => item);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ targetId: 'meta:caremetric-intel:2026-11', input: { dailyBudgetCents: 500, flightDays: 10, firstAd: { creativeAssetId: metaAsset } } });
    expect(only.preview).toContain('runs until 2026-11-25');
  });
});

describe('creating a flight', () => {
  const metaFlight = { platform: 'meta', product: 'caremetric-intel', name: 'CareMetric Intel retargeting 2026-11', dailyBudgetCents: 500, audienceId: '1234567', flightDays: 10 };
  it('creates the owner\'s approved flight paused with its last day, so it ends on its own even if started later', async () => {
    const h = setup();
    expect(await h.executors['social.campaign_create']({ id: 'a1', input: metaFlight })).toEqual({ created: true, campaignId: '601', adsetId: '602' });
    expect(h.meta.createCampaign).toHaveBeenCalledWith({ name: metaFlight.name, dailyBudgetCents: 500, audienceId: '1234567', endAt: '2026-11-26T04:59:59.000Z' });
    await h.executors['social.campaign_create']({ id: 'a2', input: { platform: 'linkedin', product: 'caremetric-intel', name: 'Intel prospecting', dailyBudgetCents: 1000, flightDays: 5 } });
    expect(h.linkedin.createCampaign).toHaveBeenCalledWith({ name: 'Intel prospecting', dailyBudgetCents: 1000, startAt: '2026-11-16T15:20:00.000Z', endAt: '2026-11-21T04:59:59.000Z' });
    const google = setup({ googleConfigured: true });
    await google.executors['social.google_campaign']({ id: 'a3', input: { product: 'caremetric-intel', name: 'Intel search', dailyBudgetCents: 500, finalUrl: 'https://www.caremetricintel.com/market-review', plan: googlePlan, flightDays: 10 } });
    expect(google.googleClient.createSearchCampaign.mock.calls[0][0]).toMatchObject({ dailyBudgetCents: 500, endDate: '2026-11-25' });
    expect(google.googleClient.createSearchCampaign.mock.calls[0][0].live).toBeUndefined();
  });

  it('refuses a flight the limits no longer allow, and a campaign of the other kind', async () => {
    const h = setup();
    for (const input of [{ ...metaFlight, dailyBudgetCents: 600 }, { ...metaFlight, flightDays: 11 }, { ...metaFlight, flightDays: 2 }, { ...metaFlight, flightDays: '10' }]) {
      await expect(h.executors['social.campaign_create']({ id: 'a1', input }), JSON.stringify(input)).rejects.toMatchObject({ code: 'budget_changed' });
    }
    // Flights switched off since it was approved; a campaign spread over the month while flights are on.
    await expect(setup({ values: { 'ads.flight_days': null } }).executors['social.campaign_create']({ id: 'a1', input: metaFlight })).rejects.toMatchObject({ code: 'budget_changed' });
    const { flightDays, ...spread } = metaFlight; void flightDays;
    await expect(setup({ values: { 'ads.monthly_budget_cents': 90000 } }).executors['social.campaign_create']({ id: 'a1', input: { ...spread, dailyBudgetCents: 3000 } })).rejects.toMatchObject({ code: 'budget_changed' });
    // A Google flight cannot be an import file: it would never end.
    await expect(setup().executors['social.google_campaign']({ id: 'a3', input: { product: 'caremetric-intel', name: 'Intel search', dailyBudgetCents: 500, finalUrl: 'https://www.caremetricintel.com/market-review', plan: googlePlan, flightDays: 10 } }))
      .rejects.toMatchObject({ code: 'google_not_configured' });
  });

  it('launches a flight handed over: reserves only its own days, and ends after its last day', async () => {
    const h = setup({ handover: true });
    const firstAd = { name: 'Intel · creative 33333333', message: asset('meta').primaryText, headline: asset('meta').headline, description: 'Free market report', link: asset('meta').landingUrl,
      callToAction: 'LEARN_MORE', imageUrl: `https://help.caremetric.ai/api/creative/a/${token}.png`, creativeAssetId: metaAsset };
    const result = await h.executors['social.campaign_create']({ id: 'a9', kind: 'social.campaign_create', agentKey: 'social_manager', taskId: 't1', targetId: 'meta:caremetric-intel:2026-11',
      input: { ...metaFlight, firstAd }, autoApproved: true, execution: 2 });
    expect(result).toMatchObject({ launched: true, dailyBudgetCents: 500, endsOn: '2026-11-25' });
    expect(h.store.adsLaunchReserve).toHaveBeenCalledWith('a9', 2, 500, 500, 10);
    expect(h.meta.createCampaign).toHaveBeenCalledWith({ name: metaFlight.name, dailyBudgetCents: 500, audienceId: '1234567', endAt: '2026-11-26T04:59:59.000Z' });
    expect(h.notifier.send.mock.calls.at(-1)[0].body).toContain('ends on 2026-11-25');
  });
});
