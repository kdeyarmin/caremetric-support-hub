# Unified communications

Every customer-service and technical-support inquiry for every CareMetric
application lands in one Hub queue: **Communications** (`/communications`),
whichever channel it arrives on. Staff triage it by application, type, status
and assignee, keep internal notes, and reply on the original channel. The Hub is
the system of record; providers only carry messages.

| Channel | How it reaches the Hub | Default |
| --- | --- | --- |
| Phone, (877) 521-2890 | Breathe's AI phone assistant answers and records the message. The platform administrator imports new messages with **Import phone-line messages**. | Available after deploy |
| Text message | Twilio posts inbound texts to `POST /api/channels/sms/twilio`, verified with `X-Twilio-Signature`. | Off until configured |
| Email | SendGrid Inbound Parse posts mail to `POST /api/channels/email/inbound` as a signed webhook. | Off until configured |
| Website chat | A chat panel on every Help page (`/help`, `/help?product=<app>`). | Off until enabled |
| Website forms (CareBase, Intel, Advisors) | Each website forwards a lead that asked to be contacted (a demo request, consultation or contact request) to the signed `POST /api/leads`; see [LEAD_INTAKE.md](LEAD_INTAKE.md). The conversation's source is `carebase.web`, `intel.web` or `advisors.web`, shown as "CareBase website", "Intel website" or "Advisors website". | Off for a product until its `HUB_LEAD_SECRET_*` is set |
| Advisors web form (import) | The platform administrator imports caremetricadvisors.com consultation requests with **Import Advisors requests**. A request that already arrived as a lead is skipped, and a lead for a request already imported is linked to it: both use `advisors.web` and the `CM-` reference. | Available once the Advisors bridge is deployed |

The channel strip at the top of the inbox shows which channels are live.

## Which application an inquiry belongs to

- **Email:** `support+<app>@` routes to that application, for example
  `support+pennfit@caremetric.ai` (Breathe) or `support+advisors@caremetric.ai`.
  Repository names are accepted: PennTrain → CareBase, PennFit → Breathe,
  CareMetric-Pennsync → PennSync, Intel → CareMetric Intel.
- **Chat:** the application the visitor's Help page was opened for.
- **Phone line:** the application the AI assistant recorded.
- **Advisors form:** Healthcare Advisors.
- **Website leads:** the product that forwarded the lead (CareBase, CareMetric Intel or Healthcare Advisors).
- Anything else arrives with **Application not set**. Only staff with
  portfolio-wide permission (or the platform administrator) see those until
  someone sets the application; staff scoped to one application see only theirs.

## Replies

A reply goes back on the original channel: text to text, email to email, chat
to chat. Phone and web-form inquiries are answered by email when an address was
left (every website lead has one), otherwise by text. If neither exists, call back and record a note.

Each reply and note is written to the database under a request key **before**
a reply is sent. A key is bound to the exact text it first carried: retrying the
same text never records or sends twice, and the database refuses the key with
different text. If an attempt's outcome is unknown and staff then edit the text,
the inbox asks them to restore the original text (a safe retry) or to send the
edit explicitly as a new message. If the provider's answer is lost, the message
shows "Send outcome unknown — confirm with the customer before resending"
instead of being resent automatically. Replies are refused when the channel's
provider is not configured.

Outbound email subjects carry exactly one `[CM-<reference>]`, at the end: any
other reference in the customer's subject is removed. A reply to an imported
phone-line message is titled "Your phone message to CareMetric", because the
conversation's own title ("Billing call from Jordan Rivera") is written for staff.
Inbound mail is threaded by the last reference in its subject. A customer's reply joins the same
conversation only when it comes from the address on that conversation; anything
else starts a new one.

Chat replies appear only in the chat panel. They are not emailed, so the panel
tells visitors to keep the page open or return to Help in the same browser.

## Data boundary

- Conversations live in `private.communications` and
  `private.communication_messages`, with row level security and no direct grants
  to any browser or server role. Every read and write goes through reviewed
  functions: staff functions require a verified SMS session plus `case.read` or
  `case.write` for the application; webhook and chat functions are executable
  only by the Hub server role.
- Inbound text is untrusted and stored as `possible_phi`. Chat requires the same
  no-patient-information acknowledgment as the support form; text and email
  cannot enforce it, so staff treat every message as possibly containing PHI.
- The AI team's Support Concierge notices new conversations without any staff
  session, through three operations only the Hub server role can run. It reads
  a minimal view (no contact details, no internal notes, the subject only for
  email) and uses it to alert the owner; it never writes to a conversation and
  keeps no message text. Only when the owner has switched on drafted answers does
  it send a plain question's scrubbed text to the model, never a message with
  identifiers or one the owner answers personally (AI_TEAM.md, "Drafted answers"). The fixed replies it offers are sent only after the owner approves each one,
  through the staff reply above with the owner's own session. See [AI_TEAM.md](AI_TEAM.md), "The
  Support Concierge".
- Attachments are never stored. The message records how many were dropped.
- Message text never enters logs, error responses or audit metadata. Audit
  events record only the action, the changed field names, and identifiers.
- Chat visitors hold only an opaque token in an `HttpOnly`, `SameSite=Strict`
  cookie. They see their own messages and staff replies, never internal notes.
  Abuse limits: three new chats per visitor per hour, 300 per hour overall, and
  bounded message rates per visitor and per conversation.
- Retention: website-lead conversations (the Advisors, CareBase and Intel
  website sources `advisors.web`, `carebase.web` and `intel.web`, Advisors
  imports included) are deleted, with their messages, twelve months after
  their last message ([LEAD_INTAKE.md](LEAD_INTAKE.md), "Retention"). Retention
  for every other channel is still not automated: decide a retention period
  before enabling text, email or chat for production traffic.

## Before enabling text, email or chat

The High Compliance controls in [SECURITY.md](../SECURITY.md) and the owner
steps in [PRODUCTION_ROLLOUT.md](PRODUCTION_ROLLOUT.md) still apply: confirm the
BAAs cover Twilio and SendGrid, and verify the Supabase HIPAA controls before
accepting messages that may contain PHI.

### Text messages (Twilio)

1. In Railway, set `HUB_TWILIO_AUTH_TOKEN` (inbound signature check) and, for
   replies, `HUB_TWILIO_ACCOUNT_SID`. Then in Settings → Text messages enter the
   Twilio Messaging Service SID (preferred) or the sending number. `HUB_PUBLIC_ORIGIN` must match the
   exact origin Twilio calls (default
   `https://support-hub-web-production.up.railway.app`). The support number
   belongs to the "CareMetric AI" Messaging Service
   (`MGe4ff7c94d59f2728b463656302ce611e`).
2. In Twilio, set the incoming-message webhook of the "CareMetric AI"
   Messaging Service to `<HUB_PUBLIC_ORIGIN>/api/channels/sms/twilio`
   (HTTP POST). The service routes inbound texts itself instead of deferring
   to the number, so the number's own webhook field has no effect. Set
   `HUB_TWILIO_AUTH_TOKEN` and let the Hub redeploy first, or every text is
   refused. **Today the service's webhook points at Breathe**
   (`cmbreathe.com/resupply-api/sms/caremetric-inbound`, see the phone
   registry), which answers each text with a fixed reply pointing to the phone
   line and Help. Moving it replaces that reply, so decide which system answers
   texts first, or use a dedicated support texting number.
3. The support number's toll-free verification was approved on October 28,
   2026 for one use only: a single optional informational text that a caller
   asks for during a call, with verbal consent, no recurring messages and no
   patient details. Customers texting in and staff replying by text fall
   outside it. Before moving the webhook or replying by text from this number,
   have the verification updated to cover two-way customer-care texting, or
   verify a dedicated support texting number for it; carriers may filter
   messages that don't match the approved use. The phone registry still lists
   the number's texting as pending; update it once this is decided.

### Email (SendGrid)

1. Point MX records for a receiving domain (a subdomain such as
   `inbound.caremetric.ai` avoids disturbing other mail) to `mx.sendgrid.net`,
   or forward `support@caremetric.ai` there.
2. In SendGrid Inbound Parse, add the host with the URL
   `<HUB_PUBLIC_ORIGIN>/api/channels/email/inbound`, parsed mode, and enable
   signed webhooks. Set `HUB_SENDGRID_INBOUND_PUBLIC_KEY` to the verification
   key. Unsigned or stale (older than ten minutes) posts are refused.
3. For replies, authenticate the sending domain in SendGrid and set
   `HUB_SENDGRID_API_KEY` (Mail Send only). The support sender (Settings →
   Email) defaults to `support@caremetric.ai`.
4. If Inbound Parse receives on a different address (for example
   `support@inbound.caremetric.ai`), enter it as the Reply-To in Settings → Email. Staff
   replies, the AI team's customer emails and bulk email then carry it as
   Reply-To, so customers' answers join the conversation (and a reply still
   stops a growth sequence). Settings refuses a value that is not an email
   address; without one, answers go to the sender itself.

### Amazon SES

Outbound email can go through Amazon SES instead of SendGrid: **Settings → Email → Email service**. Replies, alerts,
customer and bulk email follow this choice. Growth uses its own setting. Inbound email arrives through SendGrid Inbound Parse. See
[Amazon SES](AMAZON_SES.md).

### One address

Every email the Hub sends comes from **support@caremetric.ai** (the support sender in Settings → Email) and
replies to it (or to the Reply-To set there): staff replies, the AI team's alerts and
external emails, customer lifecycle emails and bulk email.
The one exception is growth email (cold email and sales follow-ups): when the growth email sender
is set (Settings → Email) it comes from that address, on its own subdomain, and still replies to the support inbox
(see [Customer growth](CUSTOMER_GROWTH.md#a-separate-sender-for-prospecting)). Unset, growth
email comes from the support address too. The email footers name the same address, in
every theme.

It receives replies: `caremetric.ai`'s MX record is `mx.sendgrid.net`, so every address on the
domain is delivered to SendGrid Inbound Parse and from there to Communications. Audit of
2026-11-08: SendGrid domain authentication (DKIM `s1`/`s2`) for `caremetric.ai` is in the same
SendGrid account as `cmcarebase.com`; answers from CMS to two emails the AI team sent from the
address arrived in Communications. At that audit no support sender or Reply-To was configured, so
production used the default.

The applications' own emails are configured in each application: CareBase's
(`NOTIFICATION_FROM_EMAIL`, a CareBase Supabase function secret) and Intel's
(`SENDGRID_FROM_EMAIL`, on Intel's Railway service, sending through a different SendGrid account
that authenticates only `caremetricintel.com`). Replies to an address on `cmcarebase.com` or
`caremetricintel.com` go to those domains' own mail hosts, not to Communications.

### Chat

Switch on **Website chat** in Settings → Customer support. Until then the Help page offers the phone number,
email and support form instead.

## Imports

**Import phone-line messages** and **Import Advisors requests** read up to 200
messages (four pages, in the order the source returns them) through the
application's administration connection with the platform administrator's
current SMS session, and add each source message once. When more remain, an
**Import the next … batch** button continues from where the last import stopped
(up to the applications' 10,000-record paging limit).
Re-importing never changes a conversation staff have already worked. Imports
are manual because every application read requires a live administrator
session; there is no unattended background sync. The AI team keeps the same
rule: its two import tasks (see [AI_TEAM.md](AI_TEAM.md), "Work that needs the
owner's session") wait until the administrator presses **Run what's waiting**
on the AI team screen, then call this same import with that session, at most
600 messages per run.

## Deployment

Apply `20261020163000_unified_communications.sql` and its gate
`20261020163100_unified_communications_contract.sql`, which declares
`support.communications.v1`. The gate refuses to declare the feature if any
communication table loses row level security or gains a direct grant, or if a
webhook or chat function becomes executable by a browser role.

`20261103120000_lead_desk.sql` adds `carebase.web` and `intel.web` to the conversation sources (the chat check is
unchanged), and its gate `20261103120100_lead_desk_contract.sql` declares `support.leads.v1` only while the
conversation table accepts both. Lead conversations are written by `private.lead_intake`, the Hub server's alone; the
visitor's message is stored only as the conversation's inbound message, never on the lead or in audit metadata.

`20261021130000_communication_reply_channel.sql` makes a started reply also
return the conversation's channel, which the phone-message subject above needs.
It is additive: a Hub deployed before it is applied keeps the stored subject.
