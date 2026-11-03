# Combined backend release contract

The connected Vite build and Node startup share `assertBackendContract` in
`src/lib/backendContract.ts`. API version 4 is stable for additive changes; the
integer alone does not establish compatibility. Both entry points require these
35 distinct feature names:

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
| `support.customer-onboarding.v1` | Reviewed tenant and product onboarding settings |
| `learning.structure.v1` | Source-bound course structure edits |
| `support.customer-registration.v1` | Reviewed customer registration and membership |
| `billing.checkout.v1` | Governed native checkout commands |
| `learning.course-creation.v1` | Governed native course creation |
| `learning.credit-policy.v1` | Reviewed course credit policy commands |
| `learning.distribution.v1` | Governed course distribution and receipts |
| `learning.pennsync-source.v1` | PennSync source snapshots and native learning mapping |
| `learning.media.v1` | Governed course media uploads and delivery |
| `phone.registry.v1` | Central phone number and routing registry |
| `phone.accounts.v1` | Phone account and tenant assignments |
| `learning.sequence.v1` | Reviewed course sequence commands |
| `support.ai-assistance.v1` | Staff AI assistance and provider configuration gates |
| `support.ai-automation.v1` | Governed automated case assistance |
| `support.go-live-readiness.v1` | Current operational readiness checks |
| `support.ai-automation-server.v1` | Server automation worker boundaries |
| `platform.admin.advisors.v1` | SMS-authorized Healthcare Advisors administration reads |
| `support.ai-automation-failure-policy.v1` | Bounded automation retry and failure handling |
| `support.communications.v1` | Shared conversations, replies and channel configuration |
| `support.ai-usage.v1` | Private AI usage ledger and administrator summaries |
| `platform.admin.tenants.v1` | Administrator tenant and subscription records |
| `support.bulk-email.v1` | Governed bulk email preparation and delivery |
| `learning.catalog-authoring.v1` | Reviewed course unpublish and published-lesson corrections |

`20261102120100_agent_control_plane_contract.sql` declares `platform.agents.v1` only after
verifying that the six AI team tables keep row level security and grant nothing to any
browser, service or server role, that every server operation is a security definer with a
pinned empty search path executable by `hub_app_server` alone, that its helpers are
executable by no role, and that each owner operation authorizes the current administrator
session (reads) or command session (changes) itself. The feature is declared ahead of the Hub
build that will require it, so the migrations can be applied before that build ships.

`20261102130100_agent_probes_contract.sql` declares `platform.agents.probes.v1` only after
`platform.agents.v1` is declared and the probe state table keeps row level security with no
privilege for any browser, service or server role, and `private.agent_probe_record(...)`
stays a security definer with a pinned empty search path executable by `hub_app_server`
alone. Like the feature above it is declared ahead of any build that requires it.

`20261102140100_agent_brief_contract.sql` declares `platform.agents.brief.v1` only after
`platform.agents.v1`, `platform.agents.probes.v1` and `billing.platform.v1` are declared and
`private.agent_brief_facts()` is a security definer with a pinned empty search path executable by
`hub_app_server` alone.

`20261102150100_agent_seo_contract.sql` declares `platform.agents.seo.v1` only after
`platform.agents.v1` is declared and the SEO Analyst agent and its weekly schedule exist.

`20261102160100_agent_concierge_contract.sql` declares `platform.agents.concierge.v1` only after
`platform.agents.v1` and `support.communications.v1` are declared, the Support Concierge agent and its
sweep schedule exist, and `private.agent_concierge_pending(...)`, `private.agent_communication_snapshot(...)`
and `private.agent_notification_count(...)` are security definers with a pinned empty search path
executable by `hub_app_server` alone. The Hub server registers the Concierge's handlers only when the
feature is declared.

`20261102170100_agent_accounts_contract.sql` declares `platform.agents.accounts.v1` only after
`platform.agents.v1` and `billing.platform.v1` are declared, the Account Manager agent and its weekly
schedule exist, `private.agent_accounts_snapshot(...)` is a security definer with a pinned empty search
path executable by `hub_app_server` alone, and its two helpers
(`private.agent_accounts_json(...)` and `private.agent_subscription_facts(...)`) pin an empty search path
and are executable by no application role. The Hub server registers the Account Manager's handler only
when the feature is declared.

`20261102180100_agent_hardening_contract.sql` declares `platform.agents.hardening.v1` only after
`platform.agents.v1`, `platform.agents.probes.v1` and `platform.agents.brief.v1` are declared and every AI team
table, operation (the earlier signatures and the new fenced ones), helper and owner operation still has its
boundary: tables closed to every role with row level security on, operations security definers executable by
`hub_app_server` alone, helpers executable by no role, owner operations behind the administrator session, and
a pinned empty search path on all of them. Each test fails closed, so a function whose `search_path` setting
was reset (which leaves it null) is refused. The Hub server uses the fenced operations only when the feature is
declared.

`20261103120100_lead_desk_contract.sql` declares `support.leads.v1` only after `support.communications.v1` is
declared and the lead desk keeps its boundary: `private.leads` exists with row level security and grants nothing to any
browser, service or server role; the conversation table's source check accepts `carebase.web`, `intel.web` and
`advisors.web`; `private.lead_intake(text,jsonb)` and `private.lead_retention(integer)` (which deletes leads and website
conversations twelve months on) are security definers with a pinned empty search path, executable by `hub_app_server`
alone and calling `private.require_hub_app_server()`; their helpers (`private.lead_text`, `private.lead_instant`,
`private.lead_json`, `private.lead_record`, `private.lead_retention_batch`) pin an empty search path and are executable
by no application role; and `hub.list_leads(...)` authorizes the administrator session and
`hub.update_lead_status(...)` the command session themselves. Every test fails closed. The Hub server answers
`POST /api/leads` and runs lead retention only when the feature is declared (read at boot);
`src/lib/backendContract.ts` does not require it, so the migrations can be applied before or after the build that uses
them. See [LEAD_INTAKE.md](LEAD_INTAKE.md).

`20261103130100_agent_growth_contract.sql` declares `platform.agents.growth.v1` only after `platform.agents.v1`,
`platform.agents.probes.v1` and `support.leads.v1` are declared and the Growth Manager keeps its boundary: `private.leads`
still has row level security, grants nothing to any browser, service or server role and has its `growth_seen_at` column;
`private.agent_growth_pending`, `agent_growth_lead`, `agent_growth_mark_seen`, `agent_growth_unanswered`,
`agent_growth_facts`, `agent_lead_probe_seen` and the conversation snapshot they extend are security definers with a pinned
empty search path, executable by `hub_app_server` alone and calling `private.require_hub_app_server()`; their helpers pin an
empty search path and are executable by no application role; and the Growth Manager, its three schedules and the Platform
Engineer's lead form check exist. Every test fails closed. The Hub server registers the Growth Manager's handlers only when the
feature is declared (read at boot); `src/lib/backendContract.ts` does not require it. See [AI_TEAM.md](AI_TEAM.md).

`20261103140100_agent_lifecycle_contract.sql` declares `platform.agents.lifecycle.v1` only after
`platform.agents.accounts.v1`, `platform.agents.hardening.v1` and `support.bulk-email.v1` are declared, the
customer email ledger keeps row level security with no privilege for any browser, service or server role, the
`email.send` action kind has its shape check and its once-per-period unique index, the three new operations
(`private.agent_lifecycle_snapshot(...)`, `private.agent_lifecycle_begin_send(...)`,
`private.agent_lifecycle_finish_send(...)`) and the two it replaced (`private.agent_action_propose(...)`, which must
carry the per-template rule, and `private.email_unsubscribe(...)`) are security definers with a pinned empty search
path executable by `hub_app_server` alone, the facts helper is executable by no role, and the Account Manager has its
`auto_send_templates` setting and its daily customer email schedule. Each test fails closed. The Hub server registers
the customer email handler and executor only when the feature is declared.

`20261103150100_agent_content_contract.sql` declares `platform.agents.content.v1` only after `platform.agents.v1`,
`platform.agents.hardening.v1`, `knowledge.publications.v1` and `support.communications.v1` are declared, the
`content.publish` action kind (aimed at a `content_item`) has its shape check and its once-per-address and
once-per-topic unique indexes, `private.agent_content_state(...)` and `private.agent_content_publish(...)` are
security definers with a pinned empty search path executable by `hub_app_server` alone (publishing must refuse an
action the owner did not decide and author as the AI assistant profile, which must exist), and the Content Marketer
has its settings and its two daily schedules. Each test fails closed. The Hub server registers the Content Marketer's
handlers only when the feature is declared and a model key is set, and its publish executor only when the feature is
declared.

The table above is not exhaustive:
later features such as the `billing.*` and `customer.self-service.v1` boundaries are declared
by their own migrations and listed in `src/lib/backendContract.ts`. See [AI_TEAM.md](AI_TEAM.md).

`20261022210000_retire_docstudio.sql` removes the retired DocStudio tables,
functions and triggers after PR #85 removed their application callers. It removes
only `knowledge.docstudio.v1` from the latest 36-feature declaration, preserving
API version 4, all 35 features above and the invoker-only RPC permissions. The
shared publication tables/functions, `source_system: "docstudio"` provenance,
`publication-media` transport and `hub-publications` bucket are retained. The
separate deployed `docstudio-media` function and empty `hub-docstudio` bucket
require their own cleanup; this migration does not delete Storage buckets.

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
metadata. Historical declaration replays recreate the retired runtime only inside
rolled-back disposable transactions, then replay its retirement to restore the
exact current 35-feature contract. Missing any required feature prevents the
matching image from starting.
