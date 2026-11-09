# Platform billing

The Hub is the only place CareMetric platform billing happens. Products, prices,
subscriptions, trials, discounts and invoices for every application (CareBase
and Train, Breathe, Intel, and later PennSync, EMR and Go) live in one Stripe
account and are managed from **Billing** (`/admin/billing`). Applications no
longer run their own checkout, webhook or Stripe keys for platform billing; they
ask the Hub what a tenant has and report billable quantities.

Facilities collecting from their own residents and families (CareBase's Stripe
Connect payments and autopay) and Breathe's patient insurance pipeline are not
platform billing and stay in those applications.

## Stripe account

- One account: **CareMetric**, `acct_1SinLKB06O2UFlNz`. The older CareMetric AI
  account is being retired and is never used.
- On boot the Hub calls `GET /v1/account` with `STRIPE_SECRET_KEY` and refuses
  every billing change (HTTP 503) when the key belongs to any other account.
  The Billing page shows the account, test or live mode and the last webhook.
- Existing billing requests keep Stripe API version `2026-02-25.clover`.
  New customer Checkout requests use `2026-08-26.dahlia` with an integration
  identifier. This does not upgrade existing subscriptions or webhook payloads.
- Products and prices are never deleted. Changing a price creates a new Stripe
  price and archives the old one; removing a product archives it.

## Service configuration (Railway `support-hub-web`)

| Variable | Required | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | yes | Secret or restricted key of `acct_1SinLKB06O2UFlNz`. `sk_test_` for test mode, `sk_live_` for live. |
| `STRIPE_WEBHOOK_SECRET` | yes | Signing secret of the Hub's webhook endpoint. Comma-separate two secrets while rolling one. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | no | `bpc_…` Customer Portal configuration for Hub customers; Stripe's default configuration otherwise. |
| `HUB_PUBLIC_ORIGIN` | no | Return address of the customer portal (`https://help.caremetric.ai`). |
| `HUB_CUSTOMER_PURCHASING_ENABLED` | no | Defaults off. Enables reviewed customer purchase confirmations only after the sandbox and native entitlement rollout gates pass. Existing checkout status and cancellation remain reachable when new purchasing is off. |
| `HUB_APP_CATALOG_SYNC` | no | `off` stops the Intel price sync (below). On by default. |
| `INTEL_CATALOG_URL` | no | Reads Intel's price catalog from another Intel (staging) instead of `https://www.caremetricintel.com/api/billing/catalog`. |

Webhook endpoint: `POST https://<hub>/api/webhooks/stripe`, API version
`2026-02-25.clover`, events: customer, subscription, discount, product, price,
coupon, promotion code, invoice and Checkout Session events (`webhookEvents` in
`server/stripe.mjs` lists them exactly).
Include `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed` and `checkout.session.expired`.

## Prices an application sets itself (Intel)

CareMetric Intel sets its plan prices in one place, `src/lib/planCatalog.ts` in
`kdeyarmin/intel`, and publishes them at
`GET https://www.caremetricintel.com/api/billing/catalog` (contract
`caremetric.app-catalog.v1`: products by entitlement key with their monthly,
annual and one-time prices, the trial, the annual saving, whether onboarding
is free, and a version hash). After the start and every 15 minutes the Hub
reads that catalog and keeps Stripe in step (`syncAppCatalog` in
`server/billing.mjs`, decisions in `server/app-catalog-sync.mjs`):

- A plan (`starter`, `growth`, `pro`, matched by the Stripe product's `kind`
  and `entitlement` metadata) with no published price for an interval gets one.
- An add-on (`extra_seat`, `extra_branch`, `extra_state`) is sold per unit. The
  Hub creates its Stripe product when none exists (`kind: addon`, the
  entitlement key, the catalog's `unit_label`, audited as
  `billing.catalog.product`), then its monthly and annual prices
  (`pricing_model: per_unit`). The extra seat costs less on larger plans, so it
  has one product per plan, named for it ("Extra seat (Growth)") and marked with
  `hub_for_plan`; sell a customer the seat product of their own plan. Intel
  counts each add-on's quantity through the entitlements answer
  (`addon_seats`, `addon_branches`, `addon_states`).
- A published price at another amount is replaced through the same
  **Change price** command an administrator uses, with **grandfather**:
  everyone already subscribed keeps their price; new subscriptions get the
  new one. Each change is audited as `billing.price.change` and
  `billing.catalog.sync`.
- A change that would cut a price by more than half or more than double it,
  a product with several active published prices for one interval, two active
  Stripe products for one plan or add-on, or a plan with no Stripe product is
  **held**: nothing changes, the log names it and `billing.catalog.held` is
  audited for an administrator. Plans are never created automatically, because
  an administrator decides their entitlements and offers.
- Customers' contract prices are never touched. Intel's onboarding is free;
  should the catalog list a one-time fee again, it is skipped and added to a
  first invoice by an administrator.
- Each product and price is created or changed on its own under an advisory
  lock, with Stripe request keys derived from the change, so two Hub instances
  or a retried run never create a second one. An unreadable catalog leaves
  Stripe and the fact sheet as they are.
- Intel's trial length follows the catalog's `trial_days`.
- The AI team quotes the catalog: Intel's prices, add-ons, trial and Founders
  Sale amounts on the fact sheet (`server/agents/content/facts.mjs`,
  `useAppCatalogFacts`) are written from it, and drafts are checked against
  those amounts from the same moment. `intelReviewedFacts` and
  `docs/GTM_FACTS.md` are the reviewed copy, quoted until the Hub has read the
  catalog. When the catalog states an amount the reviewed copy does not, the
  sync logs it and audits `billing.catalog.facts_stale`: update both (the test
  `intelFactsFromCatalog(fixture)` equals `intelReviewedFacts` keeps them
  together, with `server/fixtures/intel-catalog.json` as the reviewed catalog).
- Replacements of Founders Sale prices keep the offer for Intel and CareBase
  (Train included). The Hub re-reads the Founders products' prices
  (`refreshFounders`) after the start, after every catalog run, every 15
  minutes and after an administrator changes a price (see
  `docs/PRICING_RESEARCH_AND_FOUNDERS_SALE.md`).

## Data mirror

Stripe is the source of truth. The Hub keeps a closed mirror in `private`
tables (`billing_customers`, `billing_products`, `billing_prices`,
`billing_subscriptions`, `billing_subscription_items`, `billing_coupons`,
`billing_promotion_codes`, `billing_invoices`) so pages, totals and entitlement
answers never wait on Stripe.

- Every change made from the Hub is sent to Stripe first and the returned object
  is mirrored in the same request.
- The webhook verifies the signature, records each event id once
  (`billing_webhook_events`) and then re-reads the object from Stripe, so a late
  or out-of-order event can never overwrite newer state. Without a key it
  applies the event's own snapshot only when it is newer than what the mirror
  last saw.
- On every start, once the key is verified, the Hub re-reads the catalog and
  every customer that carries a Hub tenant (with their subscriptions and
  invoices), so changes made in the Stripe Dashboard or while the Hub was down
  are never missing.
- **Refresh from Stripe** on a customer, and **Sync from Stripe** on the
  catalog, re-read everything for that customer or the whole catalog.
- Every table is closed to browser, service and server roles; reads go through
  `hub.billing_workspace()`, `hub.billing_customer()` and `hub.my_billing()`,
  writes through security-definer functions that only the Hub server role
  (`hub_app_server`) may call. Each mirrored row carries a version used for
  optimistic checks on every change.
- The audit trail (`private.audit_events`, `billing.*`) records actions, states,
  amounts and Stripe identifiers only — never names, emails or free text.

## Administrator workspace (`/admin/billing`)

Platform administrators read Billing with their administrator session; every
change needs the command session (signed in within the last eight hours).

- **Subscriptions** — every subscription in every application, filtered by
  application, status and customer, with MRR, ARR and trial totals. MRR counts
  active and past-due subscriptions after discounts, yearly prices as one
  twelfth; trials are shown separately until they convert.
- **Customers** — every Hub tenant. Open one to:
  - save the billing contact (one Stripe customer per tenant, tagged with
    `hub_tenant_id`);
  - start a subscription for an application: plan and add-ons, quantities,
    one-time fees such as onboarding (charged on the first invoice), a trial,
    invoice by email (net terms) or automatic card charge, and a coupon or
    promotion code;
  - add, change or remove items and quantities, or add a one-time fee to the
    next invoice; extend or end a trial; pause
    or resume collection; cancel at period end (and undo) or immediately with
    or without a prorated credit;
  - create a price for this customer only (a negotiated or complimentary $0
    rate) and use it on their subscription;
  - apply or remove discounts;
  - see invoices, email or copy an open invoice's payment link, and open the
    Stripe customer portal for them;
  - link each application's own account id to the tenant.
- **Catalog** — products per application (plan, add-on or one-time fee, an
  entitlement key the application checks, a unit label such as *facility*) and
  their prices: flat or per unit, monthly, annual or one-time. **Change price**
  creates a new price and archives the old one, then either grandfathers current
  subscribers or moves them now, with or without proration.
- **Discounts** — coupons (percent or amount; once, repeating or forever;
  optionally limited to an application or products, a redemption count or a
  date) and promotion codes for them (optionally first-time only, a minimum,
  an expiry or one customer).
- **App connections** — issue or revoke each application's key for the APIs
  below. A key is shown once and stored only as a hash.

## Customer billing (`/billing`)

Tenant administrators see their organization's plans, quantities and invoices,
pay an open invoice on Stripe's hosted invoice page and update their payment
method or billing details in the Stripe customer portal. The verified native
customer workspace at `/subscriptions` adds published plan/add-on previews,
confirmed changes and initial paid setup when purchasing is enabled. Facility
purchasing remains gated on native facility entitlement enforcement.

### Initial paid setup

`POST /api/billing/customer` uses the versioned
`billing.customer-checkout.v1` contract. `quote` previews an initial plan when
there is no existing subscription; `confirm` requires `confirmed: true`.
`checkout_resume` and `checkout_cancel` require the current native connection
and quote ID; cancellation also requires `confirmed: true`. A current organization
administrator can recover checkout after signing in again. Facility administrators
cannot operate the shared payer.

The server chooses quantities from the published billing basis: flat prices stay
at one, and facility prices count verified native facilities. Seats, patients and
other units require an app-owned usage adapter. The server refuses existing trials,
unresolved subscriptions and ambiguous provider results before creating Checkout.

Some plans are sold only to customers who fit them (`src/billing/planSize.ts`):
- CareBase `small_home` and `small_home_complete`: licensed homes under 20 beds.
- `train_single_facility`: organizations with one active facility.

The application reports the facts with purchasing authority (`plan_size`, read from each
facility's licence in force), and the Hub never stores or estimates bed counts. An
organization-wide purchase needs every facility to qualify; a per-facility purchase checks
only the facility being billed. Missing facts refuse the plan. A facility already on one of
these plans keeps it when it adds modules. Owner-created subscriptions are not checked.
Read-only checks also preserve an existing EMR/Go shared subscription; this work
does not add Go to the customer workspace.

A committed reservation and stable provider idempotency key prevent duplicate
checkout. A tenant-level lock also coordinates native trial creation. The session
expires one hour after confirmation. Success/cancel return URLs only navigate;
they never grant access or cancel a payable session. Cancellation releases the
reservation only after Stripe confirms expiration, or reconciles a completed
payment if payment won the race.

Subscriptions carrying `hub_checkout_quote` remain held in the entitlement query
until the server verifies the exact bound session, customer, application, initial
paid invoice, prices, quantities, currency and approved amount. Removing or
malforming the marker cannot clear that hold. Unchanged legacy subscriptions
retain their existing entitlement rules. A once-per-minute sweep recovers delayed
events and lost session responses without creating new sessions. Logs report
failed/unbound counts; unresolved ownership or payment conflicts stay pending.

Before enabling purchasing, use an isolated Stripe sandbox to verify bank
authentication, delayed/failed payments, credits, mixed facility selections,
proration, scheduled changes, concurrent retries and delayed/duplicate webhooks.
Link existing native billing accounts and verify native record-owner, background
and offline entitlement enforcement before enabling separate facility plans.
Keep the production flag off until these gates pass. Existing tax configuration
is retained; this flow does not enable automatic tax or new tax collection.

## Application APIs

All application endpoints use `POST` with a JSON body and `Authorization: Bearer cmb_…` (the
application key from **App connections**). They accept no cookies or browser
origin. `account` is the application's own tenant id — CareBase organization
id, Breathe organization id or Intel organization id — the same identifier the
application already federates to the Hub.

### `POST /api/apps/entitlements`

```json
{ "account": "5f10a61e-3209-411a-8207-d657c8fd936d" }
```

```json
{
  "linked": true, "tenant_id": "…", "app": "carebase", "status": "active", "entitled": true,
  "trial_end": null, "current_period_end": "2026-11-27T00:00:00+00:00", "cancel_at_period_end": false,
  "products": [{ "key": "core", "kind": "plan", "name": "CareBase Core", "quantity": 3, "unit_label": "facility",
                  "status": "active", "plan": "core", "package_id": "…", "product": "prod_…", "subscription": "sub_…" }],
  "cache_ttl_seconds": 300, "checked_at": "2026-10-27T12:00:00.000Z"
}
```

`entitled` is true while a subscription is active, trialing or past due (Stripe
is retrying payment). A suspended or closed tenant, an unlinked account, and a
canceled or unpaid subscription answer `entitled: false`. Applications cache an
answer for at most `cache_ttl_seconds` and **fail closed**: if the Hub cannot be
reached and no fresh answer is cached, paid features stay off.

In facility mode this compatibility endpoint returns `billing_mode: "facility"`,
`billing_revision`, the native `account`, and the actual `organization_status`.
Its top-level status is `incomplete`, entitlement is false and products are empty:
an older worker must never turn facility allocations into organization-wide
access. Updated applications retain the organization membership status separately
and request the full scoped snapshot below.

### `POST /api/apps/facility-entitlements`

```json
{ "version": 1, "account": "native-organization-id", "facility_ids": ["site-a", "site-b"] }
```

Returns contract `caremetric.facility-entitlements.v1`, application/account,
`billing_mode`, monotonic `revision`, database `checked_at`, a 300-second maximum
cache lease and a `facilities` list containing each requested ID, status,
entitlement and selected plan/add-on products. At most 1,000 unique facility IDs
are accepted. Go is excluded. Other application keys cannot resolve this native
account. Missing allocations, missing payment, unknown products and insufficient
paid aggregate quantity grant no facility access. Only current allocations count;
scheduled removals retain the existing selection until renewal settlement.

Native applications must check the record's owner, retain the source observation
time on retries, refuse stale revisions and expire their online/offline cache.
CareBase implements the initial database and client boundaries, but does not yet
advertise `facility.entitlements.v1`: privileged reader/job coverage and other
native adapters remain rollout gates. No mixed plan activation is enabled here.

### `POST /api/apps/usage`

```json
{ "account": "…", "metric": "facility", "quantity": 4, "request_key": "<uuid>" }
```

Sets the quantity of the tenant's per-unit items for that application whose
product counts `metric` (its unit label or `billing_metric`). The new quantity
applies from the next billing period without proration, as CareBase billed it.
Repeating a `request_key` returns the first result. Answers `outcome`:
`updated`, `unchanged`, `no_subscription`, `not_linked` or `facility_managed`.
Facility-managed reports are recorded without changing provider quantities.
Legacy changes reserve immutable target item IDs, prices and original quantities
before provider I/O; an uncertain result blocks another report, purchase or scope
activation until the identical request is reconciled. Every item retry preserves
its Stripe idempotency key and parameters.
The Hub retries orphaned reservations every minute, recording each recovery attempt
before provider I/O and rotating failures behind untouched accounts. Confirmed
canceled/expired subscriptions close the reservation without changing quantities.
Changed customer, application, item or price identity still requires reconciliation;
recovery never substitutes a new purchase or payment operation.

### `POST /api/apps/billing`

Customers change their plan and add-ons inside their own application; the Hub is private to its
owner. The application verifies its organization administrator (CareBase: `org_admin`, through
`native_self_service_billing_authority`) and asks for one of its own linked accounts:

```json
{
  "account": "5f10a61e-3209-411a-8207-d657c8fd936d",
  "return_url": "https://cmcarebase.com/app/billing",
  "actor": { "id": "native-profile-id" },
  "scope": { "facilities": [{ "id": "site-a", "name": "Maple Grove" }], "plan_size": { "small_home_bed_limit": 20, "…": "…" } },
  "request": { "action": "quote", "facility_id": null, "plan": "price_…", "addons": ["price_…"], "request_id": "<uuid>" }
}
```

`request` is the customer center's own request (`billing.customer-checkout.v1`) without the Hub
`connection_id`: `workspace`, `quote`, `confirm`, `checkout_resume` and `checkout_cancel`; separate
facility billing is still enabled only from the Hub customer center. The Hub runs the same flow as
`/api/billing/customer` for an organization administrator, so the same answers come back: the
workspace (without the Hub's tenant, connection and Stripe customer identities), a quote, and
`{ state, url?, effective_at? }` for confirmation and Checkout. The application's facilities set
per-facility quantities and its `plan_size` facts decide size-limited plans, exactly as the native
purchasing authority does for the customer center. Additions and upgrades are invoiced now with
proration; removals, downgrades and cancellation are scheduled for renewal. An organization with no
subscription pays in Stripe Checkout and returns to `return_url` with `?checkout=returned` or
`?checkout=cancelled`; returning never grants access.

- A key reaches only its own application's linked accounts (`private.app_customer_billing_tenant`,
  resolved like entitlements): an unlinked account or another application's account is 404, and a
  suspended or closed organization is 403. Browser requests (an `Origin` or a cookie) are refused.
- Workspace and quote work while `HUB_CUSTOMER_PURCHASING_ENABLED` is off; `confirm` answers 503 and a
  pending Checkout can be checked or cancelled but never newly created.
- A quote belongs to the administrator who reviewed it (`app_actor`); only they can confirm it. A
  pending Checkout belongs to the organization: any of its administrators can check or cancel it.
- Every request is recorded as `billing.plan_change.app` with the application, account,
  administrator id, action, outcome and quote — never names or emails.

### `POST /api/apps/trials`

```json
{ "account": "…", "name": "Maple Grove Senior Living", "email": "owner@example.com", "plan": "core" }
```

For a self-service signup: creates (once) the Hub tenant and link, the Stripe
customer and a trial subscription on the application's trial plan (the monthly
price of the product whose entitlement key is `plan`, or the product marked
`hub_trial_default`), then returns the entitlement answer. CareBase trials last
30 days, others 14. A trial without a payment method cancels at its end. An
account that already has billing gets its current answer and no second trial.

## Verifying

- `node server/billing-integration.mjs` (local Supabase stack, local fake of
  the Stripe API) covers account pinning, sessions, catalog, subscriptions,
  price changes (grandfather and migrate), coupons, promotion codes, custom
  prices, quantities, trials, pause, cancel, invoices, portal, webhook
  idempotency and ordering, entitlements, usage and bounded audit. CI runs it
  twice to prove teardown.
- `supabase/tests/034_platform_billing.test.sql` checks the tables are closed
  and every function has its intended caller.
- `server/self-service-integration.mjs` also exercises initial paid setup through
  real SMS sessions and PostgreSQL: concurrent reservations, native trial refusal,
  session recovery, role/organization refusal, held subscription mirrors, exact
  paid receipts, signed/duplicate webhooks and legacy access. CI runs it twice.
- `supabase/tests/036_customer_checkout.test.sql` checks private receipt state,
  closed service operations, server connection identity and the new contract.
- `server/app-plan-changes-integration.mjs` (run by `billing-integration.mjs`) exercises
  `/api/apps/billing` against PostgreSQL and the fake Stripe API: key and account scope, purchasing
  off and on, administrator-bound quotes, plan fit, a paid add-on, first-plan Checkout and its return
  address, and the audit. `supabase/tests/045_app_plan_changes.test.sql` checks its privileges.

- `docs/evidence/customer-checkout-sandbox-20261027.json` preserves the initial
  preview, Checkout and expiration smoke before the owner claimed the sandbox.
- `docs/evidence/customer-checkout-sandbox-20261028.json` records claimed-sandbox
  hosted payment, consolidated quantities, matching proration preview, concurrent
  idempotent upgrades, failed-payment recovery and authentication-required results.
  Owner-authorized CLI access verifies the exact sandbox through the unchanged Hub
  account guard. Isolated clocks confirm downgrade/add-on removal at renewal,
  invoice collection after finalization and cancellation at the following renewal.
  The actual Hub customer billing service also passes two-facility activation,
  mixed plan purchases, credit-preserving exact-invoice recovery and scheduled downgrade
  reconciliation against the real provider. Native authority and Auth/Storage are
  isolated fixtures; no hosted native capability or purchasing flag is enabled.
  All synthetic paid subscriptions are canceled and the Hub matrix catalog retired.
  Actual signed provider events separately pass signature, persistent duplicate and
  expired-signature checks through the shared receipt ledger. These transport checks
  are distinct from the customer-service calls and do not claim a hosted deployment.
  Baseline CI #40632703353 passes, including 503 pgTAP assertions and the runtime image.
  Remaining gates include further delayed-payment variants and complete native
  facility enforcement across privileged readers, background jobs and offline sync.
  Keep the account-verification guard and disabled purchasing capability in place
  until those gates pass.

## Current Founders Sale

Eligible new paid CareBase, Train and Intel subscriptions automatically receive **50% off the first 12 paid months**, then regular renewal pricing. No code entry or assisted activation is needed. Checkout verifies the discount in its preview, session and receipt. Hub subscription creation applies it automatically; trial conversions apply it on the first paid invoice so the free trial does not consume the year. Eligibility, no stacking, one introductory year and exact public prices are checked server-side. See [pricing, exclusions and operational details](PRICING_RESEARCH_AND_FOUNDERS_SALE.md). Existing founding agreements retain their terms.
