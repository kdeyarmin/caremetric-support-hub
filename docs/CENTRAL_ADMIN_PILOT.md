# Central administrator pilot

The `/admin` workspace is available to Hub platform administrators after MFA.
It collects existing Hub learning/support tools and a searchable inventory of
97 source routes and panels. The inventory identifies source capabilities;
it does not imply that every operation has already moved into the Hub.

The first live application adapter is read-only CareBase administration:
organization count, active-profile count, global course count, paginated course
metadata, and lesson titles. No patient rows, employee rows, emails, grades,
answer keys, media URLs, or service credentials pass through this API.
`activeUserCount` in contract v1 counts `profiles.is_active = true`; it is not
an assertion that every corresponding Auth account is currently sign-in eligible.

## Request and authority

The browser sends its Hub session JWT to the `platform-admin` Supabase Edge
Function. That function calls `hub.authorize_platform_admin()` and then calls
the fixed `https://cmcarebase.com/api/platform-admin/read` endpoint, forwarding
the user token. The CareBase backend rechecks the same Hub authorization and
its explicit Hub-UUID-to-CareBase-UUID deployment mapping. It then checks the
native profile role/activity and current Auth user deletion/ban state.

The authorization RPC requires an existing nonexpired Auth session, its verified
TOTP factor, AAL2 in both the JWT and session, a usable Auth user, a Hub profile,
and current unscoped `platform.admin` permission. Product-scoped grants, user
metadata, email equality, and client-supplied identity do not grant authority.
OAuth client sessions are excluded from this first-party pilot. Revoking the
Hub session, native role, factor, permission, or explicit mapping denies the next
adapter operation. This does not create native app browser sessions or enable
customer SSO; the Hub session authorizes the centralized administrator API.

The Edge Function has an exact two-origin browser allowlist (the Railway Hub
origin and `help.caremetric.ai`), no wildcard proxy destination, bounded JSON
requests/responses, deadlines, no redirects, `no-store`, and explicit response
field projection. It contains no service key and no request-payload logging.
The CareBase backend retains its own server credentials. Its endpoint has
concurrency/body limits and denies browser Origin headers.

Supported operations are `overview`, `courses.list`, and `courses.get`, all
read-only POST requests. Search is a literal title substring up to 100
characters, with control characters and `*` rejected. Lists allow at most
50 items per request; lesson outlines are capped at 200. Missing or failing
sources display unavailable states, never zero totals. New selection/sign-out
unmounts discard late responses.

## Deployment order

1. Validate the complete database chain, Edge Function, Hub, and CareBase tests.
2. Apply the renamed, previously unshipped learning migration, then the
   administrator authorization migration. Backend API contract becomes 2.
3. Deploy the Edge Function from the checked-in files. It uses Supabase's
   built-in `SUPABASE_ANON_KEY` and verifies user authorization through the RPC.
4. Deploy the CareBase adapter and configure the explicit UUID mapping following
   that repository's `DEPLOYMENT.md`. The integration is off by default. Never
   create an identity mapping merely because two email strings match.
5. Deploy the Hub frontend. Confirm production CSP and public routes, failed
   anonymous API calls, and the real administrator's AAL2-authorized operations.
6. Verify revoked session/permission/native role, wrong user, source timeout,
   pagination, and course detail behavior before adding write operations.

The demo-only Admin persona previews layout and the function inventory. It does
not manufacture API data or connected authority. Billing mutations, tenant/user
lifecycle writes, other app adapters, and customer SSO remain separate work.
