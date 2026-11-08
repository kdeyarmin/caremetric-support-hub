# Owner username and password

The private Hub's primary sign-in is a username and password. There is no public registration and no default credential. The existing owner chooses both in the app; credentials never need to be shared with an operator or entered into deployment variables.

## First setup and recovery

An owner who is already signed in opens **Security** (`/security`) and chooses a username and a password. Usernames contain 3–64 ASCII letters, numbers, dots, underscores or hyphens and are case insensitive. Passwords contain 15–128 Unicode characters, are normalized to NFC without trimming, and reject a small set of common/repeated passwords. Password managers can recognize the username, current-password and new-password fields.

When signed out, **Set up or reset your password** verifies the existing registered mobile number through the normal Telnyx SMS flow, then opens Security. This creates no user, permission or identity binding. Initial enrollment accepts an existing valid owner SMS session. Replacing an existing password requires the current password or an SMS session created within the last ten minutes. Password login itself does not request an SMS code.

Saving credentials rotates the browser's session and revokes all earlier sessions. Password reset also invalidates older password credential versions. Changing or revoking the approved mobile identity invalidates password login until recovery under the new identity. Removing the owner's administrator permission, banning/deleting their Auth user, and normal sign-out remain effective on the next request.

## Security boundary

- Passwords use independent random 128-bit salts and Node's asynchronous scrypt with `N=32768`, `r=8`, `p=3`, a 256-bit result and timing-safe comparison. Unknown usernames still perform the same derivation. At most two derivations run concurrently per process.
- PostgreSQL stores only password hashes in a private table with RLS and access limited to `hub_app_server`. Browser Data API roles, including `service_role`, have no table access. Neither passwords nor hashes are returned by an HTTP endpoint or written to audit metadata.
- Persisted hashed username/client buckets limit attempts to 10 per username, 40 per visitor, and 300 globally in 15 minutes. Reservations are serialized before hashing, work across replicas, and expire; SMS recovery has its independent existing limits. Attempts older than one day are removed.
- Authentication endpoints accept small JSON bodies, reject query parameters, and require the exact approved Origin for writes. Responses are not cached. Eight-hour opaque session cookies retain `Secure`, `HttpOnly`, `SameSite=Strict` and the `__Host-` prefix.
- The historical `private.sms_sessions` table and `sms_session_id` claim remain the shared session transport so native-app capabilities keep their existing contract. Sessions now record `auth_method`; password sessions bind the credential version and report `password`, never SMS or AAL2. All owner, account and native authorization checks still run.
- A password change and concurrent password login serialize per user; login rechecks the credential after hashing. Database triggers rotate versions, revoke earlier sessions and record only `auth.password.created`/`auth.password.changed` metadata.

## Release and verification

Deploy the paired Intel, Advisors, Breathe and CareBase adapters first. They accept the exact `sms`/`password` methods under the existing one-use Hub capability and retain their native administrator and operation checks. CareBase also requires its `hub_password_delegations` migration and learning-delegation edge functions; Breathe requires `0566_hub_password_authority.sql`.

Then apply `20261108010205_owner_password_login.sql` before deploying its paired application code. Startup refuses a database missing the password schema. It is additive, creates no credentials, and preserves existing SMS sessions. The old release can still use the migrated schema. Follow the repository PR/CI workflow; Railway deploys from main.

`server/password-auth-integration.mjs` runs only against disposable PostgreSQL at `127.0.0.1:54322`. It exercises the real hash implementation and HTTP handlers for enrollment, case-insensitive username login, bad credentials, current-password changes, stale/fresh SMS recovery, credential races, persisted limits, account/permission/identity revocation and logout replay. CI runs it twice after the complete Supabase migration chain. `supabase/tests/071_password_auth.test.sql` checks RLS and database grants. Component and HTTP unit tests cover browser forms, failure notices, cookies, Origin checks and query rejection.

These automated fixtures do not establish a production owner password sign-in. After release, the owner sets their password in the app, signs out, signs in with that password, and saves the authenticated browser profile. Catalog refresh and production payment fulfillment retain their own verification requirements.
