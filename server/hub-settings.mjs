import { HttpError, transaction, withSession } from './sms-auth.mjs';
import { validGrowthFromEmail, validGrowthFromName } from './growth/sender.mjs';
import { readProperties } from './agents/seo/search-console.mjs';

/**
 * The Hub's settings (supabase/migrations/20261109150000_hub_settings.sql): every switch and value that is not a secret, changed by
 * the owner on the Settings page (/admin/settings) instead of in Railway variables. Ordinary settings never contain secrets.
 * Most secrets and the service's wiring stay in Railway; social-connections.mjs separately encrypts Meta/LinkedIn credentials.
 *
 * Once the database declares `platform.settings.v1`:
 * - at start the server copies the value of each Railway variable a setting replaces into the setting, once, and only into a setting
 *   nobody has set yet. A variable is never read again after that, so it can be deleted (the server says which at start);
 * - `get(key)` answers from the values read at start and every 30 seconds after, and at once after the owner saves on this server, so
 *   a change applies within a minute without a restart. A setting without a value, or with one the server cannot use, is its default.
 *
 * Until the feature is declared (the server deployed before the migration is applied), and while the values cannot be read at start,
 * `get(key)` reads the Railway variable exactly as the server did before, so nothing changes.
 *
 * To add a setting: a row in a migration (key and kind) and an entry here. Never add a Railway variable for anything that is not a
 * secret (CLAUDE.md).
 */
export const settingsFeature = 'platform.settings.v1';

const emailAddress = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const isEmail = value => typeof value === 'string' && value.length <= 320 && emailAddress.test(value);
const isHttps = value => {
  if (typeof value !== 'string' || value.length > 1000 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password; } catch { return false; }
};
const matches = pattern => value => typeof value === 'string' && pattern.test(value);
const wholeNumber = (min, max) => value => Number.isInteger(value) && value >= min && value <= max;
const oneLine = max => value => typeof value === 'string' && value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const listOf = (test, max = 20) => value => Array.isArray(value) && value.length >= 1 && value.length <= max && value.every(test);

// How a Railway variable's text became the value the server used. `undefined` means there is nothing to copy.
const fromFlag = raw => raw === 'true';
const fromText = raw => raw.trim() || undefined;
const fromNumber = raw => { const number = Number(raw.trim()); return raw.trim() && Number.isFinite(number) ? number : undefined; };
const fromList = raw => { const items = raw.split(',').map(item => item.trim()).filter(Boolean); return items.length ? items : undefined; };
const fromSites = raw => { const items = raw.split(/[\s,]+/).filter(Boolean); return items.length ? items : undefined; };
const searchConsoleSite = value => typeof value === 'string' && value.length <= 300 && readProperties(value).properties.length === 1;

export const settingGroups = Object.freeze([
  { id: 'agents', label: 'AI team', description: 'Whether the AI team runs, where it reaches you, and what it may send to the model.' },
  { id: 'support', label: 'Customer support', description: 'Website chat and the AI help on support cases.' },
  { id: 'email', label: 'Email', description: 'Which service sends the Hub\'s email, who it comes from and where answers go. Each sender\'s domain must be verified with that service.' },
  { id: 'sms', label: 'Text messages', description: 'The Twilio sender staff replies and owner alerts are texted from.' },
  { id: 'growth', label: 'Customer growth', description: 'Finding prospects and sending reviewed prospecting and follow-up email.' },
  { id: 'billing', label: 'Billing', description: 'What customers can buy themselves and how prices stay in step with Intel.' },
  { id: 'ads', label: 'Paid ads', description: 'New ad campaigns on LinkedIn, Meta and Google search (always created paused, each approved by you), their monthly limit, and reporting leads from ads back to the ad platforms.' },
  { id: 'social', label: 'Social media', description: 'The Facebook Page, Instagram account, LinkedIn Page and ad accounts the Social Media Manager works on, and its ad limits. Connect the Pages and save encrypted access tokens here.' },
  { id: 'creative', label: 'Creative', description: 'The Creative Director: whether it works, how many images and videos it starts a day, and how videos are made. HeyGen\'s key stays in Railway.' },
  { id: 'seo', label: 'Search', description: 'The Search Console properties the SEO Analyst and the Monday scorecard read. The service account key stays in Railway.' },
  { id: 'analytics', label: 'Website analytics', description: 'Read first-party measurements from the public marketing website. Signing keys stay in Railway.' },
  { id: 'learning', label: 'Course distribution', description: 'How shared courses reach CareBase.' },
]);

/**
 * Every setting. `kind` is the database's (flag, text, number, list); `input` is how the Settings page shows it. `env` is the
 * Railway variable the setting replaces, or null for a setting that never was one (everything new is a setting from the start).
 * `valid` is the test a value must pass to be saved and to be used.
 */
export const settingsCatalog = Object.freeze([
  { key: 'agents.enabled', group: 'agents', kind: 'flag', input: 'toggle', default: false, env: 'HUB_AGENTS_ENABLED', fromEnv: fromFlag,
    label: 'Run the AI team', help: 'Runs the scheduler for the agents on the AI team page. Each agent also stays paused until you resume it there.' },
  { key: 'agents.customer_text_to_ai', group: 'agents', kind: 'flag', input: 'toggle', default: false, env: 'HUB_AGENTS_CUSTOMER_TEXT_TO_AI', fromEnv: fromFlag,
    label: 'Let agents send customer messages to the AI', help: 'The Support Concierge, Sales Executive and Social Media Manager may send a message\'s scrubbed text to the model to draft an answer for you to approve. Turn it on only when your Anthropic agreement covers support messages.' },
  { key: 'agents.concurrent_tasks', group: 'agents', kind: 'number', input: 'number', default: 3, min: 1, max: 10, unit: 'tasks', env: null, valid: wholeNumber(1, 10),
    label: 'Tasks at once', help: 'How many agent tasks may run side by side (1 to 10). A slow task no longer holds up the rest of the team.' },
  { key: 'agents.watchdog_idle_days', group: 'agents', kind: 'number', input: 'number', default: 3, min: 1, max: 30, unit: 'days', env: null, valid: wholeNumber(1, 30),
    label: 'Days before an idle agent is flagged', help: 'The morning brief names an active agent that has not run for this many days, with the likely cause (1 to 30).' },
  { key: 'agents.owner_email', group: 'agents', kind: 'text', input: 'email', default: null, env: 'HUB_OWNER_EMAIL', fromEnv: fromText, valid: isEmail,
    label: 'Your email for alerts and the morning brief', help: 'Where the AI team emails alerts, the morning brief and the Monday scorecard. Urgent items are also texted to your verified number.' },
  { key: 'support.chat', group: 'support', kind: 'flag', input: 'toggle', default: false, env: 'HUB_CHAT_ENABLED', fromEnv: fromFlag,
    label: 'Website chat', help: 'Shows the chat panel on every Help page. Conversations land in Communications.' },
  { key: 'support.ai_automation', group: 'support', kind: 'flag', input: 'toggle', default: false, env: 'HUB_AI_AUTOMATION_ENABLED', fromEnv: fromFlag,
    label: 'AI answers on new support cases', help: 'Drafts an answer for each new eligible case, asks the customer whether it fixed the problem, and follows up. Needs the Anthropic key.' },
  { key: 'support.ai_draft_tier', group: 'support', kind: 'text', input: 'choice', default: 'draft', env: 'HUB_AI_DRAFT_TIER', fromEnv: fromText,
    choices: [{ value: 'draft', label: 'Standard (faster, lower cost)' }, { value: 'quality', label: 'Best quality (slower, higher cost)' }], valid: value => value === 'draft' || value === 'quality',
    label: 'AI answer quality', help: 'Which model drafts the answers on support cases.' },
  { key: 'support.ai_follow_up_hours', group: 'support', kind: 'number', input: 'number', default: 24, min: 1, max: 720, unit: 'hours', env: 'HUB_AI_FOLLOW_UP_DELAY_HOURS', fromEnv: fromNumber, valid: wholeNumber(1, 720),
    label: 'Follow up after', help: 'Hours to wait for the customer\'s answer before the AI checks in again (1 to 720).' },
  { key: 'email.support_from', group: 'email', kind: 'text', input: 'email', default: 'support@caremetric.ai', env: 'HUB_SUPPORT_FROM_EMAIL', fromEnv: fromText, valid: isEmail,
    label: 'Support sender', help: 'The address staff replies, alerts, customer email and bulk email come from. Its domain must be verified with the email service.' },
  { key: 'email.reply_to', group: 'email', kind: 'text', input: 'email', default: null, env: 'HUB_SUPPORT_REPLY_TO', fromEnv: fromText, valid: isEmail,
    label: 'Reply-To', help: 'Where customers\' answers go: the address SendGrid Inbound Parse receives (for example support@inbound.caremetric.ai), so answers join the conversation. Empty: the sender itself.' },
  { key: 'email.postal_address', group: 'email', kind: 'text', input: 'text', default: null, env: 'HUB_BULK_EMAIL_POSTAL_ADDRESS', fromEnv: fromText, valid: oneLine(300),
    label: 'Mailing address in email footers', help: 'Required by CAN-SPAM in marketing and growth email. Bulk, growth and customer emails are not sent without it.' },
  { key: 'email.growth_from', group: 'email', kind: 'text', input: 'email', default: null, env: 'HUB_GROWTH_FROM_EMAIL', fromEnv: fromText, valid: validGrowthFromEmail,
    label: 'Growth email sender', help: 'Cold email and sales follow-ups only, on their own subdomain (for example hello@go.caremetric.ai) so prospecting never affects the support address. Authenticate it in SendGrid (SPF, DKIM), publish DMARC and warm it up first. Empty: the support sender.' },
  { key: 'email.growth_from_name', group: 'email', kind: 'text', input: 'text', default: null, env: 'HUB_GROWTH_FROM_NAME', fromEnv: fromText, valid: validGrowthFromName,
    label: 'Growth email display name', help: 'At most 64 characters, without quotes or angle brackets. Empty: "CareMetric".' },
  { key: 'email.provider', group: 'email', kind: 'text', input: 'choice', default: 'sendgrid', env: null,
    choices: [{ value: 'sendgrid', label: 'SendGrid' }, { value: 'ses', label: 'Amazon SES' }], valid: value => value === 'sendgrid' || value === 'ses',
    label: 'Email service', help: 'Which service sends the Hub\'s email: staff replies, alerts, customer, bulk and growth email. Amazon SES needs its access key in Railway and each sender\'s domain verified in SES. If the chosen service is not set up, the other one keeps sending.' },
  { key: 'email.growth_provider', group: 'email', kind: 'text', input: 'choice', default: 'sendgrid', env: null,
    choices: [{ value: 'sendgrid', label: 'SendGrid' }, { value: 'ses', label: 'Amazon SES' }], valid: value => value === 'sendgrid' || value === 'ses',
    label: 'Growth email service', help: 'Which service sends growth email (cold email and sales follow-ups). Keep SendGrid: Amazon SES does not allow unsolicited email, and an SES suspension would stop all of the Hub\'s email.' },
  { key: 'email.ses_region', group: 'email', kind: 'text', input: 'text', default: 'us-east-2', env: null, valid: matches(/^[a-z]{2}(-[a-z]+)+-\d$/),
    label: 'Amazon SES region', help: 'The AWS region your SES domains are verified in, for example us-east-2.' },
  { key: 'email.ses_configuration_set', group: 'email', kind: 'text', input: 'text', default: null, env: null, valid: matches(/^[A-Za-z0-9_-]{1,64}$/),
    label: 'Amazon SES configuration set', help: 'The configuration set that publishes delivery, bounce and complaint events (for example caremetric-hub). Empty: SES sends without one and the Hub hears no delivery events.' },
  { key: 'email.ses_events_topic', group: 'email', kind: 'text', input: 'text', default: null, env: null, valid: matches(/^arn:aws:sns:[a-z]{2}(-[a-z]+)+-\d:\d{12}:[A-Za-z0-9_-]{1,256}$/),
    label: 'Amazon SES events topic', help: 'The SNS topic ARN the configuration set publishes to. The Hub accepts SES events only from this topic, at /api/growth/delivery/ses.' },
  { key: 'sms.messaging_service_sid', group: 'sms', kind: 'text', input: 'text', default: null, env: 'HUB_TWILIO_MESSAGING_SERVICE_SID', fromEnv: fromText, valid: matches(/^MG[0-9a-f]{32}$/),
    label: 'Twilio Messaging Service SID', help: 'MG followed by 32 characters. Preferred over a single sending number.' },
  { key: 'sms.from_number', group: 'sms', kind: 'text', input: 'text', default: null, env: 'HUB_TWILIO_FROM_NUMBER', fromEnv: fromText, valid: matches(/^\+[1-9][0-9]{7,14}$/),
    label: 'Twilio sending number', help: 'In +1… form. Used only when no Messaging Service SID is set.' },
  { key: 'growth.send', group: 'growth', kind: 'flag', input: 'toggle', default: false, env: 'HUB_GROWTH_SEND_ENABLED', fromEnv: fromFlag,
    label: 'Send growth email', help: 'Master switch for sending reviewed prospecting and follow-up email. Off: messages are drafted and reviewed but never sent.' },
  { key: 'growth.cold_email_daily_cap', group: 'growth', kind: 'number', input: 'number', default: 10, min: 1, max: 100, unit: 'emails', env: null, valid: wholeNumber(1, 100),
    label: 'Most cold emails a day', help: 'First-contact and follow-up emails to businesses that have not replied, per Eastern day, across every product (1 to 100). Raise it in steps (25, then 50) only while bounces stay under 2% and nobody marks the email as spam. Each product\'s own daily limit on the Growth page still applies beneath it.' },
  { key: 'growth.people_per_organization', group: 'growth', kind: 'number', input: 'number', default: 3, min: 1, max: 5, unit: 'people', env: null, valid: wholeNumber(1, 5),
    label: 'Most people to email at one organization', help: 'Each cold email to a business also goes, as its own email, to the other decision-makers there you permitted (owner, administrator, marketing lead first), up to this many people including the first contact (1 to 5). Each one counts toward "Most cold emails a day". 1: only the first contact.' },
  { key: 'growth.roster', group: 'growth', kind: 'flag', input: 'toggle', default: false, env: null,
    label: 'Find prospects from the Medicare roster', help: 'The Marketing Manager reads every Medicare-certified home health agency and hospice in your states from Intel\'s marketing feed each week, looks up the best-ranked ones\' own websites and adds those it confirms to Growth. Needs HUB_INTEL_FEED_SECRET in Railway, set to the same value as Intel\'s HUB_MARKETING_FEED_SECRET. Nothing is sent: drafts still wait for Send growth email and your approvals.' },
  { key: 'growth.roster_states', group: 'growth', kind: 'list', input: 'lines', default: [], env: null, valid: listOf(matches(/^[A-Z]{2}$/), 60),
    label: 'States to prospect in', help: 'Two-letter state codes, one per line (PA, OH, …), at most 60. Empty: the roster is not read.' },
  { key: 'growth.roster_daily_resolutions', group: 'growth', kind: 'number', input: 'number', default: 25, min: 0, max: 200, unit: 'agencies', env: null, valid: wholeNumber(0, 200),
    label: 'Most roster agencies to look up a day', help: 'Each look-up is one web search and a read of the agency\'s own site (0 to 200 per Eastern day). 25 a day is about 750 searches a month on your search plan. 0 stops looking up.' },
  { key: 'growth.roster_match_daily', group: 'growth', kind: 'number', input: 'number', default: 40, min: 0, max: 200, unit: 'prospects', env: null, valid: wholeNumber(0, 200),
    label: 'Most web prospects to match a day', help: 'Agencies found on the web are matched to their Medicare record through Intel, by a phone number on their own website or their name and place, so each gets its own market report (0 to 200 per Eastern day). Only a certain match is kept. Runs while Find prospects from the Medicare roster is on; uses no web search. 0 stops matching.' },
  { key: 'growth.inbound_followup', group: 'growth', kind: 'flag', input: 'toggle', default: false, env: null,
    label: 'Follow up website leads by email', help: 'A county report, contact, savings model or newsletter request becomes a qualified prospect, and the Marketing Manager drafts a short follow-up to the person who asked (for your approval until you hand it over). A trial sign-up stops cold email to its business at once. Off: leads are counted and alerted as before.' },
  { key: 'growth.save_emails', group: 'growth', kind: 'flag', input: 'toggle', default: false, env: null,
    label: 'Win-back and cancellation emails', help: 'The Account Manager proposes, for your approval, one short email when a trial ends unpaid (within 14 days) and one when a customer sets a plan to cancel, asking what got in the way. Each is sent once per account and product, only after you approve it. Off: neither is proposed.' },
  { key: 'growth.recontact_days', group: 'growth', kind: 'number', input: 'number', default: 90, min: 30, max: 365, unit: 'days', env: null, valid: wholeNumber(30, 365),
    label: 'Ask again after "not now"', help: 'Days before the Marketing Manager asks once more, briefly, a prospect who said not now or did not answer three emails (30 to 365). Sooner when the Medicare roster shows the agency changed ownership. Never after a no, an opt-out or a trial, and never twice.' },
  // The key keeps its first name (it chose a contact-data service before the Hub found people itself); the page shows the label.
  { key: 'growth.enrichment_provider', group: 'growth', kind: 'text', input: 'choice', default: 'verify', env: null,
    choices: [{ value: 'none', label: 'Names only: never look for a person\'s own address' }, { value: 'published', label: 'Addresses businesses publish on their own websites' },
      { value: 'verify', label: 'Also guess and check addresses with the business\'s mail server' }], valid: value => ['none', 'published', 'verify'].includes(value),
    label: 'Finding people\'s addresses', help: 'Decision-makers are found free (CMS owners file, NPI registry, their websites). For a work address: keep one the business publishes, or ask its mail server which usual shape (jane.doe@, jdoe@) is real, sending nothing; kept only if it refuses a made-up one. Checking needs Railway\'s Pro plan (port 25). Each waits for you on Growth until you hand named people\'s addresses over on the AI team page.' },
  { key: 'growth.enrichment_daily_credits', group: 'growth', kind: 'number', input: 'number', default: 10, min: 0, max: 500, unit: 'checks', env: null, valid: wholeNumber(0, 500),
    label: 'Most address checks a day', help: 'Businesses whose mail server is asked about a person\'s address, per Eastern day (0 to 500). Each check asks about at most six addresses and sends nothing. Addresses a business publishes are not counted. 0 stops checks.' },
  { key: 'growth.deep_research', group: 'growth', kind: 'flag', input: 'toggle', default: false, env: null,
    label: 'Research prospects with web search', help: 'The Marketing Manager researches one prospect at a time with the model\'s web search and page reading (services, service area, hiring, expansion, referral partners) and keeps what it finds as evidence. Uses the Marketing Manager\'s daily model budget; searches cost about a cent each.' },
  { key: 'growth.deep_research_per_day', group: 'growth', kind: 'number', input: 'number', default: 5, min: 0, max: 50, unit: 'prospects', env: null, valid: wholeNumber(0, 50),
    label: 'Most prospects to research a day', help: 'Per Eastern day (0 to 50).' },
  { key: 'growth.deep_research_cents', group: 'growth', kind: 'number', input: 'cents', default: 30, min: 5, max: 200, env: null, valid: wholeNumber(5, 200),
    label: 'Most to spend researching one prospect', help: 'A ceiling for one prospect\'s research, searches included (5 to 200 cents). Research stops before a round that could pass it.' },
  { key: 'growth.learning_memo', group: 'growth', kind: 'flag', input: 'toggle', default: false, env: null,
    label: 'Write from what is working', help: 'Each Monday the Marketing Manager writes a short memo from 90 days of replies, objections and your notes on drafts you turned down. Drafts use a memo only after you choose "Use this memo" on Growth, or as soon as it is written once you hand "Learning memo" over on the AI team page.' },
  { key: 'billing.customer_purchasing', group: 'billing', kind: 'flag', input: 'toggle', default: false, env: 'HUB_CUSTOMER_PURCHASING_ENABLED', fromEnv: fromFlag,
    label: 'Customers can buy subscriptions', help: 'Lets a customer administrator start a new subscription from the Hub. Existing subscriptions and payment methods work either way.' },
  { key: 'billing.intel_price_sync', group: 'billing', kind: 'flag', input: 'toggle', default: true, env: 'HUB_APP_CATALOG_SYNC', fromEnv: raw => raw.trim() !== 'off',
    label: 'Keep Stripe in step with Intel\'s prices', help: 'Every 15 minutes the Hub reads Intel\'s plan prices and updates Stripe, keeping current subscribers on their price.' },
  { key: 'billing.portal_configuration', group: 'billing', kind: 'text', input: 'text', default: null, env: 'STRIPE_PORTAL_CONFIGURATION_ID', fromEnv: fromText, valid: matches(/^bpc_[A-Za-z0-9]{1,200}$/),
    label: 'Stripe customer portal configuration', help: 'The portal configuration customers see (bpc_…). Empty: the Stripe account\'s default.' },
  { key: 'learning.legacy_distribution_opt_in', group: 'learning', kind: 'flag', input: 'toggle', default: false, env: 'HUB_LEGACY_DISTRIBUTION_OPT_IN', fromEnv: fromFlag,
    label: 'Allow legacy opt-in distribution', help: 'Lets a course distribution use the older opt-in mode for facilities that have not moved to entitlements. Leave off unless you were told to use it.' },
  { key: 'social.meta_page_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_META_PAGE_ID', fromEnv: fromText, valid: matches(/^[0-9]{1,40}$/),
    label: 'Facebook Page id', help: 'Your Facebook Page\'s numeric id. Connect it using the Meta setup card.' },
  { key: 'social.instagram_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_META_INSTAGRAM_ID', fromEnv: fromText, valid: matches(/^[0-9]{1,40}$/),
    label: 'Instagram account id', help: 'The numeric id of the Instagram professional account linked to the Page. Empty: Instagram is left out.' },
  { key: 'social.meta_ad_account_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_META_AD_ACCOUNT_ID', fromEnv: fromText, valid: matches(/^(act_)?[0-9]{1,40}$/),
    label: 'Meta ad account id', help: 'act_ followed by digits, or the digits. Empty: Meta ads are left out.' },
  { key: 'social.meta_graph_version', group: 'social', kind: 'text', input: 'text', default: 'v23.0', env: 'HUB_META_GRAPH_VERSION', fromEnv: fromText, valid: matches(/^v\d{1,2}\.\d$/),
    label: 'Meta Graph API version', help: 'Change it only when Meta retires the current one.' },
  { key: 'social.linkedin_organization_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_LINKEDIN_ORGANIZATION_ID', fromEnv: fromText, valid: matches(/^(urn:li:organization:)?\d{1,30}$/),
    label: 'LinkedIn Company Page id', help: 'The numeric organization id (the digits in the Page\'s admin address). Connect it using the LinkedIn setup card.' },
  { key: 'social.linkedin_ad_account_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_LINKEDIN_AD_ACCOUNT_ID', fromEnv: fromText, valid: matches(/^(urn:li:sponsoredAccount:)?\d{1,30}$/),
    label: 'LinkedIn ad account id', help: 'The numeric id from Campaign Manager. Empty: LinkedIn ads are left out.' },
  { key: 'social.linkedin_client_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_LINKEDIN_CLIENT_ID', fromEnv: fromText, valid: matches(/^[A-Za-z0-9_-]{4,100}$/),
    label: 'LinkedIn app client id', help: 'Used only to renew the Page access token by itself, with the refresh token and client secret in the LinkedIn setup card.' },
  { key: 'social.linkedin_ads_client_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_LINKEDIN_ADS_CLIENT_ID', fromEnv: fromText, valid: matches(/^[A-Za-z0-9_-]{4,100}$/),
    label: 'LinkedIn advertising app client id', help: 'Only when ads use a second LinkedIn app. Empty: the Page app\'s client id.' },
  { key: 'social.linkedin_api_version', group: 'social', kind: 'text', input: 'text', default: '202609', env: 'HUB_LINKEDIN_API_VERSION', fromEnv: fromText, valid: matches(/^20\d{4}$/),
    label: 'LinkedIn API version', help: 'YYYYMM. Change it only when LinkedIn retires the current one.' },
  { key: 'social.event_posts', group: 'social', kind: 'flag', input: 'toggle', default: false, env: null,
    label: 'Post about new CMS data and observances', help: 'The weekly plan may write a post when Intel loads a new CMS or Census release, or a healthcare observance (such as Nurse Practitioner Week) is coming up. Every post still waits for your approval.' },
  { key: 'social.founder_posts', group: 'social', kind: 'flag', input: 'toggle', default: false, env: null,
    label: 'Write posts for my LinkedIn profile', help: 'The weekly plan also writes a few posts in your own voice for your personal LinkedIn profile. You approve each one, until you hand "Founder posts" over on the AI team page; then they publish at their time slots on their own. Without your personal token on the LinkedIn connection they are emailed for you to copy.' },
  { key: 'social.founder_posts_per_week', group: 'social', kind: 'number', input: 'number', default: 3, min: 0, max: 5, unit: 'posts', env: null, valid: wholeNumber(0, 5),
    label: 'Posts for my profile a week', help: 'How many posts for your personal LinkedIn profile the weekly plan writes (0 to 5).' },
  { key: 'ads.monthly_budget_cents', group: 'ads', kind: 'number', input: 'cents', default: null, min: 0, max: 10000000, env: null, valid: wholeNumber(0, 10000000),
    label: 'Most to spend on new campaigns a month', help: 'New LinkedIn, Meta and Google search campaigns only while this is set, each with a daily budget of at most a thirtieth of it (never above the daily ad-set limit), created paused after you approve it. Once you hand ad campaign launch over on the AI team page they start on their own with your approved creative, together within this number, each ending with its month. Empty: none.' },
  { key: 'ads.meta_audience_id', group: 'ads', kind: 'text', input: 'text', default: null, env: null, valid: matches(/^[0-9]{5,30}$/),
    label: 'Meta retargeting audience', help: 'The id of a Custom Audience of your website visitors (Ads Manager → Audiences). New Meta campaigns show ads only to it.' },
  { key: 'ads.meta_pixel_id', group: 'ads', kind: 'text', input: 'text', default: null, env: null, valid: matches(/^[0-9]{5,30}$/),
    label: 'Meta Pixel (dataset) id', help: 'Where leads from Meta ads are reported, when reporting leads is on.' },
  { key: 'ads.linkedin_conversion_id', group: 'ads', kind: 'text', input: 'text', default: null, env: null, valid: matches(/^[0-9]{3,30}$/),
    label: 'LinkedIn conversion rule id', help: 'The conversion in Campaign Manager that leads from LinkedIn ads are reported to (its token needs the rw_conversions permission).' },
  { key: 'ads.server_conversions', group: 'ads', kind: 'flag', input: 'toggle', default: false, env: null,
    label: 'Report leads to the ad platforms', help: 'Tells Meta and LinkedIn, by a hashed work email and the ad click ID, when a county report or trial request came from their ad. Turn on only after your privacy notice says so (Intel\'s does).' },
  { key: 'ads.google_customer_id', group: 'ads', kind: 'text', input: 'text', default: null, env: null, valid: matches(/^[0-9]{10}$/),
    label: 'Google Ads customer id', help: 'The 10-digit account number, without dashes. The Hub signs in as its Google service account (the Search Console key), which needs Standard access to this account or its manager. Until then, approved search campaigns are emailed as an import file instead.' },
  { key: 'ads.google_login_customer_id', group: 'ads', kind: 'text', input: 'text', default: null, env: null, valid: matches(/^[0-9]{10}$/),
    label: 'Google Ads manager account id', help: 'Optional: the manager account the API signs in through, without dashes.' },
  { key: 'ads.google_client_id', group: 'ads', kind: 'text', input: 'text', default: null, env: null, valid: matches(/^[0-9A-Za-z._-]{10,200}$/),
    label: 'Google Ads OAuth client id', help: 'Optional, and only to sign in as a person instead of the service account: from the Google Cloud project that has Google Ads API access.' },
  { key: 'ads.google_api_version', group: 'ads', kind: 'text', input: 'text', default: 'v26', env: null, valid: matches(/^v[0-9]{2}$/),
    label: 'Google Ads API version', help: 'Change when Google retires this version.' },
  { key: 'ads.google_competitor_keywords', group: 'ads', kind: 'flag', input: 'toggle', default: false, env: null,
    label: 'Bid on competitor names', help: 'Lets search campaigns include competitors\' names as keywords. Ad text never names a competitor.' },
  { key: 'social.image_urls', group: 'social', kind: 'list', input: 'lines', default: [], env: 'HUB_SOCIAL_IMAGE_URLS', fromEnv: fromList, valid: listOf(isHttps),
    label: 'Approved brand images', help: 'Https addresses of images approved for Instagram posts, one per line (at most 20). Instagram posts need an image; without any, Instagram is left out of the plan.' },
  { key: 'social.target_cost_cents', group: 'social', kind: 'number', input: 'cents', default: null, min: 1, max: 10_000_000, env: 'HUB_SOCIAL_TARGET_COST_PER_RESULT_CENTS', fromEnv: fromNumber, valid: wholeNumber(1, 10_000_000),
    label: 'Target cost per lead or sign-up', help: 'The daily ad review judges ads against it. Empty: ads are judged against each other only.' },
  { key: 'social.max_daily_budget_cents', group: 'social', kind: 'number', input: 'cents', default: null, min: 1, max: 10_000_000, env: 'HUB_SOCIAL_AD_MAX_DAILY_BUDGET_CENTS', fromEnv: fromNumber, valid: wholeNumber(1, 10_000_000),
    label: 'Most any ad may spend per day', help: 'The Social Media Manager may propose a budget increase only up to this, and only you can approve one. Empty: no increase is ever proposed.' },
  { key: 'creative.enabled', group: 'creative', kind: 'flag', input: 'toggle', default: false, env: null,
    label: 'Turn on the Creative Director', help: 'Lets the Creative Director turn the marketing plans into ad images and videos for your approval. It also needs "Run the AI team" on and the agent resumed on the AI team page. Off: creative you already approved is still handed over.' },
  { key: 'creative.daily_render_cap', group: 'creative', kind: 'number', input: 'number', default: 40, min: 0, max: 1000, unit: 'renders', env: null, valid: wholeNumber(0, 1000),
    label: 'Most renders a day', help: 'Images and videos started per Eastern day, across every server (0 to 1,000). 0 renders nothing.' },
  { key: 'creative.county_snapshots_per_week', group: 'creative', kind: 'number', input: 'number', default: 3, min: 0, max: 7, unit: 'images', env: null, valid: wholeNumber(0, 7),
    label: 'County snapshots a week', help: 'Images that each show one public Medicare or Census number for a county where your roster prospects are (0 to 7; 0 turns them off). Code prints the number and its source; you approve each image.' },
  { key: 'creative.video_provider', group: 'creative', kind: 'text', input: 'choice', default: 'internal', env: null,
    choices: [{ value: 'internal', label: 'Made by the Hub' }, { value: 'heygen', label: 'HeyGen presenter videos' }], valid: value => value === 'internal' || value === 'heygen',
    label: 'How videos are made', help: 'HeyGen presenter videos need HUB_HEYGEN_API_KEY in Railway and an avatar and voice in the product\'s brand kit; without them, videos are made by the Hub.' },
  { key: 'seo.search_console_sites', group: 'seo', kind: 'list', input: 'lines', default: [], env: 'HUB_SEARCH_CONSOLE_SITES', fromEnv: fromSites, valid: listOf(searchConsoleSite, 10),
    label: 'Search Console properties', help: 'One per line, exactly as Search Console names them: sc-domain:cmcarebase.com for a domain property, https://www.caremetricintel.com/ (with its final /) for an address prefix. At most 10.' },
  { key: 'analytics.intel_visitors', group: 'analytics', kind: 'flag', input: 'toggle', default: true, env: null,
    label: 'Read Intel website sessions', help: 'Adds anonymous public-site session counts to the Monday scorecard. Requires the native Intel measurement endpoint and the same HUB_VISITOR_METRICS_KEY on both services. Counts begin when collection starts; missing historical weeks stay unavailable.' },
  { key: 'analytics.google_carebase_property', group: 'analytics', kind: 'text', input: 'text', default: null, env: null, valid: matches(/^(properties\/)?\d{4,20}$/),
    label: 'CareBase Google Analytics property ID', help: 'The number in Google Analytics → Admin → Property details (for example 564318607). The Monday scorecard reads CareBase\'s weekly website visitors from it with the Search Console service account, which needs Viewer access in Google Analytics. Empty: CareBase visitors are not read.' },
  { key: 'analytics.google_intel_property', group: 'analytics', kind: 'text', input: 'text', default: null, env: null, valid: matches(/^(properties\/)?\d{4,20}$/),
    label: 'Intel Google Analytics property ID', help: 'Intel\'s property number in Google Analytics. Used for Intel\'s weekly website visitors only while Read Intel website sessions is off or not set up. Empty: Intel is read from its own measurement alone.' },
]);

const byKey = new Map(settingsCatalog.map(entry => [entry.key, entry]));
// Variables nothing reads any more and no setting replaces. HUB_BOOKING_URL: CareMetric offers no demos, calls or meetings (owner
// decision 2026-11-09), so no message carries a booking page. HUB_APOLLO_API_KEY: the Hub finds people and addresses itself (owner
// decision 2026-11-13).
export const retiredVariables = Object.freeze(['HUB_BULK_EMAIL_FROM', 'HUB_BOOKING_URL', 'HUB_APOLLO_API_KEY']);
const usable = (entry, value) => {
  if (value === null || value === undefined) return false;
  if (entry.kind === 'flag') return typeof value === 'boolean';
  return entry.valid ? entry.valid(value) : false;
};
const present = value => typeof value === 'string' && value.trim().length > 0;

/** The value a Railway variable gave, the way the server read it before settings, or undefined when it gives none the server can use. */
export function settingFromEnv(entry, env) {
  if (!entry.env) return undefined;
  const raw = env?.[entry.env];
  if (!present(raw)) return undefined;
  const value = entry.fromEnv(raw);
  return usable(entry, value) ? value : undefined;
}

/** A value from the Settings page, tidied (trimmed text, whole lines) and checked; null clears the setting. Throws 400 when unusable. */
export function settingInput(entry, value) {
  if (value === null) return null;
  let tidy = value;
  if (entry.kind === 'text' && typeof value === 'string') tidy = value.trim();
  if (entry.kind === 'list' && Array.isArray(value)) tidy = [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
  if ((entry.kind === 'text' && tidy === '') || (entry.kind === 'list' && Array.isArray(tidy) && tidy.length === 0)) return null;
  if (!usable(entry, tidy)) throw new HttpError(400, `${entry.label}: ${entry.help}`);
  return tidy;
}

const keyPattern = /^[a-z][a-z0-9_]{1,30}\.[a-z][a-z0-9_]{1,60}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export function hubSettings({
  pool = null, features = new Set(), env = process.env, refreshMs = 30_000, log = console,
  call = (operation, args = []) => transaction(pool, async client =>
    (await client.query(`select ${operation}(${args.map((_, index) => `$${index + 1}`).join(', ')}) as result`, args)).rows[0].result),
  session = (token, work) => withSession(pool, token, work),
}) {
  const declared = features?.has?.(settingsFeature) === true;
  // The values read from the database, or null until they have been read once (then the Railway variables are used, as before).
  let stored = null;
  let timer = null;

  function get(key) {
    const entry = byKey.get(key);
    if (!entry) throw new Error(`Unknown Hub setting ${key}.`);
    if (declared && stored !== null) return usable(entry, stored[key]) ? stored[key] : entry.default;
    const value = settingFromEnv(entry, env);
    return value === undefined ? entry.default : value;
  }

  // Copies the Railway values into settings nobody has set, once per process. It must succeed before the database's values replace
  // the variables: otherwise a copy that failed would let the still-empty settings turn everything back to its default.
  let copiedIn = false;
  async function copyIn() {
    if (copiedIn) return;
    const copies = {};
    const unusable = [];
    for (const entry of settingsCatalog) {
      const value = settingFromEnv(entry, env);
      if (value !== undefined) copies[entry.key] = { value, from: entry.env };
      else if (entry.env && present(env?.[entry.env])) unusable.push(entry);
    }
    const copied = Object.keys(copies).length ? await call('private.hub_settings_import', [copies]) : [];
    copiedIn = true;
    for (const entry of unusable) log.warn?.(`${entry.env} has a value the Hub cannot use, so it was not copied into "${entry.label}". Set it on the Settings page.`);
    if (Array.isArray(copied) && copied.length) log.info?.(`Hub settings: copied ${copied.length} Railway variable(s) into Settings: ${copied.map(key => byKey.get(key)?.env).join(', ')}.`);
    const leftover = settingsCatalog.map(entry => entry.env).filter(name => name && present(env?.[name]));
    if (leftover.length) log.info?.(`Hub settings: these Railway variables are no longer read and can be deleted: ${leftover.join(', ')}. Change them on the Settings page.`);
  }

  async function refresh() {
    if (!declared) return false;
    await copyIn();
    const values = await call('private.hub_settings_values');
    stored = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    return true;
  }

  /** Copies the Railway values in (once), reads the settings, and keeps reading them. Never throws: the variables apply until it works. */
  async function start() {
    for (const name of retiredVariables) if (present(env?.[name])) log.warn?.(`${name} is set but no longer used. Remove it from the service.`);
    if (!declared) {
      log.info?.('Hub settings: the Railway variables apply until supabase/migrations/20261109150000_hub_settings.sql is applied.');
      return;
    }
    try {
      // Every refresh copies the Railway values in first until that has worked, so a failure here is retried by the timer.
      await refresh();
    } catch {
      log.warn?.('Hub settings could not be read; the Railway variables apply until they can. It will retry.');
    }
    timer = setInterval(() => { refresh().catch(() => log.warn?.('Hub settings could not be refreshed; the last values apply. It will retry.')); }, refreshMs);
    timer.unref?.();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  /** The owner's view: every setting with its group, what it means, its value and where it came from. */
  async function list(token) {
    if (!declared) {
      // Before the migration, the page shows what the Railway variables give, read-only.
      await session(token, db => db.query('select hub.authorize_app_admin()'));
      return view(new Map(), false);
    }
    const rows = await session(token, async db => (await db.query('select hub.get_hub_settings() as result')).rows[0].result);
    return view(new Map((Array.isArray(rows) ? rows : []).map(row => [row.key, row])), true);
  }

  function view(rows, editable) {
    return {
      editable,
      groups: settingGroups.map(group => ({
        ...group,
        settings: settingsCatalog.filter(entry => entry.group === group.id).map(entry => {
          const row = rows.get(entry.key) ?? null;
          const fromEnv = settingFromEnv(entry, env);
          const value = editable ? (usable(entry, row?.value) ? row.value : null) : (fromEnv ?? null);
          return {
            key: entry.key, label: entry.label, help: entry.help, input: entry.input, default: entry.default,
            ...(entry.choices ? { choices: entry.choices } : {}), ...(entry.min !== undefined ? { min: entry.min, max: entry.max } : {}), ...(entry.unit ? { unit: entry.unit } : {}),
            value, effective: value ?? entry.default,
            source: value === null ? 'default' : editable ? (row?.importedFrom ? 'copied' : 'hub') : 'railway',
            variable: entry.env ?? null, variableSet: Boolean(entry.env) && present(env?.[entry.env]),
            changedAt: row?.changedAt ?? null,
          };
        }),
      })),
    };
  }

  /** Saves one setting (or clears it with null) and applies it on this server at once. Returns the owner's view. */
  async function save(token, input) {
    const keys = Object.keys(input ?? {});
    if (keys.length !== 3 || !['key', 'value', 'expectedChangedAt'].every(key => keys.includes(key))) throw new HttpError(400, 'Invalid setting.');
    if (!declared) throw new HttpError(409, 'Apply the Hub settings migration (20261109150000_hub_settings.sql) before changing settings here.');
    const entry = typeof input.key === 'string' && keyPattern.test(input.key) ? byKey.get(input.key) : null;
    if (!entry) throw new HttpError(404, 'Unknown setting.');
    if (typeof input.expectedChangedAt !== 'string' || !instant.test(input.expectedChangedAt)) throw new HttpError(400, 'Invalid setting version.');
    const value = settingInput(entry, input.value);
    await session(token, db => db.query('select hub.set_hub_setting($1, $2::jsonb, $3) as result', [entry.key, JSON.stringify(value), input.expectedChangedAt]));
    await refresh().catch(() => log.warn?.('The saved setting applies within a minute; it could not be read back at once.'));
    return list(token);
  }

  async function admin(token, input) {
    if (input?.action === 'list' && Object.keys(input).length === 1) return list(token);
    if (input?.action === 'save') { const { action: _action, ...rest } = input; return save(token, rest); }
    throw new HttpError(400, 'Invalid settings request.');
  }

  /** A function that reads one setting each time it is called, for services that take live values (server/live.mjs). */
  const reader = key => { get(key); return () => get(key); };

  return { declared, get, reader, refresh, start, stop, admin, list, save };
}
