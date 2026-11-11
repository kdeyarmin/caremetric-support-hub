# Settings

Everything the Hub uses that is **not a secret** is a setting you change in the Hub: **Administration → Settings**
(`/admin/settings`). Turn a feature on or off, or type an address, account id or limit, and press Save. The Hub server
reads settings every 30 seconds (and at once after you save), so a change applies within a minute with nothing to
redeploy. Every change is recorded in the audit trail.

Only **secrets** (API keys, tokens and signing keys) and the service's own wiring stay in Railway. Integration setup on
the Control center (`/admin`) shows which of those are set, by presence only.

## Moving off the Railway variables

1. Apply `supabase/migrations/20261109150000_hub_settings.sql`, then
   `supabase/migrations/20261109150100_hub_settings_contract.sql`.
2. Deploy. On its first start the Hub copies the value of every Railway variable a setting replaced into that setting,
   once, and only into settings nobody has saved yet. The deploy log lists what was copied, any value it could not use
   (for example an owner email that is not an address), and every variable that can now be deleted.
3. Open Settings and check the values. A copied value says "Copied in from the Railway variable …".
4. Delete the variables the log listed from the Hub service in Railway. The Settings page also says, beside each
   setting, when its old variable is still set ("… is still set in Railway but is no longer read: you can delete it").

Until the migration is applied, the Hub keeps reading the Railway variables exactly as before and the Settings page is
read-only, so the server can be deployed first. After the copy, a variable is never read again: changing it in Railway
does nothing. A setting you saved, or cleared back to its default, is never overwritten by a later copy.

## Settings and the variables they replaced

| Settings group | Setting | Replaced |
| --- | --- | --- |
| AI team | Run the AI team | `HUB_AGENTS_ENABLED` |
| AI team | Let agents send customer messages to the AI | `HUB_AGENTS_CUSTOMER_TEXT_TO_AI` |
| AI team | Your email for alerts and the morning brief | `HUB_OWNER_EMAIL` |
| Customer support | Website chat | `HUB_CHAT_ENABLED` |
| Customer support | AI answers on new support cases | `HUB_AI_AUTOMATION_ENABLED` |
| Customer support | AI answer quality | `HUB_AI_DRAFT_TIER` |
| Customer support | Follow up after (hours) | `HUB_AI_FOLLOW_UP_DELAY_HOURS` |
| Email | Support sender | `HUB_SUPPORT_FROM_EMAIL` |
| Email | Reply-To | `HUB_SUPPORT_REPLY_TO` |
| Email | Mailing address in email footers | `HUB_BULK_EMAIL_POSTAL_ADDRESS` |
| Email | Growth email sender | `HUB_GROWTH_FROM_EMAIL` |
| Email | Growth email display name | `HUB_GROWTH_FROM_NAME` |
| Text messages | Twilio Messaging Service SID | `HUB_TWILIO_MESSAGING_SERVICE_SID` |
| Text messages | Twilio sending number | `HUB_TWILIO_FROM_NUMBER` |
| Customer growth | Send growth email | `HUB_GROWTH_SEND_ENABLED` |
| Billing | Customers can buy subscriptions | `HUB_CUSTOMER_PURCHASING_ENABLED` |
| Billing | Keep Stripe in step with Intel's prices | `HUB_APP_CATALOG_SYNC` (`off` meant switched off) |
| Billing | Stripe customer portal configuration | `STRIPE_PORTAL_CONFIGURATION_ID` |
| Social media | Facebook Page id | `HUB_META_PAGE_ID` |
| Social media | Instagram account id | `HUB_META_INSTAGRAM_ID` |
| Social media | Meta ad account id | `HUB_META_AD_ACCOUNT_ID` |
| Social media | Meta Graph API version | `HUB_META_GRAPH_VERSION` |
| Social media | LinkedIn Company Page id | `HUB_LINKEDIN_ORGANIZATION_ID` |
| Social media | LinkedIn ad account id | `HUB_LINKEDIN_AD_ACCOUNT_ID` |
| Social media | LinkedIn app client id | `HUB_LINKEDIN_CLIENT_ID` |
| Social media | LinkedIn advertising app client id | `HUB_LINKEDIN_ADS_CLIENT_ID` |
| Social media | LinkedIn API version | `HUB_LINKEDIN_API_VERSION` |
| Social media | Approved brand images (one per line) | `HUB_SOCIAL_IMAGE_URLS` |
| Social media | Target cost per lead or sign-up (dollars) | `HUB_SOCIAL_TARGET_COST_PER_RESULT_CENTS` |
| Social media | Most any ad may spend per day (dollars) | `HUB_SOCIAL_AD_MAX_DAILY_BUDGET_CENTS` |
| Search | Search Console properties (one per line) | `HUB_SEARCH_CONSOLE_SITES` |
| Website analytics | Read Intel website sessions | none: a setting from the start |
| Creative | Turn on the Creative Director | none: a setting from the start |
| Creative | Most renders a day | none: a setting from the start |
| Creative | How videos are made | none: a setting from the start |
| Course distribution | Allow legacy opt-in distribution | `HUB_LEGACY_DISTRIBUTION_OPT_IN` |

`HUB_BULK_EMAIL_FROM` and `HUB_BOOKING_URL` are no longer used at all (CareMetric offers no demos, calls or meetings); the
Hub warns at start while either is set. Delete them.

## What stays in Railway

Secrets, which are never shown on screen or stored in the database:

- `ANTHROPIC_API_KEY`
- `HUB_TELNYX_API_KEY`
- `HUB_TWILIO_AUTH_TOKEN`, `HUB_TWILIO_ACCOUNT_SID`
- `HUB_SENDGRID_API_KEY`, `HUB_SENDGRID_INBOUND_PUBLIC_KEY`, `HUB_SENDGRID_EVENT_PUBLIC_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `HUB_GROWTH_SIGNING_KEY`, `HUB_GROWTH_SEARCH_API_KEY`, `HUB_GROWTH_CAREBASE_EVENT_KEY`, `HUB_GROWTH_INTEL_EVENT_KEY`
- `HUB_LEAD_SECRET_CAREBASE`, `HUB_LEAD_SECRET_INTEL`, `HUB_LEAD_SECRET_ADVISORS`
- `HUB_META_ACCESS_TOKEN`
- `HUB_LINKEDIN_ACCESS_TOKEN`, `HUB_LINKEDIN_REFRESH_TOKEN`, `HUB_LINKEDIN_CLIENT_SECRET`,
  `HUB_LINKEDIN_ADS_ACCESS_TOKEN`, `HUB_LINKEDIN_ADS_REFRESH_TOKEN`, `HUB_LINKEDIN_ADS_CLIENT_SECRET`
- `HUB_SEARCH_CONSOLE_CREDENTIALS`
- `HUB_VISITOR_METRICS_KEY` (dedicated shared key for Intel’s aggregate website session reports)
- `HUB_HEYGEN_API_KEY` (only for HeyGen presenter videos, Settings → Creative)
- `CAREBASE_DISTRIBUTION_OBSERVER_TOKEN`

The service's wiring, which has to be right before the Hub can start or sign you in:

- `HUB_DATABASE_URL`, `HUB_DATABASE_CA_PEM` and `PORT`
- `HUB_TELNYX_VERIFY_PROFILE_ID`: the sign-in codes depend on it, so a wrong value saved in the Hub could lock you out of
  the page you would fix it on.
- `HUB_PUBLIC_ORIGIN` (optional): must match the webhook addresses Twilio and SendGrid hold.
- `HUB_MEDIA_IMPORT_HOSTS` (optional): the hosts bulk lesson-video import may fetch from.
- `INTEL_CATALOG_URL` (optional, staging only): reads another Intel's price catalog.
- The `VITE_*` build arguments, which are compiled into the web app.

## For developers

Do not add a Railway variable for anything that is not a secret. Add a setting:

1. A row in a new migration: `insert into private.hub_settings (key, kind) values ('<group>.<name>', '<flag|text|number|list>')`.
   A setting that never was a Railway variable has `env: null` in the catalog (the Creative Director's are).
2. An entry in `settingsCatalog` in `server/hub-settings.mjs`: its group, label, help text, input, default and the test
   a value must pass. `server/hub-settings.test.mjs` keeps the catalog and the migrations' rows equal.
3. Pass `settings.reader('<key>')` (or `() => settings.get('<key>')`) from `server/main.mjs` to the service, and read it
   with `live(value)` (`server/live.mjs`) each time it is used, so a change applies without a restart.

The Settings page renders whatever the server's catalog lists, so it needs no change.
