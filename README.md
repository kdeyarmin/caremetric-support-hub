# CareMetric Support Hub

## One hub for CareBase, Breathe, and Intel

The Hub is the administration, support, billing, and knowledge center for
CareBase (PennTrain), Breathe (PennFit), and CareMetric Intel.
PennSync, EMR, Go, and Healthcare Advisors use their own support. Historical Hub
product identities, cases, memberships, and learning records are retained; new
connections, intake, delegated actions, and purchases for those apps are disabled.

- **Control center** (`/admin`): the administrator's home. Every application's
  connection health, subscriptions, users and organizations, Help SDK and
  administration-connection status, open cases, waiting conversations, published
  articles, customer intake and AI usage on one page, beside the five customer
  channels, the Hub service checks, AI usage by application and by customer, and
  an integration setup panel that shows which service variables are set
  (secrets by presence only). Every figure is read live and links into the
  workspace that manages it. The per-application workspace moved to
  `/admin/apps`. See [the control center](docs/CONTROL_CENTER.md).
- **Customer growth** (`/admin/growth`): CareBase and CareMetric Intel prospect research, reviewed outreach, onboarding and retention work, contact suppression, and cohort outcomes. Breathe is deferred. See [setup and operation](docs/CUSTOMER_GROWTH.md).
- **Communications** (`/communications`): customer service and technical
  support from the (877) 521-2890 phone line, text messages, email, website chat
  land in one queue with triage, internal notes and
  replies on the original channel. Text, email and chat stay off until their
  provider settings (or `HUB_CHAT_ENABLED`) are set. See
  [unified communications](docs/UNIFIED_COMMUNICATIONS.md).
- **Leads** (`/admin/leads`): every lead from the CareBase, Intel and Healthcare
  Advisors websites (demo and consultation requests, contact forms, trial and
  newsletter sign-ups, savings calculators and county reports), newest first,
  with where each person came from and a status to work it. Products forward
  leads server to server to the signed `POST /api/leads`; a person who asked to
  be contacted also gets a conversation in Communications. See
  [website leads](docs/LEAD_INTAKE.md).
- **Knowledge** (`/knowledge`): shared and app-specific articles for every
  supported application, with per-app coverage.
- **Billing** (`/admin/billing`): the only place CareMetric platform billing
  happens. Products and prices, every subscription across the applications with
  MRR and ARR, price changes (grandfather or move subscribers), coupons and
  promotion codes, customer-specific prices, trials, pause and cancel, and
  invoices, all in the CareMetric Stripe account. Tenant administrators see
  their plans and invoices at `/billing` and manage their payment method in the
  Stripe customer portal. Applications check entitlements and report billable
  quantities through the Hub. See [platform billing](docs/PLATFORM_BILLING.md).
- **Bulk email** (`/admin/email`): email the users of one or more applications,
  narrowed by role and account status read from each application's own user
  directory. Duplicates across applications and unsubscribed addresses are
  left out, every message has a one-click unsubscribe link, and delivery runs
  on the Hub through SendGrid. See [bulk email](docs/BULK_EMAIL.md).
- **Portfolio rollup** (`/admin/portfolio`): health, subscriber and subscription
  figures, and a live **super-admin coverage** matrix showing, per application,
  what the Hub holds now and what app-side work each gap needs.
- **Go-to-market facts** ([docs/GTM_FACTS.md](docs/GTM_FACTS.md)): the single
  source of truth for marketing claims about CareBase, Intel and Advisors (who
  each is for, live prices and trials, the founding-partner offer, the claims we
  may and may not make, and the fixed vocabulary). The AI team's Content
  Marketer writes help-center articles only from it, and nothing it drafts is
  published until the owner approves it on **AI team** (`/admin/team`); see
  [the AI team](docs/AI_TEAM.md#the-content-marketer).

What the Hub can show depends on what each application's administration
connection provides. As documented for each connection today:

| Application | Directory | Subscribers | Invoices & payments | Other |
| --- | --- | --- | --- | --- |
| CareBase (PennTrain) | Organizations, users | Subscriptions, status totals | Invoices, Stripe verification | Courses, facility training, jobs, releases, audit |
| Breathe (PennFit) | Organizations, staff | Subscriptions, status totals | Not provided yet | Shared phone-line messages |
| CareMetric Intel | Registered users only | Not provided yet | Not provided yet | |
| Healthcare Advisors | No software accounts | Not applicable (consulting practice) | Not applicable | Consultation requests: list, status, notes and delete ([connection](docs/ADVISORS_ADMIN_CONNECTION.md)) |

"Not provided yet" items need a read added to that application's
administration connection; the coverage matrix lists them live.

Apply `20261021120000_ai_usage_ledger.sql` and
`20261021120100_ai_usage_ledger_contract.sql` before deploying the control
center release: it records every Anthropic call in a private ledger attributed
to the application and customer, and connected builds require the
`support.ai-usage.v1` contract feature.

Apply `20261021140000_tenant_subscriptions.sql` and
`20261021140100_tenant_subscriptions_contract.sql` before deploying the tenant
setup release: pricing is a private, administrator-only record, and connected
builds require the `platform.admin.tenants.v1` contract feature.

Apply `20261021160000_bulk_email.sql` and `20261021160100_bulk_email_contract.sql`
before deploying the bulk email release; connected builds require the
`support.bulk-email.v1` contract feature. Sending needs `HUB_SENDGRID_API_KEY`.

Apply `20261022120000_learning_catalog_authoring_intents.sql` and
`20261022120100_learning_catalog_authoring_contract.sql` before deploying the
[central course authoring](docs/CENTRAL_COURSE_AUTHORING.md) release: the course
version controls can unpublish a course and correct a lesson of its live version,
and connected builds require the `learning.catalog-authoring.v1` contract feature.

The CareBase courses view includes the [training library](docs/TRAINING_LIBRARY.md):
elective collections, refresher lessons, course discovery details and starter kits,
saved through CareBase's catalog route. It needs no Hub migration.

CareBase courses can be [drafted with AI, and draft lessons regenerated or given an
avatar video](docs/AI_COURSE_GENERATION.md), through CareBase's generation route. It
needs no Hub migration.

A cloned CareBase draft's copied packages are [replaced from the course version
controls](docs/COURSE_PACKAGE_INGESTION.md#replacing-packages-in-a-cloned-draft). It needs
no Hub migration.

The Super Admin workspace now includes [facility training management](docs/FACILITY_TRAINING.md): create training-only facilities, invite administrators and students, manage enrollment and progress, open issued certificates, run complete printable/CSV reports and manage module access terms through the Hub session. Shared support, phone routing, course, onboarding and security workspaces are reachable from the same Admin page. The native CareBase `training.v1` capability gates these controls; deploy its migrations and adapter before this Hub update. Live owner verification remains separate from fixture testing.

CareBase course details include exact governed source review and native version
controls. An administrator loads a version, reviews its material and policy,
preserves that immutable source in the Hub, and previews a clone or publication.
The confirmation applies the same native command identity, including after a
connection failure. Every attempt rechecks current Hub and mapped CareBase
authority; CareBase remains the version, publication and completion writer.

The source view includes lesson bodies, assessment configuration and answer keys,
credit rules, provider evidence and package metadata. Private media paths are
excluded. Cloning preserves the published source and creates a draft that needs
its own AI review and accepted package replacements when applicable. These
controls do not yet edit draft content, record AI review or transfer media.

Deployment requires the native governed-authoring migration and adapter plus
`CAREMETRIC_LEARNING_AUTHORING_ENABLED=true` in CareBase, alongside its existing
administrator/command configuration. The Hub intent migration is
`20260911181309_learning_authoring_intents.sql`. Its private records pin source
evidence and native outcomes; they introduce no second course-content writer.
`20260911183517_governed_source_credential_keys.sql` also tightens recognized
credential fields in source JSON while preserving existing validator permissions.

CareMetric Support Hub is the first-party support, knowledge, media, learning, and product-contact platform for the CareMetric software portfolio. It is designed to replace duplicated help pages and disconnected ticket tables without introducing an outside help-desk vendor.

## Central learning release

The September 11 release deploys Hub authoring, publication, private video
playback, quizzes, learner progress, and completion records for newly authored
shared courses, with no HeyGen runtime dependency.
SDK 0.4.0 includes catalog, course-editor, and My Learning links. See
[the central learning contract and migration steps](docs/CENTRAL_LEARNING.md).
Existing CareBase courses keep their native launch paths. Their imported Hub
drafts cannot publish until quiz behavior, credits, and completion reporting are
connected. Media, identities, and legacy learning history still require verified
transfer. The owner must complete MFA before the privileged workflows can be
verified end to end.

## Current implementation status

For the September 10 portfolio audit and the proposed path to one-login
administration, shared course authoring, and consolidated SaaS billing, see
[the platform architecture audit](docs/PLATFORM_ARCHITECTURE_AUDIT.md).
The deployed Hub includes `/admin`, a searchable inventory of 97 app functions,
a read-only CareBase adapter client, and the central learning pilot. The CareBase
server adapter is deployed and its health and anonymous-denial probes passed;
the authenticated connection still requires owner-session verification. See
[the administrator connection](docs/CENTRAL_ADMIN_PILOT.md) and
[central learning](docs/CENTRAL_LEARNING.md) for their exact scope and deployment
order. Customer SSO, remaining app adapters, and CareBase course cutover are
still pending. Platform billing is consolidated in the Hub
([platform billing](docs/PLATFORM_BILLING.md)).

Version `0.1.0` now runs as the first production vertical slice:

- A unified customer portal and CareMetric agent console.
- Multi-product case intake, queue filtering, assignment, status and priority updates, customer replies, and staff-only notes.
- A canonical knowledge catalog with one-to-many product placements.
- A public learning library at `/learn` displaying 80 existing CareBase courses;
  search covers course titles, summaries, and categories. Existing course
  playback, quizzes, and completion continue through controlled CareBase launches.
- Native authoring and delivery for new Hub courses, including reviewed private
  media, server-graded quizzes, revision-pinned progress, and completion records.
- An SMS-verified `/admin` workspace with the app-function inventory and a
  CareBase connection for aggregate counts, shared course metadata, and lesson
  titles. Live authenticated adapter operations remain unverified.
- A governed import of 70 published CareBase help articles; no learner, employee, resident, organization, assignment, progress, or ticket records were copied.
- An owner-approved product/contact registry that publishes only approved contact values; mailbox delivery readiness is tracked separately.
- A framework-neutral `@caremetric/help-sdk` that opens Help or the shared Learning Library while passing only an allowlisted product and safe, static context.
- A dedicated `hub`/`private` Supabase schema design, RLS policies, narrow grants, atomic case RPCs, physically separate internal notes, and metadata-only audit records.
- [SMS sign-in](docs/APP_SMS_SIGNIN.md): a registered mobile number receives a six-digit code and the server issues an app session that every protected database path rechecks. Authenticator apps (TOTP) are turned off; the database keeps its legacy AAL2 checks only for existing integrations.
- Fail-closed, per-tenant/product case-intake settings plus UUID request keys that make case creation and replies safely retryable without putting support text in the idempotency ledger. Runtime checks immediately reject deleted, banned, or anonymous principals and keep dual-role staff/customer authority paths separate.
- A credential-free DocStudio publication preview plus an SMS-authorized [publication import executor](docs/PUBLICATION_IMPORTS.md): exact streamed asset checks, immutable catalog revisions, explicit placement confirmations, private media, and bounded staging cleanup.
- Pull-request CI for both the application and a clean local Supabase migration/pgTAP stack.
- A polished implementation preview that works without credentials. Demo mode is never a production data store.

The private GitHub repository, isolated `CareMetric Support Hub` Supabase project (`xgauehtwksmnoqhgqegm`, `us-east-2`), and Railway deployment are provisioned. The live portal is `https://support-hub-web-production.up.railway.app`; direct `/help` and `/learn` links use production routing rather than localhost. Railway also has `help.caremetric.ai` attached; it will remain unavailable until the owner creates the required Name.com CNAME recorded in [docs/PRODUCTION_ROLLOUT.md](docs/PRODUCTION_ROLLOUT.md). The September 11 Hub deployment is `c529172`; production has 28 migrations through `20260911142604_platform_admin_session_authorization.sql`, backend contract `2`, and version `1` of the `platform-admin` Edge Function. The Data API remains restricted to `hub`. Existing application databases remain independent; the deployed CareBase catalog import contains published platform metadata.

Owner-verified central routing is `(877) 521-2890` and `support@caremetric.ai`. `kdeyarmin@comcast.net` is the active platform administrator. The owner has confirmed that the applicable BAAs are signed; the remaining High Compliance controls still require operational verification before PHI-capable intake is enabled.

## Ownership boundary

CareMetric owns the application, schema, workflows, case history, content revisions, media catalog, integration contract, exports, and backups.

Infrastructure is replaceable:

- Supabase supplies hosted Postgres, Auth, and private Storage.
- The Hub accepts reviewed videos with captions and transcripts; no video vendor is required for course delivery.
- The Hub owns authoring and delivery for new shared courses. CareBase retains
  its existing course runtime and learning records. A new course published in
  the Hub opens at `/learn/courses/<uuid>`; imported CareBase drafts remain
  blocked from publication and retain their validated native launch.
- Email and telephone providers deliver messages/calls but do not own case history.

## Architecture

```mermaid
flowchart TD
  Apps["CareMetric apps"] --> SDK["Help SDK"]
  Portal["Customer portal"] --> Hub["Support Hub"]
  Console["Agent console"] --> Hub
  SDK --> Hub
  Hub --> DB["Dedicated Supabase project"]
  Hub --> Content["Knowledge + media catalog"]
  Hub --> Learning["Course authoring + delivery"]
  Learning --> DB
  Learning --> Media["Private reviewed media"]
  PennTrain["Legacy CareBase courses"] --> Import["Reviewed draft import"]
  Import --> Learning
```

The first deployment is a modular monolith. Services can be extracted only when scale, risk, or operational ownership justifies the additional failure modes.

## Run locally

Requirements: Node.js 22 or newer.

```bash
npm install
cp .env.example .env.local
npm run dev
```

`VITE_DEMO_MODE=true` starts the in-memory implementation preview. Use the Staff/Customer switch to verify both experiences. The preview rejects a case marked as containing patient or clinical information.

`VITE_DEMO_MODE` must always be set explicitly. When it is `false`, both the
production build and browser startup fail closed unless both browser-safe
Supabase values are present; a missing production variable can never silently
expose the in-memory preview. Production builds also reject demo mode itself.
CI sets the non-browser `SUPPORT_HUB_ALLOW_DEMO_BUILD=true` escape hatch only
for its credential-free preview build; never set that variable in Railway.

Run the complete application check:

```bash
SUPPORT_HUB_ALLOW_DEMO_BUILD=true VITE_DEMO_MODE=true npm run check
```

That escape hatch is for this credential-free local verification only. A
connected check can instead use `VITE_DEMO_MODE=false` with both Supabase
browser variables present.

Connected builds also call the public, data-free `hub.get_backend_contract()`
RPC and require API version `4` plus every feature in
`src/lib/backendContract.ts`. The Node server uses the same assertion at startup.
Apply the reviewed migration chain through
`20260911190819_combined_authoring_publication_support_contract.sql` before deploying
this release. The [combined release contract](docs/BACKEND_RELEASE_CONTRACT.md)
lists the guarded SQL dependencies and the separate hosted verification steps.
Missing/incompatible contracts or connection failures stop deployment. Use a
modern `sb_publishable_` key; the build probe rejects secret and legacy keys.
Preview builds keep their explicitly enabled, credential-free CI path.

## Connect the production backend

Do not connect this application to `CM Train`, PennFit, CMbackup, or any other existing production database. Create one dedicated Support Hub project in the selected Supabase organization.

1. Confirm the signed BAAs and verify the required Supabase HIPAA add-on, MFA, PITR, SSL enforcement, and network restrictions before enabling PHI-capable support.
2. Expose only the `hub` schema through the Data API. Never expose `private`.
3. Apply the reviewed files in `supabase/migrations`; `supabase/schema.sql` is the consolidated reference schema.
4. Run database/security advisors and the pgTAP tests.
5. Keep every production change represented by a reviewed, idempotent migration.
6. Configure `VITE_SUPABASE_URL` and the publishable key. Never put a secret or service-role key in a browser variable.
7. Register each staff account's mobile number for [SMS sign-in](docs/APP_SMS_SIGNIN.md), then provision product entitlements, tenant memberships, and explicit staff permissions.
8. Explicitly activate case intake for each approved tenant/product only after a non-banned support writer with `case.write` or `platform.admin` has a verified SMS sign-in number. A missing setting remains disabled.
9. Verify the published central routing remains `(877) 521-2890` and `support@caremetric.ai`.
10. Set `VITE_DEMO_MODE=false`, build, and deploy.

Supabase changed new-project Data API exposure defaults in 2026. The schema therefore includes explicit grants, but the project must also explicitly expose `hub` in its API settings.

## PHI gate

The initial release is deliberately non-PHI:

- The intake requires a no-PHI acknowledgment and blocks submission when the requester says PHI is present.
- There are no customer attachment uploads.
- No ticket text is sent to HeyGen, analytics, AI retrieval, logs, or search indexing.
- Inbound free text is still conservatively classified `possible_phi` in the database.

Production case intake is now also gated in the database and defaults off. Do not create an activation row until the exact project is approved for the intended data class, tenant/product membership is provisioned, an SMS-verified staff route exists, and the controls in [SECURITY.md](SECURITY.md) are operational.

## Repository structure

```text
src/                         portal and agent console
src/data/                    demo and Supabase repository adapters
src/imports/                 credential-free publication validation and preview planning
src/security/                executable security-contract tests
packages/help-sdk/           cross-product contextual help launcher
supabase/schema.sql          migration-ready schema source
supabase/tests/              pgTAP schema/security checks
docs/                        API, integration, and rollout guidance
```

## Source applications

- PennTrain is the canonical CareBase source for help, courses, learning
  execution, and existing HeyGen render metadata.
- Breathe and Intel use their deployed native self-service adapters and central Help launchers.
- PennSync, EMR, Go, and Healthcare Advisors are independent of this Hub. Their
  retired product identifiers and historical contracts are retained for archival reads.
- DocStudio is retired. PR #85 removed its application runtime;
  `20261022210000_retire_docstudio.sql` removes its private database objects and
  `knowledge.docstudio.v1` declaration. The shared publication importer,
  `publication-media` transport and existing source provenance remain supported.

The first CareBase snapshot now includes 80 published courses and 70 published help articles. The DocStudio preview remains pure; the separate publication executor applies reviewed changes through current Hub permissions and private immutable asset storage. Deployment requires the reviewed migration and protected Edge transport described in [Publication imports](docs/PUBLICATION_IMPORTS.md). Legacy source IDs are provenance only; stable Support Hub `content_key` values are canonical.

See [docs/PRODUCTION_ROLLOUT.md](docs/PRODUCTION_ROLLOUT.md) for the verified
application-by-application deployment record, excluded duplicate/prototype
repositories, and the exact owner-controlled prerequisites that remain.

See [docs/VIDEO_GOVERNANCE.md](docs/VIDEO_GOVERNANCE.md) for the verified
HeyGen/Storage inventory and the caption, checksum, and entitlement gates for
reviewed media uploads and source-course transfer.


### Governed CareBase lesson media

The lesson media controls use the native `learning.media.v1` capability. Uploads are streamed to the fixed CareBase media endpoint with exact size and SHA-256 binding (PDF up to 25 MiB; MP4/WebM up to 100 MiB). A separate confirmation attaches a verified immutable asset to the current draft. Each step rechecks the original SMS authority and the preserved source revision. Stored locations and playback tokens never enter the Hub source snapshot.

Saved native operation IDs support receipt observation across sessions; a new session cannot finish an older session's pending upload. Committed receipts do not advance the Hub source head: reload and explicitly preserve the resulting material before editing again. PDF and video previews use the authenticated same-origin byte route with bounded single ranges. Native learner access remains governed by the native assignment/published-course resolver.

The additive `learning.media.v1` backend feature declares support for optional immutable source references. Native writes additionally require the separately deployed `CAREMETRIC_ADMIN_MEDIA_ENABLED` flag (default false), the native administrator/command flags, and current native authorization. This repository change alone does not enable a native deployment. Integrity/format verification is separate from human course-content review.
