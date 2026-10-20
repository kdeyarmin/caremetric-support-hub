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
| Advisors web form | The platform administrator imports caremetricadvisors.com consultation requests with **Import Advisors requests**. | Available once the Advisors bridge is deployed |

The channel strip at the top of the inbox shows which channels are live.

## Which application an inquiry belongs to

- **Email:** `support+<app>@` routes to that application, for example
  `support+pennfit@caremetric.ai` (Breathe) or `support+advisors@caremetric.ai`.
  Repository names are accepted: PennTrain → CareBase, PennFit → Breathe,
  CareMetric-Pennsync → PennSync, Intel → CareMetric Intel.
- **Chat:** the application the visitor's Help page was opened for.
- **Phone line:** the application the AI assistant recorded.
- **Advisors form:** Healthcare Advisors.
- Anything else arrives with **Application not set**. Only staff with
  portfolio-wide permission (or the platform administrator) see those until
  someone sets the application; staff scoped to one application see only theirs.

## Replies

A reply goes back on the original channel: text to text, email to email, chat
to chat. Phone and web-form inquiries are answered by email when an address was
left, otherwise by text. If neither exists, call back and record a note.

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
other reference in the customer's subject is removed. Inbound mail is threaded
by the last reference in its subject. A customer's reply joins the same
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
- Attachments are never stored. The message records how many were dropped.
- Message text never enters logs, error responses or audit metadata. Audit
  events record only the action, the changed field names, and identifiers.
- Chat visitors hold only an opaque token in an `HttpOnly`, `SameSite=Strict`
  cookie. They see their own messages and staff replies, never internal notes.
  Abuse limits: three new chats per visitor per hour, 300 per hour overall, and
  bounded message rates per visitor and per conversation.
- Retention is not automated. Decide a retention period before enabling text,
  email or chat for production traffic.

## Before enabling text, email or chat

The High Compliance controls in [SECURITY.md](../SECURITY.md) and the owner
steps in [PRODUCTION_ROLLOUT.md](PRODUCTION_ROLLOUT.md) still apply: confirm the
BAAs cover Twilio and SendGrid, and verify the Supabase HIPAA controls before
accepting messages that may contain PHI.

### Text messages (Twilio)

1. In Railway, set `HUB_TWILIO_AUTH_TOKEN` (inbound signature check) and, for
   replies, `HUB_TWILIO_ACCOUNT_SID` plus `HUB_TWILIO_MESSAGING_SERVICE_SID`
   (preferred) or `HUB_TWILIO_FROM_NUMBER`. `HUB_PUBLIC_ORIGIN` must match the
   exact origin Twilio calls (default
   `https://support-hub-web-production.up.railway.app`).
2. In Twilio, set the support number's incoming-message webhook to
   `<HUB_PUBLIC_ORIGIN>/api/channels/sms/twilio` (HTTP POST).
   **Today that webhook points at Breathe** (`cmbreathe.com/resupply-api/sms/caremetric-inbound`,
   see the phone registry). Moving it stops Breathe's automated text handling
   for that number, so decide which system answers texts first, or use a
   dedicated support texting number.
3. The support number's A2P registration is still pending in the phone
   registry; outbound replies may be blocked until it is approved.

### Email (SendGrid)

1. Point MX records for a receiving domain (a subdomain such as
   `inbound.caremetric.ai` avoids disturbing other mail) to `mx.sendgrid.net`,
   or forward `support@caremetric.ai` there.
2. In SendGrid Inbound Parse, add the host with the URL
   `<HUB_PUBLIC_ORIGIN>/api/channels/email/inbound`, parsed mode, and enable
   signed webhooks. Set `HUB_SENDGRID_INBOUND_PUBLIC_KEY` to the verification
   key. Unsigned or stale (older than ten minutes) posts are refused.
3. For replies, authenticate the sending domain in SendGrid and set
   `HUB_SENDGRID_API_KEY` (Mail Send only). `HUB_SUPPORT_FROM_EMAIL` defaults
   to `support@caremetric.ai`.

### Chat

Set `HUB_CHAT_ENABLED=true`. Until then the Help page offers the phone number,
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
session; there is no unattended background sync.

## Deployment

Apply `20261020163000_unified_communications.sql` and its gate
`20261020163100_unified_communications_contract.sql`, which declares
`support.communications.v1`. The gate refuses to declare the feature if any
communication table loses row level security or gains a direct grant, or if a
webhook or chat function becomes executable by a browser role.
