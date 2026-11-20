/**
 * Google search ads (owner decision 2026-11-13): the Social Media Manager writes one search campaign a month per marketed product (keywords,
 * negative keywords and a responsive search ad, from the fact sheet), proposed for the owner's approval. On approval it is created PAUSED
 * through the Google Ads API when the API is set up (Settings → Paid ads → Google Ads customer id, and the Hub's Google service account
 * added as a Standard user in Google Ads); until then the same plan is emailed as an import file for Google Ads Editor. Competitors' names may be keywords only with
 * Settings → Paid ads → "Bid on competitor names" on, and never appear in ad text.
 */
import { namesCompetitor, textProblems } from '../content/validate.mjs';
import { readCredentials, signAssertion, tokenUrl } from '../seo/search-console.mjs';
import { factSheetText } from '../content/facts.mjs';
import { playbookText } from '../../growth/playbook.mjs';

export const googlePromptVersion = 'google-search.2';
export const matchTypes = Object.freeze(['EXACT', 'PHRASE', 'BROAD']);
const limits = { headline: 30, description: 90, keyword: 80, headlines: 15, descriptions: 4, keywords: 40, negatives: 40 };

export const googleSystem = `You write one Google search campaign for a CareMetric product: the keywords people type when they look for what it does, negative keywords that keep away searches it cannot help, and one responsive search ad. CareMetric's owner approves the campaign before it exists; code checks every word.

Rules:
- Headlines: 10 to 15, each at most 30 characters, each able to stand alone. Descriptions: 4, each at most 90 characters, complete sentences.
- State facts about CareMetric only from the fact sheet below, exactly as written. No number, price, discount or claim that is not there; no promise of referrals, revenue or compliance; never a competitor's name in a headline or description.
- Name where CareMetric Intel's data comes from: "Medicare data", "CMS and Census data", "CMS ratings". Never call it public, publicly available or free data, and never proprietary, exclusive or licensed.
- Keywords: 15 to 40 short phrases a home health or hospice owner, administrator or marketer would search for (for CareBase: a Pennsylvania personal care home or assisted living owner), with a match type: EXACT, PHRASE or BROAD. Prefer PHRASE and EXACT.
- Negative keywords: 10 to 40 words or phrases for searches the product cannot help: jobs and careers, patient care at home, free software lists, logins of other products, and similar.
- When the request says competitors are allowed, you may add up to five competitor product names as EXACT keywords; otherwise none.

Answer with one JSON object: keywords, negatives, headlines, descriptions.

${factSheetText()}

${playbookText()}`;

export const googleSchema = { type: 'object', additionalProperties: false, required: ['keywords', 'negatives', 'headlines', 'descriptions'], properties: {
  keywords: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'match'], properties: { text: { type: 'string' }, match: { type: 'string', enum: [...matchTypes] } } } },
  negatives: { type: 'array', items: { type: 'string' } }, headlines: { type: 'array', items: { type: 'string' } }, descriptions: { type: 'array', items: { type: 'string' } },
} };

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const unique = list => [...new Map(list.map(item => [JSON.stringify(item).toLowerCase(), item])).values()];

/**
 * The plan as code keeps it, or the reason it cannot be used: lengths and counts, every headline and description through the fact-sheet
 * checks (a competitor named, a number or price not on the sheet, a promise), keywords plain words, competitor keywords only when allowed.
 */
export function checkGooglePlan(raw, { factsKey, competitors = false }) {
  const problems = new Set();
  const fits = (text, max) => text && text.length <= max && !/[<>{}\n]/.test(text);
  const copy = (list, max, kind) => unique((Array.isArray(list) ? list : []).map(clean).filter(text => {
    if (!fits(text, max)) { problems.add(`${kind}_length`); return false; }
    const found = textProblems(text, { product: factsKey });
    if (namesCompetitor(text)) found.unshift('competitor_named');
    if (found.length) { problems.add(found[0]); return false; }
    return true;
  }));
  const headlines = copy(raw?.headlines, limits.headline, 'headline').slice(0, limits.headlines);
  const descriptions = copy(raw?.descriptions, limits.description, 'description').slice(0, limits.descriptions);
  const keywords = unique((Array.isArray(raw?.keywords) ? raw.keywords : []).map(item => ({ text: clean(item?.text).toLowerCase(), match: matchTypes.includes(item?.match) ? item.match : 'PHRASE' }))
    .filter(item => /^[a-z0-9][a-z0-9 &'+-]{1,79}$/.test(item.text) && (competitors || !namesCompetitor(item.text)))).slice(0, limits.keywords);
  const negatives = unique((Array.isArray(raw?.negatives) ? raw.negatives : []).map(item => clean(item).toLowerCase()).filter(text => /^[a-z0-9][a-z0-9 &'+-]{0,79}$/.test(text))).slice(0, limits.negatives);
  if (headlines.length < 3 || descriptions.length < 2 || keywords.length < 5) return { ok: false, reason: headlines.length < 3 ? 'headlines' : descriptions.length < 2 ? 'descriptions' : 'keywords', problems: [...problems] };
  return { ok: true, plan: { keywords, negatives, headlines, descriptions }, problems: [...problems] };
}

const csvCell = value => (/[",\n]/.test(String(value ?? '')) ? `"${String(value).replace(/"/g, '""')}"` : String(value ?? ''));

/** The plan as one CSV for Google Ads Editor (Account → Import → From file): the campaign (paused), its keywords and negatives, and the ad. */
export function editorCsv(plan, { name, finalUrl, dailyBudgetCents, states = [] }) {
  const header = ['Campaign', 'Campaign Type', 'Campaign Status', 'Budget', 'Networks', 'Location', 'Ad Group', 'Keyword', 'Criterion Type', 'Final URL',
    ...Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `Description ${i + 1}`)];
  const row = values => header.map(column => csvCell(values[column] ?? '')).join(',');
  const group = `${name} - search`;
  const matchName = { EXACT: 'Exact', PHRASE: 'Phrase', BROAD: 'Broad' };
  // Keep the same locations as an API launch. Each location needs its own campaign row in Editor; qualifying the state with its
  // country also keeps a state name from being interpreted as a city. Only an unscoped campaign gets the whole country.
  const locations = states.length ? [...new Set(states.map(state => `${state.name}, United States`))] : ['United States'];
  return [header.map(csvCell).join(','),
    row({ Campaign: name, 'Campaign Type': 'Search', 'Campaign Status': 'Paused', Budget: (dailyBudgetCents / 100).toFixed(2), Networks: 'Google search', Location: locations[0] }),
    ...locations.slice(1).map(location => row({ Campaign: name, Location: location })),
    ...plan.keywords.map(keyword => row({ Campaign: name, 'Ad Group': group, Keyword: keyword.text, 'Criterion Type': matchName[keyword.match] })),
    ...plan.negatives.map(text => row({ Campaign: name, Keyword: text, 'Criterion Type': 'Campaign Negative Broad' })),
    row({ Campaign: name, 'Ad Group': group, 'Final URL': finalUrl, ...Object.fromEntries(plan.headlines.map((text, i) => [`Headline ${i + 1}`, text])),
      ...Object.fromEntries(plan.descriptions.map((text, i) => [`Description ${i + 1}`, text])) }),
  ].join('\n');
}

const failure = (code, transient = false) => Object.assign(new Error('Google Ads refused the request.'), { code, transient });
const calendarDay = value => typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// Google's own enum names (SERVING, DISAPPROVED, NOT_CONVERSION_TRACKED, …): kept only when they look like one.
const enumWord = value => (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(value) ? value : null);
const count = value => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0; };
const cents = micros => { const n = Number(micros); return Number.isFinite(n) && n >= 0 ? Math.round(n / 10_000) : null; };
const dayOf = value => (typeof value === 'string' && calendarDay(value.slice(0, 10)) ? value.slice(0, 10) : null);
// Why the Data Manager API refused a request: the reason of its google.rpc.ErrorInfo (SERVICE_DISABLED, ACCESS_TOKEN_SCOPE_INSUFFICIENT),
// else the first field violation's reason (INVALID_NUMBER_FORMAT). Only the enum is kept, never the message or a field's value.
const dataManagerRefusal = data => {
  const details = Array.isArray(data?.error?.details) ? data.error.details : [];
  const info = details.find(detail => String(detail?.['@type'] ?? '').endsWith('google.rpc.ErrorInfo'));
  const violation = details.flatMap(detail => (Array.isArray(detail?.fieldViolations) ? detail.fieldViolations : []))[0];
  for (const value of [info?.reason, violation?.reason, data?.error?.status]) if (enumWord(value) && value !== 'INVALID_ARGUMENT') return value;
  return enumWord(data?.error?.status);
};
// A refused search keeps only Google's error enum (e.g. queryError.UNRECOGNIZED_FIELD), never its message text.
const searchRefusal = data => {
  for (const detail of Array.isArray(data?.error?.details) ? data.error.details : []) {
    for (const item of Array.isArray(detail?.errors) ? detail.errors : []) {
      for (const [kind, value] of Object.entries(item?.errorCode ?? {})) {
        const reason = `${kind}.${value}`;
        if (/^[a-zA-Z]{1,40}\.[A-Z][A-Z0-9_]{0,59}$/.test(reason)) return reason;
      }
    }
  }
  return null;
};

/**
 * The read-back of the account's running campaigns (review 2026-11-18): the raw rows of deliveryReport's searches, keyed by campaign id.
 * Exported for tests. `rows` is { account, campaigns, metrics, ads, locations }, each the `results` of one search.
 */
export function deliveryFromRows({ account = [], campaigns = [], metrics = [], ads = [], locations = [] }) {
  const customer = account[0]?.customer ?? {};
  const byId = new Map();
  for (const row of campaigns) {
    const id = String(row?.campaign?.id ?? '');
    if (!/^[0-9]{1,20}$/.test(id) || byId.has(id)) continue;
    const campaign = row.campaign;
    const budget = row.campaignBudget ?? {};
    byId.set(id, {
      id, name: String(campaign.name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120),
      status: enumWord(campaign.status), serving: enumWord(campaign.servingStatus), primary: enumWord(campaign.primaryStatus),
      reasons: (Array.isArray(campaign.primaryStatusReasons) ? campaign.primaryStatusReasons : []).map(enumWord).filter(Boolean).slice(0, 10),
      startDay: dayOf(campaign.startDateTime), endDay: dayOf(campaign.endDateTime),
      budget: { period: enumWord(budget.period), dailyCents: cents(budget.amountMicros), totalCents: cents(budget.totalAmountMicros) },
      locations: [], ads: { approved: 0, limited: 0, disapproved: 0, underReview: 0, other: 0 },
      impressions: 0, clicks: 0, costCents: 0, conversions: 0,
    });
  }
  for (const row of metrics) {
    const item = byId.get(String(row?.campaign?.id ?? ''));
    if (!item) continue;
    item.impressions += count(row.metrics?.impressions);
    item.clicks += count(row.metrics?.clicks);
    item.costCents += cents(row.metrics?.costMicros) ?? 0;
    item.conversions += Number.isFinite(Number(row.metrics?.conversions)) && Number(row.metrics.conversions) > 0 ? Number(row.metrics.conversions) : 0;
  }
  for (const row of ads) {
    const item = byId.get(String(row?.campaign?.id ?? ''));
    if (!item) continue;
    const approval = enumWord(row.adGroupAd?.policySummary?.approvalStatus);
    const review = enumWord(row.adGroupAd?.policySummary?.reviewStatus);
    if (approval === 'DISAPPROVED') item.ads.disapproved += 1;
    else if (approval === 'APPROVED') item.ads.approved += 1;
    else if (approval === 'APPROVED_LIMITED' || approval === 'AREA_OF_INTEREST_ONLY') item.ads.limited += 1;
    else if (review === 'REVIEW_IN_PROGRESS' || review === 'UNDER_APPEAL') item.ads.underReview += 1;
    else item.ads.other += 1;
  }
  for (const row of locations) {
    const item = byId.get(String(row?.campaign?.id ?? ''));
    const place = row?.campaignCriterion?.location?.geoTargetConstant;
    if (item && /^geoTargetConstants\/[0-9]{1,12}$/.test(String(place ?? '')) && !item.locations.includes(place)) item.locations.push(place);
  }
  for (const item of byId.values()) item.conversions = Math.round(item.conversions * 100) / 100;
  return {
    // JSON leaves out a field at its default, so a customer row without autoTaggingEnabled means false; no row at all means unknown.
    account: { autoTagging: account.length ? customer.autoTaggingEnabled === true : null,
      conversionTracking: enumWord(customer.conversionTrackingSetting?.conversionTrackingStatus) },
    campaigns: [...byId.values()],
  };
}

export const adwordsScope = 'https://www.googleapis.com/auth/adwords';
/** Google's Data Manager API, where offline click conversions go since the Google Ads API stopped taking new adopters (June 15, 2026). */
export const dataManagerScope = 'https://www.googleapis.com/auth/datamanager';
export const dataManagerIngestUrl = 'https://datamanager.googleapis.com/v1/events:ingest';

/**
 * The Google Ads API: an access token, and one atomic mutate that creates a PAUSED search campaign (its budget, United States targeting,
 * negative keywords, one ad group with its keywords and the responsive search ad). Nothing runs until the owner enables it in Google Ads,
 * unless the owner handed ad campaign launch over: then it is created ENABLED and ends with its month. `deliveryReport` reads back, and
 * never changes, what Google reports about the enabled campaigns.
 *
 * The token comes from an OAuth client's refresh token when all three are set, else from the Hub's Google service account
 * (`serviceAccount`, the HUB_SEARCH_CONSOLE_CREDENTIALS key) added as a Standard user in Google Ads, which needs no refresh token. API
 * access follows the Google Cloud project whose credentials make the call; developer tokens were retired on September 9, 2026, so one is
 * sent only when it is still set.
 */
export function googleAdsClient({ developerToken = '', clientId = '', clientSecret = '', refreshToken = '', serviceAccount = '', customerId = '', loginCustomerId = '', version = 'v26', fetchImpl = fetch, timeoutMs = 20_000, clock = () => Date.now() } = {}) {
  const customer = /^[0-9]{10}$/.test(customerId) ? customerId : null;
  const login = /^[0-9]{10}$/.test(loginCustomerId) ? loginCustomerId : null;
  const apiVersion = /^v[0-9]{2}$/.test(version) ? version : 'v26';
  const oauth = Boolean(clientId && clientSecret.length >= 10 && refreshToken.length >= 20);
  const account = oauth ? { state: 'unused' } : readCredentials(serviceAccount);
  const auth = oauth ? 'oauth' : account.state === 'ready' ? 'service_account' : null;
  const configured = Boolean(customer && auth);
  const devToken = developerToken.length >= 10 ? developerToken : '';
  // The service account asks for the scope the call needs (the Google Ads API's, or the Data Manager API's for conversions); a person's
  // refresh token carries the scopes they granted when they signed in.
  async function accessToken(signal, scope = adwordsScope) {
    const body = auth === 'oauth'
      ? new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }).toString()
      : new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signAssertion(account, { issuedAt: Math.floor(clock() / 1000), scope }) }).toString();
    let response;
    try {
      response = await fetchImpl(tokenUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    } catch (error) { if (signal?.aborted) throw error; throw failure('google_unavailable', true); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data?.access_token !== 'string') throw failure(response.status === 400 || response.status === 401 ? 'google_token_invalid' : 'google_unavailable', response.status >= 500);
    return data.access_token;
  }
  // Google's location for each US state, from its location suggestions (geoTargetConstants:suggest), never written by hand; kept for the
  // process. `states` is [{ code, name }]. A state without an exact enabled US State match fails as google_geo_unresolved.
  const stateCache = new Map();
  async function stateTargets(states, signal) {
    const missing = states.filter(state => !stateCache.has(state?.code));
    if (states.some(state => !/^[A-Z]{2}$/.test(String(state?.code ?? '')) || !state?.name)) throw failure('google_geo_unresolved');
    if (missing.length) {
      const token = await accessToken(signal);
      let response;
      try {
        response = await fetchImpl(`https://googleads.googleapis.com/${apiVersion}/geoTargetConstants:suggest`, { method: 'POST', redirect: 'error',
          signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]),
          headers: { Authorization: `Bearer ${token}`, ...(devToken ? { 'developer-token': devToken } : {}), 'Content-Type': 'application/json', ...(login ? { 'login-customer-id': login } : {}) },
          body: JSON.stringify({ locale: 'en', countryCode: 'US', locationNames: { names: missing.map(state => state.name) } }) });
      } catch (error) { if (signal?.aborted) throw error; throw failure('google_unavailable', true); }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? 'google_permission' : 'google_geo_unresolved');
      for (const state of missing) {
        const match = (data?.geoTargetConstantSuggestions ?? []).map(item => item?.geoTargetConstant ?? {})
          .find(item => item.targetType === 'State' && item.countryCode === 'US' && item.status === 'ENABLED' && String(item.name ?? '').toLowerCase() === state.name.toLowerCase()
            && /^geoTargetConstants\/[0-9]{1,12}$/.test(String(item.resourceName ?? '')));
        if (!match) throw failure('google_geo_unresolved');
        stateCache.set(state.code, match.resourceName);
      }
    }
    return states.map(state => stateCache.get(state.code));
  }
  // One GAQL search (googleAds:search), every page of it (at most five): read only, with the credentials that create campaigns.
  async function search(query, token, signal) {
    const rows = [];
    let pageToken = null;
    for (let page = 0; page < 5; page += 1) {
      let response;
      try {
        response = await fetchImpl(`https://googleads.googleapis.com/${apiVersion}/customers/${customer}/googleAds:search`, { method: 'POST', redirect: 'error',
          signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]),
          headers: { Authorization: `Bearer ${token}`, ...(devToken ? { 'developer-token': devToken } : {}), 'Content-Type': 'application/json', ...(login ? { 'login-customer-id': login } : {}) },
          body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }) });
      } catch (error) { if (signal?.aborted) throw error; throw failure('google_unavailable', true); }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const refused = failure(response.status === 401 || response.status === 403 ? 'google_permission' : response.status === 429 || response.status >= 500 ? 'google_unavailable' : 'google_query_refused',
          response.status === 429 || response.status >= 500);
        const reason = searchRefusal(data);
        throw reason ? Object.assign(refused, { reason }) : refused;
      }
      rows.push(...(Array.isArray(data?.results) ? data.results : []));
      pageToken = typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : null;
      if (!pageToken) break;
    }
    return rows;
  }

  return {
    configured, auth,

    /**
     * Whether `conversionActionId` is a conversion action leads can be uploaded to (owner request 2026-11-19): it exists in this account,
     * is enabled and imports conversions from clicks (UPLOAD_CLICKS, Google Ads → Goals → Conversions → New → Import → "Manual import
     * using API or uploads"). Read only. `{ ready: true }`, or `{ ready: false, reason }` with reason missing, not_enabled or not_click_import.
     */
    async conversionActionReady(conversionActionId, { signal } = {}) {
      if (!configured) throw failure('google_not_configured');
      if (!/^[0-9]{1,20}$/.test(String(conversionActionId ?? ''))) throw failure('google_invalid_request');
      const token = await accessToken(signal);
      const rows = await search(`SELECT conversion_action.id, conversion_action.type, conversion_action.status FROM conversion_action WHERE conversion_action.id = ${conversionActionId}`, token, signal);
      const action = rows[0]?.conversionAction;
      if (!action) return { ready: false, reason: 'missing' };
      if (action.status !== 'ENABLED') return { ready: false, reason: 'not_enabled' };
      if (action.type !== 'UPLOAD_CLICKS') return { ready: false, reason: 'not_click_import' };
      return { ready: true };
    },

    /**
     * Reports one lead from a Google ad click to `conversionActionId` as an offline click conversion, through Google's Data Manager API
     * (review 2026-11-20: since June 15, 2026 the Google Ads API refuses offline conversions from a new adopter with
     * CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE, and it refused this Hub's first lead). One event: its gclid, when the lead happened
     * (`happenedAt`, milliseconds) and the lead's id as the transaction id, which Google deduplicates on; nothing else about the person,
     * so no user data and no encoding. The destination is this account and the conversion action, through the manager account when one
     * is set, as the Google Ads API calls sign in.
     *
     * `{ accepted: true }` once Google takes the request for processing: Google matches the click later, and the outcome shows in
     * Google Ads. A refusal is a fixed code: google_datamanager_disabled (the Data Manager API is not enabled in the Google Cloud
     * project of the Hub's credentials), google_datamanager_scope (a person's sign-in without the Data Manager scope), google_permission,
     * google_request_refused (with the enum `reason` only), google_unavailable (transient), or google_unconfirmed when the answer
     * confirms nothing. Nothing Google writes is kept.
     */
    async sendClickConversion({ conversionActionId, gclid, happenedAt, transactionId }, { signal } = {}) {
      if (!configured) throw failure('google_not_configured');
      if (!/^[0-9]{1,20}$/.test(String(conversionActionId ?? '')) || !/^[A-Za-z0-9_.-]{1,500}$/.test(String(gclid ?? ''))
        || !Number.isFinite(happenedAt) || !/^[0-9A-Za-z-]{1,64}$/.test(String(transactionId ?? ''))) throw failure('google_invalid_request');
      const googleAds = id => ({ accountType: 'GOOGLE_ADS', accountId: id });
      const request = {
        destinations: [{ operatingAccount: googleAds(customer), ...(login ? { loginAccount: googleAds(login) } : {}), productDestinationId: String(conversionActionId) }],
        events: [{ adIdentifiers: { gclid }, eventTimestamp: new Date(happenedAt).toISOString(), transactionId, eventSource: 'WEB' }],
      };
      const token = await accessToken(signal, dataManagerScope);
      let response;
      try {
        response = await fetchImpl(dataManagerIngestUrl, { method: 'POST', redirect: 'error',
          signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      } catch (error) { if (signal?.aborted) throw error; throw failure('google_unavailable', true); }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = dataManagerRefusal(data);
        const transient = response.status === 429 || response.status >= 500;
        const code = transient ? 'google_unavailable'
          : reason === 'SERVICE_DISABLED' ? 'google_datamanager_disabled'
            : reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ? 'google_datamanager_scope'
              : response.status === 401 || response.status === 403 ? 'google_permission' : 'google_request_refused';
        throw Object.assign(failure(code, transient), reason ? { reason } : {});
      }
      if (typeof data?.requestId !== 'string' || !data.requestId) throw failure('google_unconfirmed');
      return { accepted: true };
    },

    /**
     * What Google reports about the account's enabled campaigns (review 2026-11-18: campaign 24493303819 was created through this client,
     * but its approval, delivery and the account's conversion tracking could be checked only in a browser session Google refused). Read
     * only, five searches: the account's auto-tagging and conversion tracking; each enabled campaign's status, serving status, budget,
     * dates; its impressions, clicks, cost and conversions from `since` to `until` (YYYY-MM-DD, the account's days); its enabled ads'
     * policy approval; and the places it targets. At most 20 campaigns, newest first. Nothing is changed in Google Ads.
     */
    async deliveryReport({ since, until }, { signal } = {}) {
      if (!configured) throw failure('google_not_configured');
      if (!calendarDay(since) || !calendarDay(until) || since > until) throw failure('google_invalid_request');
      const token = await accessToken(signal);
      const rows = {};
      rows.account = await search('SELECT customer.auto_tagging_enabled, customer.conversion_tracking_setting.conversion_tracking_status FROM customer LIMIT 1', token, signal);
      rows.campaigns = await search('SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.primary_status, campaign.primary_status_reasons, '
        + 'campaign.start_date_time, campaign.end_date_time, campaign_budget.period, campaign_budget.amount_micros, campaign_budget.total_amount_micros '
        + "FROM campaign WHERE campaign.status = 'ENABLED' ORDER BY campaign.id DESC LIMIT 20", token, signal);
      const ids = [...new Set(rows.campaigns.map(row => String(row?.campaign?.id ?? '')).filter(id => /^[0-9]{1,20}$/.test(id)))];
      if (ids.length) {
        const which = `campaign.id IN (${ids.join(', ')})`;
        rows.metrics = await search(`SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE ${which} AND segments.date BETWEEN '${since}' AND '${until}'`, token, signal);
        rows.ads = await search(`SELECT campaign.id, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status FROM ad_group_ad WHERE ${which} AND ad_group_ad.status = 'ENABLED'`, token, signal);
        rows.locations = await search(`SELECT campaign.id, campaign_criterion.location.geo_target_constant FROM campaign_criterion WHERE ${which} AND campaign_criterion.type = 'LOCATION' AND campaign_criterion.negative = FALSE`, token, signal);
      }
      return { since, until, ...deliveryFromRows(rows) };
    },

    /**
     * Creates the campaign PAUSED in one mutate; returns its resource name. `live` (a launch the owner handed over) creates it ENABLED with
     * its last day `endDate` (YYYY-MM-DD, the account's time zone), so it can never spend past its month; the mutate is atomic, so a
     * refusal creates nothing. A paused campaign may carry its last day too (a flight, which ends on its own). A bounded automatic launch
     * supplies totalBudgetCents and startDate as well: a campaign total budget enforces its reservation, unlike an average daily budget.
     */
    stateTargets,

    async createSearchCampaign({ name, dailyBudgetCents, totalBudgetCents = null, finalUrl, plan, live = false, startDate = null, endDate = null, states = [] }, { signal } = {}) {
      if (!configured) throw failure('google_not_configured');
      if ((live || endDate !== null || totalBudgetCents !== null) && !calendarDay(endDate)) throw failure('google_invalid_request');
      if (startDate !== null && (!calendarDay(startDate) || (endDate !== null && startDate > endDate))) throw failure('google_invalid_request');
      if (totalBudgetCents !== null && (!Number.isSafeInteger(totalBudgetCents) || totalBudgetCents <= 0 || !calendarDay(startDate))) throw failure('google_invalid_request');
      if (totalBudgetCents !== null) {
        const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1;
        if (days < 3 || days > 90) throw failure('google_invalid_request');
      }
      // Limited to the roster's states (team review 2026-11-17, stage 6), each found through Google's own location suggestions before
      // anything is created: a state it cannot name stops the campaign rather than letting it run nationwide.
      const places = states.length ? await stateTargets(states, signal) : ['geoTargetConstants/2840'];
      const base = `customers/${customer}`;
      const budget = `${base}/campaignBudgets/-1`, campaign = `${base}/campaigns/-2`, adGroup = `${base}/adGroups/-3`;
      const mutateOperations = [
        { campaignBudgetOperation: { create: { resourceName: budget, name: `${name} budget`.slice(0, 250),
          ...(totalBudgetCents === null ? { amountMicros: String(dailyBudgetCents * 10_000) }
            : { period: 'CUSTOM_PERIOD', totalAmountMicros: String(BigInt(totalBudgetCents) * 10_000n) }),
          deliveryMethod: 'STANDARD', explicitlyShared: false } } },
        // Google's API calls the Maximize clicks bidding strategy targetSpend; maximizeClicks is not a campaign field.
        { campaignOperation: { create: { resourceName: campaign, name: name.slice(0, 250), status: live ? 'ENABLED' : 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budget, targetSpend: {},
          ...(startDate !== null ? { startDateTime: `${startDate} 00:00:00` } : {}),
          ...(endDate !== null ? { endDateTime: `${endDate} 23:59:59` } : {}),
          // A roster-state campaign reaches people in those states; Google's default also includes people elsewhere interested in them.
          ...(states.length ? { geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' } } : {}),
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
          containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING' } } },
        ...places.map(geoTargetConstant => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant } } } })),
        ...plan.negatives.map(text => ({ campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text, matchType: 'BROAD' } } } })),
        { adGroupOperation: { create: { resourceName: adGroup, name: `${name} - search`.slice(0, 250), campaign, status: 'ENABLED', type: 'SEARCH_STANDARD' } } },
        ...plan.keywords.map(keyword => ({ adGroupCriterionOperation: { create: { adGroup, status: 'ENABLED', keyword: { text: keyword.text, matchType: keyword.match } } } })),
        { adGroupAdOperation: { create: { adGroup, status: 'ENABLED', ad: { finalUrls: [finalUrl], responsiveSearchAd: {
          headlines: plan.headlines.map(text => ({ text })), descriptions: plan.descriptions.map(text => ({ text })) } } } } },
      ];
      const token = await accessToken(signal);
      let response;
      try {
        response = await fetchImpl(`https://googleads.googleapis.com/${apiVersion}/${base}/googleAds:mutate`, { method: 'POST', redirect: 'error',
          signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]),
          headers: { Authorization: `Bearer ${token}`, ...(devToken ? { 'developer-token': devToken } : {}), 'Content-Type': 'application/json', ...(login ? { 'login-customer-id': login } : {}) },
          body: JSON.stringify({ mutateOperations }) });
      } catch (error) { if (signal?.aborted) throw error; throw failure('google_unconfirmed'); }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? 'google_permission' : response.status >= 500 ? 'google_unconfirmed' : 'google_invalid_request');
      const responses = Array.isArray(data?.mutateOperationResponses) ? data.mutateOperationResponses : [];
      const created = responses.map(item => item?.campaignResult?.resourceName).find(Boolean);
      // A 2xx response without a campaign receipt is not confirmation that it was launched. It may already be running, so preserve
      // its reservation and require reconciliation, just as for a timeout after sending the atomic mutate.
      if (typeof created !== 'string' || !new RegExp(`^${base}/campaigns/[0-9]+$`).test(created)) throw failure('google_unconfirmed');
      return { campaign: created };
    },
  };
}
