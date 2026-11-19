import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { adsConfig, adsFeature, adsTeam } from './index.mjs';

const monday = () => new Date('2026-11-16T14:20:00Z');
const tuesday = () => new Date('2026-11-17T14:20:00Z');
const task = over => ({ id: 't1', agentKey: 'social_manager', kind: 'ads.plan', sourceKind: 'schedule', agent: { autonomy: 'propose' }, ...over });
const settingsOf = values => key => ({ 'ads.monthly_budget_cents': 90000, 'ads.meta_audience_id': '1234567', 'ads.meta_pixel_id': '7654321', 'ads.linkedin_conversion_id': '123456', 'ads.server_conversions': true, ...values })[key];
const googlePlan = { headlines: ['Referral sources in one place', 'Plan visits by county', 'Free county report'], descriptions: ['CareMetric Intel brings territory analysis and a marketing CRM into one place.', 'Start with the free county report.'],
  keywords: ['home health crm', 'hospice marketing', 'home health marketing software', 'referral source tracking', 'hospice referral tracking'].map(text => ({ text, match: 'PHRASE' })), negatives: ['jobs'] };

function setup({ values = {}, proposedAlready = false, candidates = [], googleConfigured = false } = {}) {
  const store = {
    socialCampaignProposed: vi.fn(async () => proposedAlready), proposeAction: vi.fn(async input => ({ id: `a-${input.targetId}`, created: true })),
    adsConversionCandidates: vi.fn(async platform => candidates.filter(item => item.platform === platform || !item.platform)), adsConversionRecord: vi.fn(async () => true),
  };
  const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
  const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: googlePlan })) };
  const meta = { configured: { ads: true }, createCampaign: vi.fn(async () => ({ campaignId: '1', adsetId: '2' })), sendConversion: vi.fn(async () => ({ received: 1 })) };
  const linkedin = { configured: { ads: true }, createCampaign: vi.fn(async () => ({ campaignGroupId: '3', campaignId: '4' })), sendConversion: vi.fn(async () => ({ received: 1 })) };
  const googleClient = { configured: googleConfigured, createSearchCampaign: vi.fn(async () => ({ campaign: 'customers/1/campaigns/5' })) };
  const team = adsTeam({ ads: () => adsConfig({}, settingsOf(values)), features: new Set([adsFeature]), googleClient });
  const handlers = team.handlers({ store, notifier, model, meta, linkedin, social: { maxDailyBudgetCents: 0 }, marketed: ['caremetric-intel'] });
  const executors = team.executors({ meta, linkedin, social: { maxDailyBudgetCents: 0 }, notifier });
  return { store, notifier, model, meta, linkedin, googleClient, handlers, executors };
}

describe('the weekly paid ads plan', () => {
  it('proposes, once a month, a LinkedIn and a Meta campaign and a checked Google search campaign, each paused and for approval', async () => {
    const h = setup();
    const done = await h.handlers['ads.plan'](task(), { now: monday });
    const proposals = h.store.proposeAction.mock.calls.map(([item]) => item);
    expect(proposals.map(item => [item.kind, item.targetId])).toEqual([['social.campaign_create', 'linkedin:caremetric-intel:2026-11'],
      ['social.campaign_create', 'meta:caremetric-intel:2026-11'], ['social.google_campaign', 'google:caremetric-intel:2026-11']]);
    expect(proposals[0].input).toMatchObject({ platform: 'linkedin', dailyBudgetCents: 3000, link: expect.stringContaining('utm_medium=paid_social') });
    // Intel's new campaigns send people to its free county report (2026-11-19), which serves every kind of organization, so the
    // LinkedIn audience is not narrowed to home health agencies and hospices.
    expect(proposals[0].input.link).toMatch(/^https:\/\/www\.caremetricintel\.com\/county-report\?/);
    expect(proposals[1].input.link).toMatch(/^https:\/\/www\.caremetricintel\.com\/county-report\?/);
    expect(proposals[2].input.finalUrl).toMatch(/^https:\/\/www\.caremetricintel\.com\/county-report\?/);
    expect(proposals[0].preview).toContain('manager level or above (upload the roster company list in Campaign Manager to narrow it further)');
    for (const proposal of proposals) expect(JSON.stringify(proposal)).not.toMatch(/market-review|market report is for home health/);
    expect(proposals[1].input).toMatchObject({ platform: 'meta', audienceId: '1234567' });
    expect(proposals[2].input.plan.headlines).toHaveLength(3);
    expect(proposals[1].preview).toContain('paused');
    // A new campaign has no ads, and the proposal says so rather than promising the team will fill it.
    expect(proposals[0].preview).toContain('It starts with no ads: add its first ad in LinkedIn Campaign Manager');
    expect(proposals[1].preview).toContain('It starts with no ads: add its first ad in Meta Ads Manager');
    expect(proposals[1].preview).not.toMatch(/proposes ads into it/);
    expect(done).toMatchObject({ status: 'awaiting_approval', result: { proposed: 3 } });
  });

  it('proposes nothing without a monthly number, on a scheduled day other than Monday, or again in the same month', async () => {
    expect((await setup({ values: { 'ads.monthly_budget_cents': null } }).handlers['ads.plan'](task(), { now: monday })).result.skipped).toBe('no_monthly_budget');
    expect((await setup().handlers['ads.plan'](task(), { now: tuesday })).result.skipped).toBe('not_monday');
    const again = setup({ proposedAlready: true });
    await again.handlers['ads.plan'](task(), { now: monday });
    expect(again.store.proposeAction).not.toHaveBeenCalled();
    const noAudience = setup({ values: { 'ads.meta_audience_id': null } });
    expect((await noAudience.handlers['ads.plan'](task(), { now: monday })).result.skipped).toMatchObject({ meta_audience_missing: 1 });
  });
});

describe('approving a new campaign', () => {
  const linkedinCampaign = { platform: 'linkedin', product: 'caremetric-intel', name: 'Intel prospecting', dailyBudgetCents: 3000 };
  it('creates it within the limits as they stand, and never on an automatic approval', async () => {
    const h = setup();
    expect(await h.executors['social.campaign_create']({ id: 'a1', input: linkedinCampaign })).toEqual({ created: true, campaignGroupId: '3', campaignId: '4' });
    await expect(h.executors['social.campaign_create']({ id: 'a1', input: linkedinCampaign, autoApproved: true })).rejects.toMatchObject({ code: 'approval_required' });
    const lowered = setup({ values: { 'ads.monthly_budget_cents': 45000 } });
    await expect(lowered.executors['social.campaign_create']({ id: 'a1', input: linkedinCampaign })).rejects.toMatchObject({ code: 'budget_changed' });
  });

  it('emails a Google search campaign as an import file until the API is set up, and creates it paused once it is', async () => {
    const input = { product: 'caremetric-intel', name: 'Intel search', dailyBudgetCents: 3000, finalUrl: 'https://www.caremetricintel.com/county-report', plan: googlePlan };
    const offline = setup();
    expect(await offline.executors['social.google_campaign']({ id: 'a2', input })).toEqual({ exported: true });
    expect(offline.notifier.send.mock.calls[0][0].blocks[1].text).toMatch(/^Campaign,Campaign Type/);
    const online = setup({ googleConfigured: true });
    expect(await online.executors['social.google_campaign']({ id: 'a2', input })).toEqual({ created: true, campaign: 'customers/1/campaigns/5' });
  });

  it('does not report the import file as emailed when a retry finds only the earlier failed attempt', async () => {
    const input = { product: 'caremetric-intel', name: 'Intel search', dailyBudgetCents: 3000, finalUrl: 'https://www.caremetricintel.com/county-report', plan: googlePlan };
    const retried = setup();
    // The same action run again: the notifier's dedupe key says this email was tried before, and that try failed.
    retried.notifier.send.mockResolvedValueOnce([{ channel: 'email', delivery: 'duplicate', original: 'failed' }]);
    await expect(retried.executors['social.google_campaign']({ id: 'a3', input })).rejects.toMatchObject({ code: 'notification_failed' });
    retried.notifier.send.mockResolvedValueOnce([{ channel: 'email', delivery: 'duplicate', original: 'sent' }]);
    expect(await retried.executors['social.google_campaign']({ id: 'a3', input })).toEqual({ exported: true });
  });
});

describe('reporting leads to the ad platforms', () => {
  const lead = (id, clickIds) => ({ id, kind: 'trial_signup', email: ' Jane@Agency.org ', occurredAt: '2026-11-16T12:00:00Z', firstSeenAt: '2026-11-15T12:00:00Z', clickIds });
  it('tells only the platform whose ad was clicked, by a hashed email, once', async () => {
    const h = setup({ candidates: [lead('l1', { fbclid: 'IwAR0abc' }), lead('l2', { liFatId: '0f1e2d3c-1234-4abc-8def-001122334455' })] });
    const done = await h.handlers['ads.conversions'](task({ kind: 'ads.conversions' }));
    expect(h.meta.sendConversion).toHaveBeenCalledTimes(1);
    expect(h.meta.sendConversion.mock.calls[0][0]).toMatchObject({ eventName: 'StartTrial', eventId: 'l1', fbclid: 'IwAR0abc', clickedAt: Date.parse('2026-11-15T12:00:00Z'),
      emailHash: createHash('sha256').update('jane@agency.org').digest('hex') });
    expect(JSON.stringify(h.meta.sendConversion.mock.calls)).not.toContain('jane');
    expect(h.linkedin.sendConversion).toHaveBeenCalledTimes(1);
    expect(h.store.adsConversionRecord.mock.calls).toEqual(expect.arrayContaining([['l1', 'meta', 'sent', null], ['l2', 'meta', 'skipped', 'no_click'],
      ['l1', 'linkedin', 'skipped', 'no_click'], ['l2', 'linkedin', 'sent', null]]));
    expect(done.result).toEqual({ sent: 2, skipped: 2, failed: 0 });
    expect((await setup({ values: { 'ads.server_conversions': false } }).handlers['ads.conversions'](task())).result).toEqual({ skipped: 'off' });
  });
});
