# Healthcare Advisors administration bridge

CareMetric Healthcare Advisors (`kdeyarmin/advisors`, caremetricadvisors.com) is
a consulting practice with a public website and a private consultation inbox.
It has no software accounts, subscriptions or learners, so the Hub manages only
its consultation requests. Advisors stays out of the Hub's customer-facing features
(billing, self-service and support intake); it appears in the owner's administration
screens: the control center, **Applications**, the portfolio rollup and Communications.

## What the Hub shows

- **Overview:** total consultation requests (Advisors keeps them 365 days) and
  how many are not closed. Organization, account and subscription totals are
  reported as not applicable, never as zero.
- **Consultation requests** (**Applications → CareMetric Healthcare Advisors →
  Consultation requests**): a searchable, paged list with the requester's
  self-reported contact details, organization, sector, service of interest and
  message. For each request the owner can change its status (needs review, in
  progress, closed) and notes, or delete it after a second confirmation. Changes
  go straight to Advisors; its private `/admin` inbox keeps working and shows them.
  Every change names the status and notes the owner last saw, so Advisors refuses
  it with "changed in Advisors since the list loaded" instead of overwriting an
  edit made meanwhile in `/admin`.
- **Knowledge:** the eleven answers published at caremetricadvisors.com/faq are
  public Hub articles for Advisors, pinned to
  `advisors@37afa7a884dc70f52d1134a7a27927ffee847373`, plus the shared safety
  article. The shared [publication import workflow](PUBLICATION_IMPORTS.md) remains
  available for approved manifest packages; the DocStudio authoring product is retired.
- **Communications:** requests can be imported into the Communications inbox
  (see [UNIFIED_COMMUNICATIONS.md](UNIFIED_COMMUNICATIONS.md)). Advisors callers
  on (877) 521-2890 arrive through the phone-line import.

## How the connection is authorized

The Hub uses two fixed destinations with the `X-CareMetric-Hub-Authorization`
header: `https://caremetricadvisors.com/api/hub/admin-read` for reads and
`https://caremetricadvisors.com/api/hub/admin-command` for changes
(`inquiries.update`, `inquiries.delete`). Only the platform administrator's
current SMS session can issue a one-use `advisors` capability, valid for 30
seconds and bound to exactly one read or change. A change also requires
`hub.authorize_app_command()`, the same check CareBase changes use. The browser
reaches changes through `POST /api/admin/advisors-command`, which accepts only the
exact change shapes (`supabase/functions/_shared/advisorsCommands.ts`). The legacy
Supabase JWT path never forwards to Advisors.

The Advisors server redeems the capability once at
`<Hub>/api/internal/admin/advisors/authorize`, then requires:

- role `platform_admin` and an owner sign-in (SMS code or [email and password](OWNER_PASSWORD_LOGIN.md));
- a Hub user ID listed in `HUB_ADMIN_USER_IDS` on the Advisors service;
- the redeemed operation to match the request body exactly;
- no browser `Origin` or `Cookie` header.

Anything else returns no data. An empty `HUB_ADMIN_USER_IDS` disables the
bridge. The Hub then keeps only the reviewed fields from the response.

## Deployment order

1. Apply `20261020150000_advisors_application.sql`,
   `20261020150100_advisors_application_contract.sql` (declares
   `platform.admin.advisors.v1`) and
   `20261020150200_advisors_knowledge_authoring.sql`, then deploy the Hub.
2. Merge the Advisors bridge pull request in `kdeyarmin/advisors` (#37 restores
   the read bridge and adds `/api/hub/admin-command`). Railway deploys it.
3. On the Advisors Railway service, set `HUB_ADMIN_USER_IDS` to the platform
   administrator's Hub user ID.
4. In the Hub, open **Platform admin → CareMetric Healthcare Advisors** and
   confirm "Connection verified". A deployed bridge alone is not proof of an
   authorized connection.
