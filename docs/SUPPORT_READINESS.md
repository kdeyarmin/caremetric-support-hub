# Customer support readiness

The platform administrator's App integration page now reads actual product,
tenant, membership, publication, and intake state. All six eligible product keys
are included. Published-item counts include approved publications across access
levels; they are not claims of public access, native administrator connectivity,
email delivery, or complete course migration.

An SMS member has an active, unrevoked product membership, a current usable Auth
identity reference and Hub profile, and a verified, unrevoked app SMS identity.
The Hub still owns verification and sessions. Active customers also require an
active tenant and product entitlement. A ready customer must have at least one
such member and pass the same intake/support-owner check used by case creation.

The paginated intake review never creates a customer, account, identity mapping,
role, or product membership. Activation requires an existing entitlement, a fresh
eight-hour administrator command session, explicit review, current customer
access, and the existing verified support-owner gate. The server locks the
entitlement and rejects changes based on an outdated settings revision. Disabling
intake remains possible when customer access has become inactive. Each accepted
change writes only IDs, the changed flag, and review metadata to the audit log.

Release the additive `20260911182857_support_intake_readiness.sql` migration before
the matching application runtime. It activates no intake and changes no existing
memberships. Validate using the disposable PostgreSQL/HTTP CI stack and an actual
owner read. Do not enable real customer intake as a smoke test.

Customer onboarding remains a separate required step when there are no existing
grants. Current ownership must be verified in each native app; do not infer or
merge customer identities from matching email addresses.
