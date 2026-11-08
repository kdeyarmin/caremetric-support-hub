import { HttpError } from './sms-auth.mjs';

/**
 * Which integrations the Hub service has configured, read from the service
 * environment at request time for the platform administrator only. A secret
 * contributes booleans only: whether it is set and, where the service requires a
 * minimum length (minLength), whether it meets it, the same test the service
 * applies before using it. No part of its value or its length is returned or logged.
 * Non-secret settings (an address, a flag, a tier, an identifier) are returned so
 * the owner can confirm them. A flag satisfies its integration only when it is
 * exactly "true", the same test server/main.mjs applies; a present but false
 * flag is reported as set and not satisfied. This endpoint reports; it never
 * sets anything.
 * Secrets are set on the Hub service (Railway → Variables) and take effect when
 * the service redeploys.
 */
const present = (value) => typeof value === 'string' && value.trim().length > 0;

export const integrationCatalog = Object.freeze([
  { id: 'anthropic', name: 'AI assistance (Anthropic)', purpose: 'Staff case summaries, reply drafts, triage suggestions, the customer auto-resolution loop and the AI team\'s agents (an agent calls it only where its own setting allows).', docs: 'docs/CONTROL_CENTER.md',
    variables: [
      { name: 'ANTHROPIC_API_KEY', secret: true, required: true, purpose: 'The Hub service calls Anthropic directly with this key.' },
      { name: 'HUB_AI_AUTOMATION_ENABLED', secret: false, required: false, flag: true, purpose: 'Exactly "true" turns on the customer auto-resolution loop.' },
      { name: 'HUB_AI_DRAFT_TIER', secret: false, required: false, purpose: '"draft" (Sonnet) or "quality" (Opus) for drafted replies.' },
      { name: 'HUB_AI_FOLLOW_UP_DELAY_HOURS', secret: false, required: false, purpose: 'Hours before the automated follow-up nudge (default 24).' },
    ] },
  { id: 'twilio-sms', name: 'Text messages (Twilio)', purpose: 'Inbound texts to the support number and staff replies by text from the Communications inbox.', docs: 'docs/UNIFIED_COMMUNICATIONS.md',
    variables: [
      { name: 'HUB_TWILIO_AUTH_TOKEN', secret: true, required: true, purpose: 'Verifies the signature on every inbound text.' },
      { name: 'HUB_TWILIO_ACCOUNT_SID', secret: true, required: false, purpose: 'With a Messaging Service SID or a sending number, lets staff reply by text.' },
      { name: 'HUB_TWILIO_MESSAGING_SERVICE_SID', secret: false, required: false, purpose: 'Preferred sender for replies.' },
      { name: 'HUB_TWILIO_FROM_NUMBER', secret: false, required: false, purpose: 'Sending number when no Messaging Service is used.' },
    ] },
  { id: 'sendgrid-email', name: 'Email (SendGrid)', purpose: 'Inbound support email through Inbound Parse, staff replies by email, and bulk email to application users.', docs: 'docs/UNIFIED_COMMUNICATIONS.md',
    variables: [
      { name: 'HUB_SENDGRID_INBOUND_PUBLIC_KEY', secret: true, required: true, purpose: 'Verifies signed Inbound Parse posts.' },
      { name: 'HUB_SENDGRID_API_KEY', secret: true, required: false, purpose: 'Mail Send key for replies and bulk email.' },
      { name: 'HUB_SUPPORT_FROM_EMAIL', secret: false, required: false, purpose: 'Reply sender (default support@caremetric.ai).' },
      { name: 'HUB_SUPPORT_REPLY_TO', secret: false, required: false, purpose: 'Reply-To on support replies and customer emails: the address Inbound Parse receives (e.g. support@inbound.caremetric.ai), so answers join the conversation. Default: the reply sender.' },
      { name: 'HUB_BULK_EMAIL_FROM', secret: false, required: false, purpose: 'Bulk email sender (default the reply sender); replies go to the reply sender.' },
      { name: 'HUB_BULK_EMAIL_POSTAL_ADDRESS', secret: false, required: false, purpose: 'Mailing address in every bulk email footer; include it for marketing email (CAN-SPAM).' },
    ] },
  { id: 'chat', name: 'Website chat', purpose: 'The chat panel on every Help page.', docs: 'docs/UNIFIED_COMMUNICATIONS.md',
    variables: [{ name: 'HUB_CHAT_ENABLED', secret: false, required: true, flag: true, purpose: 'Exactly "true" turns chat on.' }] },
  { id: 'public-origin', name: 'Webhook origin', purpose: 'The exact origin Twilio and SendGrid call back; it must match the webhook URLs they hold.', docs: 'docs/UNIFIED_COMMUNICATIONS.md',
    variables: [{ name: 'HUB_PUBLIC_ORIGIN', secret: false, required: false, purpose: 'Defaults to https://support-hub-web-production.up.railway.app.' }] },
  { id: 'telnyx-signin', name: 'SMS sign-in (Telnyx)', purpose: 'Sends the six-digit sign-in codes for every Hub account.', docs: 'docs/APP_SMS_SIGNIN.md',
    variables: [
      { name: 'HUB_TELNYX_API_KEY', secret: true, required: true, purpose: 'Telnyx API key.' },
      { name: 'HUB_TELNYX_VERIFY_PROFILE_ID', secret: false, required: true, purpose: 'Telnyx Verify profile that issues the codes.' },
    ] },
  { id: 'stripe-billing', name: 'Platform billing (Stripe)', purpose: 'Products, prices, subscriptions, discounts and invoices for every application, managed in Billing. The Hub is the only Stripe client for platform billing.', docs: 'docs/PLATFORM_BILLING.md',
    variables: [
      { name: 'STRIPE_SECRET_KEY', secret: true, required: true, purpose: 'Secret key for the CareMetric Stripe account (acct_1SinLKB06O2UFlNz). Any other account is refused at startup.' },
      { name: 'STRIPE_WEBHOOK_SECRET', secret: true, required: true, purpose: 'Signing secret of the Hub webhook endpoint (/api/webhooks/stripe). Separate several with commas while rotating.' },
      { name: 'STRIPE_PORTAL_CONFIGURATION_ID', secret: false, required: false, purpose: 'Customer portal configuration (bpc_…) customers see; the account default otherwise.' },
    ] },
  { id: 'ai-team', name: 'AI team', purpose: 'Runs the agents on the Team screen: the scheduler, owner alerts by text and email, and the daily brief. Every agent also stays paused until the owner resumes it.', docs: 'docs/AI_TEAM.md',
    variables: [
      { name: 'HUB_AGENTS_ENABLED', secret: false, required: true, flag: true, purpose: 'Exactly "true" turns the scheduler on.' },
      { name: 'HUB_OWNER_EMAIL', secret: false, required: true, purpose: 'Where the AI team emails alerts and the morning brief. Urgent items are also texted to the administrator\'s verified number.' },
      { name: 'HUB_BOOKING_URL', secret: false, required: false, purpose: 'Your booking page (an https link, for example Calendly or Cal.com). The Support Concierge offers it in its sales-inquiry acknowledgment, and the Account Manager\'s customer emails show it as a "Pick a time" button. Leave it unset to offer no link.' },
      { name: 'HUB_AGENTS_CUSTOMER_TEXT_TO_AI', secret: false, required: false, flag: true, purpose: 'Exactly "true" lets the Support Concierge send a plain question\'s scrubbed text to the model to draft an answer for you to approve. Set it only when your Anthropic agreement covers support messages.' },
    ] },
  { id: 'customer-growth', name: 'Customer growth', purpose: 'CareBase and Intel prospecting, customer success, activity and delivery events.', docs: 'docs/CUSTOMER_GROWTH.md',
    variables: [
      { name: 'HUB_GROWTH_SEND_ENABLED', secret: false, required: false, flag: true, purpose: 'Master switch for sending reviewed growth messages.' },
      { name: 'HUB_GROWTH_SIGNING_KEY', secret: true, minLength: 32, required: true, purpose: 'At least 32 characters; signs stable unsubscribe links. Keep it across releases.' },
      { name: 'HUB_GROWTH_SEARCH_API_KEY', secret: true, required: false, purpose: 'Brave Search API key for attributable organization discovery; manual evidence also works.' },
      { name: 'HUB_GROWTH_CAREBASE_EVENT_KEY', secret: true, minLength: 32, required: false, purpose: 'CareBase server-only activity signing key, at least 32 characters.' },
      { name: 'HUB_GROWTH_INTEL_EVENT_KEY', secret: true, minLength: 32, required: false, purpose: 'Intel server-only activity signing key, at least 32 characters.' },
      { name: 'HUB_SENDGRID_EVENT_PUBLIC_KEY', secret: true, required: false, purpose: 'Verifies delivery, bounce, complaint and unsubscribe webhooks.' },
    ] },
  { id: 'social-media', name: 'Social media (Meta)', purpose: 'The Social Media Manager\'s connection to your Facebook Page, Instagram professional account and Meta ad account: weekly posts, replies to comments and messages, the daily ad review and the weekly report. Every post, reply and ad change waits for your approval until you hand that work over on the AI team screen; budget increases always do.', docs: 'docs/SOCIAL_MEDIA.md',
    variables: [
      { name: 'HUB_META_ACCESS_TOKEN', secret: true, minLength: 20, required: true, purpose: 'A system user access token from your Meta Business account with access to the Page, the Instagram account and the ad account (see docs/SOCIAL_MEDIA.md for the permissions). The Hub sends it only to graph.facebook.com and never shows or logs it.' },
      { name: 'HUB_META_PAGE_ID', secret: false, required: true, purpose: 'Your Facebook Page\'s numeric id.' },
      { name: 'HUB_META_INSTAGRAM_ID', secret: false, required: false, purpose: 'The numeric id of the Instagram professional account linked to the Page. Leave it unset to leave Instagram out.' },
      { name: 'HUB_META_AD_ACCOUNT_ID', secret: false, required: false, purpose: 'The ad account id (act_ followed by digits, or the digits). Leave it unset to leave ads out.' },
      { name: 'HUB_SOCIAL_IMAGE_URLS', secret: false, required: false, purpose: 'Https addresses of brand images you approve for Instagram posts, separated by commas. Instagram posts need an image; without any, the plan leaves Instagram out.' },
      { name: 'HUB_SOCIAL_TARGET_COST_PER_RESULT_CENTS', secret: false, required: false, purpose: 'Your target cost per lead or sign-up, in cents (2500 is $25). The ad review judges ads against it; without it, ads are judged against each other only.' },
      { name: 'HUB_SOCIAL_AD_MAX_DAILY_BUDGET_CENTS', secret: false, required: false, purpose: 'The most any Meta ad set or LinkedIn campaign may be given per day, in cents. The Social Media Manager may propose a budget increase only up to it, and only you can approve one. Unset means no increase is ever proposed.' },
    ] },
  { id: 'social-linkedin', name: 'Social media (LinkedIn)', purpose: 'The Social Media Manager\'s connection to your LinkedIn Company Page and LinkedIn ad account: posts, replies to comments, the daily ad review and the weekly report, approved like Meta\'s. LinkedIn has no API for Page messages, so those stay with you. A comment can only be deleted, never hidden, so a deletion always waits for you. The cost and cap settings above apply here too.', docs: 'docs/SOCIAL_MEDIA.md',
    variables: [
      { name: 'HUB_LINKEDIN_ACCESS_TOKEN', secret: true, minLength: 20, required: true, purpose: 'An access token from your LinkedIn developer app, authorized by an administrator of the Page (see docs/SOCIAL_MEDIA.md for the products and scopes). The Hub sends it only to api.linkedin.com and never shows or logs it.' },
      { name: 'HUB_LINKEDIN_ORGANIZATION_ID', secret: false, required: true, purpose: 'Your Company Page\'s numeric organization id (the digits in its admin address, or in urn:li:organization:…).' },
      { name: 'HUB_LINKEDIN_AD_ACCOUNT_ID', secret: false, required: false, purpose: 'Your LinkedIn ad account\'s numeric id from Campaign Manager. Leave it unset to leave LinkedIn ads out.' },
      { name: 'HUB_LINKEDIN_REFRESH_TOKEN', secret: true, minLength: 20, required: false, purpose: 'The refresh token issued with the access token. With it and the app\'s client id and secret, the Hub renews an expired access token by itself; without them, renew the token every 60 days.' },
      { name: 'HUB_LINKEDIN_CLIENT_ID', secret: false, required: false, purpose: 'Your LinkedIn developer app\'s client id, used only to renew the access token.' },
      { name: 'HUB_LINKEDIN_CLIENT_SECRET', secret: true, required: false, purpose: 'Your LinkedIn developer app\'s client secret, used only to renew the access token through www.linkedin.com.' },
      { name: 'HUB_LINKEDIN_ADS_ACCESS_TOKEN', secret: true, minLength: 20, required: false, purpose: 'A token from a second LinkedIn developer app that has the Advertising API, when LinkedIn keeps the Page API on an app of its own. Without it, the Page token is used for ads too.' },
      { name: 'HUB_LINKEDIN_ADS_REFRESH_TOKEN', secret: true, minLength: 20, required: false, purpose: 'The refresh token issued with the ads token, so the Hub can renew it by itself.' },
      { name: 'HUB_LINKEDIN_ADS_CLIENT_ID', secret: false, required: false, purpose: 'The advertising app\'s client id, used only to renew the ads token (the Page app\'s is used when unset).' },
      { name: 'HUB_LINKEDIN_ADS_CLIENT_SECRET', secret: true, required: false, purpose: 'The advertising app\'s client secret, used only to renew the ads token (the Page app\'s is used when unset).' },
      { name: 'HUB_LINKEDIN_API_VERSION', secret: false, required: false, purpose: 'The LinkedIn API version as YYYYMM (default 202609). Set a newer one when LinkedIn retires the default.' },
    ] },
  { id: 'website-leads', name: 'Website leads', purpose: 'CareBase, Intel and Healthcare Advisors forward every lead from their public forms to the Hub (POST /api/leads), where it appears on Leads and, when the person asked to be contacted, in Communications. Each product signs its leads with its own secret; a product without one keeps its leads to itself.', docs: 'docs/LEAD_INTAKE.md',
    variables: [
      { name: 'HUB_LEAD_SECRET_CAREBASE', secret: true, minLength: 32, required: false, purpose: 'The secret CareBase signs its website leads with: the same value as CareBase\'s HUB_LEAD_SECRET. Use at least 32 random characters; a shorter value counts as not set.' },
      { name: 'HUB_LEAD_SECRET_INTEL', secret: true, minLength: 32, required: false, purpose: 'The secret Intel signs its website leads with: the same value as Intel\'s HUB_LEAD_SECRET. Use at least 32 random characters; a shorter value counts as not set.' },
      { name: 'HUB_LEAD_SECRET_ADVISORS', secret: true, minLength: 32, required: false, purpose: 'The secret Healthcare Advisors signs its consultation requests with: the same value as Advisors\' HUB_LEAD_SECRET. Use at least 32 random characters; a shorter value counts as not set.' },
    ] },
  { id: 'carebase-distribution', name: 'CareBase course distribution observer', purpose: 'Lets the Hub observe shared course availability in CareBase.', docs: 'docs/SHARED_COURSE_DISTRIBUTION.md',
    variables: [{ name: 'CAREBASE_DISTRIBUTION_OBSERVER_TOKEN', secret: true, required: true, purpose: 'Token CareBase issued to the Hub observer.' }] },
  { id: 'search-console', name: 'Google Search Console', purpose: 'Optional. Adds clicks, impressions, click-through rate, position and searches to the SEO Analyst\'s Monday report; without it the report uses the crawl alone. To connect: in Google Cloud, create a service account with a JSON key and enable the Google Search Console API; in Search Console, add the service account\'s email as a user on each property.', docs: 'docs/AI_TEAM.md',
    variables: [
      { name: 'HUB_SEARCH_CONSOLE_CREDENTIALS', secret: true, required: true, purpose: 'The service account\'s JSON key file, pasted whole. The Hub uses it only to read Search Console and never shows or logs it.' },
      { name: 'HUB_SEARCH_CONSOLE_SITES', secret: false, required: true, purpose: 'The properties to read, separated by commas, exactly as Search Console names them: sc-domain:cmcarebase.com for a domain property, https://www.caremetricintel.com/ (with its final /) for an address prefix.' },
    ] },
]);

export function integrationSetup({ rpc, env = process.env, now = () => new Date() }) {
  async function handle(sessionToken) {
    const context = await rpc('get_support_actor_context', {}, sessionToken);
    if (context?.role !== 'platform_admin') {
      throw new HttpError(403, 'Integration setup is available to the platform administrator only.');
    }
    return {
      checkedAt: now().toISOString(),
      integrations: integrationCatalog.map((integration) => {
        const variables = integration.variables.map((variable) => {
          const value = env[variable.name];
          const set = present(value);
          return {
            name: variable.name, secret: variable.secret, required: variable.required, purpose: variable.purpose, set,
            // A secret shorter than the service's minimum is treated as missing by the service, so it does not satisfy here either.
            satisfied: variable.flag ? value === 'true' : variable.minLength ? typeof value === 'string' && value.length >= variable.minLength : set,
            // Only a non-secret setting is ever shown; a secret is represented by `set` alone.
            ...(variable.secret ? {} : { value: set ? String(value).trim().slice(0, 200) : null }),
          };
        });
        return {
          id: integration.id, name: integration.name, purpose: integration.purpose, docs: integration.docs, variables,
          ready: variables.filter((variable) => variable.required).every((variable) => variable.satisfied),
          complete: variables.every((variable) => variable.satisfied),
        };
      }),
    };
  }
  return { handle };
}
