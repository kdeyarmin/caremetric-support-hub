# Consolidated content inventory

Status date: 2026-09-07

This register separates content that is approved and live in the Support Hub
from source material that has only been inventoried. A source manifest passing
validation proves that its snapshot, identifiers, paths, classifications, and
safety checks are internally consistent; it does **not** approve the content
for publication.

## Approved live catalog

The live catalog has six registered product placements:

| Product | Slug | Anonymous catalog |
| --- | --- | ---: |
| CareMetric CareBase | `carebase` | 80 courses + 1 public safety article |
| CareMetric Breathe | `breathe` | 80 courses + 1 public safety article |
| PennSync | `pennsync` | 80 courses + 1 public safety article |
| CareMetric EMR | `caremetric-emr` | 80 courses + 1 public safety article |
| CareMetric Go | `caremetric-go` | 80 courses + 1 public safety article |
| CareMetric Intel | `caremetric-intel` | 80 courses + 1 public safety article |

The 80 courses are governed CareBase course records across 22 categories. The
single public article shared by all six products is
`support.protect-patient-information`. It tells requesters not to include PHI
in a support request.

Two additional reviewed placements are authorization-gated for every product:

- `account.invite-user`, a customer-only core article; and
- `course.team-onboarding`, a customer-only course-catalog entry for customer
  administrators and managers.

Consequently, each product has 81 governed course placements and two reviewed
core-article placements, but an anonymous request returns only the 80 public
courses and the one public safety article. Customer-only placement does not
grant access by itself; the Hub still applies membership, product entitlement,
and audience checks.

CareBase also has 70 published, customer-only help articles from the reviewed
CareBase snapshot. These remain CareBase-scoped and are not automatically
shared with the other products. Articles carrying source-role restrictions
remain fail-closed for staff review until the source roles have an explicit,
reviewed mapping to Hub roles.

## Live learning and video metadata

CareBase remains the learning system of record. The Hub provides discovery and
launches an authorized learner into CareBase; it does not copy learning
activity or serve private video bytes.

| Verified production inventory | Count |
| --- | ---: |
| Published CareBase courses | 80 |
| Courses containing video | 7 |
| Current published video blocks | 65 |
| Blocks matched to completed HeyGen jobs | 65 / 65 |
| Blocks matched to private CareBase Storage objects | 65 / 65 |
| Searchable lesson titles in the Hub | 65 |
| Current stored media | 986,673,769 bytes (~941 MiB) |
| Current video duration | 154.91 minutes |
| Caption/subtitle sidecars | 0 |
| SHA-256 asset-manifest entries | 0 |

The Hub exposes safe course and lesson metadata only: titles, summaries,
categories, durations, counts, and governed relative launch paths. Playback is
resolved after authentication by CareBase using a short-lived signed URL to
its private `course-videos` bucket. Twelve current blocks use the preferred
`storage://course-videos/...` locator; 53 retain a legacy
public-endpoint-shaped locator that CareBase resolves to the same private
bucket. Those 53 locators are a guarded normalization task, not public assets.

The wider HeyGen reconciliation contains 169 records: 127 completed, 11
pending, and 31 failed. Of the completed CareBase renders, 65 are referenced by
current course blocks and 32 are unreferenced. There are also 22 duplicate
CareBase title groups and one unreferenced stored object. The unreferenced,
duplicate, failed, pending, and orphaned items are investigation queues; none
is approved for automatic publication or deletion. See
[VIDEO_GOVERNANCE.md](VIDEO_GOVERNANCE.md) for the asset workflow.

## Validated review queues — not published

These three manifests contain static, source-authored, non-PHI candidates.
None of their entries was published merely because it appears in an inventory,
and a `shared-core` classification means *candidate for editorial extraction*,
not approved shared content.

| Source snapshot | Manifest records | Shared-core candidates | Product overlays | Current disposition |
| --- | ---: | ---: | ---: | --- |
| CareMetric Breathe — `kdeyarmin/PennFit@c92b0b2` | 135 | 15 | 120 | Review queue; route and product terminology must be parameterized before any core extraction. |
| CareMetric EMR — `kdeyarmin/CMbackup@9718b07c` | 94 | 9 | 85 | Review queue; grouped records represent 218 primary authored units and overlapping FAQ surfaces require reconciliation. |
| PennSync — `kdeyarmin/CareMetric-Pennsync@11ccc85e` | 104 | 30 | 74 | 89 review-required, 2 held, and 13 outline-only; no entry is auto-publishable. |
| **Inventory total** | **333** | **54** | **279** | Planning count only; source granularities differ and cross-source duplicates have not yet been collapsed. |

### CareMetric EMR–Breathe dedupe result

A deterministic comparison expanded the 94 grouped EMR records into 218
atomic units and compared all of them with the 135 Breathe records. It evaluated
29,430 cross-product pairs.

| Result | Count | Publication meaning |
| --- | ---: | --- |
| Raw/basic exact-title matches | 0 | No automatic merge is justified. |
| Normalized-title matches | 2 | Both require review; one is a low-specificity single-token collision. |
| Likely semantic-overlap candidates | 40 | Candidate pairs only, not confirmed duplicates. |
| Proposed canonical shared-core groups | 11 | Proposal-only and not published. |
| Product-overlay domains that must remain separate | 9 | Preserve product-specific routes, roles, workflows, vendors, and rules. |
| Conflicting guidance items | 9 | Hold for explicit human resolution. |

The report validated its pair accounting and non-PHI/source-boundary checks.
Every proposed core group remains review-gated: the comparison supplies an
editorial worklist, not publication authority. In particular, normalized-title
or semantic similarity must never overwrite product-specific instructions or
resolve contradictory clinical, billing, security, SLA, retention, messaging,
browser-support, integration, or regulatory guidance automatically.

### CareMetric Breathe

The Breathe manifest includes 126 primary in-app records and nine supplemental
assets: 52 how-tos, 17 guide chapters, 57 FAQs, and nine manuals, templates, or
tutorial assets. Its content-key, source-path, static-route, contact-value, and
assistant-index checks passed.

The 15 core candidates still contain Breathe-oriented names or routes in some
source text. They must be rewritten into a product-neutral canonical article
with render-time product and route variables. The 120 CPAP, DME, insurance,
patient-workflow, and Breathe-navigation records remain Breathe overlays. The
content-as-data arrays are authoritative; the administrator-assistant prompt
and flattened search index are derived consumers and must not be imported as
duplicate articles.

### CareMetric EMR

The EMR manifest has 94 grouped records representing 218 primary authored
units: 27 guides, 80 public-FAQ questions, 20 in-app FAQ questions, 16 manual
modules, 21 troubleshooting scenarios, six quick checks, five role tracks,
seven CCM sections, eight FHIR sections, and 28 chatbot support intents. Its
snapshot, source-path, identifier, route-context, contact/identity, and secret
checks passed.

The FAQ, comprehensive-help, in-app, manual, troubleshooting, and chatbot
surfaces overlap. They must be reduced to one canonical question/article
registry with aliases before migration. Security, support-SLA, retention,
uptime, vendor, training, pricing, billing, clinical, interoperability, and
regulatory claims require current fact and subject-matter review. The EMR
manifest must not be interpreted as evidence that those claims are current.

### PennSync

The PennSync manifest includes 29 articles, one checklist, 12 individual FAQs,
two FAQ collections, 13 guide outlines, four synthetic interactive tutorials,
and 43 feature tutorials. Its source-path, static-route, allowlist, identifier,
count, and secret/contact checks passed.

The current 12 Help-page FAQs take precedence over older manual FAQ wording.
The older OASIS and FAQ manual blocks conflict with the currently paused
feature state and are held. The 13 guide records are outlines only and need
governed authored bodies; runtime AI-generated PDFs cannot become their source.
Feature claims in the 43 tutorials require live-behavior verification. No
static, provider-safe PennSync tutorial-video catalog was found, so no PennSync
video was added to the Hub.

## Excluded material

The inventories deliberately exclude the following source classes. They are
not migration backlogs unless a separate, approved sanitization and governance
project is created.

| Boundary | Examples excluded |
| --- | --- |
| People, care, and customer data | Patients, users, tenants, organizations, visits, orders, claims, clinical records, learner responses, progress, assignments, quiz results, certificates, and uploaded customer material. |
| Support conversations | Tickets, ticket messages, chats, free-text prompts, notifications, and mutable knowledge-base rows. |
| Secrets and private delivery data | Credentials, environment values, access tokens, provider job identifiers, temporary HeyGen URLs, private object paths, signed URLs, and integration configuration. |
| Unapproved generated content | Runtime AI guides, generated courses or quizzes, tutorial jobs, draft renders, generated guide PDFs, and tenant-generated tutorials. |
| Duplicates and derivatives | Generated HTML/PDF/text copies, print-rendering code, assistant/search indexes, navigation-only cards, metadata-only webinar/resource cards, and duplicate legacy repositories. |
| Non-customer documentation | Engineering runbooks, implementation plans, audit evidence, deployment output, internal video-operator documentation, and explicitly unfinished readiness documents. |
| Product-specific exclusions | Breathe patient/provider portal and public patient-education content; EMR volatile promotional FAQs and governed policy forms; PennSync dead/redirected tutorial pages and entity-backed video metadata. |
| Images and captures | Screenshots, demo fixtures, and captures that may contain patient, customer, tenant, user, or environment-specific data. |

Support contact blocks are configuration rather than article content. Approved
articles must render the central values from the owner-approved contact registry
instead of embedding source-system email addresses or phone numbers.

## Dedupe and approval workflow

Every review-queue entry follows this sequence before it can become live:

1. **Revalidate provenance.** Pin the canonical repository commit, verify the
   source path, recompute the manifest checksum, and reject missing or changed
   sources.
2. **Stage review-only.** Import into a preview namespace with its original
   source identifier and classification. Inventory ingestion must never set a
   publication state.
3. **Normalize safely.** Remove embedded brand/contact values, replace only
   approved product names and static routes with typed variables, and reject
   dynamic route context, free text, identifiers, secrets, and URLs outside the
   allowlist.
4. **Detect duplicates.** Compare stable source keys, exact body hashes,
   normalized titles/bodies, and high-similarity candidates against both the
   live catalog and all staged sources. Preserve source IDs as provenance or
   aliases; do not create a second canonical article for the same task.
5. **Resolve conflicts.** Apply source precedence recorded in each manifest,
   compare claims with live behavior, and send clinical, legal, regulatory,
   security, billing, pricing, or compliance statements to the appropriate
   reviewer. A conflict is held rather than silently merged.
6. **Choose scope.** An organization-neutral explanation can become shared
   core. Product navigation, terminology, workflow, and screenshots remain a
   product overlay. Mixed records are split into a core revision plus a thin
   overlay rather than generalized beyond their evidence.
7. **Approve an immutable revision.** Record the canonical `content_key`,
   owner, locale, source version/hash, review state, approver, approval time,
   last-reviewed date, next-review date, access level, audience, and exact
   product placements.
8. **Publish through preview and audit.** Require an explicit human approval,
   create only allowlisted placements, exercise anonymous and entitled-user
   access tests, and record the publication event. A newer approved revision
   may supersede an older one; removal retires content and preserves history.

## Non-PHI and private-media boundary

The consolidation pipeline accepts only static, approved, organization-neutral
or explicitly product-scoped source content. It must not ingest PHI, customer
data, tenant context, user-entered text, application database records, or
private delivery locators. Launcher context is limited to an allowlisted
product slug, static route or feature, sanitized application version, locale,
and environment.

HeyGen is a replaceable rendering adapter, not the content system of record. A
new video can be registered only after its PHI-free script is approved, the
render is downloaded, the MP4 and human-reviewed WebVTT are stored privately,
a visible transcript and SHA-256 checksum are recorded, access and product
placements are reviewed, and an immutable asset revision is approved. Until
those controls exist centrally, the Hub continues to expose metadata and a
governed CareBase launch only—never inline private media.

## Manifest provenance

| Manifest | SHA-256 | Validation |
| --- | --- | --- |
| [Breathe manifest](evidence/caremetric-breathe-admin-help-manifest-c92b0b2-2026-09-07.json) | `52f0bbf1ee34e3d392e8f44d80e38ba11a13b8571103f8cb4ea34cbe49da2ef2` | Passed |
| [EMR manifest](evidence/caremetric_emr_help_manifest_9718b07c_20260907T180626Z.json) | `6f1cbaf8f8c4c2a6220c1ab4a9ac459adb6a2b64f0002f149c837065d15fb3ef` | Passed |
| [PennSync manifest](evidence/pennsync_help_consolidation_manifest_20260907_11ccc85e.json) | `6094fbee093daedbe50721b3ae6a28a6dccc5e405b108ee3d8fedc0de7418d49` | Passed |
| [EMR–Breathe dedupe report](evidence/caremetric-emr-breathe-dedup-report-9718b07c-c92b0b2-20260907T183209Z.json) | `dd79977597b44af605cc8f11fed188a85fd32a9b65bf582a5a4335b90fa8468a` | Passed |

These checksums cover the sanitized copies committed under `docs/evidence`.
The inventory files are evidence inputs, not executable publishing
instructions. Publication authority remains in the first-party Hub revision,
approval, placement, and audit records.
