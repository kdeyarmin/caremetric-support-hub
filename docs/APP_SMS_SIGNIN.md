# Application SMS sign-in

The Hub accepts a registered mobile number and a six-digit SMS code directly in its own sign-in screen. Telnyx Verify sends and checks codes. The Railway application creates an opaque, eight-hour HttpOnly session; Supabase Auth does not send or verify codes. Existing database identity, role and tenant records remain authoritative.

## Deployment

1. Pass the application, database and HTTP integration CI jobs. The production ledger already contains `20260911160622_app_sms_sessions.sql` (SMS backend contract 3). The additive `20260911161851_sms_portfolio_delegation.sql` must also be applied before Breathe SMS administration. Coordinate these with the pending portfolio snapshot, command and receipt migrations before deploying. Both the frontend build check and `server/main.mjs` must check the combined feature contract; a numeric version shared by independent branches does not prove compatibility. Do not edit an applied migration.
2. Enable the dedicated `hub_app_server` database role with a generated private password. Use a verified TLS connection with that role, never the database owner or service role. It can manage SMS sessions and assume the existing restricted application roles; it cannot read the Auth user directory or change registered numbers.
3. Bind the owner's approved mobile number to the existing administrator UUID in `private.sms_identities`. Do not create a second administrator or commit the number. Other users must have an explicitly registered number before using SMS sign-in. Phone changes and revocation rotate the identity version and invalidate existing sessions.
4. Set Railway server-only variables `HUB_DATABASE_URL`, `HUB_TELNYX_API_KEY` and `HUB_TELNYX_VERIFY_PROFILE_ID`. Do not give any of these a `VITE_` prefix. Use the dedicated CareMetric Support Hub Verify profile (six digits, five-minute expiry and a daily spend cap).
5. Deploy the paired CareBase and Breathe adapters that accept single-use Hub app delegations. Their existing explicit administrator identity maps and native role checks remain required. CareBase introspects at `/api/internal/admin/authorize`; Breathe uses `/api/internal/admin/breathe/authorize`. The audiences are distinct and each capability binds the exact requested operation. Deploy `app-media` with platform JWT verification disabled: it accepts only one-use, 30-second capabilities introspected by the Hub server. It handles storage transport only.
6. Deploy the Node 24 Docker runtime. Verify public help/catalog, real SMS receipt and sign-in, sign-out revocation, administrator reads, course authoring, media and learner delivery through the real app.

### Verified database connection

`server/database-config.mjs` accepts only the exact `hub_app_server` role on the Hub's direct database host, or `hub_app_server.xgauehtwksmnoqhgqegm` on the verified Supabase session-pooler host, using port 5432 and database `postgres`. Retrieve the exact pooler host from project settings; do not infer it from the region. The connection URL must have no query parameters. The server supplies explicit PostgreSQL client fields so URL options cannot override the role, database, host or TLS verification.

Set server-only `HUB_DATABASE_CA_PEM` to the official trusted CA PEM when required. The module checks certificate format, CA usage and validity dates, preserves `rejectUnauthorized: true`, and verifies the hostname. Do not use `sslmode=no-verify`, disable verification, trust a chain merely presented by a server, or put the password in a migration/source file.

The public CA test fixture comes from the production download used by Supabase's own dashboard: [official distribution](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt), supported by its [published configuration](https://github.com/supabase/supabase/blob/ea203f70dfdc8764b62a987a94eedd81ee463ccb/apps/studio/hooks/custom-content/custom-content.json) and [production URL selection](https://github.com/supabase/supabase/blob/ea203f70dfdc8764b62a987a94eedd81ee463ccb/apps/studio/components/interfaces/Settings/Database/SSLConfiguration.tsx). SHA-256 fingerprint: `807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`; expires April 26, 2031. It is a public trust certificate, not a private key, and is a test fixture rather than an implicit runtime fallback.

On September 11, the direct host passed PostgreSQL SSL negotiation and strict TLS 1.3 verification using this CA. No credentials or SQL were sent during that probe. The host is IPv6-only; Railway still needs IPv6 egress enabled before using it. Local reachability does not prove Railway runtime reachability.

## Owner-only access

The Hub is private to its owner. Only the platform administrator can sign in or stay signed in:

- After a correct code, the server runs `hub.authorize_app_admin()` for the new session. Any other identity's session is revoked at once and the browser gets "This Hub is private. Only its owner can sign in."
- Every API request with a session cookie runs the same check. A session that fails it is treated as signed out, so removing the owner's `platform.admin` permission ends access on the next request.
- The routes that created sign-ins for other people are closed: invitation claims (`/api/auth/invitation/*`), application self-service (`/api/self-service/connect/*`) and the application hand-off (`/api/apps/connect`). The `/join` and `/connect` pages show a private-Hub notice with support contacts, and App integration no longer offers customer invitations or customer account linking.

Public pages that need no sign-in, such as the help center, learning catalog and website chat, are unchanged. `server/owner-access-integration.mjs` checks all of this against a real database.

## Authorization and recovery

Every protected request rechecks the current relational permissions and account usability. Codes are bound to the requesting browser, expire after five minutes, have five attempts, and cannot be reused. Resends wait 60 seconds; persisted number, client and global limits survive restarts. Unknown numbers receive a generic response without sending a message or creating an account. Cookies use Secure, HttpOnly and SameSite=Strict; mutations require the exact application Origin.

Application sessions cannot be asserted through a client JWT: the database also requires the actual `hub_app_server` connection role and a live session record. Legacy Supabase AAL2 semantics remain unchanged for existing integrations. App sessions identify their verification method as SMS and never claim AAL2. Delegations expire after 30 seconds, bind a single read operation or storage object, and recheck permissions when consumed.

Number recovery is an operator action: verify the account holder through the established support process before updating a private identity binding. Revoking a binding or session takes effect on the next request. No registration or recovery endpoint silently grants administrator access.

## Rollback

The migration is additive and retains legacy authorization. Roll the Railway application back to the previous successful deployment if release checks fail. Existing old frontend assets continue using their prior contract; rebuilding an older connected frontend requires its matching contract version. Revoke app sessions if the release is withdrawn. Do not delete identity or course records as a rollback step.

## Validation status

The repository includes unit tests for provider verdicts, fixed RPC boundaries, cookies, origins and object paths; pgTAP authorization contracts; and an isolated HTTP/PostgreSQL test for browser binding, rate limits, retries, real role enforcement, course authoring, delegation replay and logout. Automated tests use synthetic numbers and a fake SMS sender. They do not establish real SMS delivery; record that separately after the owner signs in.

On September 11, the SMS branch at `ba98048` passed both CI jobs: 287 application/unit tests, 24 SDK tests, 219 pgTAP assertions, Edge checks, database advisors and HTTP/PostgreSQL integration. The paired CareBase PR #519 and Breathe PR #1375 also passed their full CI suites. The approved owner binding, dedicated Telnyx profile/server variables and storage-only `app-media` function are configured in production. The dedicated database role remains login-disabled and `HUB_DATABASE_URL` is not configured. No production SMS has been sent, no SMS session has been established, and no Node runtime cutover has occurred. Hold further production authentication changes until the database connection and combined release contract are ready.

