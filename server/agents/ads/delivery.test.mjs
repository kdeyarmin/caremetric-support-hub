import { describe, expect, it, vi } from 'vitest';
import { deliveryFromRows, googleAdsClient } from './google.mjs';
import { adsConfig, adsFeature, adsTeam, googleDeliveryFindings, googleQuietDays, reachFeature } from './index.mjs';

// The read-back of Google search campaigns (review 2026-11-18): campaign 24493303819 was created by the Hub, and its approval, delivery
// and the account's conversion tracking could be checked only in a browser session Google refused.
const credentials = { clientId: 'client.apps', clientSecret: 'secret-0123456789', refreshToken: '1//refresh-token-0123456789', customerId: '3021386768' };
const campaignRow = (over = {}) => ({
  campaign: { resourceName: 'customers/3021386768/campaigns/24493303819', id: '24493303819', name: 'CareMetric CareMetric Intel search 2026-11', status: 'ENABLED',
    servingStatus: 'SERVING', primaryStatus: 'ELIGIBLE', primaryStatusReasons: [], startDateTime: '2026-11-18 00:00:00', endDateTime: '2026-11-27 23:59:59', ...over },
  campaignBudget: { period: 'CUSTOM_PERIOD', totalAmountMicros: '50000000' },
});
const pa = 'geoTargetConstants/21167';

function searchFetch(answers) {
  return vi.fn(async (url, init) => {
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'ya29.token' }));
    const { query } = JSON.parse(init.body);
    const key = /FROM customer /.test(query) ? 'account' : /FROM ad_group_ad /.test(query) ? 'ads' : /FROM campaign_criterion /.test(query) ? 'locations'
      : /metrics\./.test(query) ? 'metrics' : 'campaigns';
    const answer = answers[key];
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify({ results: answer ?? [] }));
  });
}

describe('the Google read-back', () => {
  it('reads the account, its enabled campaigns, their results, ad approval and places, and changes nothing', async () => {
    const fetchImpl = searchFetch({
      account: [{ customer: { resourceName: 'customers/3021386768', conversionTrackingSetting: { conversionTrackingStatus: 'NOT_CONVERSION_TRACKED' } } }],
      campaigns: [campaignRow()],
      metrics: [{ campaign: { id: '24493303819' }, metrics: { impressions: '120', clicks: '4', costMicros: '3120000', conversions: 0 } }],
      ads: [{ campaign: { id: '24493303819' }, adGroupAd: { policySummary: { approvalStatus: 'APPROVED', reviewStatus: 'REVIEWED' } } }],
      locations: [{ campaign: { id: '24493303819' }, campaignCriterion: { location: { geoTargetConstant: pa } } }],
    });
    const client = googleAdsClient({ ...credentials, fetchImpl });
    const report = await client.deliveryReport({ since: '2026-10-21', until: '2026-11-19' });
    const searches = fetchImpl.mock.calls.filter(([url]) => !String(url).includes('oauth2'));
    expect(searches.map(([url]) => url)).toEqual(Array(5).fill('https://googleads.googleapis.com/v26/customers/3021386768/googleAds:search'));
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes(':mutate'))).toBe(false);
    const queries = searches.map(([, init]) => JSON.parse(init.body).query);
    expect(queries[1]).toContain("WHERE campaign.status = 'ENABLED'");
    expect(queries[2]).toContain("campaign.id IN (24493303819) AND segments.date BETWEEN '2026-10-21' AND '2026-11-19'");
    expect(queries[3]).toContain('ad_group_ad.policy_summary.approval_status');
    expect(queries[4]).toContain("campaign_criterion.type = 'LOCATION' AND campaign_criterion.negative = FALSE");
    // A customer row without autoTaggingEnabled is false: JSON leaves out a field at its default.
    expect(report.account).toEqual({ autoTagging: false, conversionTracking: 'NOT_CONVERSION_TRACKED' });
    expect(report.campaigns).toEqual([{ id: '24493303819', name: 'CareMetric CareMetric Intel search 2026-11', status: 'ENABLED', serving: 'SERVING', primary: 'ELIGIBLE', reasons: [],
      startDay: '2026-11-18', endDay: '2026-11-27', budget: { period: 'CUSTOM_PERIOD', dailyCents: null, totalCents: 5000 }, locations: [pa],
      ads: { approved: 1, limited: 0, disapproved: 0, underReview: 0, other: 0 }, impressions: 120, clicks: 4, costCents: 312, conversions: 0 }]);
  });

  it('asks nothing more of an account with no enabled campaign', async () => {
    const fetchImpl = searchFetch({ account: [{ customer: { autoTaggingEnabled: true } }], campaigns: [] });
    const report = await googleAdsClient({ ...credentials, fetchImpl }).deliveryReport({ since: '2026-10-21', until: '2026-11-19' });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('googleAds:search'))).toHaveLength(2);
    expect(report).toMatchObject({ account: { autoTagging: true, conversionTracking: null }, campaigns: [] });
  });

  it('keeps only a fixed code and Google\'s error enum from a refusal, never its message', async () => {
    const refusal = { error: { code: 400, message: 'Unrecognized field secret text', details: [{ errors: [{ errorCode: { queryError: 'UNRECOGNIZED_FIELD' }, message: 'more text' }] }] } };
    const client = googleAdsClient({ ...credentials, fetchImpl: searchFetch({ campaigns: new Response(JSON.stringify(refusal), { status: 400 }) }) });
    const error = await client.deliveryReport({ since: '2026-10-21', until: '2026-11-19' }).catch(caught => caught);
    expect(error).toMatchObject({ code: 'google_query_refused', transient: false, reason: 'queryError.UNRECOGNIZED_FIELD' });
    expect(JSON.stringify({ ...error })).not.toContain('secret text');
    const denied = googleAdsClient({ ...credentials, fetchImpl: searchFetch({ account: new Response('{}', { status: 403 }) }) });
    await expect(denied.deliveryReport({ since: '2026-10-21', until: '2026-11-19' })).rejects.toMatchObject({ code: 'google_permission' });
    await expect(googleAdsClient({ ...credentials, fetchImpl: searchFetch({}) }).deliveryReport({ since: '2026-11-19', until: '2026-11-01' })).rejects.toMatchObject({ code: 'google_invalid_request' });
    await expect(googleAdsClient({ fetchImpl: searchFetch({}) }).deliveryReport({ since: '2026-10-21', until: '2026-11-19' })).rejects.toMatchObject({ code: 'google_not_configured' });
  });

  it('counts ads by approval and adds results across rows', () => {
    const ad = (approvalStatus, reviewStatus = 'REVIEWED') => ({ campaign: { id: '7' }, adGroupAd: { policySummary: { approvalStatus, reviewStatus } } });
    const report = deliveryFromRows({ campaigns: [campaignRow({ id: '7' })],
      ads: [ad('APPROVED'), ad('APPROVED_LIMITED'), ad('DISAPPROVED'), ad('UNKNOWN', 'REVIEW_IN_PROGRESS'), ad(undefined, undefined)],
      metrics: [{ campaign: { id: '7' }, metrics: { impressions: '3' } }, { campaign: { id: '7' }, metrics: { impressions: '2', clicks: '1', conversions: 1.5 } }, { campaign: { id: '8' }, metrics: { impressions: '9' } }] });
    expect(report.account.autoTagging).toBeNull();
    expect(report.campaigns[0]).toMatchObject({ ads: { approved: 1, limited: 1, disapproved: 1, underReview: 1, other: 1 }, impressions: 5, clicks: 1, conversions: 1.5 });
  });

  it('rejects malformed successful reads and incomplete pagination instead of reporting an empty or partial account', async () => {
    for (const body of ['not JSON', 'null', '[]', '{"results":{}}', '{"results":[null]}', '{"nextPageToken":42}']) {
      const client = googleAdsClient({ ...credentials, fetchImpl: searchFetch({ account: new Response(body) }) });
      await expect(client.deliveryReport({ since: '2026-11-01', until: '2026-11-19' }))
        .rejects.toMatchObject({ code: 'google_response_invalid', transient: true });
    }
    const fetchImpl = vi.fn(async url => new Response(JSON.stringify(String(url).includes('oauth2')
      ? { access_token: 'ya29.token' } : { results: [campaignRow()], nextPageToken: 'more' })));
    await expect(googleAdsClient({ ...credentials, fetchImpl }).deliveryReport({ since: '2026-11-01', until: '2026-11-19' }))
      .rejects.toMatchObject({ code: 'google_query_incomplete' });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('googleAds:search'))).toHaveLength(5);
  });
});

describe('Google account spend', () => {
  it('reads all campaign spend for the requested days and rounds the total once, following pages', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'ya29.token' }));
      const request = JSON.parse(init.body);
      expect(request.query).toBe("SELECT metrics.cost_micros FROM customer WHERE segments.date BETWEEN '2026-11-09' AND '2026-11-15'");
      return new Response(JSON.stringify(request.pageToken
        ? { results: [{ metrics: { costMicros: '6000' } }] }
        : { results: [{ metrics: { costMicros: '6000' } }], nextPageToken: 'next' }));
    });
    expect(await googleAdsClient({ ...credentials, fetchImpl }).spendReport({ since: '2026-11-09', until: '2026-11-15' })).toEqual({ spendCents: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('accepts omitted protobuf zero fields, rejects malformed amounts and dates, and retries throttled sign-in', async () => {
    const fetchFor = body => vi.fn(async url => new Response(JSON.stringify(String(url).includes('oauth2') ? { access_token: 'ya29.token' } : body)));
    for (const body of [{}, { results: [] }, { results: [{}] }, { results: [{ metrics: {} }] }]) {
      expect(await googleAdsClient({ ...credentials, fetchImpl: fetchFor(body) }).spendReport({ since: '2026-11-09', until: '2026-11-15' })).toEqual({ spendCents: 0 });
    }
    for (const costMicros of ['invalid', -10, 1.5, [6000], {}, null, true, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(googleAdsClient({ ...credentials, fetchImpl: fetchFor({ results: [{ metrics: { costMicros } }] }) })
        .spendReport({ since: '2026-11-09', until: '2026-11-15' })).rejects.toMatchObject({ code: 'google_response_invalid', transient: true });
    }
    for (const metrics of ['bad', [], null, 0, true]) {
      await expect(googleAdsClient({ ...credentials, fetchImpl: fetchFor({ results: [{ metrics }] }) })
        .spendReport({ since: '2026-11-09', until: '2026-11-15' })).rejects.toMatchObject({ code: 'google_response_invalid', transient: true });
    }
    const fetchImpl = fetchFor({});
    await expect(googleAdsClient({ ...credentials, fetchImpl }).spendReport({ since: '2026-11-15', until: '2026-11-09' })).rejects.toMatchObject({ code: 'google_invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(googleAdsClient({ ...credentials, fetchImpl: vi.fn(async () => new Response('{}', { status: 429 })) })
      .spendReport({ since: '2026-11-09', until: '2026-11-15' })).rejects.toMatchObject({ code: 'google_unavailable', transient: true });
  });
});

describe('what the read-back finds', () => {
  const report = (over = {}, account = { autoTagging: true, conversionTracking: 'CONVERSION_TRACKING_MANAGED_BY_SELF' }) => ({ since: '2026-10-21', until: '2026-11-21', account,
    campaigns: [{ id: '24493303819', name: 'Intel search', status: 'ENABLED', serving: 'SERVING', startDay: '2026-11-18', endDay: '2026-11-27', locations: [pa],
      ads: { approved: 1, limited: 0, disapproved: 0, underReview: 0, other: 0 }, impressions: 40, clicks: 2, costCents: 180, conversions: 0, ...over }] });
  const expected = new Map([[pa, 'Pennsylvania']]);

  it('passes a campaign that is approved, serving and seen in the roster\'s states, naming its places', () => {
    const found = googleDeliveryFindings(report(), { today: '2026-11-21', expected });
    expect(found).toMatchObject({ read: true, account: { issues: [] }, campaigns: [{ issues: [], places: ['Pennsylvania'] }] });
    expect(found.campaigns[0]).not.toHaveProperty('locations');
  });

  it('names each problem the owner would have to fix in Google Ads', () => {
    const issues = (over, today = '2026-11-21') => googleDeliveryFindings(report(over), { today, expected }).campaigns[0].issues;
    expect(issues({ ads: { approved: 0, limited: 0, disapproved: 1, underReview: 0, other: 0 } })).toEqual(['ad_disapproved']);
    expect(issues({ ads: { approved: 0, limited: 0, disapproved: 0, underReview: 1, other: 0 } })).toEqual(['ads_under_review']);
    expect(issues({ ads: { approved: 0, limited: 0, disapproved: 0, underReview: 0, other: 0 } })).toEqual(['no_enabled_ads']);
    expect(issues({ serving: 'SUSPENDED' })).toEqual(['not_serving']);
    expect(issues({ locations: [pa, 'geoTargetConstants/2840'] })).toEqual(['outside_states']);
    expect(issues({ locations: [] })).toEqual(['outside_states']);
    // No impression is news only after googleQuietDays of serving, and never before it starts or after it ends.
    expect(issues({ impressions: 0 }, '2026-11-19')).toEqual([]);
    expect(issues({ impressions: 0 }, `2026-11-${18 + googleQuietDays}`)).toEqual(['no_impressions']);
    expect(issues({ impressions: 0, serving: 'ENDED' }, '2026-11-28')).toEqual([]);
    expect(issues({ impressions: 0, startDay: '2026-11-25', serving: 'PENDING' })).toEqual([]);
  });

  it('records auto-tagging off and conversions not tracked for the whole account', () => {
    const found = googleDeliveryFindings(report({}, { autoTagging: false, conversionTracking: 'NOT_CONVERSION_TRACKED' }), { today: '2026-11-21' });
    expect(found.account.issues).toEqual(['auto_tagging_off', 'conversions_not_tracked']);
    // Without the roster's places known, places are left as Google names them and are not judged.
    expect(found.campaigns[0]).toMatchObject({ places: [pa], issues: [] });
  });
});

describe('the daily plan with the Google read-back', () => {
  const now = () => new Date('2026-11-21T14:20:00Z');
  const task = { id: 't1', agentKey: 'social_manager', kind: 'ads.plan', sourceKind: 'schedule', agent: { autonomy: 'act' } };
  const settings = key => ({ 'ads.monthly_budget_cents': 5000, 'ads.flight_days': 10, 'growth.roster_states': ['PA'] })[key];
  function setup(googleClient) {
    const store = { adsMonthCampaigns: vi.fn(async () => [{ kind: 'social.google_campaign', targetId: 'google:caremetric-intel:2026-11', status: 'executed', flight: true }]),
      socialCampaignProposed: vi.fn(async () => true), proposeAction: vi.fn() };
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    const team = adsTeam({ ads: () => adsConfig({}, settings), features: new Set([adsFeature, reachFeature]), googleClient });
    const handlers = team.handlers({ store, notifier, model: { configured: true, run: vi.fn() }, meta: { configured: { ads: false } }, linkedin: { configured: { ads: false } },
      social: { maxDailyBudgetCents: 0 }, marketed: ['caremetric-intel'], log: () => {} });
    return { store, notifier, plan: handlers['ads.plan'] };
  }
  const google = report => ({ configured: true, createSearchCampaign: vi.fn(), stateTargets: vi.fn(async () => [pa]), deliveryReport: vi.fn(async () => report) });

  it('puts the findings on the receipt of a day with nothing to plan, and tells the owner once about a disapproved ad', async () => {
    const client = google({ since: '2026-10-23', until: '2026-11-21', account: { autoTagging: true, conversionTracking: 'NOT_CONVERSION_TRACKED' },
      campaigns: [{ id: '24493303819', name: 'Intel search', status: 'ENABLED', serving: 'SERVING', startDay: '2026-11-18', endDay: '2026-11-27', locations: [pa],
        ads: { approved: 0, limited: 0, disapproved: 1, underReview: 0, other: 0 }, impressions: 0, clicks: 0, costCents: 0, conversions: 0 }] });
    const h = setup(client);
    const done = await h.plan(task, { now });
    expect(client.deliveryReport).toHaveBeenCalledWith({ since: '2026-10-23', until: '2026-11-21' }, { signal: undefined });
    expect(done.result).toMatchObject({ skipped: 'not_monday', google: { read: true, account: { issues: ['conversions_not_tracked'] },
      campaigns: [{ id: '24493303819', places: ['Pennsylvania'], issues: ['ad_disapproved', 'no_impressions'] }] } });
    expect(h.notifier.send).toHaveBeenCalledTimes(1);
    const [message] = h.notifier.send.mock.calls[0];
    expect(message).toMatchObject({ severity: 'warning', attention: 'now', dedupeKey: 'ads:google:delivery:24493303819:ad_disapproved+no_impressions' });
    expect(message.body).toContain('Google disapproved an ad');
    expect(message.body).toContain('Its places: Pennsylvania.');
  });

  it('records a refused read and still plans, saying nothing to the owner', async () => {
    const client = { configured: true, createSearchCampaign: vi.fn(),
      deliveryReport: vi.fn(async () => { throw Object.assign(new Error('refused'), { code: 'google_query_refused', reason: 'queryError.UNRECOGNIZED_FIELD' }); }) };
    const h = setup(client);
    const done = await h.plan(task, { now });
    expect(done.result).toEqual({ skipped: 'not_monday', google: { read: false, code: 'google_query_refused', reason: 'queryError.UNRECOGNIZED_FIELD' } });
    expect(h.notifier.send).not.toHaveBeenCalled();
  });

  it('adds nothing while the Google Ads API is not set up', async () => {
    const done = await setup({ configured: false, createSearchCampaign: vi.fn(), deliveryReport: vi.fn() }).plan(task, { now });
    expect(done.result).toEqual({ skipped: 'not_monday' });
  });
});
