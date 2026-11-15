/**
 * The Social Media Manager (supabase/migrations/20261108190000_social_manager.sql): runs CareMetric's Facebook Page, Instagram
 * account, Meta ad account, LinkedIn Company Page and LinkedIn ad account for engagement, with every post, reply and ad change approved by the owner until the owner hands that
 * kind of work over. Its handlers and executors register only when the database declares `platform.agents.social.v1`.
 *
 * `social` is the Hub's configuration (server/main.mjs): resolved encrypted credentials (or legacy Railway tokens), and the ids, the Instagram image list and the ad
 * settings from the Hub's Settings page. The daily budget cap is "Most any ad may spend per day"; with none set no budget is ever
 * raised. Comments and messages reach the model only while the owner's switch for customer text (Settings → AI team) is on.
 *
 * `creative` links it to the Creative Director (creative/index.mjs) when the database has it: `approved({ product, platform })` lists
 * creative the owner approved, which posts and new ads use before anything else; `live(assetId, ref)` records that one was published;
 * `planned(week)` tells the Creative Director a weekly plan was written. Without it, everything works as before.
 */
import { socialExecutors } from './executor.mjs';
import { linkedinClient } from './linkedin.mjs';
import { metaClient } from './meta.mjs';
import { socialHandlers } from './tasks.mjs';
import { live, rebuilt } from '../../live.mjs';
import { handoverDeclared } from '../handover.mjs';

export const socialFeature = 'platform.agents.social.v1';
export const socialDeclared = features => (features instanceof Set ? features.has(socialFeature) : Array.isArray(features) && features.includes(socialFeature));

const cents = value => { const number = Number(value); return Number.isInteger(number) && number >= 0 && number <= 10_000_000 ? number : null; };

/**
 * The configuration, validated. Unset or invalid values mean "not connected" or "no cap". Tokens come from the server's resolved
 * credentials (`env`); the ids, versions, images and ad limits come from the Hub's settings when `setting` (hub-settings `get`) is given, and from
 * the old Railway variables otherwise.
 */
export function socialConfig(env = {}, setting = null) {
  const value = (key, variable) => (setting ? setting(key) : env[variable]);
  const text = (key, variable) => { const found = value(key, variable); return typeof found === 'string' ? found : ''; };
  const images = value('social.image_urls', 'HUB_SOCIAL_IMAGE_URLS');
  const imageUrls = (Array.isArray(images) ? images : String(images ?? '').split(',')).map(item => String(item).trim()).filter(item => {
    try { const url = new URL(item); return url.protocol === 'https:' && !url.username && !url.password && item.length <= 1000; } catch { return false; }
  }).slice(0, 20);
  return {
    meta: { token: env.HUB_META_ACCESS_TOKEN ?? '', pageId: text('social.meta_page_id', 'HUB_META_PAGE_ID'), instagramId: text('social.instagram_id', 'HUB_META_INSTAGRAM_ID'),
      adAccountId: text('social.meta_ad_account_id', 'HUB_META_AD_ACCOUNT_ID'), version: text('social.meta_graph_version', 'HUB_META_GRAPH_VERSION') || 'v23.0' },
    linkedin: {
      token: env.HUB_LINKEDIN_ACCESS_TOKEN ?? '', refreshToken: env.HUB_LINKEDIN_REFRESH_TOKEN ?? '', clientId: text('social.linkedin_client_id', 'HUB_LINKEDIN_CLIENT_ID'), clientSecret: env.HUB_LINKEDIN_CLIENT_SECRET ?? '',
      adsToken: env.HUB_LINKEDIN_ADS_ACCESS_TOKEN ?? '', adsRefreshToken: env.HUB_LINKEDIN_ADS_REFRESH_TOKEN ?? '', adsClientId: text('social.linkedin_ads_client_id', 'HUB_LINKEDIN_ADS_CLIENT_ID'), adsClientSecret: env.HUB_LINKEDIN_ADS_CLIENT_SECRET ?? '',
      memberToken: env.HUB_LINKEDIN_MEMBER_ACCESS_TOKEN ?? '',
      organizationId: text('social.linkedin_organization_id', 'HUB_LINKEDIN_ORGANIZATION_ID'), adAccountId: text('social.linkedin_ad_account_id', 'HUB_LINKEDIN_AD_ACCOUNT_ID'),
      version: text('social.linkedin_api_version', 'HUB_LINKEDIN_API_VERSION') || '202609',
    },
    imageUrls,
    settings: { maxDailyBudgetCents: cents(value('social.max_daily_budget_cents', 'HUB_SOCIAL_AD_MAX_DAILY_BUDGET_CENTS')) ?? 0, targetCostCents: cents(value('social.target_cost_cents', 'HUB_SOCIAL_TARGET_COST_PER_RESULT_CENTS')) || null,
      eventPosts: setting ? setting('social.event_posts') === true : false,
      founderPosts: setting ? setting('social.founder_posts') === true : false,
      founderPostsPerWeek: (n => (Number.isInteger(n) && n >= 0 && n <= 5 ? n : 3))(setting ? setting('social.founder_posts_per_week') : null) },
  };
}

export function socialTeam({ social = null, features = null, fetchImpl = fetch, meta: givenMeta = null, linkedin: givenLinkedin = null }) {
  if (!socialDeclared(features)) return { handlers: () => ({}), executors: () => ({}), meta: null, linkedin: null, ads: null };
  // `social` may be a function (server/main.mjs: live settings and resolved credentials), read on each use. The clients are built
  // again only when what they are built from changes, so a page id or ad account saved in Settings applies to the next request.
  const config = () => live(social) ?? socialConfig({});
  const meta = givenMeta ?? rebuilt(() => config().meta, input => metaClient({ ...input, fetchImpl }));
  const linkedin = givenLinkedin ?? rebuilt(() => config().linkedin ?? {}, input => linkedinClient({ ...input, fetchImpl }));
  const settings = { get maxDailyBudgetCents() { return config().settings?.maxDailyBudgetCents ?? 0; }, get targetCostCents() { return config().settings?.targetCostCents ?? null; },
    get eventPosts() { return config().settings?.eventPosts === true; },
    get founderPosts() { return config().settings?.founderPosts === true; }, get founderPostsPerWeek() { return config().settings?.founderPostsPerWeek ?? 3; } };
  const imageUrls = () => config().imageUrls ?? [];
  return {
    meta, linkedin,
    // The connected ad accounts and the ad rules' settings, for the Chief of Staff's Monday scorecard (ad spend and ads losing money).
    ads: {
      settings,
      sources: () => [{ name: 'Meta', client: meta, on: meta.configured?.ads }, { name: 'LinkedIn', client: linkedin, on: linkedin.configured?.ads }].filter(source => source.on === true),
    },
    handlers: ({ store, notifier, model, customerTextToAi, publicOrigin, marketed = null, log, creative = null, feed = null }) => socialHandlers({ store, notifier, model, meta, linkedin, settings, imageUrls, customerTextToAi, publicOrigin, marketed, log, creative, feed }),
    // Founder posts approved automatically (the owner's hand-over) are carried out only when the database declares it.
    executors: ({ notifier, log, creative = null, store = null, publicOrigin = null }) => socialExecutors({ meta, linkedin, settings, notifier, log, creative, store, publicOrigin, handover: handoverDeclared(features) }),
  };
}
