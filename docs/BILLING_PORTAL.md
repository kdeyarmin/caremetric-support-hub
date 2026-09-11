# Reviewed CareBase billing portal

CareBase remains the owner of Stripe configuration, its customer/organization
relationship, provider credentials, the durable provider reservation and the
stable Stripe idempotency key. The Hub adds review and recovery to the existing
administrator workspace. It does not copy subscription business logic or create
provider sessions during deployment or verification.

## Workflow

The organization and subscription tables show **Review billing portal** only for
CareBase when its current capabilities include both `billing.commands.preview`
and `billing.commands.apply`. Native administrator, command and billing-command
flags still apply. An advertised operation does not prove that Stripe's portal
configuration or provider connection is ready; preview errors report that
configuration or connectivity may be unavailable.

1. Select an existing native organization and provide an administrative reason.
2. Review the exact native organization, Stripe customer, configuration identifier
   and return destination. The portal's enabled billing options are not enumerated
   by this preview, so the UI does not describe the portal as read-only.
3. Explicitly confirm creation. A native preview expires within five minutes.
4. Pending or uncertain results retain the same command/digest and offer a manual
   retry after 30 seconds. No timer creates or replaces a provider session.
5. **Open Stripe portal** repeats that same command against current Hub and native
   authority before same-tab navigation. The provider may reject an expired link;
   the API does not report a reliable portal-link expiry, so none is invented.

The return path is the native `/admin/enterprise` destination. The Hub supplies no
customer ID, configuration ID, provider URL or return URL in a command request.

## Recovery and authorization

`/api/admin/billing-command` is a closed, same-origin POST route protected by the
existing HttpOnly SMS session. The only native destination is
`https://cmcarebase.com/api/platform-admin/billing/command`, with the existing
single-use `carebase.command` audience and fixed Authorization header. Its closed
billing parser is combined with the existing administrative command parser;
neither accepts arbitrary endpoints, operations, headers or actor claims.

Private Hub intent functions reserve the request identity under the current
actor, SMS session and native organization **before** native preview dispatch.
Dispatch is recorded before issuing any capability, so a lost preview response
cannot be mistaken for an undispatched review. Only a review with no preview or
apply dispatch can be discarded. Closing or reloading resumes the saved identity
within the same SMS session. Another administrator or another session cannot
inherit it. Starting a replacement is an explicit action after a terminal outcome
or a preview that expired before apply; unresolved apply attempts stay reserved.

The Hub stores the exact immutable preview and redacted result metadata. It never
stores provider session URLs in intents, audit records or browser storage. A
completed replay still calls the native owner, so removing an administrator or
changing the native customer mapping prevents retrieval of a cached link. Current
Hub authority is checked again after the native response and before disclosure.
Out-of-order pending observations cannot regress a terminal receipt.
These checks do not revoke an already-open Stripe session, which follows
Stripe's own lifetime and configuration.

Private reservations are limited to 20 per actor and 200 globally per hour.
Metadata whose session expiry is more than 30 days old is removed during a later
reservation; this does not delete the native provider ledger or audit. RLS and
revoked direct table privileges restrict writes to the guarded app-server
functions. Native commands remain responsible for fresh mapped authority,
concurrency, stable provider keys and their bounded uncertainty window.

## Provider URL contract

Only canonical HTTPS `billing.stripe.com` portal URLs are accepted. The closed
forms are `/p/session/<token>` and `/p/session?secret=<token>`, where a token has
1–2048 ASCII letters, digits, underscores or hyphens. No credentials, explicit
port, fragments, percent encoding, extra path segments or extra query parameters
are allowed. The second form is covered by the actual public example in
[Stripe's create-session documentation](https://docs.stripe.com/api/customer_portal/sessions/create).
The component does not retain the URL in state or a reusable hyperlink; opening
performs a fresh bound replay and validates the returned URL immediately before
navigation. Existing CSP and referrer protections remain unchanged.

## Release and verification

Apply the reviewed Hub migration, native reservation migration and native adapter
release before enabling the existing native billing-command flag. Verify the
real native customer/configuration ownership and fixed return destination.
Hub SQL compatibility alone never declares provider readiness. Deployment creates
no Stripe portal session and changes no payment, subscription, tax or access state.
Tax configuration and portal features remain with the existing Stripe account;
this change does not enable or infer Stripe Tax registrations.

Validation includes strict adversarial DTO/URL tests, actual React confirmation,
reload, pending, revocation and navigation tests, pgTAP privilege contracts, and a
disposable PostgreSQL + real SMS + HTTP composition with synthetic native/provider
observations. A separate local composition exercises the actual native handler,
Hub transport and shared parser with mocked SQL/provider responses. Hosted
provider creation is outside this verification and requires a deliberate reviewed
command by the authorized administrator.
