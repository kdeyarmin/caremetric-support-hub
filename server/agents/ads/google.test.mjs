import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { adwordsScope, checkGooglePlan, editorCsv, googleAdsClient } from './google.mjs';
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

  it('keeps the roster states in the Editor import instead of silently targeting the whole country', () => {
    const csv = editorCsv(checkGooglePlan(plan(), { factsKey: 'intel' }).plan, {
      name: 'Intel search', finalUrl: 'https://www.caremetricintel.com/county-report', dailyBudgetCents: 500,
      states: [{ code: 'PA', name: 'Pennsylvania' }, { code: 'NJ', name: 'New Jersey' }],
    });
    const lines = csv.split('\n');
    expect(lines[1]).toContain('Search,Paused,5.00,Google search,"Pennsylvania, United States"');
    expect(lines[2]).toMatch(/^Intel search,,,,,"New Jersey, United States",/);
    expect(csv).not.toMatch(/,United States(?:,|$)/);
    expect(csv).toContain('home health crm,Exact');
    expect(lines.at(-1)).toContain('https://www.caremetricintel.com/county-report');
  });

  it('treats a successful response without a valid campaign receipt as unconfirmed, never as launched', async () => {
    const campaign = { name: 'Intel search', dailyBudgetCents: 500, finalUrl: 'https://www.caremetricintel.com/county-report',
      plan: checkGooglePlan(plan(), { factsKey: 'intel' }).plan, live: true, endDate: '2026-11-30' };
    for (const response of [null, {}, { mutateOperationResponses: {} }, { mutateOperationResponses: [{}] },
      { mutateOperationResponses: [{ campaignResult: { resourceName: 'customers/0987654321/campaigns/55' } }] },
      { mutateOperationResponses: [{ campaignResult: { resourceName: 'customers/1234567890/campaigns/' } }] }]) {
      const fetchImpl = vi.fn(async url => new Response(JSON.stringify(String(url).includes('oauth2') ? { access_token: 'ya29.token' } : response)));
      const client = googleAdsClient({ clientId: 'client.apps', clientSecret: 'secret-0123456789', refreshToken: '1//refresh-token-0123456789', customerId: '1234567890', fetchImpl });
      await expect(client.createSearchCampaign(campaign)).rejects.toMatchObject({ code: 'google_unconfirmed', transient: false });
      expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('googleAds:mutate'))).toHaveLength(1);
    }
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
    expect(operations[1].campaignOperation.create).toMatchObject({ status: 'PAUSED', advertisingChannelType: 'SEARCH', targetSpend: {} });
    expect(operations[1].campaignOperation.create).not.toHaveProperty('maximizeClicks');
    expect(operations.filter(op => op.adGroupCriterionOperation)).toHaveLength(checked.keywords.length);
    expect(operations.at(-1).adGroupAdOperation.create.ad.responsiveSearchAd.headlines).toHaveLength(checked.headlines.length);
    expect(googleAdsClient({ customerId: '1234567890' }).configured).toBe(false);
  });

  it('creates a campaign the owner handed over running, with its last day, and refuses one without a last day before asking Google', async () => {
    const fetchImpl = vi.fn(async url => (String(url).includes('oauth2') ? new Response(JSON.stringify({ access_token: 'ya29.token' }))
      : new Response(JSON.stringify({ mutateOperationResponses: [{}, { campaignResult: { resourceName: 'customers/1234567890/campaigns/56' } }] }))));
    const client = googleAdsClient({ clientId: 'client.apps', clientSecret: 'secret-0123456789', refreshToken: '1//refresh-token-0123456789', customerId: '1234567890', fetchImpl });
    const checked = checkGooglePlan(plan(), { factsKey: 'intel' }).plan;
    const campaign = { name: 'Intel search', dailyBudgetCents: 1000, finalUrl: 'https://www.caremetricintel.com/county-report', plan: checked };
    expect(await client.createSearchCampaign({ ...campaign, live: true, endDate: '2026-11-30' })).toEqual({ campaign: 'customers/1234567890/campaigns/56' });
    const operations = JSON.parse(fetchImpl.mock.calls[1][1].body).mutateOperations;
    expect(operations[1].campaignOperation.create).toMatchObject({ status: 'ENABLED', endDateTime: '2026-11-30 23:59:59', targetSpend: {} });
    expect(operations[0].campaignBudgetOperation.create.amountMicros).toBe('10000000');
    await expect(client.createSearchCampaign({ ...campaign, live: true })).rejects.toMatchObject({ code: 'google_invalid_request' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // A flight the owner approved: paused, with its last day, so it ends on its own once started; a malformed day is refused first.
    await client.createSearchCampaign({ ...campaign, endDate: '2026-11-25' });
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body).mutateOperations[1].campaignOperation.create).toMatchObject({ status: 'PAUSED', endDateTime: '2026-11-25 23:59:59' });
    const before = fetchImpl.mock.calls.length;
    await expect(client.createSearchCampaign({ ...campaign, endDate: 'next week' })).rejects.toMatchObject({ code: 'google_invalid_request' });
    expect(fetchImpl).toHaveBeenCalledTimes(before);
  });

  it('signs in as the Hub\'s service account when no refresh token is set, and sends no retired developer token', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const serviceAccount = JSON.stringify({ type: 'service_account', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      client_email: 'hub@caremetric-hub.iam.gserviceaccount.com' });
    const fetchImpl = vi.fn(async url => (String(url).includes('oauth2') ? new Response(JSON.stringify({ access_token: 'ya29.service' }))
      : new Response(JSON.stringify({ mutateOperationResponses: [{}, { campaignResult: { resourceName: 'customers/7579556529/campaigns/9' } }] }))));
    const client = googleAdsClient({ serviceAccount, customerId: '7579556529', loginCustomerId: '1840441372', fetchImpl });
    expect(client).toMatchObject({ configured: true, auth: 'service_account' });
    const checked = checkGooglePlan(plan(), { factsKey: 'intel' }).plan;
    expect(await client.createSearchCampaign({ name: 'Intel search', dailyBudgetCents: 1500, finalUrl: 'https://www.caremetricintel.com/county-report', plan: checked }))
      .toEqual({ campaign: 'customers/7579556529/campaigns/9' });
    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0];
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(tokenInit.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion').split('.');
    expect(JSON.parse(Buffer.from(claims, 'base64url'))).toMatchObject({ iss: 'hub@caremetric-hub.iam.gserviceaccount.com', scope: adwordsScope });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    const [, init] = fetchImpl.mock.calls[1];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ya29.service', 'login-customer-id': '1840441372' });
    expect(init.headers).not.toHaveProperty('developer-token');
    // An OAuth client with a refresh token still wins; a key that does not parse configures nothing.
    expect(googleAdsClient({ serviceAccount, clientId: 'client.apps', clientSecret: 'secret-0123456789', refreshToken: '1//refresh-token-0123456789', customerId: '7579556529' }).auth).toBe('oauth');
    expect(googleAdsClient({ serviceAccount: '{"type":"service_account"}', customerId: '7579556529' }).configured).toBe(false);
    expect(googleAdsClient({ serviceAccount }).configured).toBe(false);
  });

  it('enforces a bounded launch reservation with a campaign total budget and both dates', async () => {
    const fetchImpl = vi.fn(async url => new Response(JSON.stringify(String(url).includes('oauth2') ? { access_token: 'ya29.token' }
      : { mutateOperationResponses: [{ campaignResult: { resourceName: 'customers/1234567890/campaigns/55' } }] })));
    const client = googleAdsClient({ clientId: 'client.apps', clientSecret: 'secret-0123456789', refreshToken: '1//refresh-token-0123456789', customerId: '1234567890', fetchImpl });
    const campaign = { name: 'Intel flight', dailyBudgetCents: 500, totalBudgetCents: 5000, finalUrl: 'https://www.caremetricintel.com/county-report',
      plan: checkGooglePlan(plan(), { factsKey: 'intel' }).plan, live: true, startDate: '2026-11-16', endDate: '2026-11-25' };
    await client.createSearchCampaign(campaign);
    const operations = JSON.parse(fetchImpl.mock.calls.at(-1)[1].body).mutateOperations;
    expect(operations[0].campaignBudgetOperation.create).toMatchObject({ period: 'CUSTOM_PERIOD', totalAmountMicros: '50000000', explicitlyShared: false });
    expect(operations[0].campaignBudgetOperation.create).not.toHaveProperty('amountMicros');
    expect(operations[1].campaignOperation.create).toMatchObject({ status: 'ENABLED', targetSpend: {}, startDateTime: '2026-11-16 00:00:00', endDateTime: '2026-11-25 23:59:59' });
    // No request can accidentally turn a missing/invalid total or time window into an unrestricted live campaign.
    fetchImpl.mockClear();
    for (const changed of [{ totalBudgetCents: 0 }, { totalBudgetCents: -1 }, { totalBudgetCents: 50.5 }, { totalBudgetCents: '5000' },
      { dailyBudgetCents: 0 }, { dailyBudgetCents: -1 }, { dailyBudgetCents: 50.5 }, { dailyBudgetCents: '500' },
      { startDate: null }, { endDate: null }, { startDate: '2026-11-26' }, { startDate: '2026-02-30' }, { endDate: '2026-11-31' },
      { endDate: '2026-11-17' }, { endDate: '2027-02-14' }]) {
      await expect(client.createSearchCampaign({ ...campaign, ...changed })).rejects.toMatchObject({ code: 'google_invalid_request' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
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

describe('reach outside cold email (team review 2026-11-17, stage 6)', () => {
  const states = [{ code: 'PA', name: 'Pennsylvania' }, { code: 'NJ', name: 'New Jersey' }];
  const suggestion = (name, id, over = {}) => ({ geoTargetConstant: { resourceName: `geoTargetConstants/${id}`, name, countryCode: 'US', targetType: 'State', status: 'ENABLED', ...over } });
  const googleFetch = (suggestions = [suggestion('Pennsylvania', 21167), suggestion('Pennsylvania', 9999, { targetType: 'City' }), suggestion('New Jersey', 21164)]) => vi.fn(async url => {
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'ya29.token' }));
    if (String(url).endsWith('geoTargetConstants:suggest')) return new Response(JSON.stringify({ geoTargetConstantSuggestions: suggestions }));
    return new Response(JSON.stringify({ mutateOperationResponses: [{}, { campaignResult: { resourceName: 'customers/1234567890/campaigns/55' } }] }));
  });
  const make = fetchImpl => googleAdsClient({ developerToken: 'dev-token-123', clientId: 'client.apps', clientSecret: 'secret-0123456789', refreshToken: '1//refresh-token-0123456789',
    customerId: '1234567890', version: 'v26', fetchImpl });

  it('limits a new search campaign to the roster\'s states through Google\'s own location suggestions', async () => {
    const fetchImpl = googleFetch();
    const client = make(fetchImpl);
    const checked = checkGooglePlan(plan(), { factsKey: 'intel' }).plan;
    await client.createSearchCampaign({ name: 'Intel search', dailyBudgetCents: 1500, finalUrl: 'https://www.caremetricintel.com/county-report', plan: checked, states });
    const suggest = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('geoTargetConstants:suggest'));
    expect(JSON.parse(suggest[1].body)).toEqual({ locale: 'en', countryCode: 'US', locationNames: { names: ['Pennsylvania', 'New Jersey'] } });
    const mutate = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('googleAds:mutate'));
    const places = JSON.parse(mutate[1].body).mutateOperations.filter(op => op.campaignCriterionOperation?.create?.location).map(op => op.campaignCriterionOperation.create.location.geoTargetConstant);
    expect(places).toEqual(['geoTargetConstants/21167', 'geoTargetConstants/21164']);
    expect(JSON.parse(mutate[1].body).mutateOperations.find(op => op.campaignOperation).campaignOperation.create.geoTargetTypeSetting)
      .toEqual({ positiveGeoTargetType: 'PRESENCE' });
    // Kept for the process: the next campaign asks Google only to create it.
    fetchImpl.mockClear();
    await client.createSearchCampaign({ name: 'Again', dailyBudgetCents: 1500, finalUrl: 'https://www.caremetricintel.com/county-report', plan: checked, states });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('geoTargetConstants:suggest'))).toBe(false);
  });

  it('creates nothing when Google does not name a state exactly', async () => {
    const fetchImpl = googleFetch([suggestion('Pennsylvania', 21167), suggestion('New Jersey', 21164, { status: 'REMOVAL_PLANNED' })]);
    const checked = checkGooglePlan(plan(), { factsKey: 'intel' }).plan;
    await expect(make(fetchImpl).createSearchCampaign({ name: 'Intel search', dailyBudgetCents: 1500, finalUrl: 'https://www.caremetricintel.com/county-report', plan: checked, states }))
      .rejects.toMatchObject({ code: 'google_geo_unresolved' });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('googleAds:mutate'))).toBe(false);
    await expect(make(googleFetch()).stateTargets([{ code: 'pa', name: 'Pennsylvania' }])).rejects.toMatchObject({ code: 'google_geo_unresolved' });
  });

  it('retries throttled location lookups and campaign requests without treating them as invalid campaigns', async () => {
    for (const target of ['geoTargetConstants:suggest', 'googleAds:mutate']) {
      const regular = googleFetch();
      const fetchImpl = vi.fn(async (url, init) => String(url).endsWith(target) ? new Response('{}', { status: 429 }) : regular(url, init));
      await expect(make(fetchImpl).createSearchCampaign({ name: 'Intel search', dailyBudgetCents: 500,
        finalUrl: 'https://www.caremetricintel.com/county-report', plan: checkGooglePlan(plan(), { factsKey: 'intel' }).plan, states }))
        .rejects.toMatchObject({ code: 'google_unavailable', transient: true });
      if (target === 'geoTargetConstants:suggest') expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('googleAds:mutate'))).toBe(false);
    }
  });
});
