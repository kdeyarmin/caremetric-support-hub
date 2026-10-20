# Healthcare Advisors administration bridge

CareMetric Healthcare Advisors (`kdeyarmin/advisors`, caremetricadvisors.com) is
a consulting practice with a public website and a private consultation inbox.
It has no software accounts, subscriptions or learners, so the Hub reads only
its consultation requests.

## What the Hub shows

- **Overview:** total consultation requests (Advisors keeps them 365 days) and
  how many are not closed. Organization, account and subscription totals are
  reported as not applicable, never as zero.
- **Consultation requests:** a searchable, paged list with the requester's
  self-reported contact details, organization, sector, service of interest,
  message, status and the owner's notes. Read-only: requests are still updated
  and deleted in the Advisors `/admin` inbox.
- **Knowledge:** the eleven answers published at caremetricadvisors.com/faq are
  public Hub articles for Advisors, pinned to
  `advisors@37afa7a884dc70f52d1134a7a27927ffee847373`, plus the shared safety
  article. Staff can add more from DocStudio.
- **Communications:** requests can be imported into the Communications inbox
  (see [UNIFIED_COMMUNICATIONS.md](UNIFIED_COMMUNICATIONS.md)). Advisors callers
  on (877) 521-2890 arrive through the phone-line import.

## How the connection is authorized

The Hub uses the fixed destination
`https://caremetricadvisors.com/api/hub/admin-read` and the
`X-CareMetric-Hub-Authorization` header. Only the platform administrator's
current SMS session can issue a one-use `advisors` capability, valid for 30
seconds. The legacy Supabase JWT path never forwards to Advisors.

The Advisors server redeems the capability once at
`<Hub>/api/internal/admin/advisors/authorize`, then requires:

- role `platform_admin` and SMS sign-in;
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
2. Merge the Advisors bridge pull request in `kdeyarmin/advisors`. Railway
   deploys it.
3. On the Advisors Railway service, set `HUB_ADMIN_USER_IDS` to the platform
   administrator's Hub user ID.
4. In the Hub, open **Platform admin → CareMetric Healthcare Advisors** and
   confirm "Connection verified". A deployed bridge alone is not proof of an
   authorized connection.
