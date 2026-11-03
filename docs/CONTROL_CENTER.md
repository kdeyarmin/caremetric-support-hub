# Control center

`/admin` is the platform administrator's home: every application, customer
channel and Hub service on one page, read live when the page opens, with a link
into the workspace that manages each thing. Nothing on it is estimated. A read
that failed, or that an application's connection never advertised, is shown as
unavailable or not provided; a silent application never contributes a zero.

The per-application workspace (organizations, users, billing, courses, facility
training, jobs, releases, audit) now lives at `/admin/apps?product=<id>`. Links
that still carry the old `/admin?product=…&view=…` query redirect there.

## What it shows and where it comes from

| Block | Read from | Opens |
| --- | --- | --- |
| Portfolio at a glance | The application connections, the inbox counts and the Hub's own case records | — |
| Customer channels | `GET /api/communications/channels` plus one bounded `communications/list` read per channel (`status: active`, one row) for its waiting count | `/communications?channel=<phone\|sms\|email\|chat\|web_form>` |
| Hub services | The AI go-live readiness report, `hub.list_phone_numbers()` and `hub.get_support_readiness()` | `/admin/go-live-readiness`, `/phone-numbers`, `/integration` |
| AI usage | `hub.get_ai_usage_summary(p_days)` (see below) | — |
| Integration setup | `POST /api/admin/integration-setup` (see below) | Setup steps in this repository's docs |
| Applications | Each connection's `capabilities`, `overview` and `billing.overview` reads (as the portfolio rollup), the Hub's support cases and published articles, one `communications/list` read per application, the support readiness summary and the AI usage summary | `/admin/apps?product=<id>&view=<organizations\|users\|billing\|inquiries>`, `/communications?product=<slug>`, `/cases?product=<slug>`, `/knowledge?product=<slug>`, `/integration` |

Every block loads independently, so one unavailable connection or service never
hides the others. **Refresh everything** re-reads all of them.

The Communications inbox, the support case queue and the knowledge catalog
accept `product=<slug>` (repository names such as `pennfit` are accepted too);
the inbox also accepts `channel=` and `status=`. The inbox and these pages open
already filtered when a control-center link carries those values.

## AI usage by application and by customer

Every Anthropic call the Hub makes — staff summaries, reply drafts, triage
suggestions, automated resolution attempts, escalation summaries and customer
reply classification — is recorded in `private.ai_usage` with its feature,
model, outcome, token counts and latency. The row is attributed through the
support case it served to the application and the customer tenant; the database
resolves both from the case id so the server never asserts them. Prompt and
reply content are never stored. The AI team's agents write to the same ledger
(actor `automation`, feature `agent_<agent key>`); their calls belong to no
support case, so they are counted as unattributed and labelled by feature. See
[AI_TEAM.md](AI_TEAM.md), "The model runtime".

- Recording runs through `private.record_ai_usage(...)`, executable only by the
  Hub server role (`hub_app_server`), after the call completes or fails. A ledger
  failure is logged by feature only and never delays or fails the AI action.
- `hub.get_ai_usage_summary(p_days)` returns totals, every current application
  (zero when nothing was recorded for it), each application's customers with
  their calls and tokens, and calls by feature. It requires the current platform
  administrator session (`hub.authorize_app_admin()`).
- The control center shows the last 7, 30 or 90 days and each application card
  shows its calls for the chosen period. Calls that could not be attributed to an
  application are counted separately.

Release: apply `20261021120000_ai_usage_ledger.sql` and
`20261021120100_ai_usage_ledger_contract.sql` before deploying this Hub
version. Connected builds require the `support.ai-usage.v1` contract feature.
The ledger starts empty; calls made before the migration were only logged.

## Integration setup

The Hub's integrations are configured with variables on the Hub service
(Railway → the Hub service → Variables). The control center lists, for each
integration, the exact variable names, what each one does, whether it is set,
and a link to the setup steps:

| Integration | Variables |
| --- | --- |
| AI assistance (Anthropic) | `ANTHROPIC_API_KEY`, `HUB_AI_AUTOMATION_ENABLED`, `HUB_AI_DRAFT_TIER`, `HUB_AI_FOLLOW_UP_DELAY_HOURS` |
| Text messages (Twilio) | `HUB_TWILIO_AUTH_TOKEN`, `HUB_TWILIO_ACCOUNT_SID`, `HUB_TWILIO_MESSAGING_SERVICE_SID`, `HUB_TWILIO_FROM_NUMBER` |
| Email (SendGrid) | `HUB_SENDGRID_INBOUND_PUBLIC_KEY`, `HUB_SENDGRID_API_KEY`, `HUB_SUPPORT_FROM_EMAIL` |
| Website chat | `HUB_CHAT_ENABLED` |
| Webhook origin | `HUB_PUBLIC_ORIGIN` |
| SMS sign-in (Telnyx) | `HUB_TELNYX_API_KEY`, `HUB_TELNYX_VERIFY_PROFILE_ID` |
| Website leads ([LEAD_INTAKE.md](LEAD_INTAKE.md)) | `HUB_LEAD_SECRET_CAREBASE`, `HUB_LEAD_SECRET_INTEL`, `HUB_LEAD_SECRET_ADVISORS` |
| CareBase course distribution observer | `CAREBASE_DISTRIBUTION_OBSERVER_TOKEN` |

A flag such as `HUB_CHAT_ENABLED` satisfies its integration only when it is exactly
`true`, the same test the Hub service applies; a present but false flag shows its
value and leaves the integration at **Needs setup**. A secret is reported as **set** or **missing** only. The server returns a boolean
for it, and the browser client's schema refuses any value sent for a secret, so
no part of a secret can reach the browser through this panel. Non-secret
settings (a flag, an address, a tier, an identifier) are shown so they can be
confirmed. The panel reports; it never writes. To add or change a secret, set
the variable on the Hub service and let it redeploy, then refresh the page.

Secret values are deliberately not entered through the Hub. Doing so would move
provider credentials into the application database or require the Hub to hold a
deployment-platform token; both widen the security boundary that
[SECURITY.md](../SECURITY.md) and the go-live readiness panel (presence only)
keep closed today.

## Verification

- `src/admin/controlCenter.test.ts` and `src/admin/ControlCenter.test.tsx`
  cover the model, the page, the deep links and the unavailable states.
- `server/ai-usage.test.mjs` and the ledger test in
  `server/ai-assistance.test.mjs` cover recording, failure isolation and the
  absence of content.
- `server/integration-setup.test.mjs` proves secrets contribute a boolean only
  and that the report is administrator-only.
- `supabase/tests/030_ai_usage.test.sql` proves the ledger is closed to every
  browser, service and server role, that only the Hub server records usage, and
  that the summary requires the current administrator session.
