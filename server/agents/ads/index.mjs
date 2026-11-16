/**
 * Paid ads (20261113230000_ads_buildout.sql), the Social Media Manager's:
 *
 * - `ads.plan`, each morning, works on Mondays (or when the owner runs it): while Settings → Paid ads → "Most to spend on new campaigns a
 *   month" is set, it proposes for each marketed product, once a month, a new LinkedIn campaign and a Meta retargeting campaign (when the
 *   ad account and, for Meta, the retargeting audience are set) and a Google search campaign the model writes and code checks. Each waits
 *   for the owner's approval and starts paused (LinkedIn as a draft), with no ads. The daily budget is at most a thirtieth of the monthly
 *   number and never above Settings → Social media → the daily ad-set limit, checked again when the campaign is created.
 * - Once the owner hands ad campaign launch over (the "Ad campaign launch" autonomy step, 20261115200000_autonomy_handover.sql), the
 *   database approves those campaigns on their own and each is launched live: a LinkedIn or Meta campaign with its first ad from creative
 *   the owner already approved (through the daily ad review's own path for a new ad, social/executor.mjs), a Google search campaign with
 *   its checked responsive search ad. The month's number is shared by the campaigns launched this way, and each one reserves its daily
 *   budget for the rest of its month in the database before it is created (private.ads_launch_reserve), so together they never pass the
 *   monthly number; each ends with its month. Where launching live is not possible (no approved creative that fits, too little of the
 *   month's number left, the month's last day, or the Google Ads API not set up), it falls back to the owner's way: created paused with
 *   no ads (or, for Google, emailed as an import file), and the owner is told.
 * - New Intel campaigns send people to the free market report for their own agency (intel-market-review), CareBase's to its free trial.
 * - `ads.conversions`, every quarter hour while "Report leads to the ad platforms" is on: a county report or trial lead that arrived from a
 *   Meta or LinkedIn ad click (its click ID) is reported to that platform once, by a hashed work email and the click. A lead without that
 *   platform's click ID is never sent to it.
 */
import { createHash } from 'node:crypto';
import { live } from '../../live.mjs';
import { easternDate, easternMidnight, weekStart } from '../accounts/week.mjs';
import { marketedNow, markets } from '../marketing.mjs';
import { productPage } from '../content/facts.mjs';
import { linkTags, taggedUrl } from '../links.mjs';
import { playbookFor } from '../../growth/playbook.mjs';
import { adCopyFromCreative, adImagePlacements } from '../social/content.mjs';
import { socialExecutors } from '../social/executor.mjs';
import { handoverDeclared, trustedWith } from '../handover.mjs';
import { delivered } from '../notify.mjs';
import { checkGooglePlan, editorCsv, googleAdsClient, googlePromptVersion, googleSchema, googleSystem } from './google.mjs';

export const adsFeature = 'platform.agents.ads.v1';
const productNames = { carebase: 'CareBase', 'caremetric-intel': 'CareMetric Intel' };
// Where new campaigns send people (2026-11-16): Intel's free market report for the reader's own agency (its share and rank in its county,
// the county's largest agencies and three moves; the strongest reason for an agency to raise its hand), CareBase's free trial.
const landing = { 'caremetric-intel': 'intel-market-review', carebase: 'carebase-signup' };
const easternWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const failure = code => Object.assign(new Error('The ad action was not carried out.'), { code, transient: false });
const codeOf = error => (/^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'ads_error');
/** Each platform's least daily budget here, in cents: LinkedIn's is $10; Meta's and Google's $5. */
export const leastDailyCents = Object.freeze({ linkedin: 1000, meta: 500, google: 500 });
const platformNames = { linkedin: 'LinkedIn', meta: 'Meta', google: 'Google search' };
const managers = { linkedin: 'LinkedIn Campaign Manager', meta: 'Meta Ads Manager', google: 'Google Ads' };
const pausedWords = { linkedin: 'as a draft', meta: 'paused', google: 'paused' };
// Why a campaign approved automatically was not launched live, in the owner's words.
const fallbackWords = {
  no_approved_creative: 'None of your approved creative fits it right now (approve some on the Creative screen).',
  month_ending: 'It is the last day of the month, too late to start a campaign that ends with it.',
  monthly_budget_used: 'Too little of this month\'s number is left for it after the campaigns already started this month.',
  no_monthly_budget: '"Most to spend on new campaigns a month" is not set.',
  month_over: 'Its month has ended.',
  cannot_start: 'This server cannot start campaigns on this platform.',
  google_refused_live: 'Google Ads refused to create it running.',
};

/** Settings → Paid ads, with the Google Ads secrets from Railway. */
export function adsConfig(env = {}, setting = null) {
  const value = key => (setting ? setting(key) : undefined);
  const text = key => (typeof value(key) === 'string' ? value(key) : '');
  const monthly = value('ads.monthly_budget_cents');
  const flight = value('ads.flight_days');
  return {
    monthlyBudgetCents: Number.isInteger(monthly) && monthly > 0 ? monthly : 0,
    // Settings → Paid ads → "Run each month's campaign as a short flight": 0 (off) spreads each campaign over the month.
    flightDays: Number.isInteger(flight) && flight >= leastFlightDays && flight <= 30 ? flight : 0,
    serverConversions: value('ads.server_conversions') === true,
    metaAudienceId: text('ads.meta_audience_id'), metaPixelId: text('ads.meta_pixel_id'), linkedinConversionId: text('ads.linkedin_conversion_id'),
    competitorKeywords: value('ads.google_competitor_keywords') === true,
    google: { customerId: text('ads.google_customer_id'), loginCustomerId: text('ads.google_login_customer_id'), clientId: text('ads.google_client_id'),
      version: text('ads.google_api_version') || 'v26', developerToken: env.HUB_GOOGLE_ADS_DEVELOPER_TOKEN ?? '', clientSecret: env.HUB_GOOGLE_ADS_CLIENT_SECRET ?? '',
      refreshToken: env.HUB_GOOGLE_ADS_REFRESH_TOKEN ?? '', serviceAccount: env.HUB_SEARCH_CONSOLE_CREDENTIALS ?? '' },
  };
}

/** A new campaign's daily budget in cents: a thirtieth of the monthly number, never above the daily ad-set limit; null when too small. */
export function campaignDailyBudget({ monthlyBudgetCents, maxDailyBudgetCents }, platform) {
  if (!Number.isInteger(monthlyBudgetCents) || monthlyBudgetCents <= 0) return null;
  let daily = Math.floor(monthlyBudgetCents / 30);
  if (Number.isInteger(maxDailyBudgetCents) && maxDailyBudgetCents > 0) daily = Math.min(daily, maxDailyBudgetCents);
  return daily >= (leastDailyCents[platform] ?? 500) ? daily : null;
}

/** The fewest days a flight runs: shorter, and the platform has too little to learn from. */
export const leastFlightDays = 3;

/**
 * A flight's budget (Settings → Paid ads → "Run each month's campaign as a short flight", owner decision 2026-11-16): the month's number
 * spent in one campaign over about `flightDays` days, at the number divided by those days a day, never below the platform's least daily
 * budget (so fewer days when the number is small) nor above the daily ad-set limit, and never past the month (`daysLeft`, today
 * counted). Null when it cannot run at least leastFlightDays days.
 */
export function flightBudget({ monthlyBudgetCents, maxDailyBudgetCents, flightDays }, platform, daysLeft = 31) {
  if (!Number.isInteger(monthlyBudgetCents) || monthlyBudgetCents <= 0 || !Number.isInteger(flightDays) || flightDays < leastFlightDays) return null;
  const least = leastDailyCents[platform] ?? 500;
  let daily = Math.max(least, Math.floor(monthlyBudgetCents / flightDays));
  if (Number.isInteger(maxDailyBudgetCents) && maxDailyBudgetCents > 0) daily = Math.min(daily, maxDailyBudgetCents);
  if (daily < least) return null;
  const days = Math.min(flightDays, Math.floor(monthlyBudgetCents / daily), daysLeft);
  return days >= leastFlightDays ? { dailyBudgetCents: daily, days } : null;
}

const addDays = (date, days) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };

/**
 * When a campaign started at `moment` stops: a flight of `days` (today counted) ends on its own after its last day, never past the month;
 * any other campaign at its month's end (monthLeft). Same shape as monthLeft.
 */
export function campaignWindow(moment, flightDays = null) {
  const left = monthLeft(moment);
  if (!Number.isInteger(flightDays) || flightDays < 1) return left;
  const days = Math.min(flightDays, left.days);
  const today = easternDate(moment);
  return { ...left, days, lastDay: addDays(today, days - 1), endsAt: new Date(easternMidnight(addDays(today, days)).getTime() - 1000) };
}

const hashEmail = email => createHash('sha256').update(String(email ?? '').trim().toLowerCase()).digest('hex');
const money = cents => `$${(cents / 100).toFixed(2)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The Eastern month a moment falls in, for a campaign launched live: `month` (YYYY-MM), `days` left in it counting today, its `lastDay`
 * (YYYY-MM-DD) and `endsAt`, the last second of that day, when the campaign ends.
 */
export function monthLeft(moment) {
  const today = easternDate(moment);
  const [year, month, day] = today.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return { month: today.slice(0, 7), days: last - day + 1, lastDay: `${today.slice(0, 7)}-${String(last).padStart(2, '0')}`, endsAt: new Date(easternMidnight(next).getTime() - 1000) };
}

export function adsTeam({ ads = null, features = null, fetchImpl = fetch, googleClient = null }) {
  const declared = features instanceof Set ? features.has(adsFeature) : Array.isArray(features) && features.includes(adsFeature);
  const config = () => live(ads) ?? adsConfig({});
  const google = () => googleClient ?? googleAdsClient({ ...config().google, fetchImpl });
  // The owner's "Ad campaign launch" step can be switched on only once the database declares it.
  const handover = handoverDeclared(features);
  if (!declared) return { declared: false, handlers: () => ({}), executors: () => ({}), config, google };

  return {
    declared: true, config, google,
    handlers: ({ store, notifier, model, meta, linkedin, social = {}, marketed = null, creative = null, publicOrigin = null, log = line => console.warn(line) }) => {
      // Approved Creative Director images are served from the Hub under each asset's public token, so Meta and LinkedIn can fetch them.
      const assetOrigin = /^https:\/\//i.test(publicOrigin ?? '') ? publicOrigin.replace(/\/+$/, '') : null;

      /** The first ad for a campaign launched live: the first approved creative for its product and platform whose words pass that platform's checks. */
      async function firstAd(product, platform, campaignName) {
        if (!creative?.approved || !assetOrigin) return null;
        let assets;
        try { assets = await creative.approved({ product, platform, limit: 20 }); }
        catch (error) {
          if (error?.transient) throw error;
          log(JSON.stringify({ event: 'hub_ads_creative_unread', code: codeOf(error) }));
          return null;
        }
        for (const asset of assets ?? []) {
          if (asset.kind !== 'static' || !adImagePlacements[platform].includes(asset.placement) || !/^[0-9a-f]{64}$/.test(asset.token ?? '') || !/^[0-9a-f-]{36}$/.test(asset.id ?? '')) continue;
          const copy = adCopyFromCreative(asset, { product, linkedin: platform === 'linkedin' });
          if (!copy) continue;
          return { ...copy, name: `${campaignName} · creative ${asset.id.slice(0, 8)}`, imageUrl: `${assetOrigin}/api/creative/a/${asset.token}.png`, creativeAssetId: asset.id };
        }
        return null;
      }

      async function plan(task, { signal, now = () => new Date() } = {}) {
        if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
        const moment = now();
        if (task.sourceKind === 'schedule' && easternWeekday.format(moment) !== 'Mon') return { result: { skipped: 'not_monday' } };
        const monthly = config().monthlyBudgetCents;
        if (!monthly) return { result: { skipped: 'no_monthly_budget' } };
        const list = await marketedNow(marketed);
        const products = ['caremetric-intel', 'carebase'].filter(product => markets(list, product));
        const month = easternDate(moment).slice(0, 7);
        const left = monthLeft(moment);
        const skipped = {};
        const skip = reason => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
        let proposedAlready = 0;
        // Handed over: approved on their own and launched live (wording and the budget split only; the database decides again).
        const onItsOwn = kind => handover && trustedWith(task.agent, kind);
        // With flights on, this month's campaigns on every platform and product are read once, whatever is connected or marketed now: one
        // created before a platform was disconnected still takes the month's flight. A campaign that was created (whatever its pacing)
        // takes it, and so does a flight proposed, approved or turned down; a proposal that failed or expired, or one paced over the whole
        // month that was never created, does not (it is refused when it is created while flights are on), so a flight can replace it.
        const flightDays = config().flightDays;
        const flights = flightDays > 0;
        const history = flights ? await store.adsMonthCampaigns(month) : null;
        // Not knowing the month's campaigns, the plan proposes no flight rather than risk a second one.
        if (flights && !Array.isArray(history)) return { result: { proposed: 0, skipped: { flight_history_unread: 1 } } };
        const takesFlight = item => item.status === 'executed' || item.status === 'executing' || (item.flight === true && !['failed', 'expired'].includes(item.status));
        const taken = (kind, targetId) => (flights ? history.some(item => item.kind === kind && item.targetId === targetId && takesFlight(item)) : store.socialCampaignProposed(kind, targetId));

        // 1. This month's campaigns not yet proposed, product by product: LinkedIn, Meta, then Google search.
        const slots = [];
        for (const product of products) {
          signal?.throwIfAborted();
          const page = productPage(landing[product]);
          if (!page) { skip('no_landing_page'); continue; }
          for (const platform of ['linkedin', 'meta']) {
            const client = platform === 'linkedin' ? linkedin : meta;
            if (!client?.configured?.ads || typeof client.createCampaign !== 'function') { skip(`${platform}_not_connected`); continue; }
            if (platform === 'meta' && !/^[0-9]{5,30}$/.test(config().metaAudienceId)) { skip('meta_audience_missing'); continue; }
            const targetId = `${platform}:${product}:${month}`;
            if (await taken('social.campaign_create', targetId)) { proposedAlready += 1; continue; }
            slots.push({ product, page, platform, kind: 'social.campaign_create', targetId,
              name: `CareMetric ${productNames[product]} ${platform === 'meta' ? 'retargeting' : 'prospecting'} ${month}` });
          }
          if (!model?.configured) { skip('model_not_configured'); continue; }
          const targetId = `google:${product}:${month}`;
          if (await taken('social.google_campaign', targetId)) { proposedAlready += 1; continue; }
          slots.push({ product, page, platform: 'google', kind: 'social.google_campaign', targetId, name: `CareMetric ${productNames[product]} search ${month}` });
        }
        // 2. Launched live: a LinkedIn or Meta campaign with approved creative for its first ad, a Google one through the API. They share the
        //    month's number, so together they stay within it (each reserves its share in the database before it is created).
        for (const slot of slots) if (onItsOwn(slot.kind) && slot.platform !== 'google') slot.firstAd = await firstAd(slot.product, slot.platform, slot.name);
        // 3. Flights (Settings → Paid ads → "Run each month's campaign as a short flight"): the month's number goes to one campaign, run at
        //    a few days' share of it a day, which ends on its own. The first that can carry it, in the order above, one that would start on
        //    its own first; none while a campaign was already proposed this month, so the month's number is never spent twice. A Google
        //    flight needs the Google Ads API, which sets its last day (an import file cannot).
        if (flights) {
          proposedAlready = history.filter(takesFlight).length;
          const fits = slot => ((slot.platform !== 'google' || google().configured)
            ? flightBudget({ monthlyBudgetCents: monthly, maxDailyBudgetCents: social.maxDailyBudgetCents, flightDays }, slot.platform, left.days) : null);
          const starts = slot => onItsOwn(slot.kind) && (slot.platform === 'google' ? google().configured : Boolean(slot.firstAd));
          const chosen = proposedAlready ? null : (slots.find(slot => starts(slot) && fits(slot)) ?? slots.find(slot => fits(slot)) ?? null);
          for (const slot of slots) if (slot !== chosen) skip(proposedAlready ? 'flight_this_month' : chosen ? 'flight_taken' : 'flight_does_not_fit');
          if (chosen) chosen.flight = fits(chosen);
          slots.splice(0, slots.length, ...(chosen ? [chosen] : []));
        }
        const launching = slots.filter(slot => onItsOwn(slot.kind) && (slot.platform === 'google' ? google().configured : Boolean(slot.firstAd)));
        const dailyFor = slot => (slot.flight ? slot.flight.dailyBudgetCents : campaignDailyBudget({ monthlyBudgetCents: launching.includes(slot) ? Math.floor(monthly / launching.length) : monthly,
          maxDailyBudgetCents: social.maxDailyBudgetCents }, slot.platform));
        const budgetLine = (slot, daily) => (slot.flight
          ? `A flight: ${money(daily)} a day for ${plural(slot.flight.days, 'day')} (${money(daily * slot.flight.days)} of your monthly ${money(monthly)}), then it ends on its own.`
          : launching.includes(slot) && launching.length > 1
            ? `Daily budget: ${money(daily)} (a thirtieth of your monthly ${money(monthly)}, shared by the ${launching.length} campaigns starting on their own this month).`
            : `Daily budget: ${money(daily)} (a thirtieth of your monthly ${money(monthly)}).`);
        // When each would stop if it started now: a flight after its last day, any other at the month's end.
        const windowOf = slot => campaignWindow(moment, slot.flight?.days ?? null);
        const flightNote = slot => (slot.flight ? ` It ends on its own ${plural(slot.flight.days, 'day')} after it is created (today counted), so start it the day you approve it.` : '');

        // 4. Propose each one. The database approves it on its own only while the owner's step is automatic.
        const waiting = [], automatic = [];
        for (const slot of slots) {
          signal?.throwIfAborted();
          const { product, page, platform, kind, targetId, name } = slot;
          const daily = dailyFor(slot);
          if (!daily) { skip('budget_too_small'); continue; }
          let action;
          if (platform !== 'google') {
            const link = taggedUrl(page.url, { ...linkTags.social(platform === 'meta' ? 'facebook' : 'linkedin', product, 'ad', { paid: true }) });
            const audience = platform === 'meta' ? `your website visitors (Custom Audience ${config().metaAudienceId}) in the United States`
              : product === 'caremetric-intel'
                ? 'people in the United States in Hospitals and Health Care, manager level or above. The free market report is for home health agencies and hospices, so upload the Medicare roster company list (Growth → Medicare roster → Download) as the campaign\'s company list in Campaign Manager, or narrow it to your states'
                : 'people in the United States in Hospitals and Health Care, manager level or above (narrow it to your states or upload the roster company list in Campaign Manager)';
            const ad = slot.firstAd;
            const how = !onItsOwn(kind)
              ? `It is created ${pausedWords[platform]}: nothing runs or spends until you start it. It starts with no ads: add its first ad in ${managers[platform]} (your approved creative is on the Creative screen). Once an ad is running in it, the team's daily ad review can propose more.${flightNote(slot)}`
              : ad
                ? `You handed ad campaign launch over, so it starts on its own, with this first ad from your approved creative ${ad.creativeAssetId}, and runs until ${windowOf(slot).lastDay}. It stays within your monthly number and your daily ad-set limit; if too little of the month's number is left when it starts, it is created ${pausedWords[platform]} with no ads instead.\n\nFirst ad\n${platform === 'linkedin' ? 'Post text' : 'Primary text'}: ${ad.message}\nHeadline: ${ad.headline}\nDescription: ${ad.description}\n${platform === 'linkedin' ? '' : `Button: ${ad.callToAction === 'SIGN_UP' ? 'Sign up' : 'Learn more'}\n`}Link: ${ad.link}\nImage: ${ad.imageUrl}`
                : `You handed ad campaign launch over, but none of your approved creative fits it yet, so it is created ${pausedWords[platform]} with no ads, as before: add its first ad in ${managers[platform]} (your approved creative is on the Creative screen) and start it there.${flightNote(slot)}`;
            action = await store.proposeAction({ taskId: task.id, kind, targetKind: 'social_item', targetId,
              preview: `New ${platformNames[platform]} campaign for ${productNames[product]}: ${name}.\n\n${budgetLine(slot, daily)}\nAudience: ${audience}.\nGoal: visits to ${page.label} (${link}).\n\n${how}`.slice(0, 6000),
              input: { platform, product, name, dailyBudgetCents: daily, ...(platform === 'meta' ? { audienceId: config().metaAudienceId } : {}), link, ...(onItsOwn(kind) && ad ? { firstAd: ad } : {}),
                ...(slot.flight ? { flightDays: slot.flight.days } : {}) } })
              .catch(error => { if (error?.code === '42501') return null; throw error; });
          } else {
            // Google search: written by the model, checked by code.
            const factsKey = playbookFor(product)?.factsKey ?? null;
            const result = await model.run(task, { promptVersion: googlePromptVersion, system: [{ text: googleSystem, cache: true }], schema: googleSchema, maxTokens: 4000, effort: 'medium',
              user: JSON.stringify({ product: productNames[product], landingPage: page.label, competitorsAllowed: config().competitorKeywords, week: weekStart(moment) }),
              describe: output => `Wrote a Google search campaign with ${output.keywords?.length ?? 0} keywords.` }, { signal });
            if (result.outcome !== 'completed') { skip(result.outcome); continue; }
            const checked = checkGooglePlan(result.output, { factsKey, competitors: config().competitorKeywords });
            if (!checked.ok) { skip(`google_${checked.reason}`); continue; }
            const finalUrl = taggedUrl(page.url, { source: 'google', medium: 'cpc', campaign: `search-${product === 'carebase' ? 'carebase' : 'intel'}` });
            const how = !onItsOwn(kind) ? `It is created paused (or emailed to you as an import file while the Google Ads API is not set up).${flightNote(slot)}`
              : google().configured
                ? `You handed ad campaign launch over, so it starts on its own with the ad above and runs until ${windowOf(slot).lastDay}, within your monthly number and your daily ad-set limit (created paused instead if too little of the month's number is left when it starts).`
                : 'You handed ad campaign launch over, but the Google Ads API is not set up, so it is emailed to you as an import file, paused, as before.';
            action = await store.proposeAction({ taskId: task.id, kind, targetKind: 'social_item', targetId,
              preview: `New Google search campaign for ${productNames[product]}: ${name}.\n\n${budgetLine(slot, daily)} Location: United States. Landing page: ${finalUrl}\n\nHeadlines:\n${checked.plan.headlines.join('\n')}\n\nDescriptions:\n${checked.plan.descriptions.join('\n')}\n\nKeywords: ${checked.plan.keywords.map(k => `${k.text} (${k.match.toLowerCase()})`).join(', ')}\n\nNegative keywords: ${checked.plan.negatives.join(', ')}\n\n${how}`.slice(0, 6000),
              input: { product, name, dailyBudgetCents: daily, finalUrl, plan: checked.plan, ...(slot.flight ? { flightDays: slot.flight.days } : {}) } }).catch(error => { if (error?.code === '42501') return null; throw error; });
          }
          if (action && action.created !== false) (action.status === 'auto_approved' ? automatic : waiting).push(targetId);
        }
        const all = [...waiting, ...automatic];
        if (all.length) {
          const body = [
            waiting.length ? `The team proposed ${plural(waiting.length, 'new paused campaign')} for ${month}. Open the AI team to review the budget, audience and ads; nothing spends until you start it.` : null,
            automatic.length ? `${plural(automatic.length, 'new campaign')} for ${month} ${automatic.length === 1 ? 'starts' : 'start'} on ${automatic.length === 1 ? 'its' : 'their'} own, because you handed ad campaign launch over: each with its first ad from your approved creative where one fits, within your monthly number and daily ad-set limit, ending with the month. Keep approving on the AI team page stops the next ones.` : null,
          ].filter(Boolean).join(' ');
          await notifier.send({ severity: 'info', subject: waiting.length ? `Paid ads: ${plural(waiting.length, 'new campaign')} to review` : `Paid ads: ${plural(automatic.length, 'new campaign')} starting on their own`,
            body, dedupeKey: `ads:plan:${month}:${all.join(',')}`.slice(0, 200), agentKey: task.agentKey, taskId: task.id });
        }
        return { status: waiting.length ? 'awaiting_approval' : 'done',
          result: { month, proposed: all.length, ...(automatic.length ? { automatic: automatic.length } : {}), ...(Object.keys(skipped).length ? { skipped } : {}) } };
      }

      async function conversions(task, { signal } = {}) {
        const settings = config();
        if (!settings.serverConversions) return { result: { skipped: 'off' } };
        const counts = { sent: 0, skipped: 0, failed: 0 };
        const platforms = [
          ['meta', meta?.configured?.ads && /^[0-9]{5,30}$/.test(settings.metaPixelId) && typeof meta.sendConversion === 'function'],
          ['linkedin', linkedin?.configured?.ads && /^[0-9]{3,30}$/.test(settings.linkedinConversionId) && typeof linkedin.sendConversion === 'function'],
        ];
        for (const [platform, ready] of platforms) {
          if (!ready) continue;
          for (const lead of (await store.adsConversionCandidates(platform, 25)) ?? []) {
            signal?.throwIfAborted();
            const click = platform === 'meta' ? lead.clickIds?.fbclid : lead.clickIds?.liFatId;
            // Only the platform whose ad was clicked hears about the lead.
            if (!click) { await store.adsConversionRecord(lead.id, platform, 'skipped', 'no_click'); counts.skipped += 1; continue; }
            const occurred = Date.parse(lead.occurredAt);
            try {
              if (platform === 'meta') {
                const clickedAt = Number.isFinite(Date.parse(lead.firstSeenAt ?? '')) ? Date.parse(lead.firstSeenAt) : occurred;
                await meta.sendConversion({ pixelId: settings.metaPixelId, eventName: lead.kind === 'trial_signup' ? 'StartTrial' : 'Lead', eventId: lead.id,
                  eventTime: Math.floor(occurred / 1000), emailHash: hashEmail(lead.email), fbclid: click, clickedAt }, { signal });
              } else {
                await linkedin.sendConversion({ conversionId: settings.linkedinConversionId, eventId: lead.id, happenedAt: occurred, emailHash: hashEmail(lead.email), liFatId: click }, { signal });
              }
              await store.adsConversionRecord(lead.id, platform, 'sent', null); counts.sent += 1;
            } catch (error) {
              if (signal?.aborted || error?.transient) throw error;
              await store.adsConversionRecord(lead.id, platform, 'failed', codeOf(error)); counts.failed += 1;
            }
          }
        }
        return { result: counts };
      }

      return { 'ads.plan': plan, 'ads.conversions': conversions };
    },

    executors: ({ meta, linkedin, social = {}, notifier, store = null, creative = null, publicOrigin = null, log = line => console.warn(line), now = () => new Date() }) => {
      // The most a campaign may spend a day, as the limits stand now: a flight's share while flights are on (and only a flight while they
      // are), else a thirtieth of the month's number. A flight also may not have been planned to spend more than the month's number.
      const allowedFor = (platform, input = {}) => {
        const settings = config();
        if (input.flightDays === undefined) return settings.flightDays > 0 ? null : campaignDailyBudget({ monthlyBudgetCents: settings.monthlyBudgetCents, maxDailyBudgetCents: social.maxDailyBudgetCents }, platform);
        if (!Number.isInteger(input.flightDays) || input.flightDays < leastFlightDays || input.flightDays > 30 || settings.flightDays <= 0) return null;
        const flight = flightBudget({ monthlyBudgetCents: settings.monthlyBudgetCents, maxDailyBudgetCents: social.maxDailyBudgetCents, flightDays: settings.flightDays }, platform);
        return flight && input.dailyBudgetCents * input.flightDays <= settings.monthlyBudgetCents ? flight.dailyBudgetCents : null;
      };
      // The daily ad review's own path for a new ad in an ad set (its checks, its creation, and marking the creative live), reused for a
      // campaign's first ad.
      const adCreate = socialExecutors({ meta, linkedin, settings: social, notifier, creative, store, publicOrigin, log, now })['social.ad_create'];
      // An automatic approval goes ahead only while the owner's "Ad campaign launch" step still hands it over, checked now.
      const trusted = async execution => handover && typeof store?.actionTrusted === 'function' && await store.actionTrusted(execution.id, execution.execution ?? null) === true;
      const canReserve = () => handover && typeof store?.adsLaunchReserve === 'function' && typeof store?.adsLaunchRelease === 'function';
      const reserve = (execution, dailyCents, platform, days) => store.adsLaunchReserve(execution.id, execution.execution ?? null, dailyCents, leastDailyCents[platform], days);
      const release = async execution => { try { await store.adsLaunchRelease(execution.id, execution.execution ?? null); } catch { log(JSON.stringify({ event: 'hub_ads_reservation_unreleased', action_id: execution.id })); } };
      // The owner hears what happened to a campaign started on their behalf. A notice that cannot be sent never fails the campaign.
      const tell = async (execution, severity, subject, body) => {
        try { await notifier?.send({ severity, subject, body, dedupeKey: `ads:launch:${execution.id}`, agentKey: 'social_manager' }); }
        catch { log(JSON.stringify({ event: 'hub_ads_launch_notice_unsent', action_id: execution.id })); }
      };
      // The approved creative is still in use: approved, or live in another ad.
      async function stillApproved(product, platform, assetId) {
        if (!/^[0-9a-f-]{36}$/.test(assetId ?? '')) return false;
        try {
          if (typeof store?.creativeLiveAssets === 'function') {
            return ((await store.creativeLiveAssets([product])) ?? []).some(asset => asset.id === assetId && asset.platform === platform && ['approved', 'live'].includes(asset.status));
          }
          return typeof creative?.approved === 'function' && ((await creative.approved({ product, platform, limit: 20 })) ?? []).some(asset => asset.id === assetId);
        } catch (error) {
          if (error?.transient) throw error;
          return false;
        }
      }

      // A LinkedIn or Meta campaign approved automatically: created paused (a draft on LinkedIn) with the budget reserved for it and its
      // month's end, its first ad put in through the daily ad review's path, then started. Where that is not possible it is created paused
      // with no ads, as the owner's approval does, and the owner is told why.
      async function launchSocial(execution, input, client, createPaused) {
        const platform = input.platform;
        const fallback = async reason => {
          const created = await createPaused();
          await tell(execution, 'info', `New ${platformNames[platform]} campaign created ${pausedWords[platform]}: ${input.name}`,
            `${fallbackWords[reason] ?? `It could not be started on its own (${reason.replaceAll('_', ' ')}).`} So it was created ${pausedWords[platform]} with no ads, as when you approve one: add its first ad in ${managers[platform]} (your approved creative is on the Creative screen) and start it there.`);
          return { created: true, ...created, launched: false, reason };
        };
        if (!canReserve()) throw failure('approval_required');
        if (typeof client.startCampaign !== 'function') return fallback('cannot_start');
        const ad = input.firstAd;
        if (!ad || !(await stillApproved(input.product, platform, ad.creativeAssetId))) return fallback('no_approved_creative');
        const moment = now();
        // A flight runs its own days (never past the month); any other campaign to the month's end.
        const left = campaignWindow(moment, input.flightDays ?? null);
        if (monthLeft(moment).days < 2) return fallback('month_ending');
        const reservation = await reserve(execution, input.dailyBudgetCents, platform, left.days);
        if (!reservation?.reserved) return fallback(/^[a-z][a-z_]{0,59}$/.test(reservation?.reason ?? '') ? reservation.reason : 'not_reserved');
        const daily = reservation.dailyBudgetCents;
        let created;
        try {
          created = await (platform === 'meta'
            ? meta.createCampaign({ name: input.name, dailyBudgetCents: daily, audienceId: input.audienceId, endAt: left.endsAt.toISOString() })
            : linkedin.createCampaign({ name: input.name, dailyBudgetCents: daily, startAt: new Date(moment.getTime() + 3_600_000).toISOString(), endAt: left.endsAt.toISOString() }));
        } catch (error) {
          // Paused, or not there at all: nothing can spend, so its share of the month is given back.
          await release(execution);
          throw error;
        }
        let made;
        try {
          made = await adCreate({ id: execution.id, kind: 'social.ad_create', agentKey: execution.agentKey, taskId: execution.taskId, targetId: execution.targetId,
            input: { adsetId: platform === 'meta' ? created.adsetId : created.campaignId, name: ad.name, message: ad.message, headline: ad.headline, description: ad.description,
              link: ad.link, imageHash: null, imageUrl: ad.imageUrl, callToAction: ad.callToAction, product: input.product, creativeAssetId: ad.creativeAssetId,
              ...(platform === 'linkedin' ? { platform: 'linkedin' } : {}) } });
        } catch (error) {
          // The campaign was never started, so nothing spends: its share is given back and it waits, paused, for the owner.
          await release(execution);
          await tell(execution, 'warning', `New ${platformNames[platform]} campaign not started: ${input.name}`,
            `Its first ad, from your approved creative, was not accepted (${codeOf(error).replaceAll('_', ' ')}), so the campaign stays ${pausedWords[platform]} with no ads running. Add its first ad in ${managers[platform]} and start it there, or leave it.`);
          return { created: true, ...created, launched: false, reason: codeOf(error) };
        }
        try {
          await client.startCampaign(created);
        } catch (error) {
          // The campaign and its ad exist; whether it started is not known for certain. Its budget and end date bound it either way, so its
          // share stays reserved.
          await tell(execution, 'warning', `Check the new ${platformNames[platform]} campaign: ${input.name}`,
            `It and its first ad were created, but starting it was not confirmed (${codeOf(error).replaceAll('_', ' ')}). Look at it in ${managers[platform]}: it spends at most ${money(daily)} a day and ends on ${left.lastDay} if it runs.`);
          return { created: true, ...created, adId: made?.id ?? null, launched: false, reason: codeOf(error) };
        }
        await tell(execution, 'info', `New ${platformNames[platform]} campaign started: ${input.name}`,
          `It started on its own, as you handed ad campaign launch over, with its first ad from your approved creative ${ad.creativeAssetId}. It spends at most ${money(daily)} a day and ends on ${left.lastDay}. Pause it in ${managers[platform]} at any time.`);
        return { created: true, ...created, adId: made?.id ?? null, launched: true, dailyBudgetCents: daily, endsOn: left.lastDay };
      }

      // A Google search campaign approved automatically, with the Google Ads API set up: its budget reserved, then created running with its
      // month's last day. Refused outright (the mutate is atomic, so nothing exists), it is created paused as before.
      async function launchGoogle(execution, input, plan, client, createPaused) {
        const fallback = async reason => {
          const created = await createPaused();
          await tell(execution, 'info', `New Google search campaign created paused: ${input.name}`,
            `${fallbackWords[reason] ?? `It could not be started on its own (${reason.replaceAll('_', ' ')}).`} So it was created paused, as when you approve one: enable it in Google Ads when you are ready.`);
          return { created: true, ...created, launched: false, reason };
        };
        if (!canReserve()) throw failure('approval_required');
        const moment = now();
        const left = campaignWindow(moment, input.flightDays ?? null);
        if (monthLeft(moment).days < 2) return fallback('month_ending');
        const reservation = await reserve(execution, input.dailyBudgetCents, 'google', left.days);
        if (!reservation?.reserved) return fallback(/^[a-z][a-z_]{0,59}$/.test(reservation?.reason ?? '') ? reservation.reason : 'not_reserved');
        const daily = reservation.dailyBudgetCents;
        let created;
        try {
          created = await client.createSearchCampaign({ name: input.name, dailyBudgetCents: daily, finalUrl: input.finalUrl, plan, live: true, endDate: left.lastDay });
        } catch (error) {
          // Not confirmed: it may exist and run, bounded by its budget and end date, so its share stays reserved.
          if (error?.code === 'google_unconfirmed') throw error;
          await release(execution);
          if (error?.code === 'google_invalid_request') return fallback('google_refused_live');
          throw error;
        }
        await tell(execution, 'info', `New Google search campaign started: ${input.name}`,
          `It started on its own, as you handed ad campaign launch over. It spends at most ${money(daily)} a day and ends on ${left.lastDay}. Pause it in Google Ads at any time.`);
        return { created: true, ...created, launched: true, dailyBudgetCents: daily, endsOn: left.lastDay };
      }

      return {
        // A LinkedIn or Meta campaign, within the limits as they stand when it is created: paused (LinkedIn as a draft) when the owner approved
        // it, launched live when the database approved it under the owner's hand-over.
        'social.campaign_create': async execution => {
          const input = execution.input ?? {};
          const automatic = execution.autoApproved === true;
          if (automatic && !(await trusted(execution))) throw failure('approval_required');
          const allowed = allowedFor(input.platform, input);
          if (!allowed || !Number.isInteger(input.dailyBudgetCents) || input.dailyBudgetCents > allowed) throw failure('budget_changed');
          // A flight is created with its last day, so it ends on its own even when it is started later (it then runs fewer days, never more).
          const flightEnd = () => (input.flightDays === undefined ? {} : { endAt: campaignWindow(now(), input.flightDays).endsAt.toISOString() });
          if (input.platform === 'meta') {
            if (!meta?.configured?.ads) throw failure('meta_not_configured');
            const createPaused = () => meta.createCampaign({ name: input.name, dailyBudgetCents: input.dailyBudgetCents, audienceId: input.audienceId, ...flightEnd() });
            return automatic ? launchSocial(execution, input, meta, createPaused) : { created: true, ...(await createPaused()) };
          }
          if (input.platform === 'linkedin') {
            if (!linkedin?.configured?.ads) throw failure('linkedin_not_configured');
            const createPaused = () => linkedin.createCampaign({ name: input.name, dailyBudgetCents: input.dailyBudgetCents,
              ...(input.flightDays === undefined ? {} : { startAt: new Date(now().getTime() + 3_600_000).toISOString(), ...flightEnd() }) });
            return automatic ? launchSocial(execution, input, linkedin, createPaused) : { created: true, ...(await createPaused()) };
          }
          throw failure('invalid_campaign');
        },
        // A Google search campaign: created through the API (paused when the owner approved it, running under the owner's hand-over), or
        // emailed as an import file, paused, until the API is set up. Launching live needs the API, so without it the hand-over changes nothing here.
        'social.google_campaign': async execution => {
          const input = execution.input ?? {};
          const automatic = execution.autoApproved === true;
          if (automatic && !(await trusted(execution))) throw failure('approval_required');
          const allowed = allowedFor('google', input);
          if (!allowed || !Number.isInteger(input.dailyBudgetCents) || input.dailyBudgetCents > allowed) throw failure('budget_changed');
          const checked = checkGooglePlan(input.plan, { factsKey: playbookFor(input.product)?.factsKey ?? null, competitors: config().competitorKeywords });
          if (!checked.ok || !/^https:\/\//.test(input.finalUrl ?? '')) throw failure('invalid_campaign');
          const client = google();
          if (client.configured) {
            const createPaused = () => client.createSearchCampaign({ name: input.name, dailyBudgetCents: input.dailyBudgetCents, finalUrl: input.finalUrl, plan: checked.plan,
              ...(input.flightDays === undefined ? {} : { endDate: campaignWindow(now(), input.flightDays).lastDay }) });
            return automatic ? launchGoogle(execution, input, checked.plan, client, createPaused) : { created: true, ...(await createPaused()) };
          }
          // An import file cannot carry a flight's last day, so a flight needs the API.
          if (input.flightDays !== undefined) throw failure('google_not_configured');
          const csv = editorCsv(checked.plan, { name: input.name, finalUrl: input.finalUrl, dailyBudgetCents: input.dailyBudgetCents });
          const sent = await notifier.send({ severity: 'info', subject: `Google search campaign to import: ${input.name}`,
            body: `The Google Ads API is not set up yet, so here is the campaign ${automatic ? 'the team planned under your hand-over' : 'you approved'} as a file. In Google Ads Editor choose Account → Import → Paste text, paste it, review and post. It is paused until you enable it.`,
            blocks: [{ type: 'paragraph', text: 'Paste this into Google Ads Editor (Account → Import → Paste text):' }, { type: 'message', text: csv }],
            dedupeKey: `ads:google:export:${execution.id}`, agentKey: 'social_manager' });
          // A retry of this action finds the earlier attempt by its dedupe key: that counts only if the earlier attempt was sent.
          if (!sent.some(delivered)) throw Object.assign(new Error('The import file could not be emailed.'), { code: 'notification_failed', transient: true });
          return { exported: true, ...(automatic ? { launched: false, reason: 'google_not_configured' } : {}) };
        },
      };
    },
  };
}
