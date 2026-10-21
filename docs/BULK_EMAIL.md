# Bulk email to application users

Platform administrators can open **Bulk email** (`/admin/email`) to email the
users of one or more applications, narrowed by role and account status. It is in
the sidebar and linked from the control center's communications panel.

## How it works

1. **Choose applications.** CareBase, Breathe, CareMetric EMR, PennSync,
   CareMetric Intel and CareMetric Go each expose a user directory
   (`users.list`) through their administration connection. Healthcare Advisors
   has consultation contacts rather than application users, so it is not
   offered.
2. **Read users.** The Hub server reads each chosen directory 50 users at a
   time through the administrator's own SMS session, ten pages per request; the
   page keeps going until every directory is read and shows progress for each.
   An application's directory can be read up to 10,050 users deep; if it has
   more, the page says how many were left out.
3. **Narrow the audience.** Each application lists every role and account
   status its directory returned, with how many users have each and how many of
   those have an email address. Roles and statuses come from the application
   itself; the Hub does not rename or merge them. Every role starts selected.
   Statuses that read as switched off (disabled, inactive, suspended,
   deactivated and similar) start unselected and can still be included.
4. **Write the message.** A subject (one line, up to 150 characters) and a
   plain-text message (up to 20,000 characters). Saving the draft updates the
   recipient count: one recipient per email address after removing duplicates
   across applications, addresses that are missing or not deliverable, and
   anyone who has unsubscribed.
5. **Test and send.** A test copy goes once to an address the administrator
   types, marked `[Test]`. Sending requires ticking the review box; the server
   refuses if the recipient count changed since it was shown.

Delivery runs on the Hub server, five messages at a time, and continues if the
administrator leaves the page. The email's page shows sent, waiting, refused,
unconfirmed and cancelled counts. *Stop sending* cancels every message not yet
handed to SendGrid; messages already in flight finish.

## What every message contains

Messages are plain text from `CareMetric <HUB_BULK_EMAIL_FROM>` with replies to
the support address. After the administrator's text, the Hub adds:

```
--
You are receiving this email because you have a <applications> account with CareMetric.
Unsubscribe from CareMetric announcements: <personal link>
<HUB_BULK_EMAIL_POSTAL_ADDRESS, when set>
```

Each message also carries `List-Unsubscribe` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058), which
large mailbox providers require from bulk senders. SendGrid click, open and
subscription tracking are turned off for these messages.

The personal link opens a page with an **Unsubscribe** button; opening the link
alone changes nothing, so link scanners cannot unsubscribe anyone. A mail
client's one-click request or the button suppresses that address for every
future bulk email from the Hub. Support replies are not affected.

Do not include patient information. For marketing (rather than service)
announcements, set `HUB_BULK_EMAIL_POSTAL_ADDRESS` so every message includes a
mailing address, as CAN-SPAM requires.

## Data handling

- The directory rows read for a draft (user reference, email, role, status)
  are kept only while it is a draft. Queuing a send deletes them; so does
  cancelling. Drafts untouched for a day are cancelled and their rows deleted.
- Each recipient's address and unsubscribe token are kept only until
  SendGrid's answer is recorded. Afterwards only a SHA-256 hash of the address
  remains, for the email's history and for unsubscribes.
- A delivery whose outcome is uncertain (a timeout, a SendGrid server error or
  a claim older than ten minutes) is recorded as *unconfirmed* and never sent
  again, so nobody receives the same email twice.
- Audit events record counts and states only, never addresses, subjects or
  message text.

All tables are private with row level security and no direct grants.
Administrator functions recheck the current administrator session; queuing a
send and sending a test also need the command session (signed in within eight
hours). Claiming deliveries, recording outcomes and unsubscribing are reachable
only by the Hub server role.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `HUB_SENDGRID_API_KEY` | Yes | Mail Send key, shared with support replies. Without it, sending and tests are refused. |
| `HUB_BULK_EMAIL_FROM` | No | Sender address; defaults to `HUB_SUPPORT_FROM_EMAIL`, then `support@caremetric.ai`. Must be a verified SendGrid sender. |
| `HUB_BULK_EMAIL_POSTAL_ADDRESS` | No | Mailing address shown in every footer. |
| `HUB_PUBLIC_ORIGIN` | No | Origin used in unsubscribe links (the existing webhook origin setting). |

The integration setup panel in the control center lists these under Email
(SendGrid).

## Deployment

Apply `20261021160000_bulk_email.sql` and `20261021160100_bulk_email_contract.sql`,
then deploy the web/server image. Connected builds and server startup require
`support.bulk-email.v1`; its declaration checks the private tables, RLS, direct
grants, the server-only delivery functions and the session check in every
administrator function. The migrations are additive and send nothing.

`server/bulk-email-integration.mjs` exercises the whole flow against the
isolated Supabase stack with synthetic directories and a recording mail
provider: administrator and command sessions, customer denial, resumable
directory reads, role and status selection, duplicate and unsubscribed
addresses, confirmed counts, one-time delivery, unconfirmed outcomes that are
never resent, unsubscribe, cancellation, housekeeping, bounded audit and
complete teardown. `supabase/tests/032_bulk_email.test.sql` checks grants and
constraints; `server/bulk-email.test.mjs` covers the routes and the SendGrid
request.
