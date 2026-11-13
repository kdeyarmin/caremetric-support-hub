# Amazon SES

The Hub can send its email through Amazon SES instead of SendGrid. One setting moves staff replies, the AI team's
alerts and answers, customer lifecycle email and bulk email. Growth email (cold email and sales follow-ups) has its own
switch, **Settings → Email → Growth email service**, which stays SendGrid by default: SES does not allow unsolicited
email, and a suspension would stop every message the Hub sends. **Settings → Email → Email
service** is SendGrid until the owner chooses Amazon SES, and a change applies within a minute with nothing to redeploy.
If SES is selected with incomplete sending credentials, the Hub can use configured SendGrid before dispatch.
Selecting SendGrid requires SendGrid. An uncertain send is never repeated through the other service.

Inbound support email is unchanged by this release: `caremetric.ai`'s MX still points at SendGrid Inbound Parse, which
posts to `/api/channels/email/inbound`. Moving inbound mail to SES receiving is a separate change.

## What the Hub does

- **Sending** (`server/ses.mjs`): one SES v2 `SendEmail` request per message, with a raw MIME message (text, and HTML
  when there is one, each part base64), signed with AWS Signature Version 4. No AWS SDK. Bulk, growth and customer email
  carry `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Each message is tagged with its
  category; growth email also carries its growth message id as the `growth_message_id` tag. A 4xx from SES means the
  message was not sent (`failed`); a timeout or a 5xx is `unknown`, exactly as with SendGrid.
- **Delivery events** (`POST /api/growth/delivery/ses`): the configuration set publishes Delivery, Bounce, Complaint and
  Reject events to an SNS topic, and SNS posts them to the Hub. The Hub checks the SNS signature against the certificate
  SNS signs with (an https `.pem` on `sns.<region>.amazonaws.com`, fetched once and cached), accepts only the topic in
  **Settings → Email → Amazon SES events topic**, refuses messages older than six hours, and confirms the subscription
  itself when SNS asks (only on SNS in that region). A delivery records `delivered`, any final bounce or reject records `bounced`, and a complaint records `complaint`, once per SNS message.
  DeliveryDelay means SES is still trying. Only permanent bounces and complaints suppress the contact locally.
  Apply the terminal-failure database function before deploying this mapper. The sender disables SES open and click tracking per request.

## Setting it up

1. **Domains.** Verify each sending domain in SES (us-east-2) with Easy DKIM (2048-bit) and a custom MAIL FROM domain
   `mail.<domain>`. Each needs five DNS records: three DKIM CNAMEs, an MX for `mail` pointing to
   `feedback-smtp.us-east-2.amazonaws.com` (priority 10) and a TXT for `mail` with `v=spf1 include:amazonses.com ~all`.
   They sit beside the SendGrid records; nothing existing changes.
2. **Production access.** A new SES account sends only to verified addresses (200 a day). Request production access in
   the SES console for transactional email. Prospecting (cold) email is not part of that request: AWS's acceptable use
   policy does not allow unsolicited bulk email, so leave **Growth email service** on SendGrid.
3. **Sending key.** The IAM user `ses-sender-hub` exists with one inline policy: `ses:SendEmail` and
   `ses:SendRawEmail` only, only for the `caremetric.ai` and `caremetricadvisors.com` identities and the
   `caremetric-hub` configuration set. In the IAM console open that user, **Security credentials → Create access key**
   (application running outside AWS), and set `HUB_SES_ACCESS_KEY_ID` and `HUB_SES_SECRET_ACCESS_KEY` on the
   **support-hub-web** Railway service. They are secrets: Integration setup on the Control center shows only whether
   they are set.
4. **Events.** Create an SNS topic (`caremetric-hub-email-events`) and a configuration set (`caremetric-hub`, TLS
   required, account suppression for bounces and complaints) whose event destination publishes Delivery, Bounce, Complaint and Reject to that topic. Enter the set's
   name in **Settings → Email → Amazon SES configuration set** and the topic's ARN in **Settings → Email → Amazon SES
   events topic**, then subscribe `<HUB_PUBLIC_ORIGIN>/api/growth/delivery/ses` to the topic (HTTPS, raw message delivery
   off). The Hub confirms the subscription by itself; the subscription shows Confirmed in the SNS console.
5. **Region.** **Settings → Email → Amazon SES region** is `us-east-2` unless the domains are verified elsewhere.
6. **Switch.** Choose **Amazon SES** in **Settings → Email → Email service**. Send a test reply from Communications and
   check it arrives signed by the domain (DKIM pass). To go back, choose SendGrid.

## Verification

- `npx vitest run server/ses.test.mjs` checks the signer against AWS's published `get-vanilla` test vector, the MIME
  message (encoded subjects, no header injection, both parts), SES outcomes, the service switch and its fallback, SNS
  signature, topic, certificate-host, freshness and subscription checks, and the mapping of SES events onto growth
  delivery events.
- On November 12, 2026 the sender was run against the live SES API in us-east-2 with the owner's local AWS sign-in:
  a support reply and a bulk message to Amazon's mailbox simulator (`success@simulator.amazonses.com`) returned SES
  message ids, and an unverified recipient was refused while the account was in the sandbox (`failed`).
