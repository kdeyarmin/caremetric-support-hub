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
- Every request pins Stripe API version `2026-02-25.clover`.
- Products and prices are never deleted. Changing a price creates a new Stripe
  price and archives the old one; removing a product archives it.

## Service configuration (Railway `support-hub-web`)

| Variable | Required | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | yes | Secret or restricted key of `acct_1SinLKB06O2UFlNz`. `sk_test_` for test mode, `sk_live_` for live. |
| `STRIPE_WEBHOOK_SECRET` | yes | Signing secret of the Hub's webhook endpoint. Comma-separate two secrets while rolling one. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | no | `bpc_…` Customer Portal configuration for Hub customers; Stripe's default configuration otherwise. |
| `HUB_PUBLIC_ORIGIN` | no | Return address of the customer portal (`https://help.caremetric.ai`). |

Webhook endpoint: `POST https://<hub>/api/webhooks/stripe`, API version
`2026-02-25.clover`, events: customer, subscription, discount, product, price,
coupon, promotion code and invoice events (`webhookEvents` in
`server/stripe.mjs` lists them exactly).

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
method or billing details in the Stripe customer portal. They never see Stripe
identifiers and there is no checkout: plans are assigned by CareMetric or
started as a trial by the application.

## Application APIs

All three are `POST` with a JSON body and `Authorization: Bearer cmb_…` (the
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

### `POST /api/apps/usage`

```json
{ "account": "…", "metric": "facility", "quantity": 4, "request_key": "<uuid>" }
```

Sets the quantity of the tenant's per-unit items for that application whose
product counts `metric` (its unit label or `billing_metric`). The new quantity
applies from the next billing period without proration, as CareBase billed it.
Repeating a `request_key` returns the first result. Answers `outcome`:
`updated`, `unchanged`, `no_subscription` or `not_linked`.

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
