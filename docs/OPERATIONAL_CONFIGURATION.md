# Reviewed native operational settings

CareBase Jobs and Releases expose configuration controls when the current native
connection advertises `operations.config.v1`. Job stops, global release rollout
and global or exact-organization feature stops use the same native writers as
the CareBase settings pages. Clearing a feature stop preserves its historical
reason and expiry; the current setting then becomes unconfigured. Existing
cohorts and memberships remain stored and their counts are shown in review.

Each operation uses the current opaque SMS session and a one-use
`carebase.command` capability bound to the closed configuration domain. The
fixed native endpoint is `/api/platform-admin/configuration`; a separate Hub
`/api/admin/configuration` route never forwards browser credentials. The Hub
checks current relational authority again after the native result.

Preview binds current configuration, policy impact, reason and requested state.
Native source locks and its earliest scheduled boundary constrain applicability.
The owner must confirm the actual before/after review. An uncertain response
locks further edits to the saved command; recovery reads cannot apply anything.
A pending command from a new session remains read-only. Expired previews cannot
be applied. Repeated unchanged preview requests keep their request identity.

Native configuration keeps the durable preview/result and audit ledger. This
Hub change requires no additional SQL or native service credentials. Release
the full-green paired native PR541 before this UI. Runtime-image checks include
the shared contract and all server imports. Actual disposable PostgreSQL/SMS/HTTP
tests cover one-use authority, native and Hub revocation, lost responses and
new-session recovery; native SQL tests cover real writers, rollback and locking.
