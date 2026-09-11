# Governed learning migration

CareBase remains the authority for its existing course assignments, progress, assessment evidence, certificates, renewals, and compliance records. The Hub can create new generic courses, and can now preserve immutable CareBase course snapshots for migration review. Preserving a snapshot does not publish, edit, retire, launch, or complete a course. The existing imported-course publication guard remains in place.

## Why a generic draft is insufficient

CareBase has three quiz purposes (`assessment`, `knowledge_check`, `final_exam`), question/answer shuffling, controlled answer review, topic feedback, multiple-choice and true/false questions, and per-attempt passing thresholds. A final examination score has a different certificate/report meaning from a formative knowledge check. Attestation evidence snapshots the exact statement and its version.

Comprehensive courses also enforce final-step progress, applied responses, designed engagement time, and package completion. Credited duration can differ from delivery time under an explicit recorded exception. Version-scoped credit crosswalks distinguish automatic hours from coverage requiring separate verification. Recurrence controls re-enrollment and certificate expiry; a renewal training-type bridge advances a requirement clock separately from annual credited hours. Provider identity and credentials are snapshotted at certificate issuance. A new generic Hub completion cannot replace these contracts.

Native implementation evidence: CareBase migrations `20260715210000_individual_course_compliance_credits.sql`, `20260715212000_comprehensive_course_content_standard.sql`, `20260830120000_annual_diabetes_education_foundations.sql`, `20260830170000_credited_duration_may_exceed_delivery.sql`, `20260830180000_exempt_diabetes_course_from_credited_duration_checks.sql`, `20260830210000_snapshot_certificate_provider_at_issuance.sql`, and `20260905200000_a_package_finished_the_course_and_issued_nothing.sql`. The last migration deliberately removed a second completion writer; package completion now feeds the same assignment completion path that issues certificates and credit evidence.

## Snapshot contract and exact field boundary

[`carebase.course.v1`](../src/imports/governedLearningImport.ts) preserves these explicit fields. Strict objects reject unknown fields instead of silently dropping future behavior. Authoring `body` and package `manifest` JSON remain complete within this envelope; they are private source material and are never rendered to learners by the snapshot APIs.

| Object | Allowed fields | Preserved meaning |
| --- | ---: | --- |
| Course envelope | 12 | Contract, native course/version identifiers and number, both publication states, course/version/blocks/credits/provider/packages |
| Course metadata | 9 | Title, description, category, catalog code, credited duration, recurrence, legacy/renewal training-type references, duration exemption |
| Version metadata | 7 | Version title/description/label, content standard, duration rationale, AI provenance/review timestamp |
| Block | 8 | Stable ID/order/type/title, complete authoring body, document reference, video locator checksum, quiz |
| Quiz | 9 | Stable ID/title, threshold, attempt limit, purpose, three behavior flags, questions |
| Question | 9 | Stable ID/order, prompt/type/points, topic code/label, explanation, options |
| Answer option | 4 | Stable ID/order, answer text, correctness |
| Credit crosswalk | 7 | Stable ID, native training-type reference, topic, exact decimal hours, mode, citation, active state |
| Provider profile | 16 | Certificate/provider metadata and clinical/regulatory maintenance information; excludes account actor IDs |
| Package reference | 8 | ID, standard, content checksum, relative entry point, manifest, capabilities, connectivity, validation state |

The source course version UUID is an opaque identifier, not a complete policy revision. Mutable course, provider, credit, and publication fields are included in the checksum. `sourceRevision` is SHA-256 over the exact UTF-8 `payload` string emitted from PostgreSQL JSONB text. Consumers must retain those bytes and must not parse/re-serialize before checking the digest. The hash detects corruption; it does not authenticate who exported the source. Staging therefore requires an authenticated, MFA-verified portfolio course editor and an existing native catalog link.

The outer export declares `global-courses-with-current-version`. It includes draft, published, and archived source courses with a current version, and excludes organization-owned courses and organization-owned descendants. It is not a deletion feed: a missing course, or one without a current version, must never be interpreted as retired. Source `publicationState = archived` is explicit review evidence; it does not automatically change the Hub publication.

No employee, account, organization, assignment, attempt, progress, certificate, or training-record table is exported. Video URLs become a checksum tied to the source block ID; this is a **locator checksum**, not proof of media-byte integrity. Documents and packages remain references. The exporter does not fetch assets, copy private files, or sign URLs. Recognized credentials, signed URL parameters, and storage/playback fields inside retained JSON cause the entire export to return a fixed error instead of payloads; an authorized operator must still review authored text for private data. This is a content-policy snapshot, not a claim that every native table, historical revision, media file, or runtime behavior has been migrated.

## Run and review

1. An authorized CareBase operator runs the single read-only statement in [export-carebase-governed-learning.sql](../scripts/export-carebase-governed-learning.sql), saves only its JSON result privately, and reviews it. It includes answer keys and provider metadata; never commit it or send it to a learner-facing endpoint.
2. Rehearse offline with `node scripts/rehearse-governed-learning-import.mjs snapshot.json`. This command never connects to a database. It reports only aggregate counts and validation status, with publication disabled. Errors omit payloads and input paths.
3. In the Hub course editor, choose the governed export and review its counts. **Preserve source snapshots** calls `hub.stage_learning_source` explicitly. The older array export still prepares generic drafts; it cannot express this governed policy.
4. Staging compares the head revision loaded during preview. A changed head produces a conflict requiring a fresh preview. The same source digest replays idempotently; replaying an older digest never rewinds the head. New metadata or retirement appends a snapshot even if the native version UUID is unchanged. Partial batches keep completed snapshots, and retrying cannot overwrite draft edits.
5. `hub.list_learning_source_heads` returns metadata only. `hub.get_learning_source_snapshot` returns exact preserved source bytes only to the same portfolio editor permission. There are no direct authenticated table grants, learner projections, or update/delete APIs for these immutable source snapshots. Audit events contain only source hashes and sequence numbers.

The server uses `extensions.jsonb_matches_schema` from `pg_jsonschema`. CI must replay the new migration and pgTAP contracts. The TypeScript test compares the generated JSON Schema in the migration to the client definition. Deployment requires the new RPCs before using this UI path; the release owner manages the backend contract bump. No production migration or source export is performed by the rehearsal script or tests.

## Next implementation and cutover

Implement a version-pinned completion receipt bridge first. CareBase continues to run its current `complete_course_assignment` path; a transactional outbox records a pointer after a completed assignment/certificate transition. Delivery reads committed evidence and emits a minimal, versioned receipt with the native assignment/certificate IDs, mapped tenant/learner IDs, original completion time, source course/version and reviewed source-revision identity. Do not copy free-text learner responses, source provider playback credentials, or existing learner history. The Hub validates source identity, mappings and the pinned course revision before accepting a receipt; its deduplication key must prevent retries from issuing new credits or moving completion dates. Amendments and certificate revocation need explicit ordered events, not overwriting past evidence.

The first receiver records native evidence for central reporting; it must not call a second credit or certificate writer. Acceptance fixtures must cover assigned historical versions, same-version policy changes, automatic versus verified-only credits, recurring re-enrollment, final-exam score selection, exact attestation, certificate/provider snapshots, retry/concurrency, stale identity mappings, tenant isolation and revocation.

Only after those contracts and the corresponding Hub runtime behaviors have parity may a reviewed per-course cutover make the Hub the single authoring/publishing authority for future versions. Keep historical assignments and certificates pinned to their native versions. Native adapters consume immutable Hub publications and route completion to one designated evidence writer; they must never independently edit the same course or issue the same credit. Switch new assignments by explicit course/version ownership, retain native launch fallback for all unmigrated assignments/media, and reconcile receipt totals before removing any legacy writer. Snapshot preservation alone does not satisfy that cutover gate.
