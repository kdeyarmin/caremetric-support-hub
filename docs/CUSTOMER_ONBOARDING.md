# Reviewed customer account linking

App integration now supports explicit customer onboarding for Breathe, EMR, Go, PennSync and Intel. CareBase continues to use its governed completion-receipt access workflow.

An operator with a current Hub SMS platform-administrator session enters exact native user/account identifiers and an existing verified Hub SMS user ID. A fixed native adapter checks the currently mapped native administrator and the requested protected native account relationship. The Hub then shows the exact native IDs, account kind, relationship, Hub user/name and canonical customer account for review. Email addresses never determine a pairing.

The preview grants nothing. It expires after 60 seconds and is bound to that administrator's exact SMS session. Confirmation requires an explicit operator attestation that the accounts belong to the same person. The server resolves the native relationship again, compares the native revision and all existing Hub access rows, and atomically records the approved mapping. Request IDs are durable; a lost response can be retried with the same ID, while reuse for another review fails. Revoked users, changed membership, expired sessions, conflicting mappings and suspended access fail closed.

New access is `customer`, own cases only, without member management or staff permissions. No Auth account or SMS identity is created. Intake stays off and must pass the separate readiness workflow. Existing intake must be disabled and reviewed before another member is linked. Existing bindings cannot be repointed or silently restored. Go and EMR remain separate products even though their native backend is shared.

The canonical federation tables retain these operator-reviewed bindings with a distinct `verification_method`. Such issuers have no JWKS and are always disabled for token federation; this is not an OIDC login flow. Only the restricted app server can execute the onboarding SQL functions, after relational SMS authorization. The regular browser RPC allowlist does not expose them.

Native proof sources:

| App | Exact relationship required |
| --- | --- |
| Breathe | Active verified in-house staff user, active `admin_users` membership with matching `org_id`, active organization |
| EMR / Go | Current usable native Auth user, protected staff profile with matching `organization_id`, active organization |
| PennSync | Protected User plus active server-owned `AgencyMembership`, exact canonical membership key/version, active or trial agency |
| Intel | Protected User and its own individual account; no organization or account-activity status is invented |

No production customer pairing is performed by deployment or test. All five native readers must be released independently; a missing reader yields an unavailable preview and cannot create access. Local database verification uses disposable PostgreSQL fixtures in `server/onboarding-integration.mjs`; CI exercises it against the complete migrated Supabase stack.
