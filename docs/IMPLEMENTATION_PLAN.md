# Implementation plan

## Completed in the first slice

- Product-neutral repository and application shell.
- Customer and staff support experiences.
- Case/message domain contract with atomic repository operations.
- Shared article, video, and course catalog model.
- Product/contact registry with verified-publication semantics.
- Headless integration SDK and safe URL-context tests.
- Migration-ready dedicated Supabase schema, RLS, grants, RPCs, audit boundaries, and initial seed catalog.
- Automated type, lint, unit, security-contract, and production-build checks.

## Phase 1 — provision and validate

1. Create the private GitHub repository.
2. Create a dedicated Supabase project in the selected organization and region.
3. Configure High Compliance prerequisites before accepting support traffic.
4. Apply the schema iteratively, fix advisors, and generate the official migration.
5. Provision the first CareMetric platform administrator through a one-time audited bootstrap script.
6. Add the first tenant/product memberships.
7. Deploy the preview behind an internal-only Railway URL.

Exit criteria:

- All RLS allow/deny tests pass.
- A customer can create and reply only within an entitled product.
- A product agent cannot access another product without explicit permission.
- Staff-only notes are absent from every customer response.
- Cases, messages, and audits survive export/restore testing.

## Phase 2 — PennFit SDK pilot

1. Publish `@caremetric/help-sdk` from a private package source or consume it by pinned Git commit.
2. Add the launcher to PennFit with product slug, version, environment, and route template only.
3. Build the server-signed context exchange and verified identity mapping.
4. Add a feature flag and keep PennFit’s local help as a temporary fallback.
5. Compare route resolution, no-result searches, and case-context quality.

Exit criteria:

- No personal or clinical values appear in launcher URLs, logs, or analytics.
- Tampered or replayed context tokens fail.
- Disabling membership blocks access immediately.
- PennFit can switch back to local help without a deployment rollback.

## Phase 3 — content migration

1. Import PennTrain help articles and course metadata in preview mode.
2. Import DocStudio articles, media manifests, and source scripts.
3. Reconcile PennFit’s patient and staff help stores.
4. Reconcile PennSync’s divergent static help pages.
5. Classify each record as shared core, product overlay, or independent content.
6. Preserve legacy paths through redirects and freeze legacy editing after cutover.

Import guarantees:

- Stable `content_key` values are canonical.
- Revisions are immutable.
- Identical checksums are no-ops.
- Older source versions never overwrite newer versions.
- Deletes retire content rather than erasing published history.
- Preview and approval are required before commit.

## Phase 4 — video and learning

1. Add a server-only HeyGen v3 renderer tied to an approved content revision.
2. Use an idempotency key based on revision, product, locale, template, and input hash.
3. Download the final MP4 and captions; do not publish a temporary HeyGen URL.
4. Human-review captions and transcript.
5. Store the final asset privately and publish a stable Hub pointer.
6. Import PennTrain course metadata and trusted relative launch paths only.

HeyGen receives synthetic, approved, PHI-free scripts and screenshots only. PennTrain remains the owner of enrollment, completion, quiz, and certificate records.

## Phase 5 — channels and operations

- Verify and publish one central support email and one central support phone route.
- Add email ingestion with idempotent provider-message envelopes.
- Add telephone call disposition and case-linking adapters without making the carrier the case system.
- Implement versioned SLA calendars and deadlines.
- Add safe aggregate analytics for volume, response time, resolution, article deflection, video reuse, and course launches.
- Add backup/restore drills and documented provider-replacement procedures.

## Explicitly deferred

- Customer file attachments.
- AI analysis of ticket bodies.
- Public anonymous case intake.
- Telephone recording/transcription.
- Automatic content deduplication.
- Automatic translation.
- Migration of learner progress into the Hub.
- Consolidation of clinical databases or product authentication databases.
