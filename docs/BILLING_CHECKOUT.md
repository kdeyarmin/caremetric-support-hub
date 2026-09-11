# Reviewed CareBase subscription checkout

The Hub supplies a reviewed administrative intent. CareBase owns the native
package/price catalog, quantities, trials, Stripe credentials and parameters,
organization-wide reservation, stable provider key, subscription events and access.
No deployment or test creates a production provider session or payment.

## Workflow and current evidence

Existing CareBase organization and subscription rows expose checkout only when
current native capabilities include `billing.packages.list` and all four
`billing.checkout.preview`, `.apply`, `.check`, and `.recover` capabilities. Native administrator,
command, billing and checkout flags plus a configured provider key control these
capabilities. Availability can change after discovery, so every request still
checks current native authority and configuration.

The plan chooser reads a bounded native database catalog. Mapped price choices
include currency, cadence and interval count, pricing model, exact base/unit minor
amount strings and quantity limits. Unmapped prices cannot be selected. Recorded
amounts are labelled as database values with provider availability `not_checked`;
they are not a live Stripe quote. Int64 values are never converted to Number.
The existing explicit currency exponent formatter displays exact values, or raw
minor units for unsupported currencies.

After selecting a package/cadence and providing a reason, the administrator
reviews the native organization, price ID, currency, quantity, trial and cadence.
An explicit confirmation submits the reviewed command. The UI does not supply a
price ID, customer ID, arbitrary URL, tax setting or quantity to native commands.
Final price, trial terms and taxes must be reviewed on Stripe before subscribing.
Existing native tax configuration remains authoritative; this feature does not
enable Stripe Tax or create tax registrations.

Pending and lost responses retain the same command/digest. **Check checkout
status** and **Open Stripe checkout** use native `check`, which cannot create a
provider session. A manual **Retry original creation** may reuse the original
native reservation/provider key. No timer dispatches either operation. Opening
uses a fresh check and same-tab navigation; a known session is never recreated.

Only native `canStartNewCheckout` evidence releases an applied review. Complete
checkout is not described as paid, settled or active access. The native owner
checks current blocking subscriptions and other payable reservations, including
those from older entry points or another administrator. An expired native preview
that never reserved provider work can be recovered by check only after native
locked proof of expiry and absence of another blocker. An unexpired preview is
not released. A Hub preview that expired before any Hub apply dispatch may be
replaced, with the native reservation still enforcing organization-wide safety.

## Recovery across administrator sessions

**Recover organization checkout** requires an administrative reason but no current
plan selection. The native owner reads the organization reservation and its
original immutable terms, then binds a separate recovery command to the current
administrator and SMS session. It does not change the original intent or grant its
creation capability. Retired or changed catalog records cannot silently substitute
new provider parameters. A retired provider price may prevent an open link while
completed/expired provider evidence can still be reconciled.

Recovery has its own exact request identity and may only use GET-only checks.
Both HTTP and SQL reject applying a recovery command. Its inspection preview may
expire while checks remain valid for the current SMS session. Unknown provider
work remains pending and never becomes a new provider POST. The native audit
attributes the observation to the current inspecting administrator.

No-reservation results include explicit native release evidence; absence alone
does not grant checkout eligibility. A new manual organization inspection creates
only another read-only inspection. The latest native release can supersede an
older cached Hub hold; the native organization-wide reservation remains the final
creation boundary. Opening a recovered checkout always performs another current
check. URLs remain absent from durable inspection metadata.

## Session and transport boundary

The same-origin POST `/api/admin/checkout-command` accepts closed preview, apply,
check, organization recovery, local resume and undispatched discard operations. It uses the existing HttpOnly
SMS session and the existing `carebase.command` single-use capability, bound to
the exact parsed operation. Only the fixed native
`https://cmcarebase.com/api/platform-admin/billing/command` endpoint is called with
the fixed Authorization header. Native current mapped authority is rechecked at
every attempt; no browser service key, caller destination or actor claim is used.

Private intents bind exact request JSON to current actor, SMS session and native
organization. Native preview dispatch is durably recorded before capability
issuance. Resuming after uncertainty restores the original key and parameters;
a distinct SMS session cannot inherit the saved creation intent. A failed request can
explicitly recover authoritative saved state, including an apply that failed
before Hub acceptance. Only reviews without any dispatch can be discarded.

Each apply/check claims a new private observation UUID. Response recording locks
the intent and rejects a superseded UUID before writing or disclosing a link.
Current Hub authority is checked again after the native call. The first observed
provider session ID remains immutable across pending observations. Durable result
and audit metadata omit the URL; the browser retains no URL in state, href or
storage. These controls do not revoke a Stripe page already opened by an admin.

Checkout URLs must use canonical `https://checkout.stripe.com/c/pay/<sessionId>`
with the exact returned `cs_test_` or `cs_live_` identity and matching live mode.
The optional bounded opaque fragment supports documented percent encoding. Query
parameters, alternate origins, credentials, explicit ports, changed session IDs
and malformed percent escapes are rejected. Tests include Stripe's public
[Checkout Session example](https://docs.stripe.com/api/checkout/sessions/object).
Only an open, unexpired, currently checked provider session may expose a URL.

Intents are capped at 20 per actor and 200 globally per hour. A later reservation
cleans metadata whose SMS expiry is more than 30 days old. Native provider
reservations and audit records are separate and are not deleted by this cleanup.

## Deployment and verification

The new Hub migrations are `20260911202906_billing_checkout_intents.sql` and
`20260911204842_billing_checkout_backend_contract.sql`. The latter declares
`billing.checkout.v1` only after actual closed action, current-session intent,
observation and immutable provider-session boundaries exist. It preserves all
previously reviewed features in a captured public literal. The same backend
assertion protects Node startup and connected frontend builds. Schema presence
does not claim native or Stripe readiness.

Verification covers strict DTOs, exact int64 money, documented and adversarial
URLs, React confirmation/recovery/check-only navigation, pgTAP privileges, actual
SMS/HTTP/PostgreSQL transactions with reversed concurrent observations and role
revocation after a native response, plus thirteen omitted-boundary release failures.
A separate composition runs the actual native handler through the actual Hub
transport/parser with synthetic SQL/provider fixtures. Native tests own the
shared legacy/Hub reservation and provider retry semantics. Production checkout
creation remains an explicit administrator action after the paired releases.
