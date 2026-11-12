import { HttpError } from './sms-auth.mjs';

/**
 * What the Hub service needs, read from the resolved server credentials at request time for the platform administrator
 * only: the secrets (API keys, tokens, signing keys) and the few values that wire the service itself. Every switch, address, account id
 * and limit is a Hub setting on the Settings page instead (server/hub-settings.mjs, docs/SETTINGS.md), so it is not listed here.
 * A secret contributes booleans only: whether it is set and, where the service requires a minimum length (minLength), whether it meets
 * it, the same test the service applies before using it. No part of its value or its length is returned or logged. A non-secret value
 * (the public origin, the Telnyx profile id) is returned so the owner can confirm it. This endpoint reports; it never sets anything.
 * Most secrets are set in Railway. Social tokens can also be entered in Settings; the resolver supplies their decrypted values here.
 */
const present = (value) => typeof value === 'string' && value.trim().length > 0;

export const integrationCatalog = Object.freeze([
  { id: 'anthropic', name: 'AI assistance (Anthropic)', purpose: 'Staff case summaries, reply drafts, triage suggestions, AI answers on support cases and the AI team\'s agents. Turn the AI features on and off in Settings.', docs: 'docs/CONTROL_CENTER.md',
    variables: [
      { name: 'ANTHROPIC_API_KEY', secret: true, required: true, purpose: 'The Hub service calls Anthropic directly with this key.' },
    ] },
  { id: 'twilio-sms', name: 'Text messages (Twilio)', purpose: 'Inbound texts to the support number and staff replies by text from the Communications inbox. The sending number or Messaging Service is in Settings → Text messages.', docs: 'docs/UNIFIED_COMMUNICATIONS.md',
    variables: [
      { name: 'HUB_TWILIO_AUTH_TOKEN', secret: true, required: true, purpose: 'Verifies the signature on every inbound text.' },
      { name: 'HUB_TWILIO_ACCOUNT_SID', secret: true, required: false, purpose: 'With a sender in Settings → Text messages, lets staff reply by text.' },
    ] },
  { id: 'sendgrid-email', name: 'Email (SendGrid)', purpose: 'Inbound support email through Inbound Parse, staff replies by email, and bulk email to application users. Senders, Reply-To and the postal address are in Settings → Email.', docs: 'docs/UNIFIED_COMMUNICATIONS.md',
    variables: [
      { name: 'HUB_SENDGRID_INBOUND_PUBLIC_KEY', secret: true, required: true, purpose: 'Verifies signed Inbound Parse posts.' },
      { name: 'HUB_SENDGRID_API_KEY', secret: true, required: false, purpose: 'Mail Send key for replies and bulk email.' },
    ] },
  { id: 'amazon-ses', name: 'Email (Amazon SES)', purpose: 'Sends the Hub\'s email instead of SendGrid when Settings → Email → Email service is Amazon SES, and reports delivery, bounces and complaints through SNS. The region, configuration set and events topic are in Settings → Email.', docs: 'docs/AMAZON_SES.md',
    variables: [
      { name: 'HUB_SES_ACCESS_KEY_ID', secret: true, required: true, purpose: 'Access key id of an IAM user allowed only to send email through SES.' },
      { name: 'HUB_SES_SECRET_ACCESS_KEY', secret: true, minLength: 20, required: true, purpose: 'That access key\'s secret. The Hub sends it nowhere: it only signs requests to email.<region>.amazonaws.com.' },
    ] },
  { id: 'public-origin', name: 'Webhook origin', purpose: 'The exact origin Twilio and SendGrid call back; it must match the webhook URLs they hold.', docs: 'docs/UNIFIED_COMMUNICATIONS.md',
    variables: [{ name: 'HUB_PUBLIC_ORIGIN', secret: false, required: false, purpose: 'Defaults to https://support-hub-web-production.up.railway.app.' }] },
  { id: 'telnyx-signin', name: 'SMS sign-in (Telnyx)', purpose: 'Sends the six-digit sign-in codes for every Hub account. It stays in Railway so a wrong value can never lock you out of the Hub.', docs: 'docs/APP_SMS_SIGNIN.md',
    variables: [
      { name: 'HUB_TELNYX_API_KEY', secret: true, required: true, purpose: 'Telnyx API key.' },
      { name: 'HUB_TELNYX_VERIFY_PROFILE_ID', secret: false, required: true, purpose: 'Telnyx Verify profile that issues the codes.' },
    ] },
  { id: 'stripe-billing', name: 'Platform billing (Stripe)', purpose: 'Products, prices, subscriptions, discounts and invoices for every application, managed in Billing. The Hub is the only Stripe client for platform billing. Purchasing and the portal configuration are in Settings → Billing.', docs: 'docs/PLATFORM_BILLING.md',
    variables: [
      { name: 'STRIPE_SECRET_KEY', secret: true, required: true, purpose: 'Secret key for the CareMetric Stripe account (acct_1SinLKB06O2UFlNz). Any other account is refused at startup.' },
      { name: 'STRIPE_WEBHOOK_SECRET', secret: true, required: true, purpose: 'Signing secret of the Hub webhook endpoint (/api/webhooks/stripe). Separate several with commas while rotating.' },
    ] },
  { id: 'customer-growth', name: 'Customer growth', purpose: 'CareBase and Intel prospecting, customer success, activity and delivery events. Sending and the growth sender are in Settings.', docs: 'docs/CUSTOMER_GROWTH.md',
    variables: [
      { name: 'HUB_GROWTH_SIGNING_KEY', secret: true, minLength: 32, required: true, purpose: 'At least 32 characters; signs stable unsubscribe links. Keep it across releases.' },
      { name: 'HUB_GROWTH_SEARCH_API_KEY', secret: true, required: false, purpose: 'Brave Search API key for attributable organization discovery; manual evidence also works.' },
      { name: 'HUB_GROWTH_CAREBASE_EVENT_KEY', secret: true, minLength: 32, required: false, purpose: 'CareBase server-only activity signing key, at least 32 characters.' },
      { name: 'HUB_GROWTH_INTEL_EVENT_KEY', secret: true, minLength: 32, required: false, purpose: 'Intel server-only activity signing key, at least 32 characters.' },
      { name: 'HUB_SENDGRID_EVENT_PUBLIC_KEY', secret: true, required: false, purpose: 'Verifies delivery, bounce, complaint and unsubscribe webhooks.' },
    ] },
  { id: 'social-media', name: 'Social media (Meta)', purpose: 'The Social Media Manager\'s access to your Facebook Page, Instagram account and Meta ad account. The Page, Instagram and ad account ids, brand images and ad limits are in Settings → Social media.', docs: 'docs/SOCIAL_MEDIA.md',
    variables: [
      { name: 'HUB_META_ACCESS_TOKEN', secret: true, minLength: 20, required: true, purpose: 'A system user access token from your Meta Business account with access to the Page, the Instagram account and the ad account (see docs/SOCIAL_MEDIA.md). The Hub sends it only to graph.facebook.com and never shows or logs it.' },
    ] },
  { id: 'social-linkedin', name: 'Social media (LinkedIn)', purpose: 'The Social Media Manager\'s access to your LinkedIn Company Page and ad account. The Page and ad account ids, client ids and API version are in Settings → Social media.', docs: 'docs/SOCIAL_MEDIA.md',
    variables: [
      { name: 'HUB_LINKEDIN_ACCESS_TOKEN', secret: true, minLength: 20, required: true, purpose: 'An access token from your LinkedIn developer app, authorized by an administrator of the Page (see docs/SOCIAL_MEDIA.md). The Hub sends it only to api.linkedin.com and never shows or logs it.' },
      { name: 'HUB_LINKEDIN_REFRESH_TOKEN', secret: true, minLength: 20, required: false, purpose: 'The refresh token issued with the access token. With it, the client secret and the client id in Settings, the Hub renews the access token by itself; without them, renew it every 60 days.' },
      { name: 'HUB_LINKEDIN_CLIENT_SECRET', secret: true, required: false, purpose: 'Your LinkedIn developer app\'s client secret, used only to renew the access token through www.linkedin.com.' },
      { name: 'HUB_LINKEDIN_ADS_ACCESS_TOKEN', secret: true, minLength: 20, required: false, purpose: 'A token from a second LinkedIn app that has the Advertising API, when LinkedIn keeps the Page API on an app of its own. Without it, the Page token is used for ads too.' },
      { name: 'HUB_LINKEDIN_ADS_REFRESH_TOKEN', secret: true, minLength: 20, required: false, purpose: 'The refresh token issued with the ads token, so the Hub can renew it by itself.' },
      { name: 'HUB_LINKEDIN_ADS_CLIENT_SECRET', secret: true, required: false, purpose: 'The advertising app\'s client secret, used only to renew the ads token (the Page app\'s is used when unset).' },
    ] },
  { id: 'website-leads', name: 'Website leads', purpose: 'CareBase, Intel and Healthcare Advisors forward every lead from their public forms to the Hub (POST /api/leads), where it appears on Leads and, when the person asked to be contacted, in Communications. Each product signs its leads with its own secret; a product without one keeps its leads to itself.', docs: 'docs/LEAD_INTAKE.md',
    variables: [
      { name: 'HUB_LEAD_SECRET_CAREBASE', secret: true, minLength: 32, required: false, purpose: 'The secret CareBase signs its website leads with: the same value as CareBase\'s HUB_LEAD_SECRET. Use at least 32 random characters; a shorter value counts as not set.' },
      { name: 'HUB_LEAD_SECRET_INTEL', secret: true, minLength: 32, required: false, purpose: 'The secret Intel signs its website leads with: the same value as Intel\'s HUB_LEAD_SECRET. Use at least 32 random characters; a shorter value counts as not set.' },
      { name: 'HUB_LEAD_SECRET_ADVISORS', secret: true, minLength: 32, required: false, purpose: 'The secret Healthcare Advisors signs its consultation requests with: the same value as Advisors\' HUB_LEAD_SECRET. Use at least 32 random characters; a shorter value counts as not set.' },
    ] },
  { id: 'carebase-distribution', name: 'CareBase course distribution observer', purpose: 'Lets the Hub observe shared course availability in CareBase.', docs: 'docs/SHARED_COURSE_DISTRIBUTION.md',
    variables: [{ name: 'CAREBASE_DISTRIBUTION_OBSERVER_TOKEN', secret: true, required: true, purpose: 'Token CareBase issued to the Hub observer.' }] },
  { id: 'search-console', name: 'Google Search Console', purpose: 'Optional. Adds clicks, impressions, click-through rate, position and searches to the SEO Analyst\'s Monday report. To connect: in Google Cloud, create a service account with a JSON key and enable the Google Search Console API; in Search Console, add the service account\'s email as a user on each property. List the properties in Settings → Search.', docs: 'docs/GOOGLE_SEARCH_CONSOLE_SETUP.md',
    variables: [
      { name: 'HUB_SEARCH_CONSOLE_CREDENTIALS', secret: true, required: true, purpose: 'The service account\'s JSON key file, pasted whole. The Hub uses it only to read Search Console and never shows or logs it.' },
    ] },
  { id: 'website-sessions', name: 'Intel website sessions', purpose: 'Reads aggregate anonymous public-site session counts from Intel. Set the same dedicated key on Intel, release its measurement endpoint, then turn on Read Intel website sessions in Settings → Website analytics.', docs: 'docs/WEBSITE_SESSION_METRICS.md',
    variables: [{ name: 'HUB_VISITOR_METRICS_KEY', secret: true, minLength: 32, required: true, purpose: 'Dedicated signing key shared only with Intel’s visitor-metrics endpoint. Never used in browser code.' }] },
]);

export function integrationSetup({ rpc, env = process.env, now = () => new Date() }) {
  async function handle(sessionToken) {
    const context = await rpc('get_support_actor_context', {}, sessionToken);
    if (context?.role !== 'platform_admin') {
      throw new HttpError(403, 'Integration setup is available to the platform administrator only.');
    }
    const environment = typeof env === 'function' ? env() : env;
    return {
      checkedAt: now().toISOString(),
      integrations: integrationCatalog.map((integration) => {
        const variables = integration.variables.map((variable) => {
          const value = environment[variable.name];
          const set = present(value);
          return {
            name: variable.name, secret: variable.secret, required: variable.required, purpose: variable.purpose, set,
            // A secret shorter than the service's minimum is treated as missing by the service, so it does not satisfy here either.
            satisfied: variable.minLength ? typeof value === 'string' && value.length >= variable.minLength : set,
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
