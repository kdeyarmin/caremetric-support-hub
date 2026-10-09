# Video and learning governance

The approved ownership direction is now full Hub course creation and delivery.
The staged runtime and reviewed media-transfer workflow are documented in
[CENTRAL_LEARNING.md](CENTRAL_LEARNING.md). It accepts private, immutable MP4s
with captions and transcripts without a HeyGen dependency. The inventory below
describes the existing source deployment; it is not evidence of a completed
central migration.

## Production inventory (2026-09-07)

CareBase remains the authoritative course runtime. The Support Hub is the
cross-product discovery catalog and launches learners into CareBase; it does
not proxy or expose CareBase media objects.

| Control point | Verified state |
| --- | ---: |
| Published CareBase courses | 80 |
| Courses containing video | 7 |
| Current published video blocks | 65 |
| Current blocks matched to completed HeyGen jobs | 65 / 65 |
| Current private Storage objects present | 65 / 65 |
| Current stored media | 986,673,769 bytes (~941 MiB) |
| Current video duration | 154.91 minutes |
| Current caption/subtitle sidecars | 0 |
| Current SHA-256 manifest entries | 0 |

Every current video has already been downloaded from HeyGen and durably
rehosted in CareBase's private `course-videos` Supabase Storage bucket. The
CareBase runtime resolves the stored locator only after authentication and
issues a short-lived signed playback URL. Temporary HeyGen URLs and private
Storage object paths must never be copied into the Hub catalog or application
launch links.

The 65 current blocks are all platform-owned and organization-neutral. Twelve
use the preferred `storage://course-videos/...` locator. Fifty-three use a
legacy public-endpoint-shaped locator, but resolve to the same private bucket
through CareBase's signed-URL resolver. Normalize those 53 locators as guarded
cleanup; existing playback does not depend on exposing the bucket publicly.

## HeyGen account reconciliation

| HeyGen inventory | Count |
| --- | ---: |
| Total videos | 169 |
| Completed | 127 |
| Pending | 11 |
| Failed | 31 |
| CareBase-prefixed videos | 128 |
| Completed CareBase videos | 97 |
| Current referenced CareBase videos | 65 |
| Unreferenced completed CareBase renders | 32 |
| Unreferenced failed CareBase renders | 31 |
| Duplicate CareBase title groups | 22 |

The 31 CareBase failures report insufficient rendering credits. The 32
unreferenced completed renders represent 86.29 minutes and require human
classification as reusable, superseded, or retired. One additional stored
CareBase video object is not referenced by a course block and must be
quarantined for investigation rather than automatically deleted. HeyGen folder
assignment is currently absent for CareBase videos.

## October 9, 2026 catalog review

Read-only review of the live CareBase catalog. Nothing in CareBase was changed.

**Course structure.** All 80 published platform courses end in a graded
assessment. Each is held to the `comprehensive` standard: 100% progress, the
final step reached, the full designed seat time, and every quiz passed, enforced
by `require_comprehensive_self_completion`. `complete_course_assignment` also
requires every attestation to be signed. It then issues a certificate whose
expiry follows the course recurrence (365 days for every annual course, none
for orientation). The `learning.video_watch_gate` release is enabled globally,
so every video must be watched to the end. Eight platform courses are archived
and none contains video. No two courses share a title.

**Published video lessons.** There are 65 video blocks in 7 courses. Each has a
distinct script, a distinct HeyGen render ID and a distinct stored file, so no
lesson is a duplicate. All 65 files exist in `course-videos`. One additional
object, `de6d79a5-…/5cda7cdd-….mp4` (1.7 MB, 2026-07-04), is referenced by no
course version. Two lessons share the title "What to carry out of this course"
(Falls and Emergency Preparedness), but their narration differs. The renders
used one photo avatar and two voices.

Problems that need action before these courses are assigned:

| Finding | Course | Action |
| --- | --- | --- |
| Lesson 9 audio narrates the restraint guidance that `20260925120400` corrected ("a specific approved intervention"). The transcript shows the corrected text. The render (`bcd5539b…`, 2026-07-25) predates the correction. | Safe Management and De-escalation (published v2) | Clone, re-render lesson 9 and publish before assigning |
| Lessons 2, 6 and 9 store only their title as the script, so learners get no transcript. Their files are 28–30 MB, against 3–13 MB for the course's other lessons. | Falls and Accident Prevention | Watch and verify the three renders; restore their scripts |
| No video has captions; there are 0 sidecar files. | All 7 video courses | Request SRT captions from HeyGen v3 (`caption.file_format`) and store them as WebVTT |
| Four annual HeyGen courses (Emergency Preparedness, Falls, Medication Self-Administration, Safe Management) have no compliance-credit rows and no training type. Completion issues a certificate but records no annual hours. Diabetes records its credit through its renewal training type. | Those four | Map training types or retire the courses |

**Overlapping courses.** The eight `PA-DHS-STANDALONE-*` annual courses, six of
them with video, teach the same audience and topics as eight
`PA-DHS-ANNUAL-*` courses. Those carry PCH and ALF hour credits.

| Standalone (video) | Annual required topic |
| --- | --- |
| Emergency Preparedness Beyond Fire (video) | Emergency Preparedness and Resident Protection |
| Falls and Accident Prevention (video) | Falls Prevention and Post-Fall Response |
| Infection Prevention and Control (video) | Infection Control, Universal Precautions, and Immobility |
| Medication Self-Administration Support (video) | Medication Self-Administration Support for PCH and ALF |
| Safe Management and De-escalation (video) | Safe Management of Challenging Situations |
| Abuse, Neglect, and Exploitation Reporting | Older Adult Protective Services: Recognition and Reporting |
| Fire Safety and Emergency Preparedness | Fire Safety Preparedness and Facility Procedures |
| Resident Rights and Dignity | Resident Rights, Dignity, and Choice |

No assignment references any of these 16 courses. Choose one course per topic,
or label the standalone courses as optional refreshers, before facilities start
assigning annual training. The aide series (home health, hospice, nursing home)
and Chapter 6400 repeat topics for different roles and are not duplicates.

**Rendering engine.** CareBase calls HeyGen `POST /v3/videos` and its v3 status
endpoint, so the October 31, 2026 retirement of v1/v2 does not affect it. The
request names no engine, so HeyGen uses Avatar IV. At the published API rates
(updated 2026-09-16), the photo-avatar look costs $2.31/min on Avatar IV and
$0.99/min on the re-engineered Avatar III. A Digital Twin costs $4.83/min and
$0.60/min respectively. These lessons are narrated by a single presenter and do
not use Avatar IV's gesture controls. Render one sample lesson on
`avatar_iii` and compare it with the current renders. If it is acceptable, set
CareBase's `HEYGEN_AVATAR_ENGINE=avatar_iii` (kdeyarmin/PennTrain
`generate-course-video`).

## Required publishing workflow

1. Author one product-neutral source script and optional product overlays.
2. Approve the script and confirm it contains no PHI or customer data.
3. Render in HeyGen with an idempotency key derived from the approved revision,
   locale, template, and input hash.
4. Download the final MP4 immediately; never publish the temporary render URL.
5. Compute SHA-256 and store the MP4 in private CareMetric-controlled Storage.
6. Generate timed WebVTT, human-review it, and store a visible transcript.
7. Register the stable asset manifest only after checksum, captions, access
   level, product placements, and human approval are complete.
8. Publish or retire through a new immutable revision; never overwrite history
   or delete audit evidence.

## Cross-product sharing model

- Use the Support Hub `/learn` catalog in every application.
- Search and browse all 65 current lesson titles in the Hub; selecting a course continues through its governed CareBase launch.
- Launch the canonical `/app/courses/<course-id>` route in CareBase for
  enrollment, playback, quizzes, progress, attestations, and certificates.
- Reject any course destination that is not exactly the canonical `https://cmcarebase.com` origin, `/app/courses`, or `/app/courses/<uuid>`; alternate origins, ports, credentials, query strings, fragments, traversal, and malformed IDs fail closed.
- Keep product launchers limited to static route and feature registries.
- Add inline Hub playback only after a central private bucket, entitlement
  broker, checksum manifest, captions, transcripts, and short-lived signed URL
  delivery are implemented.
- Keep HeyGen as a replaceable rendering adapter, never the content system of
  record.

## Next implementation gates

The repository now includes a first-party DocStudio publication preview boundary. It requires the upstream PHI-review attestation and both caption/transcript sidecars for video; conservatively rejects obvious identifier, HTML, unsafe-link patterns, external-resource CSS, and inline WebVTT markup. Captions therefore use a documented plain-text WebVTT profile with validated timing, identifiers, regions, safe settings, supported header metadata, and non-fetching styles. The boundary verifies the exact six-product allowlist, declared hashes, a supported MP4 `ftyp` major brand, bounded history, approved next source version, catalog-snapshot identity, and retirement-as-preview semantics. This scan cannot certify that video pixels or arbitrary prose contain no PHI, so human review remains mandatory. The boundary has no credentials, network calls, storage/database writes, or delete operation; it is a validation step, not a live media importer.

- Build a server-only, incremental CareBase-to-Hub catalog synchronizer using
  source versions and hashes; retire missing source content rather than delete
  it.
- Normalize the 53 legacy CareBase locators.
- Caption and checksum all 65 current videos before any inline Hub playback.
- Classify the 32 unused completed renders, 31 credit failures, and one orphan
  object; organize HeyGen into Published, Review, Failed, and Retired folders.
- Record course launches and video reuse only as non-identifying aggregate
  events.
