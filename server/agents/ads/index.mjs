/**
 * Paid ads (20261113230000_ads_buildout.sql), the Social Media Manager's:
 *
 * - `ads.plan`, each morning, works on Mondays (or when the owner runs it): while Settings → Paid ads → "Most to spend on new campaigns a
 *   month" is set, it proposes for each marketed product, once a month, a new LinkedIn campaign and a Meta retargeting campaign (when the
 *   ad account and, for Meta, the retargeting audience are set) and a Google search campaign the model writes and code checks. Each is one
 *   owner approval, never automatic; each starts paused (LinkedIn as a draft). The daily budget is at most a thirtieth of the monthly
 *   number and never above Settings → Social media → the daily ad-set limit, checked again when the owner approves.
 * - `ads.conversions`, every quarter hour while "Report leads to the ad platforms" is on: a county report or trial lead that arrived from a
 *   Meta or LinkedIn ad click (its click ID) is reported to that platform once, by a hashed work email and the click. A lead without that
 *   platform's click ID is never sent to it.
 */
import { createHash } from 'node:crypto';
import { live } from '../../live.mjs';
import { easternDate, weekStart } from '../accounts/week.mjs';
import { marketedNow, markets } from '../marketing.mjs';
import { productPage } from '../content/facts.mjs';
import { linkTags, taggedUrl } from '../links.mjs';
import { playbookFor } from '../../growth/playbook.mjs';
import { checkGooglePlan, editorCsv, googleAdsClient, googlePromptVersion, googleSchema, googleSystem } from './google.mjs';

export const adsFeature = 'platform.agents.ads.v1';
const productNames = { carebase: 'CareBase', 'caremetric-intel': 'CareMetric Intel' };
// Where new campaigns send people: Intel's free county report, CareBase's free trial.
const landing = { 'caremetric-intel': 'intel-county-report', carebase: 'carebase-signup' };
const easternWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const failure = code => Object.assign(new Error('The ad action was not carried out.'), { code, transient: false });
const codeOf = error => (/^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'ads_error');

/** Settings → Paid ads, with the Google Ads secrets from Railway. */
export function adsConfig(env = {}, setting = null) {
  const value = key => (setting ? setting(key) : undefined);
  const text = key => (typeof value(key) === 'string' ? value(key) : '');
  const monthly = value('ads.monthly_budget_cents');
  return {
    monthlyBudgetCents: Number.isInteger(monthly) && monthly > 0 ? monthly : 0,
    serverConversions: value('ads.server_conversions') === true,
    metaAudienceId: text('ads.meta_audience_id'), metaPixelId: text('ads.meta_pixel_id'), linkedinConversionId: text('ads.linkedin_conversion_id'),
    competitorKeywords: value('ads.google_competitor_keywords') === true,
    google: { customerId: text('ads.google_customer_id'), loginCustomerId: text('ads.google_login_customer_id'), clientId: text('ads.google_client_id'),
      version: text('ads.google_api_version') || 'v26', developerToken: env.HUB_GOOGLE_ADS_DEVELOPER_TOKEN ?? '', clientSecret: env.HUB_GOOGLE_ADS_CLIENT_SECRET ?? '',
      refreshToken: env.HUB_GOOGLE_ADS_REFRESH_TOKEN ?? '' },
  };
}

/** A new campaign's daily budget in cents: a thirtieth of the monthly number, never above the daily ad-set limit; null when too small. */
export function campaignDailyBudget({ monthlyBudgetCents, maxDailyBudgetCents }, platform) {
  if (!Number.isInteger(monthlyBudgetCents) || monthlyBudgetCents <= 0) return null;
  let daily = Math.floor(monthlyBudgetCents / 30);
  if (Number.isInteger(maxDailyBudgetCents) && maxDailyBudgetCents > 0) daily = Math.min(daily, maxDailyBudgetCents);
  // LinkedIn's least daily budget is $10; Meta's and Google's here $5.
  return daily >= (platform === 'linkedin' ? 1000 : 500) ? daily : null;
}

const hashEmail = email => createHash('sha256').update(String(email ?? '').trim().toLowerCase()).digest('hex');
const money = cents => `$${(cents / 100).toFixed(2)}`;

export function adsTeam({ ads = null, features = null, fetchImpl = fetch, googleClient = null }) {
  const declared = features instanceof Set ? features.has(adsFeature) : Array.isArray(features) && features.includes(adsFeature);
  const config = () => live(ads) ?? adsConfig({});
  const google = () => googleClient ?? googleAdsClient({ ...config().google, fetchImpl });
  if (!declared) return { declared: false, handlers: () => ({}), executors: () => ({}), config, google };

  return {
    declared: true, config, google,
    handlers: ({ store, notifier, model, meta, linkedin, social = {}, marketed = null }) => {
      const budgetOf = platform => campaignDailyBudget({ monthlyBudgetCents: config().monthlyBudgetCents, maxDailyBudgetCents: social.maxDailyBudgetCents }, platform);

      async function plan(task, { signal, now = () => new Date() } = {}) {
        if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
        const moment = now();
        if (task.sourceKind === 'schedule' && easternWeekday.format(moment) !== 'Mon') return { result: { skipped: 'not_monday' } };
        if (!config().monthlyBudgetCents) return { result: { skipped: 'no_monthly_budget' } };
        const list = await marketedNow(marketed);
        const products = ['caremetric-intel', 'carebase'].filter(product => markets(list, product));
        const month = easternDate(moment).slice(0, 7);
        const proposed = [], skipped = {};
        const skip = reason => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
        for (const product of products) {
          signal?.throwIfAborted();
          const page = productPage(landing[product]);
          if (!page) { skip('no_landing_page'); continue; }
          for (const platform of ['linkedin', 'meta']) {
            const client = platform === 'linkedin' ? linkedin : meta;
            const daily = budgetOf(platform);
            if (!client?.configured?.ads || typeof client.createCampaign !== 'function') { skip(`${platform}_not_connected`); continue; }
            if (platform === 'meta' && !/^[0-9]{5,30}$/.test(config().metaAudienceId)) { skip('meta_audience_missing'); continue; }
            if (!daily) { skip('budget_too_small'); continue; }
            const targetId = `${platform}:${product}:${month}`;
            if (await store.socialCampaignProposed('social.campaign_create', targetId)) continue;
            const name = `CareMetric ${productNames[product]} ${platform === 'meta' ? 'retargeting' : 'prospecting'} ${month}`;
            const link = taggedUrl(page.url, { ...linkTags.social(platform === 'meta' ? 'facebook' : 'linkedin', product, 'ad', { paid: true }) });
            const audience = platform === 'meta' ? `your website visitors (Custom Audience ${config().metaAudienceId}) in the United States`
              : 'people in the United States in Hospitals and Health Care, manager level or above (narrow it to your states or upload the roster company list in Campaign Manager)';
            const action = await store.proposeAction({ taskId: task.id, kind: 'social.campaign_create', targetKind: 'social_item', targetId,
              preview: `New ${platform === 'meta' ? 'Meta' : 'LinkedIn'} campaign for ${productNames[product]}: ${name}.\n\nDaily budget: ${money(daily)} (a thirtieth of your monthly ${money(config().monthlyBudgetCents)}).\nAudience: ${audience}.\nGoal: visits to ${page.label} (${link}).\n\nIt is created ${platform === 'meta' ? 'paused' : 'as a draft'}: nothing runs or spends until you start it. It starts with no ads: add its first ad in ${platform === 'meta' ? 'Meta Ads Manager' : 'LinkedIn Campaign Manager'} (your approved creative is on the Creative screen). Once an ad is running in it, the team's daily ad review can propose more.`,
              input: { platform, product, name, dailyBudgetCents: daily, ...(platform === 'meta' ? { audienceId: config().metaAudienceId } : {}), link } }).catch(error => { if (error?.code === '42501') return null; throw error; });
            if (action?.created !== false && action) proposed.push(targetId);
          }
          // Google search: written by the model, checked by code.
          const daily = budgetOf('google');
          const targetId = `google:${product}:${month}`;
          if (!daily) { skip('budget_too_small'); continue; }
          if (!model?.configured) { skip('model_not_configured'); continue; }
          if (await store.socialCampaignProposed('social.google_campaign', targetId)) continue;
          const factsKey = playbookFor(product)?.factsKey ?? null;
          const result = await model.run(task, { promptVersion: googlePromptVersion, system: [{ text: googleSystem, cache: true }], schema: googleSchema, maxTokens: 4000, effort: 'medium',
            user: JSON.stringify({ product: productNames[product], landingPage: page.label, competitorsAllowed: config().competitorKeywords, week: weekStart(moment) }),
            describe: output => `Wrote a Google search campaign with ${output.keywords?.length ?? 0} keywords.` }, { signal });
          if (result.outcome !== 'completed') { skip(result.outcome); continue; }
          const checked = checkGooglePlan(result.output, { factsKey, competitors: config().competitorKeywords });
          if (!checked.ok) { skip(`google_${checked.reason}`); continue; }
          const finalUrl = taggedUrl(page.url, { source: 'google', medium: 'cpc', campaign: `search-${product === 'carebase' ? 'carebase' : 'intel'}` });
          const name = `CareMetric ${productNames[product]} search ${month}`;
          const action = await store.proposeAction({ taskId: task.id, kind: 'social.google_campaign', targetKind: 'social_item', targetId,
            preview: `New Google search campaign for ${productNames[product]}: ${name}.\n\nDaily budget: ${money(daily)}. Location: United States. Landing page: ${finalUrl}\n\nHeadlines:\n${checked.plan.headlines.join('\n')}\n\nDescriptions:\n${checked.plan.descriptions.join('\n')}\n\nKeywords: ${checked.plan.keywords.map(k => `${k.text} (${k.match.toLowerCase()})`).join(', ')}\n\nNegative keywords: ${checked.plan.negatives.join(', ')}\n\nIt is created paused (or emailed to you as an import file while the Google Ads API is not set up).`,
            input: { product, name, dailyBudgetCents: daily, finalUrl, plan: checked.plan } }).catch(error => { if (error?.code === '42501') return null; throw error; });
          if (action?.created !== false && action) proposed.push(targetId);
        }
        if (proposed.length) {
          await notifier.send({ severity: 'info', subject: `Paid ads: ${proposed.length} new campaign${proposed.length === 1 ? '' : 's'} to review`,
            body: `The team proposed ${proposed.length} new paused campaign${proposed.length === 1 ? '' : 's'} for ${month}. Open the AI team to review the budget, audience and ads; nothing spends until you start it.`,
            dedupeKey: `ads:plan:${month}:${proposed.join(',')}`.slice(0, 200), agentKey: task.agentKey, taskId: task.id });
        }
        return { status: proposed.length ? 'awaiting_approval' : 'done', result: { month, proposed: proposed.length, ...(Object.keys(skipped).length ? { skipped } : {}) } };
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

    executors: ({ meta, linkedin, social = {}, notifier }) => ({
      // A LinkedIn or Meta campaign, created paused (LinkedIn as a draft), within the limits as they stand when the owner approved it.
      'social.campaign_create': async execution => {
        const input = execution.input ?? {};
        if (execution.autoApproved === true) throw failure('approval_required');
        const allowed = campaignDailyBudget({ monthlyBudgetCents: config().monthlyBudgetCents, maxDailyBudgetCents: social.maxDailyBudgetCents }, input.platform);
        if (!allowed || !Number.isInteger(input.dailyBudgetCents) || input.dailyBudgetCents > allowed) throw failure('budget_changed');
        if (input.platform === 'meta') {
          if (!meta?.configured?.ads) throw failure('meta_not_configured');
          return { created: true, ...(await meta.createCampaign({ name: input.name, dailyBudgetCents: input.dailyBudgetCents, audienceId: input.audienceId })) };
        }
        if (input.platform === 'linkedin') {
          if (!linkedin?.configured?.ads) throw failure('linkedin_not_configured');
          return { created: true, ...(await linkedin.createCampaign({ name: input.name, dailyBudgetCents: input.dailyBudgetCents })) };
        }
        throw failure('invalid_campaign');
      },
      // A Google search campaign, created paused through the API, or emailed as an import file until the API is set up.
      'social.google_campaign': async execution => {
        const input = execution.input ?? {};
        if (execution.autoApproved === true) throw failure('approval_required');
        const allowed = campaignDailyBudget({ monthlyBudgetCents: config().monthlyBudgetCents, maxDailyBudgetCents: social.maxDailyBudgetCents }, 'google');
        if (!allowed || !Number.isInteger(input.dailyBudgetCents) || input.dailyBudgetCents > allowed) throw failure('budget_changed');
        const checked = checkGooglePlan(input.plan, { factsKey: playbookFor(input.product)?.factsKey ?? null, competitors: config().competitorKeywords });
        if (!checked.ok || !/^https:\/\//.test(input.finalUrl ?? '')) throw failure('invalid_campaign');
        const client = google();
        if (client.configured) return { created: true, ...(await client.createSearchCampaign({ name: input.name, dailyBudgetCents: input.dailyBudgetCents, finalUrl: input.finalUrl, plan: checked.plan })) };
        const csv = editorCsv(checked.plan, { name: input.name, finalUrl: input.finalUrl, dailyBudgetCents: input.dailyBudgetCents });
        const sent = await notifier.send({ severity: 'info', subject: `Google search campaign to import: ${input.name}`,
          body: 'The Google Ads API is not set up yet, so here is the campaign you approved as a file. In Google Ads Editor choose Account → Import → Paste text, paste it, review and post. It is paused until you enable it.',
          blocks: [{ type: 'paragraph', text: 'Paste this into Google Ads Editor (Account → Import → Paste text):' }, { type: 'message', text: csv }],
          dedupeKey: `ads:google:export:${execution.id}`, agentKey: 'social_manager' });
        if (!sent.some(item => ['sent', 'duplicate'].includes(item.delivery))) throw Object.assign(new Error('The import file could not be emailed.'), { code: 'notification_failed', transient: true });
        return { exported: true };
      },
    }),
  };
}
