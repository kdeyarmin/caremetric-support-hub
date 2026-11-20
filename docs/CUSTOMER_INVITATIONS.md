# Customer invitations

**Billing → Invite a customer** (`/admin/billing?tab=invitations`) invites one customer to one application at a price
you authorize, with a discount from 0 to 100% (owner request 2026-11-19). The customer gets a welcome email in that
application's own look, describing the application, their plan, their discount and their price, with a link to accept
and sign up. At 100% they never see Stripe.

## Inviting a customer

1. Open **Billing → Invite a customer**.
2. Choose the application: **CareMetric CareBase**, **CareMetric Breathe** or **CareMetric Intel**.
3. Enter the contact's name and email and the organization's name.
4. Choose the plan and price. The list holds that application's active, published, recurring plan prices from
   **Catalog** (not add-ons, one-time fees or another customer's own price). For a per-unit price, enter the number of
   units (facilities, for CareBase Core).
5. Set the discount, 0 to 100% (up to two decimals), and how long it lasts: for as long as they subscribe, for their
   first months (1 to 36), or on their first invoice only. The summary shows the regular price, the discount and what
   they will pay, in the words the email uses.
6. Optionally add a personal note. It is shown in the email exactly as written.
7. **Preview email** shows the exact email. **Send invitation** creates the invitation and emails it.

Sending is safe to retry: a second click or a retry after an uncertain answer returns the same invitation and never
emails twice. The invitation's discount takes the place of the Founders Sale (offers are not combined); enter 50% to
match it.

## What the customer sees

- **The invitation email**, in the application's theme (server/email-layout.mjs: CareBase's logo over its blue rule,
  Breathe's navy band and accent rule, Intel's Emberline). It comes from the support sender with the application's name
  ("CareMetric CareBase"), and replies reach the support inbox. It welcomes them, describes the application, lists their
  plan, regular price, discount and price, says how paying works, and links to the welcome page. It says when the
  invitation expires (Settings → Billing → Invitations last, 30 days unless you change it).
- **The welcome page** (`https://<hub>/welcome/<link>`, in the same look) shows the offer and one button. Opening it
  changes nothing, so a mail scanner that follows the link never accepts it.
  - **100% discount:** *Accept and activate your plan*. The Hub creates the subscription in Stripe itself, with the
    invitation's 100% coupon: no Checkout page and no card. A complimentary period that ends (first months or first
    invoice) bills by emailed invoice, so nothing fails for want of a card.
  - **Below 100%:** *Accept and continue to secure payment* opens Stripe Checkout with the discount already applied.
    Cancelling there changes nothing; they can come back to the page and continue.
- **"Your plan is active"**: once the plan is active the page shows **Create your sign-in**, and the same button is
  emailed to them once. It opens the application's sign-up address (Settings → Billing) with `?hub_invite=<code>`; a
  CareBase invitation to a Train plan (entitlement key `train…`) opens CareBase's training sign-up (`product=train`), and a
  Breathe invitation names its plan (`plan=<entitlement key>`), which Breathe's form chooses for them.

## What happens behind it

- Accepting creates the customer's own Hub tenant (named for the organization), its Stripe customer and the invitation's
  own coupon (that percent, that duration, one redemption, only for that plan's product). Every Stripe request carries a
  key derived from the invitation, so a double click or a retry never creates a second customer, coupon, subscription or
  Checkout session; an open Checkout is reopened. The tenant is saved before the first Stripe request and each Stripe
  object is recorded as soon as Stripe answers, so if Stripe fails part-way the customer is told nothing was charged and
  accepting again carries on from that step with the same request.
- A payment is recorded from Stripe's webhook (`checkout.session.*`) even if the customer never returns to the page, and
  again when they do. The subscription then appears in **Subscriptions** and on the customer in **Customers** like any
  other.
- The link is 32 random bytes; the database keeps only its SHA-256. Every table and function is closed to everyone but
  the Hub server (`private.customer_invitation_*`); the audit trail (`billing.invitation.*`) holds states, amounts and
  identifiers, never names, emails or notes.

## What each application passes

CareBase (`kdeyarmin/PennTrain`), Breathe (`kdeyarmin/PennFit`) and Intel (`kdeyarmin/intel`) each pass the code from their
own sign-up; deploy the Hub (with its migrations) first, because the Hub's trial call refuses fields it does not know.

The application's sign-up must pass the code on to the Hub, so the new account joins the plan instead of starting a
trial: read `hub_invite` from the sign-up address, keep it through sign-up, and add it as `invite` to the existing
`POST /api/apps/trials` call ([Platform billing](PLATFORM_BILLING.md#post-apiappstrials)). The Hub links the account to the
invitation's tenant and answers with the plan's entitlement; nothing else changes for the application. A code that is
unknown, revoked, expired or not paid for yet is refused with 409 and starts no trial, so the application carries on with
its ordinary sign-up. Intel ([#536](https://github.com/kdeyarmin/intel/pull/536)) still creates the account and opens it on
Billing, which says why the invitation didn't apply and can apply it again: a newer link opened while signed in, or the
same code once the Hub answers. A refused or unanswered code there never sends a trial lead.

Intel applies a code only to a new sign-up or an organization still setting up its card. An organization that already
uses Intel (a plan, a trial, or one that ended) is already connected to its own customer here, so an invitation can't
take it, and its **Link account** can't either: when someone there opens the link, Intel says the invitation can't be
applied and asks them to reply to your email. Change that customer's plan, price or discount on its page under
**Customers** instead. The invitation form says so when CareMetric Intel is chosen.

Until an application passes it, a sign-up whose email matches an invitation that is already paid for or complimentary
is **held**: the Hub starts no trial (so the customer is never billed twice) and the invitation shows *Signed up without
the link: account …1234* with **Link account**. Link it once you know the sign-up is theirs; the account is then
entitled to the plan within the application's five-minute cache. A sign-up whose email matches nothing starts its
ordinary trial. The same hold applies to an account whose code was refused and that then asks for an ordinary trial with
the invited email: Intel's card setup then tells the person their plan is waiting, rather than that a trial ended.

## The invitation list

| Status | Meaning | Actions |
| --- | --- | --- |
| Invited | Sent; not accepted yet | Resend, Revoke |
| Paying in Stripe | They opened Checkout and have not finished | Resend (closes the open Checkout; they continue from the new link), Revoke (closes it too). A Checkout that has just been paid makes the invitation Active instead |
| Active · waiting for sign-up | Paid for or complimentary; their application account is not linked yet | Resend (sends the sign-up email again), Link account (when one is held) |
| Signed up | Their application account is linked to the plan | none; manage the subscription in Billing |
| Expired / Revoked | The link no longer opens the offer | Resend (Expired only) |

**Resend** makes a new link (the old one stops working) and starts a new expiry period. A paid or complimentary
invitation cannot be revoked: cancel its subscription in **Subscriptions** instead.

## Settings

Settings → Billing: **CareBase sign-up address for invitations** (`https://cmcarebase.com/signup`), **Breathe sign-up
address for invitations** (`https://cmbreathe.com/breathe/signup`), **CareMetric Intel sign-up address for invitations**
(`https://www.caremetricintel.com/login?signup=true`) and **Invitations last** (30 days). Email
goes through the Hub's email service and support sender (Settings → Email); Stripe needs nothing new.

## Deployment

Apply `20261120120000_customer_invitations.sql` and `20261120120100_customer_invitations_contract.sql` (declares
`billing.customer-invitations.v1`). The server can be deployed first: until the feature is declared, the tab answers that
invitations are waiting for their migration, `/welcome/…` serves nothing and sign-ups are unchanged. The server reads the
declared features when it starts, so a server that started before the contract migration keeps invitations off until it
restarts: apply the migrations before the deploy goes live, or restart the service afterwards. Its log then says
`Customer invitations: ready.` (`waiting for the billing.customer-invitations.v1 migration` before). Then update each
application to pass `invite` (above).

Production: both migrations were applied on 2026-11-20 after the release
([#294](https://github.com/kdeyarmin/caremetric-support-hub/pull/294)) deployed, and the service was restarted.

## Verifying

- `node server/invitations-integration.mjs` (local Supabase stack and the fake Stripe API; CI runs it twice to prove
  teardown) covers owner-only commands, the preview, idempotent creation and the themed email, paid acceptance through
  Checkout with the invitation's coupon, recovery when Stripe fails part-way (the fake Stripe, like Stripe, refuses a key
  reused with other parameters), webhook activation, one sign-up email with the code, a sign-up linked without a
  trial, complimentary activation without Checkout, a held sign-up linked by the owner, resend, revoke and the audit.
- `supabase/tests/125_customer_invitations.test.sql` checks the closed table and functions and the database's own rules.
- `server/customer-invitations.test.mjs` and `src/billing/Invitations.test.tsx` cover the words, the emails in each theme,
  the welcome page and its route, and the Billing tab.
