# Settings

Everything the Hub uses that is **not a secret** is a setting you change in the Hub: **Administration → Settings**
(`/admin/settings`). Turn a feature on or off, or type an address, account id or limit, and press Save. The Hub server
reads settings every 30 seconds (and at once after you save), so a change applies within a minute with nothing to
redeploy. Every change is recorded in the audit trail.

Most **secrets** (API keys and signing keys) and the service's own wiring stay in Railway. Meta and LinkedIn have guided connection
cards under **Social media**: enter account details and masked tokens together, then **Save and check**. Their tokens are encrypted
in separate private storage and never returned by Settings. See [Social media](SOCIAL_MEDIA.md#secure-connection-storage-deployment-and-recovery)
for deployment and recovery. Integration setup on the Control center (`/admin`) shows credential presence only.

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
| Email | Email service (SendGrid or Amazon SES) | none: a setting from the start |
| Email | Growth email service | none: a setting from the start |
| Email | Amazon SES region | none: a setting from the start |
| Email | Amazon SES configuration set | none: a setting from the start |
| Email | Amazon SES events topic | none: a setting from the start |
| Text messages | Twilio Messaging Service SID | `HUB_TWILIO_MESSAGING_SERVICE_SID` |
| Text messages | Twilio sending number | `HUB_TWILIO_FROM_NUMBER` |
| Customer growth | Send growth email | `HUB_GROWTH_SEND_ENABLED` |
| Customer growth | Most cold emails a day | none: a setting from the start |
| Customer growth | Most people to email at one organization | none: a setting from the start (three, the contact included, until you save a number; [Customer growth](CUSTOMER_GROWTH.md#several-decision-makers-at-one-organization)) |
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
| Website analytics | CareBase Google Analytics property ID | none: a setting from the start |
| Website analytics | Intel Google Analytics property ID | none: a setting from the start |
| Creative | Turn on the Creative Director | none: a setting from the start |
| Creative | Most renders a day | none: a setting from the start |
| Creative | How videos are made | none: a setting from the start |
| Course distribution | Allow legacy opt-in distribution | `HUB_LEGACY_DISTRIBUTION_OPT_IN` |

Settings added with the AI workforce build-out (2026-11-13), all settings from the start and all off or empty until you choose
([AI_WORKFORCE_REVIEW_2026-11-13.md](AI_WORKFORCE_REVIEW_2026-11-13.md) has the order to turn them on):

| Settings group | Setting | What it does |
| --- | --- | --- |
| AI team | Tasks at once | How many agent tasks run side by side (default 3) |
| AI team | Days before an idle agent is flagged | When the morning brief names a quiet agent (default 3) |
| Customer growth | Find prospects from the Medicare roster; States to prospect in; Most roster agencies to look up a day | Prospecting from Intel's roster of home health agencies and hospices |
| Customer growth | Most web prospects to match a day | Agencies found on the web matched to their Medicare record, so each gets its own market report (default 40; needs the roster switch) |
| Customer growth | Follow up website leads by email | County report, contact and savings-model leads get a two-email follow-up, after your approval |
| Customer growth | Days before asking again | When a "not now" or a silent prospect is asked once more (at least 30) |
| Customer growth | Win-back and cancellation emails | The Account Manager proposes, for your approval, one email when a trial ends unpaid and one when a plan is set to cancel |
| Customer growth | Finding people's addresses; Most address checks a day | Named decision-makers from the CMS owners file, the NPI registry and their own websites; an address they publish, or one their mail server confirms; every address waits for your review until you hand "Named people's email addresses" over on the AI team page |
| Customer growth | Learn which agencies opened their report | Reads from Intel which market report links were opened (agency and time only), alerts you on an agency's first open, and shapes its second email ([Customer growth](CUSTOMER_GROWTH.md#which-agencies-opened-their-market-report)) |
| Customer growth | Write an account brief before the first email; Most account briefs a day; Most to spend on one account brief | A brief per Intel agency from Intel's data, its county's figures for its own setting and dated web triggers, written on the top model ([Customer growth](CUSTOMER_GROWTH.md#an-account-brief-before-the-first-email-written-and-reviewed-on-the-top-model)) |
| Customer growth | Write first emails on the top model; Have a reader review each first email | The first email written from the brief on the top model, and a second model's 1-to-5 review with one rewrite below 4 |
| Customer growth | Check an address before the first email | Off, Check or Strict: the business's mail server is asked whether a mailbox exists before the first cold email to it, and one that does not is never written to ([Customer growth](CUSTOMER_GROWTH.md#checking-an-address-before-the-first-email-and-the-bounce-guard)) |
| Customer growth | Pause cold email at this bounce rate | Cold email waits for you to resume it on Growth when the last seven days' cold emails bounce above this percent or one is marked as spam (empty: off) |
| Customer growth | Research prospects with web search; Most prospects to research a day; Most to spend researching one prospect | Deeper research within a cost ceiling |
| Customer growth | Write from what is working | Drafts use the weekly memo you approve on Growth, or each new memo at once after you hand "Learning memo" over on the AI team page |
| Creative | County snapshots a week | Images of one public number for a county your prospects are in (0 turns them off) |
| Social media | Post about new CMS data and observances | The weekly plan may write one post about a new release or an observance |
| Social media | Write posts for my LinkedIn profile; Posts for my profile a week | Posts in your voice, each approved by you until you hand "Founder posts" over on the AI team page |
| Paid ads | Most to spend on new campaigns a month | New LinkedIn, Meta and Google search campaigns are proposed only while it is set; after you hand "Ad campaign launch" over, the campaigns that start on their own share it and never pass it together |
| Paid ads | Meta retargeting audience; Meta Pixel (dataset) id; LinkedIn conversion rule id | Where new Meta campaigns aim and where leads are reported |
| Paid ads | Report leads to the ad platforms | Hashed-email lead reports to the platform whose ad was clicked |
| Paid ads | Google Ads customer id; Google Ads manager account id; Google Ads OAuth client id; Google Ads API version | The Google Ads API |
| Paid ads | Bid on competitor names | Competitor names as search keywords only, never in ad text |

`HUB_BULK_EMAIL_FROM` and `HUB_BOOKING_URL` are no longer used at all (CareMetric offers no demos, calls or meetings), nor is
`HUB_APOLLO_API_KEY` (the Hub finds people and their addresses itself); the Hub warns at start while any of them is set. Delete them.

## What stays in Railway

Secrets, which are never shown on screen or stored in the database:

- `ANTHROPIC_API_KEY`
- `HUB_TELNYX_API_KEY`
- `HUB_TWILIO_AUTH_TOKEN`, `HUB_TWILIO_ACCOUNT_SID`
- `HUB_SENDGRID_API_KEY`, `HUB_SENDGRID_INBOUND_PUBLIC_KEY`, `HUB_SENDGRID_EVENT_PUBLIC_KEY`
- `HUB_SES_ACCESS_KEY_ID`, `HUB_SES_SECRET_ACCESS_KEY` (Amazon SES sending key, [AMAZON_SES.md](AMAZON_SES.md))
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `HUB_GROWTH_SIGNING_KEY`, `HUB_GROWTH_SEARCH_API_KEY`, `HUB_GROWTH_CAREBASE_EVENT_KEY`, `HUB_GROWTH_INTEL_EVENT_KEY`
- `HUB_LEAD_SECRET_CAREBASE`, `HUB_LEAD_SECRET_INTEL`, `HUB_LEAD_SECRET_ADVISORS`
- `HUB_SOCIAL_CREDENTIALS_KEY` (server encryption key for the Meta and LinkedIn connection cards)
- `HUB_META_ACCESS_TOKEN` (legacy fallback until the Meta card is first saved)
- `HUB_LINKEDIN_ACCESS_TOKEN`, `HUB_LINKEDIN_REFRESH_TOKEN`, `HUB_LINKEDIN_CLIENT_SECRET`,
  `HUB_LINKEDIN_ADS_ACCESS_TOKEN`, `HUB_LINKEDIN_ADS_REFRESH_TOKEN`, `HUB_LINKEDIN_ADS_CLIENT_SECRET`
  (legacy fallbacks until the LinkedIn card is first saved)
- `HUB_SEARCH_CONSOLE_CREDENTIALS` (also reads Google Analytics for the Monday scorecard's website visitors, and signs in to
  Google Ads to create approved search campaigns once Settings → Paid ads → Google Ads customer id is set and the service
  account is a Standard user on that account or its manager)
- `HUB_VISITOR_METRICS_KEY` (dedicated shared key for Intel’s aggregate website session reports)
- `HUB_HEYGEN_API_KEY` (only for HeyGen presenter videos, Settings → Creative)
- `HUB_INTEL_FEED_SECRET` (Intel's marketing feed: the same value as Intel's `HUB_MARKETING_FEED_SECRET`)
- `HUB_GROWTH_IMPORT_SECRET` (signs prospect lists sent to `/api/growth/import`)
- `HUB_GOOGLE_ADS_CLIENT_SECRET`, `HUB_GOOGLE_ADS_REFRESH_TOKEN` (optional: only to sign in to Google Ads as a person instead
  of the service account). `HUB_GOOGLE_ADS_DEVELOPER_TOKEN` is optional too; Google stopped requiring developer tokens on
  September 9, 2026, and the Hub sends one only when it is set. Without any Google Ads sign-in, approved campaigns are
  emailed as an import file.
- Your personal LinkedIn token is not a Railway variable: save it on the LinkedIn connection card (Settings → Social media).
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

The Settings page renders the catalog, except the account and client IDs handled together by the guided social connection cards.
