import { describe, expect, it, vi } from 'vitest';
import { checkGooglePlan, editorCsv, googleAdsClient } from './google.mjs';
import { campaignDailyBudget } from './index.mjs';

const plan = (over = {}) => ({
  headlines: ['Referral sources in one place', 'Plan visits by county', 'Free county report', 'See your territory'],
  descriptions: ['CareMetric Intel brings territory analysis and a marketing CRM into one place.', 'Start with the free county report for your market.'],
  keywords: [{ text: 'home health marketing software', match: 'PHRASE' }, { text: 'hospice referral tracking', match: 'PHRASE' }, { text: 'home health crm', match: 'EXACT' },
    { text: 'hospice marketing', match: 'BROAD' }, { text: 'referral source tracking', match: 'PHRASE' }, { text: 'Trella', match: 'EXACT' }],
  negatives: ['jobs', 'careers', 'Bad Negative!'], ...over,
});

describe('the Google search plan', () => {
  it('keeps checked headlines, descriptions and plain keywords, and competitor names only as keywords when allowed', () => {
    const checked = checkGooglePlan(plan(), { factsKey: 'intel' });
    expect(checked.ok).toBe(true);
    expect(checked.plan.keywords.map(k => k.text)).not.toContain('trella');
    expect(checked.plan.negatives).toEqual(['jobs', 'careers']);
    expect(checkGooglePlan(plan(), { factsKey: 'intel', competitors: true }).plan.keywords.map(k => k.text)).toContain('trella');
    // Ad text never names a competitor, whatever the setting.
    const named = checkGooglePlan(plan({ headlines: ['Better than Trella', ...plan().headlines] }), { factsKey: 'intel', competitors: true });
    expect(named.plan.headlines).not.toContain('Better than Trella');
    expect(named.problems).toContain('competitor_named');
  });

  it('refuses a plan too thin to run, and copy over the limits', () => {
    expect(checkGooglePlan(plan({ headlines: ['Only one'] }), { factsKey: 'intel' })).toMatchObject({ ok: false, reason: 'headlines' });
    const long = checkGooglePlan(plan({ headlines: [...plan().headlines, 'A headline that is far longer than thirty characters'] }), { factsKey: 'intel' });
    expect(long.problems).toContain('headline_length');
    expect(checkGooglePlan(plan({ keywords: plan().keywords.slice(0, 2) }), { factsKey: 'intel' })).toMatchObject({ ok: false, reason: 'keywords' });
  });

  it('writes an Editor import file with the campaign paused', () => {
    const csv = editorCsv(checkGooglePlan(plan(), { factsKey: 'intel' }).plan, { name: 'CareMetric Intel search 2026-11', finalUrl: 'https://www.caremetricintel.com/county-report', dailyBudgetCents: 1500 });
    const lines = csv.split('\n');
    expect(lines[0]).toMatch(/^Campaign,Campaign Type,Campaign Status,Budget/);
    expect(lines[1]).toContain('Search,Paused,15.00');
    expect(csv).toContain('home health crm,Exact');
    expect(csv).toContain('jobs,Campaign Negative Broad');
    expect(lines.at(-1)).toContain('Referral sources in one place');
  });

  it('creates the campaign paused in one mutate, with the developer token, after renewing its access token', async () => {
    const fetchImpl = vi.fn(async url => (String(url).includes('oauth2') ? new Response(JSON.stringify({ access_token: 'ya29.token' }))
      : new Response(JSON.stringify({ mutateOperationResponses: [{}, { campaignResult: { resourceName: 'customers/1234567890/campaigns/55' } }] }))));
    const client = googleAdsClient({ developerToken: 'dev-token-123', clientId: 'client.apps', clientSecret: 'secret-0123456789', refreshToken: '1//refresh-token-0123456789',
      customerId: '1234567890', loginCustomerId: '0987654321', version: 'v26', fetchImpl });
    expect(client.configured).toBe(true);
    const checked = checkGooglePlan(plan(), { factsKey: 'intel' }).plan;
    expect(await client.createSearchCampaign({ name: 'Intel search', dailyBudgetCents: 1500, finalUrl: 'https://www.caremetricintel.com/county-report', plan: checked }))
      .toEqual({ campaign: 'customers/1234567890/campaigns/55' });
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe('https://googleads.googleapis.com/v26/customers/1234567890/googleAds:mutate');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ya29.token', 'developer-token': 'dev-token-123', 'login-customer-id': '0987654321' });
    const operations = JSON.parse(init.body).mutateOperations;
    expect(operations[0].campaignBudgetOperation.create.amountMicros).toBe('15000000');
    expect(operations[1].campaignOperation.create).toMatchObject({ status: 'PAUSED', advertisingChannelType: 'SEARCH' });
    expect(operations.filter(op => op.adGroupCriterionOperation)).toHaveLength(checked.keywords.length);
    expect(operations.at(-1).adGroupAdOperation.create.ad.responsiveSearchAd.headlines).toHaveLength(checked.headlines.length);
    expect(googleAdsClient({ customerId: '1234567890' }).configured).toBe(false);
  });
});

describe('a new campaign\'s daily budget', () => {
  it('is a thirtieth of the monthly number, never above the daily ad-set limit, and none when too small', () => {
    expect(campaignDailyBudget({ monthlyBudgetCents: 90_000, maxDailyBudgetCents: 0 }, 'meta')).toBe(3000);
    expect(campaignDailyBudget({ monthlyBudgetCents: 90_000, maxDailyBudgetCents: 2000 }, 'meta')).toBe(2000);
    expect(campaignDailyBudget({ monthlyBudgetCents: 24_000, maxDailyBudgetCents: 0 }, 'linkedin')).toBeNull();
    expect(campaignDailyBudget({ monthlyBudgetCents: 24_000, maxDailyBudgetCents: 0 }, 'meta')).toBe(800);
    expect(campaignDailyBudget({ monthlyBudgetCents: 0 }, 'google')).toBeNull();
  });
});
