# PennSync source migration

The library's PennSync migration panel reads the actual native administrator
source, presents catalog/count metadata, and preserves the exact private source
revision after a second native read. The browser cannot submit source content,
learner identities or an alternate endpoint. Current app SMS, portfolio admin
and content-editor authority are required; the native bridge also verifies its
current mapped protected administrator.

The native source contract is `pennsync.learning-source.v1` from Base44 app
`694ec16e72e01b60d22f7cbf`. It includes all declared fields in ten learning
entities and minimum source identity evidence. Course records, standalone
modules, plans, plan associations and historical evidence remain separate.
The private snapshot retains original learner email evidence without mapping
it to a Hub user. Inspection returns only totals and source catalog metadata.

The source reader hashes external/credential-bearing references instead of
fetching or exposing them. These are explicit migration dependencies, and the
original projected native record has its own revision hash. Required source
material must be transferred and verified before it can be treated as migrated.

Preservation uses an exact source hash, an expected current head, an advisory
lock, immutable snapshots and audit events. A repeated revision returns the
existing snapshot and never rewinds the latest head. Current native authority
is checked on retries. The storage and mutation functions are unavailable to
anonymous, browser-authenticated and service-role callers; the dedicated app
server uses narrowly granted private functions after SMS authorization.

This source release creates no content items, course publications, learner
grants, enrollments, certificates or credits. Before PennSync cutover, reconcile
agency/audience visibility, assessment types and scoring, plan/assignment
behavior, certificates, credits and renewal, and every historical identity.
Do not convert an unmatched learner into the owner or a new account. Preserve
source reads and original records while resolving these dependencies.

Release order: apply the exact reviewed `20260912002000` source SQL and
`20260912002100` contract SQL, deploy the tested native reader, then deploy Hub
web. The backend declares `learning.pennsync-source.v1` only after private
storage and operation boundaries exist. Validate actual owner inspection,
preserve the real eligible source revision, and verify private source counts.

Native source field declarations are copied from the native reader's reviewed
field inventory into `src/imports/pennsyncSourceFields.json`. Source decoder
schemas and the embedded SQL schemas are tested for exact parity. CI runs real
PostgreSQL, HTTP, SMS-cookie and one-use capability tests for this migration.
