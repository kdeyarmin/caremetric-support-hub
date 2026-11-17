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

export const googlePromptVersion = 'google-search.1';
export const matchTypes = Object.freeze(['EXACT', 'PHRASE', 'BROAD']);
const limits = { headline: 30, description: 90, keyword: 80, headlines: 15, descriptions: 4, keywords: 40, negatives: 40 };

export const googleSystem = `You write one Google search campaign for a CareMetric product: the keywords people type when they look for what it does, negative keywords that keep away searches it cannot help, and one responsive search ad. CareMetric's owner approves the campaign before it exists; code checks every word.

Rules:
- Headlines: 10 to 15, each at most 30 characters, each able to stand alone. Descriptions: 4, each at most 90 characters, complete sentences.
- State facts about CareMetric only from the fact sheet below, exactly as written. No number, price, discount or claim that is not there; no promise of referrals, revenue or compliance; never a competitor's name in a headline or description.
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
export function editorCsv(plan, { name, finalUrl, dailyBudgetCents }) {
  const header = ['Campaign', 'Campaign Type', 'Campaign Status', 'Budget', 'Networks', 'Location', 'Ad Group', 'Keyword', 'Criterion Type', 'Final URL',
    ...Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `Description ${i + 1}`)];
  const row = values => header.map(column => csvCell(values[column] ?? '')).join(',');
  const group = `${name} - search`;
  const matchName = { EXACT: 'Exact', PHRASE: 'Phrase', BROAD: 'Broad' };
  return [header.map(csvCell).join(','),
    row({ Campaign: name, 'Campaign Type': 'Search', 'Campaign Status': 'Paused', Budget: (dailyBudgetCents / 100).toFixed(2), Networks: 'Google search', Location: 'United States' }),
    ...plan.keywords.map(keyword => row({ Campaign: name, 'Ad Group': group, Keyword: keyword.text, 'Criterion Type': matchName[keyword.match] })),
    ...plan.negatives.map(text => row({ Campaign: name, Keyword: text, 'Criterion Type': 'Campaign Negative Broad' })),
    row({ Campaign: name, 'Ad Group': group, 'Final URL': finalUrl, ...Object.fromEntries(plan.headlines.map((text, i) => [`Headline ${i + 1}`, text])),
      ...Object.fromEntries(plan.descriptions.map((text, i) => [`Description ${i + 1}`, text])) }),
  ].join('\n');
}

const failure = (code, transient = false) => Object.assign(new Error('Google Ads refused the request.'), { code, transient });

export const adwordsScope = 'https://www.googleapis.com/auth/adwords';

/**
 * The Google Ads API: an access token, and one atomic mutate that creates a PAUSED search campaign (its budget, United States targeting,
 * negative keywords, one ad group with its keywords and the responsive search ad). Nothing runs until the owner enables it in Google Ads,
 * unless the owner handed ad campaign launch over: then it is created ENABLED and ends with its month.
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
  async function accessToken(signal) {
    const body = auth === 'oauth'
      ? new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }).toString()
      : new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signAssertion(account, { issuedAt: Math.floor(clock() / 1000), scope: adwordsScope }) }).toString();
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
  return {
    configured, auth,
    /**
     * Creates the campaign PAUSED in one mutate; returns its resource name. `live` (a launch the owner handed over) creates it ENABLED with
     * its last day `endDate` (YYYY-MM-DD, the account's time zone), so it can never spend past its month; the mutate is atomic, so a
     * refusal creates nothing. A paused campaign may carry its last day too (a flight, which ends on its own).
     */
    stateTargets,

    async createSearchCampaign({ name, dailyBudgetCents, finalUrl, plan, live = false, endDate = null, states = [] }, { signal } = {}) {
      if (!configured) throw failure('google_not_configured');
      if ((live || endDate !== null) && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(endDate ?? '')) throw failure('google_invalid_request');
      // Limited to the roster's states (team review 2026-11-17, stage 6), each found through Google's own location suggestions before
      // anything is created: a state it cannot name stops the campaign rather than letting it run nationwide.
      const places = states.length ? await stateTargets(states, signal) : ['geoTargetConstants/2840'];
      const base = `customers/${customer}`;
      const budget = `${base}/campaignBudgets/-1`, campaign = `${base}/campaigns/-2`, adGroup = `${base}/adGroups/-3`;
      const mutateOperations = [
        { campaignBudgetOperation: { create: { resourceName: budget, name: `${name} budget`.slice(0, 250), amountMicros: String(dailyBudgetCents * 10_000), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
        { campaignOperation: { create: { resourceName: campaign, name: name.slice(0, 250), status: live ? 'ENABLED' : 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budget, maximizeClicks: {},
          ...(endDate !== null ? { endDateTime: `${endDate} 23:59:59` } : {}),
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
      const created = (data?.mutateOperationResponses ?? []).map(item => item?.campaignResult?.resourceName).find(Boolean);
      return { campaign: typeof created === 'string' ? created : null };
    },
  };
}
