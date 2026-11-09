import { HttpError, transaction, withSession } from './sms-auth.mjs';
import { validGrowthFromEmail, validGrowthFromName } from './growth/sender.mjs';
import { readProperties } from './agents/seo/search-console.mjs';

/**
 * The Hub's settings (supabase/migrations/20261109150000_hub_settings.sql): every switch and value that is not a secret, changed by
 * the owner on the Settings page (/admin/settings) instead of in Railway variables. Secrets (API keys, tokens, signing keys) and the
 * service's own wiring (the database URL, the port, the public origin) stay in Railway; docs/SETTINGS.md lists both.
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
  { id: 'email', label: 'Email', description: 'Who the Hub\'s email comes from and where answers go. Each sender must be verified in SendGrid.' },
  { id: 'sms', label: 'Text messages', description: 'The Twilio sender staff replies and owner alerts are texted from.' },
  { id: 'growth', label: 'Customer growth', description: 'Sending reviewed prospecting and follow-up email.' },
  { id: 'billing', label: 'Billing', description: 'What customers can buy themselves and how prices stay in step with Intel.' },
  { id: 'social', label: 'Social media', description: 'The Facebook Page, Instagram account, LinkedIn Page and ad accounts the Social Media Manager works on, and its ad limits. The access tokens stay in Railway.' },
  { id: 'creative', label: 'Creative', description: 'The Creative Director: whether it works, how many images and videos it starts a day, and how videos are made. HeyGen\'s key stays in Railway.' },
  { id: 'seo', label: 'Search', description: 'The Search Console properties the SEO Analyst and the Monday scorecard read. The service account key stays in Railway.' },
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
    label: 'Support sender', help: 'The address staff replies, alerts, customer email and bulk email come from. It must be verified in SendGrid.' },
  { key: 'email.reply_to', group: 'email', kind: 'text', input: 'email', default: null, env: 'HUB_SUPPORT_REPLY_TO', fromEnv: fromText, valid: isEmail,
    label: 'Reply-To', help: 'Where customers\' answers go: the address SendGrid Inbound Parse receives (for example support@inbound.caremetric.ai), so answers join the conversation. Empty: the sender itself.' },
  { key: 'email.postal_address', group: 'email', kind: 'text', input: 'text', default: null, env: 'HUB_BULK_EMAIL_POSTAL_ADDRESS', fromEnv: fromText, valid: oneLine(300),
    label: 'Mailing address in email footers', help: 'Required by CAN-SPAM in marketing and growth email. Bulk, growth and customer emails are not sent without it.' },
  { key: 'email.growth_from', group: 'email', kind: 'text', input: 'email', default: null, env: 'HUB_GROWTH_FROM_EMAIL', fromEnv: fromText, valid: validGrowthFromEmail,
    label: 'Growth email sender', help: 'Cold email and sales follow-ups only, on their own subdomain (for example hello@go.caremetric.ai) so prospecting never affects the support address. Authenticate it in SendGrid (SPF, DKIM), publish DMARC and warm it up first. Empty: the support sender.' },
  { key: 'email.growth_from_name', group: 'email', kind: 'text', input: 'text', default: null, env: 'HUB_GROWTH_FROM_NAME', fromEnv: fromText, valid: validGrowthFromName,
    label: 'Growth email display name', help: 'At most 64 characters, without quotes or angle brackets. Empty: "CareMetric".' },
  { key: 'sms.messaging_service_sid', group: 'sms', kind: 'text', input: 'text', default: null, env: 'HUB_TWILIO_MESSAGING_SERVICE_SID', fromEnv: fromText, valid: matches(/^MG[0-9a-f]{32}$/),
    label: 'Twilio Messaging Service SID', help: 'MG followed by 32 characters. Preferred over a single sending number.' },
  { key: 'sms.from_number', group: 'sms', kind: 'text', input: 'text', default: null, env: 'HUB_TWILIO_FROM_NUMBER', fromEnv: fromText, valid: matches(/^\+[1-9][0-9]{7,14}$/),
    label: 'Twilio sending number', help: 'In +1… form. Used only when no Messaging Service SID is set.' },
  { key: 'growth.send', group: 'growth', kind: 'flag', input: 'toggle', default: false, env: 'HUB_GROWTH_SEND_ENABLED', fromEnv: fromFlag,
    label: 'Send growth email', help: 'Master switch for sending reviewed prospecting and follow-up email. Off: messages are drafted and reviewed but never sent.' },
  { key: 'billing.customer_purchasing', group: 'billing', kind: 'flag', input: 'toggle', default: false, env: 'HUB_CUSTOMER_PURCHASING_ENABLED', fromEnv: fromFlag,
    label: 'Customers can buy subscriptions', help: 'Lets a customer administrator start a new subscription from the Hub. Existing subscriptions and payment methods work either way.' },
  { key: 'billing.intel_price_sync', group: 'billing', kind: 'flag', input: 'toggle', default: true, env: 'HUB_APP_CATALOG_SYNC', fromEnv: raw => raw.trim() !== 'off',
    label: 'Keep Stripe in step with Intel\'s prices', help: 'Every 15 minutes the Hub reads Intel\'s plan prices and updates Stripe, keeping current subscribers on their price.' },
  { key: 'billing.portal_configuration', group: 'billing', kind: 'text', input: 'text', default: null, env: 'STRIPE_PORTAL_CONFIGURATION_ID', fromEnv: fromText, valid: matches(/^bpc_[A-Za-z0-9]{1,200}$/),
    label: 'Stripe customer portal configuration', help: 'The portal configuration customers see (bpc_…). Empty: the Stripe account\'s default.' },
  { key: 'learning.legacy_distribution_opt_in', group: 'learning', kind: 'flag', input: 'toggle', default: false, env: 'HUB_LEGACY_DISTRIBUTION_OPT_IN', fromEnv: fromFlag,
    label: 'Allow legacy opt-in distribution', help: 'Lets a course distribution use the older opt-in mode for facilities that have not moved to entitlements. Leave off unless you were told to use it.' },
  { key: 'social.meta_page_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_META_PAGE_ID', fromEnv: fromText, valid: matches(/^[0-9]{1,40}$/),
    label: 'Facebook Page id', help: 'Your Facebook Page\'s numeric id. The Meta access token stays in Railway.' },
  { key: 'social.instagram_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_META_INSTAGRAM_ID', fromEnv: fromText, valid: matches(/^[0-9]{1,40}$/),
    label: 'Instagram account id', help: 'The numeric id of the Instagram professional account linked to the Page. Empty: Instagram is left out.' },
  { key: 'social.meta_ad_account_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_META_AD_ACCOUNT_ID', fromEnv: fromText, valid: matches(/^(act_)?[0-9]{1,40}$/),
    label: 'Meta ad account id', help: 'act_ followed by digits, or the digits. Empty: Meta ads are left out.' },
  { key: 'social.meta_graph_version', group: 'social', kind: 'text', input: 'text', default: 'v23.0', env: 'HUB_META_GRAPH_VERSION', fromEnv: fromText, valid: matches(/^v\d{1,2}\.\d$/),
    label: 'Meta Graph API version', help: 'Change it only when Meta retires the current one.' },
  { key: 'social.linkedin_organization_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_LINKEDIN_ORGANIZATION_ID', fromEnv: fromText, valid: matches(/^(urn:li:organization:)?\d{1,30}$/),
    label: 'LinkedIn Company Page id', help: 'The numeric organization id (the digits in the Page\'s admin address). The LinkedIn tokens stay in Railway.' },
  { key: 'social.linkedin_ad_account_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_LINKEDIN_AD_ACCOUNT_ID', fromEnv: fromText, valid: matches(/^(urn:li:sponsoredAccount:)?\d{1,30}$/),
    label: 'LinkedIn ad account id', help: 'The numeric id from Campaign Manager. Empty: LinkedIn ads are left out.' },
  { key: 'social.linkedin_client_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_LINKEDIN_CLIENT_ID', fromEnv: fromText, valid: matches(/^[A-Za-z0-9_-]{4,100}$/),
    label: 'LinkedIn app client id', help: 'Used only to renew the Page access token by itself, with the refresh token and client secret in Railway.' },
  { key: 'social.linkedin_ads_client_id', group: 'social', kind: 'text', input: 'text', default: null, env: 'HUB_LINKEDIN_ADS_CLIENT_ID', fromEnv: fromText, valid: matches(/^[A-Za-z0-9_-]{4,100}$/),
    label: 'LinkedIn advertising app client id', help: 'Only when ads use a second LinkedIn app. Empty: the Page app\'s client id.' },
  { key: 'social.linkedin_api_version', group: 'social', kind: 'text', input: 'text', default: '202609', env: 'HUB_LINKEDIN_API_VERSION', fromEnv: fromText, valid: matches(/^20\d{4}$/),
    label: 'LinkedIn API version', help: 'YYYYMM. Change it only when LinkedIn retires the current one.' },
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
  { key: 'creative.video_provider', group: 'creative', kind: 'text', input: 'choice', default: 'internal', env: null,
    choices: [{ value: 'internal', label: 'Made by the Hub' }, { value: 'heygen', label: 'HeyGen presenter videos' }], valid: value => value === 'internal' || value === 'heygen',
    label: 'How videos are made', help: 'HeyGen presenter videos need HUB_HEYGEN_API_KEY in Railway and an avatar and voice in the product\'s brand kit; without them, videos are made by the Hub.' },
  { key: 'seo.search_console_sites', group: 'seo', kind: 'list', input: 'lines', default: [], env: 'HUB_SEARCH_CONSOLE_SITES', fromEnv: fromSites, valid: listOf(searchConsoleSite, 10),
    label: 'Search Console properties', help: 'One per line, exactly as Search Console names them: sc-domain:cmcarebase.com for a domain property, https://www.caremetricintel.com/ (with its final /) for an address prefix. At most 10.' },
]);

const byKey = new Map(settingsCatalog.map(entry => [entry.key, entry]));
// Variables nothing reads any more and no setting replaces. HUB_BOOKING_URL: CareMetric offers no demos, calls or meetings (owner
// decision 2026-11-09), so no message carries a booking page.
export const retiredVariables = Object.freeze(['HUB_BULK_EMAIL_FROM', 'HUB_BOOKING_URL']);
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
