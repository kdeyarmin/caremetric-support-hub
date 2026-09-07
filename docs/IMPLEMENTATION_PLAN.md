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
- Public production `/help` and `/learn` routes at the Railway origin.
- A non-PHI CareBase snapshot containing 80 published courses, 70 published help articles, 22 categories, and metadata for 65 video lessons.
- Searchable, browsable titles for all 65 current video lessons without exposing private media locators.
- Reconciliation of all 65 current video lessons to completed HeyGen jobs and
  existing private CareBase Storage objects; playback remains in CareBase.
- An installable, dependency-free `@caremetric/help-sdk` with a production URL default and fail-closed context validation.
- Live central Help launchers in CareMetric EMR and the CareMetric Breathe admin
  experience, a published PennSync launcher, plus a live portfolio-level
  Software Help Center on PennSite.
- A registered CareMetric Go product with the governed 80-course catalog and
  two explicitly approved shared-core articles; no private learning data or
  provider URLs were copied.
- A registered CareMetric Intel pilot with the same governed shared-course and
  core-safety boundaries; its existing product guide remains review-gated.
- Database-enforced TOTP/AAL2 for all staff principals and customers who opt into TOTP.
- Default-off tenant/product case-intake settings and idempotent keyed case/reply RPC overloads, with no production activations seeded.
- `@caremetric/help-sdk` 0.3 Help and Learning launchers; Learning accepts only an optional registered product slug.
- Canonical CareBase course launches pinned to `https://cmcarebase.com/app/courses` and UUID course-detail routes.
- A deterministic DocStudio publication-import preview boundary that requires the upstream PHI-review attestation, conservatively rejects obvious identifier/unsafe-link patterns, verifies asset hashes, and performs no write, upload, fetch, retirement, or deletion. The scan is not a PHI certification, especially for video pixels.
- Pull-request CI that starts an isolated Supabase stack and executes the migration chain plus pgTAP contracts.

## Phase 1 — provision and validate

1. ✅ Create the private GitHub repository.
2. ✅ Create a dedicated Supabase project in the selected organization and region.
3. Confirm signed BAAs and complete operational verification of the remaining High Compliance prerequisites before accepting PHI-capable support traffic.
4. ✅ Apply the schema iteratively, fix blocking advisors, and record the official migrations.
5. ✅ Provision the first CareMetric platform administrator through a one-time audited bootstrap script, then permanently close bootstrap.
6. Add the first tenant/product memberships.
7. ✅ Deploy the portal at the production Railway URL.

Exit criteria:

- All RLS allow/deny tests pass.
- A customer can create and reply only within an entitled product.
- A product agent cannot access another product without explicit permission.
- Staff-only notes are absent from every customer response.
- Cases, messages, and audits survive export/restore testing.

## Phase 2 — application launchers

1. Build and version the installable `@caremetric/help-sdk` tarball; consume it from each application's private source tree until a CareMetric-owned package registry is approved.
2. ✅ Add the launcher to PennFit/CareMetric Breathe with product slug, version, environment, and route template only.
3. Build the server-signed context exchange and verified identity mapping.
4. ✅ Keep the verified CareMetric EMR, CareMetric Breathe, PennSync, and CareBase launchers behind application-owned rollback controls or local-help fallbacks.
5. Compare route resolution, no-result searches, and case-context quality.

Exit criteria:

- No personal or clinical values appear in launcher URLs, logs, or analytics.
- Tampered or replayed context tokens fail.
- Disabling membership blocks access immediately.
- ✅ PennFit and CareMetric EMR can switch back to local help without a deployment rollback.

## Phase 3 — content migration

1. ✅ Import published, organization-neutral PennTrain help articles and course metadata through an idempotent non-PHI migration.
2. ✅ Build the first-party DocStudio validation/hash/dry-run planner. Connect a separate authenticated approval and commit boundary before importing any article, media manifest, or source script.
3. Reconcile PennFit’s patient and staff help stores.
4. Reconcile PennSync’s divergent static help pages.
5. Classify each record as shared core, product overlay, or independent content.
6. Preserve legacy paths through redirects and freeze legacy editing after cutover.

Requirements for the follow-on incremental synchronizer (the current import is
a reviewed, one-time snapshot):

- Stable `content_key` values are canonical.
- Revisions are immutable.
- Re-delivery of the identical source revision and package is a no-op; a newly approved source revision preserves its provenance even when asset bytes happen to match.
- Older source versions never overwrite newer versions.
- Deletes retire content rather than erasing published history.
- Preview and approval are required before commit.

The current preview implementation deliberately stops before transport or commit. It accepts no credentials or tenant/user identity, has no network or persistence path, requires captions and a timed WebVTT plus transcript for video, verifies declared primary/sidecar SHA-256 values, caps input and revision history, binds governance and the catalog-snapshot hash into plan identities, enforces strictly increasing `docstudio-vN` source revisions, and converts removals/replacements only into explicit approval actions.

## Phase 4 — video and learning

1. Add a server-only HeyGen v3 renderer tied to an approved content revision.
2. Use an idempotency key based on revision, product, locale, template, and input hash.
3. Download the final MP4 and captions; do not publish a temporary HeyGen URL.
4. Human-review captions and transcript.
5. Store the final asset privately and publish a stable Hub pointer.
6. ✅ Import PennTrain course metadata and trusted relative launch paths only.
7. ✅ Pin every Hub course launch to the canonical CareBase HTTPS origin and the exact catalog/UUID-detail route shapes.

HeyGen receives synthetic, approved, PHI-free scripts and screenshots only. PennTrain remains the owner of enrollment, completion, quiz, and certificate records.

## Phase 5 — channels and operations

- ✅ Publish the owner-verified central support routes: `(877) 521-2890` and `support@caremetric.ai`.
- ✅ Add default-off case-intake activation and request-key idempotency. No production tenant/product is activated yet.
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
