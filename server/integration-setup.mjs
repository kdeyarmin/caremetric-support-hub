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
