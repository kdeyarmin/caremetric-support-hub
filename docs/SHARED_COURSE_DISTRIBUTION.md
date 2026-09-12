# Reviewed shared-course distribution

CareBase remains the writer and runtime for course material, assignments, progress,
credit and certificates. Hub distribution writes only its existing catalog item,
immutable catalog revision, and product placements. It never duplicates a learner
record or publishes a newer source implicitly.

## Review and commit

The course authoring screen includes **Shared course distribution**. The server
loads the current published native course/version and exact source bytes from the
fixed authenticated `POST https://cmcarebase.com/api/learning-admin/distribution`
context operation. The read uses a fresh, single-use `carebase.learning` delegation
bound to the current original Hub SMS session; CareBase rechecks its mapped native
administrator. A draft/archived source cannot be distributed. HTTP 404 is unavailable,
not proof of a missing-source tombstone or current native authority.

The administrator reviews the material and the bounded catalog title, summary,
category and displayed duration, chooses explicit eligible products and visibility,
and gives a reason. Existing or scheduled placement replacement and every removal
require explicit confirmation. “All eligible apps” freezes the current IDs; it is
not an implicit future-app grant. The five-minute saved preview binds the original
actor/session, exact source hash/version, complete catalog fingerprint, metadata,
placements and visibility. A changed/reused request ID cannot create another plan.

Commit obtains the current native context again and a matching machine observation,
then rechecks the current Hub session, product permissions and catalog fingerprint. After lock waits,
it separately checks wall-clock session and original eight-hour assurance expiry;
transaction-time authorization alone cannot extend either deadline.
The SQL transaction writes the revision, provenance, placements and receipt together.
An audit/storage failure rolls everything back. Concurrent stale observations are
rejected; retries return the original immutable receipt. Source bytes remain only
in private provenance. Public metadata includes no lesson bodies, quiz answers,
provider evidence, raw media locations or learner information.

Existing catalog IDs, native launch paths and previous revision rows are retained.
Private provenance stores the previous item/link/placements and hashes/IDs of prior
revision rows. All catalog revisions of a managed item, intent/source bytes and committed receipts
cannot be updated or deleted. The separate source-preservation head is never moved:
it may legitimately contain a newer draft than the current published version.
Expired preview request IDs remain durable and cannot be reused. Preview creation
is bounded to 20 per actor per 15 minutes; context returns the latest 20 for the
current same actor, including prior sessions. Read-only recovery separately proves
current native administrator authority; only an unexpired review in its original
session can be committed. An old receipt confirms its historical commit, not the
availability of that source today.

The distribution HTTP coordinator enforces its 28-second deadline across database
pool acquisition, authorization/delegation queries and remote calls. Cancelled or
late-acquired connections are destroyed; lost responses recover immutable receipts.

## Independent availability observer

Set `CAREBASE_DISTRIBUTION_OBSERVER_TOKEN` on both native CareBase and Hub to the
same dedicated 43-character base64url secret (32 random bytes), outside the browser.
The only destination is
`POST https://cmcarebase.com/api/internal/learning/distribution-status`, with
standard Bearer authorization and the closed `course.distribution.status.v1`
request. There are no caller-selected URLs, headers, SQL queries or authoring verbs.
The native machine token only reads current global course publication pointers,
hashes and missing tombstones; it cannot read source bodies or mutate anything.

Hub starts the worker immediately and every five minutes. Each SQL lease covers at
most ten opted-in courses. A run drains at most 100 batches/120 seconds. Native
responses are limited to 16 KiB and an exact unordered requested ID set, with a
freshness window of 120 seconds behind/30 seconds ahead. Each DB operation has a
12-second cancellation deadline, 9-second statement and 3-second lock timeout;
stalled/late connections are destroyed. Failed batches retain attempt backoff and
do not stop the bounded drain of healthy courses. Leases/nonces prevent older,
partial or superseded responses from overwriting newer facts.

Only an explicit successful distribution commit enables this policy for a course.
Its current approved revision is visible only while a matching published native
pointer/hash was observed within 15 minutes. A confirmed changed/archived/draft or
missing source hides it immediately. A transport failure does not invent a healthy
or retired state; the last evidence eventually expires. The worker never approves
or publishes a changed version. It remains independent of an owner's SMS lifetime.

## Release and rollout

Apply the reviewed `232209` migration and additive API-4 `234549` declaration before
shipping this server/frontend (`learning.distribution.v1`). `schema.sql` includes
the full chronological DocStudio, distribution and PennSync source assembly; migrations are primary.
The schema feature does not assert that native code, the observer token or app
consumers have been deployed. Native capability `learning.distribution.context`
is accepted only for CareBase and the existing native authoring flags govern it.

`HUB_LEGACY_DISTRIBUTION_OPT_IN` defaults off. The existing 80 imported courses keep
their previous behavior until individually reviewed and explicitly distributed;
the migration does not enroll them in the freshness policy. Enable legacy opt-in
only after native/Hub observer deployment, authenticated initial reconciliation
and acceptance of the shared catalog in two actual consuming apps. New Hub-created
courses can be distributed once the matching machine probe succeeds. No production
course or placement is changed by deployment itself.

Automated tests cover the two-product shared sanitized RPC projection, actual
PostgreSQL/SMS/HTTP authorization and transaction boundaries, immutable history,
source-head preservation, native/source drift, retry and rollback, replacement,
retirement, worker freshness and lease conflicts. Cross-repository composition
uses the actual native handler and Hub strict projectors with synthetic underlying
network/database fixtures. These are not a substitute for the production two-app
rollout acceptance or a claim of automatic approval of future native versions.
