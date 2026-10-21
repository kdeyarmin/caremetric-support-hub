# Tenant setup and subscription pricing

Platform administrators can open **Tenants & pricing** (`/admin/tenants`) to set
up a customer tenant by hand, choose its applications and record what each
subscription costs, or make it complimentary (free). It is linked from the
sidebar and from the control center's Hub services panel.

## What the administrator can do

- **Set up a tenant**: name, a permanent slug (suggested from the name),
  optional industry, and the first application with its pricing. Applications
  can also be added later. Slugs beginning with `carebase-` or `support-` are
  reserved for app onboarding, which generates them.
- **Edit a tenant**: name, industry and status (active, suspended, closed). The
  slug never changes. Customer support intake works only while a tenant is
  active, as before.
- **Add an application** the tenant does not have yet, with its access status
  and pricing.
- **Edit pricing** per application: plan name, price in US dollars, billed per
  month or per year, and notes.
- **Make a subscription free**: choose *Complimentary (free)* and record why.
  An optional end date keeps it free through that day; the recorded regular
  price applies afterward, so a dated complimentary period needs a price.
  Without an end date it stays free until someone changes it. Switching back
  to *Paid* clears the complimentary reason and date.

Tenants created through app onboarding appear in the same list. Their
applications show *No pricing recorded* until an administrator sets pricing;
doing so keeps the existing access row and its members.

The summary shows tenants, paid subscriptions in use, complimentary
subscriptions and the recorded monthly value: the sum of active paid
subscriptions on active tenants, with yearly prices counted as one twelfth.
Filters find suspended or closed tenants, tenants with a complimentary
subscription, and tenants with an application whose pricing is not recorded.

## What it does not do

This is the Hub's subscription record. Saving never charges or refunds a card,
and it does not change Stripe, the CareBase billing portal or any application's
own billing or entitlements. Billing commands remain in each application's
reviewed workflow ([billing portal](BILLING_PORTAL.md),
[checkout](BILLING_CHECKOUT.md)). Adding an application here grants no user
access by itself: members still come from the reviewed
[onboarding](CUSTOMER_ONBOARDING.md) and [registration](CUSTOMER_REGISTRATION.md)
flows, and support intake still needs its own readiness review.

## Data and security

Tenants and their applications stay in `hub.tenants` and `hub.tenant_products`.
Pricing lives in the private, RLS-enabled `private.tenant_subscriptions` table
(one row per tenant and application) with no direct grants to any browser,
service or server role. The table itself refuses a paid subscription without a
price and a complimentary one without a reason.

Four closed RPCs serve the page through the app server's allowlist:

| RPC | Authorization | Purpose |
| --- | --- | --- |
| `hub.list_tenant_accounts()` | Current administrator session | Every tenant with its applications, access status and pricing, plus current applications |
| `hub.create_tenant(p_record)` | Administrator command session | Creates a tenant and its first applications atomically |
| `hub.save_tenant(p_tenant_id, p_record, p_expected_updated_at)` | Administrator command session | Edits name, industry and status |
| `hub.save_tenant_subscription(p_tenant_id, p_product_id, p_record, p_expected_version)` | Administrator command session | Adds an application (version 0) or edits its access and pricing |

The command session is the existing SMS administrator session started within
the last eight hours. Every record has a closed set of keys and bounded plain
text. Writes check the tenant revision or subscription version, so a stale
edit never overwrites a newer one; the page keeps the administrator's entries
and asks them to refresh. Audit events record the action, tenant, application,
version, access status, price, billing interval, complimentary flag and end
date, never plan names, reasons or notes.

## Deployment

Apply `20261021140000_tenant_subscriptions.sql` and
`20261021140100_tenant_subscriptions_contract.sql`, then deploy the web/server
image. Connected builds require `platform.admin.tenants.v1`; its declaration
checks the private table, RLS, direct grants, private helpers and the session
check in each RPC while preserving other backend features. The migrations are
additive: they create no tenants and change no existing access.

`server/tenant-integration.mjs` exercises real administrator and command
sessions against the isolated Supabase stack: customer and anonymous denial,
older sessions that can read but not write, revoked and banned administrators,
field validation, reserved and duplicate slugs, stale revisions, complimentary
periods, pricing an onboarded tenant, bounded audit and complete teardown.
`supabase/tests/031_tenant_subscriptions.test.sql` checks grants and table
constraints.
