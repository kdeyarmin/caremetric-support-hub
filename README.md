# CareMetric Support Hub

CareMetric Support Hub is the first-party support, knowledge, media, course-catalog, and product-contact platform for the CareMetric software portfolio. It is designed to replace duplicated help pages and disconnected ticket tables without introducing an outside help-desk vendor.

## Current implementation status

Version `0.1.0` now runs as the first production vertical slice:

- A unified customer portal and CareMetric agent console.
- Multi-product case intake, queue filtering, assignment, status and priority updates, customer replies, and staff-only notes.
- A canonical knowledge catalog with one-to-many product placements.
- Shared CareBase course metadata and course-level HeyGen video counts. The
  current Hub is launch-only; it does not expose or proxy private video files.
- A public, searchable learning library at `/learn` with 80 governed CareBase courses across 22 categories and 65 cataloged video lessons.
- A governed import of 70 published CareBase help articles; no learner, employee, resident, organization, assignment, progress, or ticket records were copied.
- A verified product/contact registry that refuses to publish fake or unverified phone/email values.
- A framework-neutral `@caremetric/help-sdk` that passes only safe product context.
- A dedicated `hub`/`private` Supabase schema design, RLS policies, narrow grants, atomic case RPCs, physically separate internal notes, and metadata-only audit records.
- A polished implementation preview that works without credentials. Demo mode is never a production data store.

The private GitHub repository, isolated `CareMetric Support Hub` Supabase project (`xgauehtwksmnoqhgqegm`, `us-east-2`), and Railway deployment are provisioned. The live portal is `https://support-hub-web-production.up.railway.app`; direct `/help` and `/learn` links use production routing rather than localhost. The live database has the reviewed migrations in `supabase/migrations`, RLS enabled on every application table, and a Data API restricted to `hub`. Existing application databases remain independent; the CareBase catalog import reads only published platform metadata.

Owner-verified central routing is `(877) 521-2890` and `support@caremetric.ai`. `kdeyarmin@comcast.net` is the active platform administrator. The owner has confirmed that the applicable BAAs are signed; the remaining High Compliance controls still require operational verification before PHI-capable intake is enabled.

## Ownership boundary

CareMetric owns the application, schema, workflows, case history, content revisions, media catalog, integration contract, exports, and backups.

Infrastructure is replaceable:

- Supabase supplies hosted Postgres, Auth, and private Storage.
- HeyGen renders approved videos but is not the source of truth and never receives PHI.
- PennTrain executes courses, tests, assignments, and certificates; the Hub owns the cross-product searchable course catalog.
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
  Content --> HeyGen["HeyGen render adapter"]
  Content --> PennTrain["CareBase course catalog"]
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

Run the complete application check:

```bash
npm run check
```

## Connect the production backend

Do not connect this application to `CM Train`, PennFit, CMbackup, or any other existing production database. Create one dedicated Support Hub project in the selected Supabase organization.

1. Confirm the signed BAAs and verify the required Supabase HIPAA add-on, MFA, PITR, SSL enforcement, and network restrictions before enabling PHI-capable support.
2. Expose only the `hub` schema through the Data API. Never expose `private`.
3. Apply the reviewed files in `supabase/migrations`; `supabase/schema.sql` is the consolidated reference schema.
4. Run database/security advisors and the pgTAP tests.
5. Keep every production change represented by a reviewed, idempotent migration.
6. Configure `VITE_SUPABASE_URL` and the publishable key. Never put a secret or service-role key in a browser variable.
7. Provision product entitlements, tenant memberships, and explicit staff permissions.
8. Verify the published central routing remains `(877) 521-2890` and `support@caremetric.ai`.
9. Set `VITE_DEMO_MODE=false`, build, and deploy.

Supabase changed new-project Data API exposure defaults in 2026. The schema therefore includes explicit grants, but the project must also explicitly expose `hub` in its API settings.

## PHI gate

The initial release is deliberately non-PHI:

- The intake requires a no-PHI acknowledgment and blocks submission when the requester says PHI is present.
- There are no customer attachment uploads.
- No ticket text is sent to HeyGen, analytics, AI retrieval, logs, or search indexing.
- Inbound free text is still conservatively classified `possible_phi` in the database.

Production must not accept real support requests until the dedicated project is High Compliance and the controls in [SECURITY.md](SECURITY.md) are operational.

## Repository structure

```text
src/                         portal and agent console
src/data/                    demo and Supabase repository adapters
src/security/                executable security-contract tests
packages/help-sdk/           cross-product contextual help launcher
supabase/schema.sql          migration-ready schema source
supabase/tests/              pgTAP schema/security checks
docs/                        API, integration, and rollout guidance
```

## Source applications

- PennTrain supplies the strongest existing ticket, knowledge, course, and HeyGen patterns.
- DocStudio remains the content-production factory.
- PennFit is the recommended first external SDK pilot.
- PennSync and CareMetric EMR follow after the pilot validates identity and route context.

The first CareBase snapshot now includes 80 published courses and 70 published help articles. Content is imported through previewable, idempotent adapters. Legacy source IDs are provenance only; stable Support Hub `content_key` values are canonical.

See [docs/VIDEO_GOVERNANCE.md](docs/VIDEO_GOVERNANCE.md) for the verified
HeyGen/Storage inventory and the caption, checksum, and entitlement gates for
future inline playback.
