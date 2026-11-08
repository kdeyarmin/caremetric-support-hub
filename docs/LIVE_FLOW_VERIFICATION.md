# Live flow verification

Production: `https://help.caremetric.ai`. Evidence inspected on November 7–8, 2026, including a fresh owner sign-in. These observations supplement the automated tests; they do not turn simulated provider tests into production verification.

## Production evidence

| Flow | Observed evidence | What it establishes |
| --- | --- | --- |
| Owner SMS authentication | After the owner signed in on November 8 at 00:01:52 UTC, the Telnyx-backed challenge matched the new active session by user, identity version, and exact transaction timestamp. Railway recorded HTTP 200 for SMS verification, session read, owner actor lookup, billing workspace, and private dashboard requests. There are now 16 matched successful challenges/sessions. | **A fresh real SMS sign-in and authenticated application reads are confirmed.** The owner entered the code in the production app; the agent did not handle it. |
| Native application reads | Following that sign-in, all eight capability/overview reads for CareBase, Breathe, Intel, and Advisors consumed their one-use capabilities and returned HTTP 200 between 00:01:56 and 00:02:01 UTC. The Hub validates each native response's source and operation before returning success. | **Fresh authenticated reads from all four connected adapters are confirmed.** This does not establish every command or mutation. |
| Stripe connection and mirror | The server verified the expected CareMetric account in live mode on November 7 at 16:58:05 UTC. Invoice mirrors were refreshed at 16:58:19 UTC. After the owner reauthorized the connector, direct Stripe reads confirmed that same account and the three invoice amounts. | The deployed service authenticated to the expected Stripe account and synchronized billing records. |
| Stripe webhook processing | All 36 recorded live webhook events have outcome `applied`. The latest was November 5 at 18:11:10 UTC; Railway also recorded successful webhook requests in that window. Stripe confirms the Hub endpoint is enabled, with exactly the 40 events in `webhookEvents` and the matching `2026-02-25.clover` version. | Live signature verification, event application, and the current webhook configuration are confirmed. |
| Production payment completion | Stripe and the mirror both contain three `paid` invoices, all for $0. Stripe lists zero live PaymentIntents, with no further page. | **A positive-value production payment remains unverified.** A $0 invoice and its `invoice.paid` event do not prove payment collection. |
| Sandbox payment completion | The documented claimed sandbox `acct_1UVIE766OwFQY1wC` contains 22 successful PaymentIntents and one canceled intent. A completed $20 subscription Checkout Session links to the matching paid invoice and subscription; that subscription is canceled, consistent with the recorded cleanup. Its later paid invoices are $19.99 and $10.00. | Actual Stripe sandbox payment completion is independently confirmed. This reconciles the October 28 evidence; it is not a new purchase or a hosted Hub fulfillment run. |
| Outbound communication | Three outbound email records have provider message IDs and state `sent`. No outbound support SMS records were present. | Provider acceptance of those emails is recorded; recipient delivery and outbound support SMS are not established. |
| Private media | 217 download and 219 upload capabilities were consumed; 72 lesson-media imports have attachment audit events. | Authorized storage operations have occurred. Browser playback and course publication still require their own checks. |

Sources: aggregate reads of the Hub's `private.sms_challenges`, `sms_sessions`, `app_delegations`, `billing_settings`, `billing_invoices`, `billing_webhook_events`, `communication_messages`, and `audit_events`; Railway production HTTP logs. No session hashes, phone numbers, codes, customer records, or raw provider payloads are included here. These observations cover the current production release; they do not verify PR #147 after deployment.

Direct provider checks used the reauthorized Stripe connector and the account IDs already recorded in the application and [October 28 sandbox evidence](evidence/customer-checkout-sandbox-20261028.json). The ordinary CareMetric test-mode account has no PaymentIntents or webhook endpoints; it is distinct from that claimed sandbox. The [redacted evidence snapshot](evidence/live-flow-verification-20261107.json) records counts, account/mode checks, and checkout/invoice/subscription agreement.

At 23:51 UTC on November 7, a fresh public run also confirmed database health (200), anonymous private-read rejection (401), and unsigned Stripe webhook rejection (400). Its authenticated checks correctly reported `blocked`.

## Repeat the authenticated checks

Use a current Node 24 release and an interactive terminal on the owner's machine:

```sh
npm ci
npm run verify:live
```

The command targets only the production Hub. It asks for the registered owner mobile number and the received SMS code with terminal echo disabled. Enter them locally, never in chat, command arguments, environment variables, or a committed file. The command creates its own session through the normal SMS endpoints; it does not accept copied cookies, forge sessions, or change identity bindings.

It checks the SMS challenge's browser binding, secure cookie attributes, authenticated session and owner role, capabilities and overviews of connected applications, the first CareBase course's provider context and command history, the Stripe catalog refresh, and the billing workspace's live account. The catalog refresh performs Stripe reads, updates the existing Hub mirror, and writes an audit event. It does not create a checkout or charge. Finally, it logs out and confirms that replaying its old session cookie is rejected, including after a later check fails.

Only check names, verdicts, safe error codes, HTTP failure statuses, and timestamps go into the JSON report. A provider's HTTP 200 response must also pass its response contract. No response bodies or authentication material are saved. The report explicitly lists unexercised flows. Exit 0 means the **selected checks** passed; it is not a payment, publication, or whole-app certification. Exit 1 means a check failed; exit 2 means a selected check is blocked.

For public checks without an SMS:

```sh
npm run --silent verify:live -- --public-only
```

The public-only run intentionally exits 2 because authenticated checks are blocked. Node's `--use-env-proxy` honors inherited network/proxy settings while keeping TLS verification enabled.

## Remaining completion gates

- **Automated authenticated replay and logout:** the owner-assisted production sign-in and dashboard/provider reads are confirmed. The full terminal runner has not yet been executed with a real OTP, so its logout replay and course-provider context checks remain unexecuted against production. The owner's current session was left active. Environment diagnostic: `ccarenv_b64_Y2NhcmVudl82NDk2NzE5OTg3Yjg4MTkxODg5MGZiMDE0MWY1MDE0NQ` advertised an enabled desktop with unknown state, but exposed no desktop JavaScript or `open_in_codex` tool; verification used production records and logs instead.
- **Hosted payment checkout and portal:** Stripe reconnection is resolved, and sandbox payment records are confirmed. The existing October 28 evidence used the actual Hub billing service with disposable PostgreSQL and synthetic native authority, plus separately verified signed-event transport. It explicitly did not establish a hosted Hub deployment's complete fulfillment. Complete a nonzero sandbox purchase through an isolated app deployment configured for that sandbox, then verify the signed webhook, matching invoice/subscription, and application entitlement. Include a declined payment and duplicate event delivery. Production positive-value collection must be supported by an actual payment record or an explicitly scoped purchase; neither was available here. Do not switch the production service's billing mode to run a test.
- **Other writes:** outbound support SMS, course/provider changes, publication, playback, and AI generation require their actual recipient or disposable content workflow. Native read success and provider acceptance are not substitutes for those outcomes.

The owner requested one fresh sign-in SMS in the production app. The agent sent no outbound support messages and made no charges, customer subscriptions, or provider content changes. The runner's eight regression tests use simulated transports and are labeled accordingly.
