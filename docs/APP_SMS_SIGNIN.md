# Application SMS sign-in

The Hub accepts a registered mobile number and a six-digit SMS code directly in its own sign-in screen. Telnyx Verify sends and checks codes. The Railway application creates an opaque, eight-hour HttpOnly session; Supabase Auth does not send or verify codes. Existing database identity, role and tenant records remain authoritative.

## Deployment

1. Pass the application, database and HTTP integration CI jobs. The production ledger already contains `20260911160622_app_sms_sessions.sql` (SMS backend contract 3). The additive `20260911161851_sms_portfolio_delegation.sql` must also be applied before Breathe SMS administration. Coordinate these with the pending portfolio snapshot, command and receipt migrations before deploying. Both the frontend build check and `server/main.mjs` must check the combined feature contract; a numeric version shared by independent branches does not prove compatibility. Do not edit an applied migration.
2. Enable the dedicated `hub_app_server` database role with a generated private password. Use a verified TLS connection with that role, never the database owner or service role. It can manage SMS sessions and assume the existing restricted application roles; it cannot read the Auth user directory or change registered numbers.
3. Bind the owner's approved mobile number to the existing administrator UUID in `private.sms_identities`. Do not create a second administrator or commit the number. Other users must have an explicitly registered number before using SMS sign-in. Phone changes and revocation rotate the identity version and invalidate existing sessions.
4. Set Railway server-only variables `HUB_DATABASE_URL`, `HUB_TELNYX_API_KEY` and `HUB_TELNYX_VERIFY_PROFILE_ID`. Do not give any of these a `VITE_` prefix. Use the dedicated CareMetric Support Hub Verify profile (six digits, five-minute expiry and a daily spend cap).
5. Deploy the paired CareBase and Breathe adapters that accept single-use Hub app delegations. Their existing explicit administrator identity maps and native role checks remain required. CareBase introspects at `/api/internal/admin/authorize`; Breathe uses `/api/internal/admin/breathe/authorize`. The audiences are distinct and each capability binds the exact requested operation. Deploy `app-media` with platform JWT verification disabled: it accepts only one-use, 30-second capabilities introspected by the Hub server. It handles storage transport only.
6. Deploy the Node 24 Docker runtime. Verify public help/catalog, real SMS receipt and sign-in, sign-out revocation, administrator reads, course authoring, media and learner delivery through the real app.

## Authorization and recovery

Every protected request rechecks the current relational permissions and account usability. Codes are bound to the requesting browser, expire after five minutes, have five attempts, and cannot be reused. Resends wait 60 seconds; persisted number, client and global limits survive restarts. Unknown numbers receive a generic response without sending a message or creating an account. Cookies use Secure, HttpOnly and SameSite=Strict; mutations require the exact application Origin.

Application sessions cannot be asserted through a client JWT: the database also requires the actual `hub_app_server` connection role and a live session record. Legacy Supabase AAL2 semantics remain unchanged for existing integrations. App sessions identify their verification method as SMS and never claim AAL2. Delegations expire after 30 seconds, bind a single read operation or storage object, and recheck permissions when consumed.

Number recovery is an operator action: verify the account holder through the established support process before updating a private identity binding. Revoking a binding or session takes effect on the next request. No registration or recovery endpoint silently grants administrator access.

## Rollback

The migration is additive and retains legacy authorization. Roll the Railway application back to the previous successful deployment if release checks fail. Existing old frontend assets continue using their prior contract; rebuilding an older connected frontend requires its matching contract version. Revoke app sessions if the release is withdrawn. Do not delete identity or course records as a rollback step.

## Validation status

The repository includes unit tests for provider verdicts, fixed RPC boundaries, cookies, origins and object paths; pgTAP authorization contracts; and an isolated HTTP/PostgreSQL test for browser binding, rate limits, retries, real role enforcement, course authoring, delegation replay and logout. Automated tests use synthetic numbers and a fake SMS sender. They do not establish real SMS delivery; record that separately after the owner signs in.

On September 11, the SMS branch at `ba98048` passed both CI jobs: 287 application/unit tests, 24 SDK tests, 219 pgTAP assertions, Edge checks, database advisors and HTTP/PostgreSQL integration. The paired CareBase PR #519 and Breathe PR #1375 also passed their full CI suites. The approved owner binding, dedicated Telnyx profile/server variables and storage-only `app-media` function are configured in production. The dedicated database role remains login-disabled and `HUB_DATABASE_URL` is not configured. No production SMS has been sent, no SMS session has been established, and no Node runtime cutover has occurred. Hold further production authentication changes until the database connection and combined release contract are ready.

