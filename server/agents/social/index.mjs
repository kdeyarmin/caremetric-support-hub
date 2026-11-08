/**
 * The Social Media Manager (supabase/migrations/20261108190000_social_manager.sql): runs CareMetric's Facebook Page, Instagram
 * account, Meta ad account, LinkedIn Company Page and LinkedIn ad account for engagement, with every post, reply and ad change approved by the owner until the owner hands that
 * kind of work over. Its handlers and executors register only when the database declares `platform.agents.social.v1`.
 *
 * `social` is the Hub's configuration (server/main.mjs): the Meta token and ids, the Instagram image list, and the ad settings. The
 * daily budget cap is `HUB_SOCIAL_AD_MAX_DAILY_BUDGET_CENTS`; with none set no budget is ever raised. Comments and messages reach the
 * model only while the owner's switch for customer text (HUB_AGENTS_CUSTOMER_TEXT_TO_AI) is on.
 */
import { socialExecutors } from './executor.mjs';
import { linkedinClient } from './linkedin.mjs';
import { metaClient } from './meta.mjs';
import { socialHandlers } from './tasks.mjs';

export const socialFeature = 'platform.agents.social.v1';
export const socialDeclared = features => (features instanceof Set ? features.has(socialFeature) : Array.isArray(features) && features.includes(socialFeature));

const cents = value => { const number = Number(value); return Number.isInteger(number) && number >= 0 && number <= 10_000_000 ? number : null; };

/** The configuration from the environment, validated. Unset or invalid values mean "not connected" or "no cap". */
export function socialConfig(env = {}) {
  const imageUrls = String(env.HUB_SOCIAL_IMAGE_URLS ?? '').split(',').map(value => value.trim()).filter(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && value.length <= 1000; } catch { return false; }
  }).slice(0, 20);
  return {
    meta: { token: env.HUB_META_ACCESS_TOKEN ?? '', pageId: env.HUB_META_PAGE_ID ?? '', instagramId: env.HUB_META_INSTAGRAM_ID ?? '', adAccountId: env.HUB_META_AD_ACCOUNT_ID ?? '', version: env.HUB_META_GRAPH_VERSION || 'v23.0' },
    linkedin: {
      token: env.HUB_LINKEDIN_ACCESS_TOKEN ?? '', refreshToken: env.HUB_LINKEDIN_REFRESH_TOKEN ?? '', clientId: env.HUB_LINKEDIN_CLIENT_ID ?? '', clientSecret: env.HUB_LINKEDIN_CLIENT_SECRET ?? '',
      adsToken: env.HUB_LINKEDIN_ADS_ACCESS_TOKEN ?? '', adsRefreshToken: env.HUB_LINKEDIN_ADS_REFRESH_TOKEN ?? '', adsClientId: env.HUB_LINKEDIN_ADS_CLIENT_ID ?? '', adsClientSecret: env.HUB_LINKEDIN_ADS_CLIENT_SECRET ?? '',
      organizationId: env.HUB_LINKEDIN_ORGANIZATION_ID ?? '', adAccountId: env.HUB_LINKEDIN_AD_ACCOUNT_ID ?? '', version: env.HUB_LINKEDIN_API_VERSION || '202609',
    },
    imageUrls,
    settings: { maxDailyBudgetCents: cents(env.HUB_SOCIAL_AD_MAX_DAILY_BUDGET_CENTS) ?? 0, targetCostCents: cents(env.HUB_SOCIAL_TARGET_COST_PER_RESULT_CENTS) || null },
  };
}

export function socialTeam({ social = null, features = null, fetchImpl = fetch, meta: givenMeta = null, linkedin: givenLinkedin = null }) {
  if (!socialDeclared(features)) return { handlers: () => ({}), executors: () => ({}), meta: null, linkedin: null };
  const config = social ?? socialConfig({});
  const meta = givenMeta ?? metaClient({ ...config.meta, fetchImpl });
  const linkedin = givenLinkedin ?? linkedinClient({ ...(config.linkedin ?? {}), fetchImpl });
  return {
    meta, linkedin,
    handlers: ({ store, notifier, model, customerTextToAi, publicOrigin, log }) => socialHandlers({ store, notifier, model, meta, linkedin, settings: config.settings, imageUrls: config.imageUrls, customerTextToAi, publicOrigin, log }),
    executors: ({ notifier, log }) => socialExecutors({ meta, linkedin, settings: config.settings, notifier, log }),
  };
}
