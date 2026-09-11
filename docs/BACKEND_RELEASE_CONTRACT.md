# Combined backend release contract

The connected Vite build and Node startup share `assertBackendContract` in
`src/lib/backendContract.ts`. API version 4 is stable for additive changes; the
integer alone does not establish compatibility. Both entry points require these
twelve distinct feature names:

| Feature | Backend boundary |
| --- | --- |
| `learning.runtime.v1` | Existing catalog and learning delivery |
| `platform.admin.read.v1` | Current platform administrator reads |
| `app.sms.v1` | Current app-owned SMS sessions |
| `learning.sources.v1` | Immutable governed source snapshots |
| `platform.admin.command.v1` | Reviewed native command delegation |
| `learning.receipts.v1` | Prospective receipt and explicit identity mappings |
| `learning.authoring.v1` | Source-pinned native authoring intents and results |
| `knowledge.publications.v1` | Reviewed DocStudio imports, private staging, immutable commits, media and cleanup |
| `support.readiness.v1` | Current support access measurement and reviewed intake settings |
| `platform.admin.intel.v1` | Intel's isolated delegation audience and current administrator authorization |
| `learning.draft-editing.v1` | Reviewed native draft editing and review actions |
| `billing.portal.v1` | Current-session portal reservation, preview, dispatch and redacted outcome recovery |

Apply the reviewed, ordered migration chain before deploying the matching image.
The CLI-generated `20260911190819_combined_authoring_publication_support_contract.sql`
preserves the existing six features and fails before declaration if any required
new SQL endpoint/table is absent. Intel additionally requires the validated
`app_delegations_audience_check` constraint to contain its exact `intel` audience;
it reuses the current SMS administrator procedure, not a new role grant.

The contract RPC remains invoker-only public release metadata. It grants no
actor access, creates no identity mapping, and enables no tenant intake. The earlier
six-, ten- and eleven-feature API 4 responses are
incompatible with this release. Later additive features remain compatible when
all required names are present and unique.

`20260911192238_learning_draft_editing_contract.sql` requires the actual draft
editing actions. The later CLI-generated
`20260911195910_billing_portal_backend_contract.sql` preserves all eleven features
and requires the portal intent table, current-session authorization, guarded
reservation/preview/claim/result/resume functions and the closed action enum used
by the intent table. Native capabilities and provider configuration remain separate
runtime checks; the declaration never creates a Stripe session.

`supabase/schema.sql` is a consolidated reference, not a migration to reapply to
production. Its appended source follows the ordered feature migrations, including
Go, authoring intents, support readiness, the governed source credential guard,
Intel, draft editing, portal intents and their declarations. Production changes
use migration history only.

SQL compatibility does not attest that a native application or Edge transport is
deployed, configured or healthy. Verify native capabilities, fixed mappings,
revocation behavior, the `publication-media` transport and its private bucket,
negative authorization cases, and the final deployed image separately. The
[publication requirements](PUBLICATION_IMPORTS.md) retain the conservative
25 MiB application video cap until project/runtime capacity is verified. A
feature declaration does not raise that cap or publish content.

CI exercises the actual declaration SQL in disposable PostgreSQL after renaming
a required endpoint or table, replacing the Intel audience check, and removing
the foundational feature metadata. Each attempt must fail without changing the
previous metadata. All synthetic schema changes are rolled back. The same test
accepts the complete contract through the actual shared startup assertion.
The portal gate additionally rejects missing reservation/result functions or its
intent table, altered action enum/nullability/validator and missing foundation
metadata. Replaying the declarations in order restores the exact twelve-feature
contract; omitting either later feature prevents the matching image from starting.
