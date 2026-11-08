# Live flow verification

Production: `https://help.caremetric.ai`. Latest verification completed November 8, 2026 at 03:57 UTC against commit `40121ee1c9c7ddb1ec5dcfdef8cf72317c3a5a47`, after the audit and password-login releases. These observations supplement the automated tests and cover the specific flows below.

## Latest production evidence

| Flow | Observed evidence | What it establishes |
| --- | --- | --- |
| Email/password authentication | The owner enrolled an email login at 03:18:24 UTC, then created a fresh password session at 03:22:12 UTC. The saved browser profile opened the authenticated dashboard; session and owner actor requests returned HTTP 200. | **Real owner email/password sign-in and dashboard access are confirmed.** The owner entered the password in the app. |
| Stripe catalog refresh | The authenticated browser clicked **Refresh from Stripe** in the live billing workspace. The `billing.catalog.sync` audit event at 03:24:32 UTC records 135 synchronized objects for the expected CareMetric Stripe account. | **The catalog refresh through the production UI is confirmed.** This action updated the Hub mirror. |
| Connected application reads | The saved session opened CareBase, Breathe, Intel and Advisors overviews. Their capability and overview requests consumed the existing one-use delegations. | **Authenticated read access to all four adapters is confirmed with the password session.** Native writes remain separate. |
| Course provider reads | An existing CareBase course's provider context and saved command history loaded through `/api/admin/provider`; both requests returned HTTP 200 at 03:25:28 UTC and consumed their learning delegations. | **Production provider context/history reads are confirmed.** No content was changed or published. |
| Sign-out | `/api/auth/logout` returned HTTP 200, and the browser's password session was revoked at 03:25:50 UTC. Reloading both the admin and billing routes showed the sign-in form. The owner's other session remained active. | **Browser sign-out and server-side session revocation are confirmed.** Raw-cookie replay was not performed in this browser run. |
| Positive-value payment | With explicit owner approval, the existing Intel test subscription's trial ended with a one-time $348 discount on its $349 monthly plan. The preview and actual hosted invoice were exactly $1 USD, with no tax or customer balance. The owner paid directly in Stripe. A succeeded live PaymentIntent received 100 cents and its invoice-payment record linked it to the exact paid invoice, with zero remaining balance. | **A real $1 production payment for the existing-trial invoice flow is confirmed.** This was not a new-customer Checkout purchase. |
| Paid fulfillment | At 03:54:31 UTC the Hub applied `customer.subscription.updated`, `invoice.paid` and `invoice.payment_succeeded`. The production mirror showed the invoice paid and subscription active; the Hub's Intel Starter billing entitlement was active and entitled. | **Stripe payment → signed webhook → production Hub billing mirror → Intel billing entitlement is confirmed.** The native Intel end-user screen was not separately signed into. |
| Payment-test cleanup | The approved test subscription ended at 03:55:48 UTC without proration or a final invoice. Its cancellation webhook applied at 03:55:49 UTC; the Hub then reported `canceled`, no entitled products and `entitled: false`. All three invoices for that subscription had zero remaining balance; only the test invoice had a positive amount paid. | **The subscription is canceled, cannot renew, and its Hub entitlement is removed.** Total collected was $1 USD; no refund was requested or issued. |

The [November 8 evidence snapshot](evidence/live-flow-verification-20261108.json) records the amounts, timestamps, source checks, cleanup and boundaries. It omits credentials, session material, customer/contact details, hosted payment URLs and raw provider payloads. Evidence comes from the authenticated browser, direct Stripe reads, production Hub records and Railway HTTP logs. Browser success alone was not used to infer a payment or entitlement change.

The current release also passed CI: 2,705 application tests, 24 SDK tests, 1,191 pgTAP assertions, the complete migration chain and the PostgreSQL/HTTP password flow twice. The password and email-identifier migrations were applied with matching canonical migration versions. Automated fixtures do not replace the real owner and payment observations above.

## Historical baseline, before the latest browser/payment verification

| Flow | Observed evidence | What it establishes |
| --- | --- | --- |
| Owner SMS authentication | After the owner signed in on November 8 at 00:01:52 UTC, the Telnyx-backed challenge matched the new active session by user, identity version, and exact transaction timestamp. Railway recorded HTTP 200 for SMS verification, session read, owner actor lookup, billing workspace, and private dashboard requests. There are now 16 matched successful challenges/sessions. | **A fresh real SMS sign-in and authenticated application reads are confirmed.** The owner entered the code in the production app; the agent did not handle it. |
| Native application reads | Following that sign-in, all eight capability/overview reads for CareBase, Breathe, Intel, and Advisors consumed their one-use capabilities and returned HTTP 200 between 00:01:56 and 00:02:01 UTC. The Hub validates each native response's source and operation before returning success. | **Fresh authenticated reads from all four connected adapters are confirmed.** This does not establish every command or mutation. |
| Stripe connection and mirror | The server verified the expected CareMetric account in live mode on November 7 at 16:58:05 UTC. Invoice mirrors were refreshed at 16:58:19 UTC. After the owner reauthorized the connector, direct Stripe reads confirmed that same account and the three invoice amounts. | The deployed service authenticated to the expected Stripe account and synchronized billing records. |
| Stripe webhook processing | All 36 recorded live webhook events have outcome `applied`. The latest was November 5 at 18:11:10 UTC; Railway also recorded successful webhook requests in that window. Stripe confirms the Hub endpoint is enabled, with exactly the 40 events in `webhookEvents` and the matching `2026-02-25.clover` version. | Live signature verification, event application, and the current webhook configuration are confirmed. |
| Production payment completion | At the baseline inspection, Stripe and the mirror contained three `paid` invoices, all for $0, and Stripe listed zero live PaymentIntents, with no further page. | Positive-value production payment was unverified at that time. The later $1 invoice flow is recorded above; $0 invoices alone did not prove collection. |
| Sandbox payment completion | The documented claimed sandbox `acct_1UVIE766OwFQY1wC` contains 22 successful PaymentIntents and one canceled intent. A completed $20 subscription Checkout Session links to the matching paid invoice and subscription; that subscription is canceled, consistent with the recorded cleanup. Its later paid invoices are $19.99 and $10.00. | Actual Stripe sandbox payment completion is independently confirmed. This reconciles the October 28 evidence; it is not a new purchase or a hosted Hub fulfillment run. |
| Outbound communication | Three outbound email records have provider message IDs and state `sent`. No outbound support SMS records were present. | Provider acceptance of those emails is recorded; recipient delivery and outbound support SMS are not established. |
| Private media | 217 download and 219 upload capabilities were consumed; 72 lesson-media imports have attachment audit events. | Authorized storage operations have occurred. Browser playback and course publication still require their own checks. |

Baseline sources: aggregate reads of the Hub's `private.sms_challenges`, `sms_sessions`, `app_delegations`, `billing_settings`, `billing_invoices`, `billing_webhook_events`, `communication_messages`, and `audit_events`; Railway production HTTP logs. No session hashes, phone numbers, codes, customer records, or raw provider payloads are included here. This earlier baseline did not verify PR #147 after deployment; the latest observations above cover the released audit and login changes.

Direct provider checks used the reauthorized Stripe connector and the account IDs already recorded in the application and [October 28 sandbox evidence](evidence/customer-checkout-sandbox-20261028.json). The ordinary CareMetric test-mode account has no PaymentIntents or webhook endpoints; it is distinct from that claimed sandbox. The [redacted evidence snapshot](evidence/live-flow-verification-20261107.json) records counts, account/mode checks, and checkout/invoice/subscription agreement.

At 23:51 UTC on November 7, a fresh public run also confirmed database health (200), anonymous private-read rejection (401), and unsigned Stripe webhook rejection (400). Its authenticated checks correctly reported `blocked`.

## Repeat the authenticated checks

For the current primary sign-in, the owner enters their email/username and password directly in the app and saves an authenticated browser profile. Verify the dashboard, Billing → Catalog → **Refresh from Stripe**, connected application overviews, and CareBase provider context/history. Sign out last, then reload protected routes and correlate the session revocation with server records. The browser check does not require exporting cookies or sharing a password.

The existing terminal runner exercises the SMS setup/recovery path and includes an explicit raw-cookie replay assertion. Use a current Node 24 release and an interactive terminal on the owner's machine:

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

- **Raw-cookie replay:** browser sign-out, production session revocation, and course-provider reads are complete. The full SMS terminal runner has not been executed with a real OTP, so its explicit revoked-cookie HTTP replay remains unverified against production. Disposable PostgreSQL/HTTP tests cover replay, but are not a production replay result.
- **New-customer Checkout, portal and native UI:** the existing-trial hosted-invoice payment and Hub entitlement fulfillment are complete. New-customer Checkout onboarding, a completed customer-portal flow and the native Intel end-user billing screen still need their own verification. The October 28 sandbox evidence used disposable PostgreSQL and synthetic native authority, with signed-event transport checked separately. A hosted sandbox run should include declined payment and duplicate-event delivery without switching the production service's billing mode.
- **Other writes:** outbound support SMS, course/provider changes, publication, playback, and AI generation require their actual recipient or disposable content workflow. Native read success and provider acceptance are not substitutes for those outcomes.

The owner entered their SMS code and password only in the app, and explicitly approved the $1 test plus cancellation. The test created a single-use discount, converted the existing test trial, and collected $1 through Stripe's hosted invoice before canceling that subscription. No new customer subscription, outbound support message, or provider content change was made. The runner's eight regression tests use simulated transports and are labeled accordingly.
