# Central course authoring and delivery

The Support Hub owns new shared course drafts, publication revisions, lessons,
video playback, quizzes, progress, and completion certificates. All six registered
products link to this runtime. HeyGen is not a runtime dependency; educators can
upload approved MP4 videos with captions and transcripts.

Implementation is in migration `20260911142602_central_learning_runtime.sql`.
This document supersedes the earlier launch-only ownership model for new Hub
courses. See the [September 11 production record](PRODUCTION_ROLLOUT.md#september-11-central-administration-and-learning-release)
for the deployed release and remaining authenticated verification gates.

## User workflow

- `/library`: drafts and source-course import, available to portfolio-wide content
  editors with AAL2. Product-scoped permissions do not authorize cross-product publishing.
- `/library/courses/new` and `/library/courses/:itemId`: edit text, video, quiz,
  and attestation lessons; choose product placements; save with revision conflict
  detection; review and publish. Changes do not alter existing enrollments.
- `/learn`: public metadata. New courses published in the Hub open here. Existing
  CareBase courses retain source launches; their imported drafts cannot publish
  until the source runtime and reporting bridge is verified.
- `/learn/courses/:itemId`: authenticated enrollment and delivery. Lessons open
  in course order, and the server refuses a submission until every earlier unit
  is complete, so the post-test follows the lessons. A video lesson's first
  viewing cannot skip ahead, and the lesson cannot be marked complete until the
  video plays to the end. That browser check is not proof of elapsed viewing
  time. Quiz answers are graded server-side. Completion requires every lesson
  to be acknowledged and every quiz to pass.
- Publishing requires at least one text or video lesson followed by a graded
  post-test; a closing attestation may follow it
  (`20261009203000_learning_course_sequence.sql`). Connected frontends require
  backend feature `learning.sequence.v1` before they deploy.
- `/learn/my`: the current learner's enrollments and progress.
- `/learn/certificates/:enrollmentId`: an authenticated, printable record of
  completion that shows the best post-test score and its passing score. These
  certificates do not claim accredited CE credit.

Hub users must already be provisioned; existing passwordless sign-in does not
create accounts. Staff and customers enrolled in TOTP must complete AAL2.

## Data and media controls

All course documents containing answer keys, enrollments, progress, submissions,
media registration, and import provenance are in `private`, with RLS and no client
table grants. Authenticated RPCs check a current, usable Auth principal and
relational permissions. Learner documents use an explicit field projection.
Submissions use an enrollment lock plus a request key and payload hash to prevent
double attempts from retries. Certificates retain immutable revision identity.

The `hub-learning` bucket is private. Shared content editors can insert new objects
and read uploads for review. They cannot overwrite or delete objects through these
policies. Learners can sign URLs only for media in their own enrolled courses
while they retain content access. The UI issues ten-minute URLs; an already-issued
URL remains valid until expiry after access is revoked. Transcript text is shown
alongside playback. Uploads require MP4, WebVTT, and plain-text files. The uploader
compares SHA-256 of the source video with the stored download before registration.
Human review is required for accuracy, captions, transcript, and absence of private
data. This is a staff-owned publishing flow, not a customer attachment inbox.

Failed uploads can leave private, unregistered objects. An operator can remove
those after confirming they are not registered; never delete a registered asset
or source video as part of an unverified cleanup. No credentials are stored in the
frontend, source exports, or SDK.

## Existing course transfer

1. Run `scripts/export-carebase-learning.sql` read-only in CM Train and save the
   `courses` JSON array privately. It includes answer keys: never commit or post it.
2. Save the six destination product UUIDs as a JSON array. Rehearse with Node
   22.18+ or 24: `node scripts/rehearse-learning-import.mjs snapshot.json product-ids.json`.
   An optional third JSON argument maps source video-block UUIDs to approved Hub
   media UUIDs. Unknown block/question types fail instead of dropping content.
3. In the authenticated Hub library, import the snapshot as drafts. Existing
   catalog IDs are retained; retries cannot overwrite later edits. Review product
   placements. Full source descriptions, lesson IDs, quiz points, passing scores,
   and unlimited-attempt settings are retained.
4. Copy each source MP4 through the reviewed upload flow, supply its matching
   captions/transcript, choose the approved video in the imported draft, then save.
   Source storage and temporary HeyGen URLs are never used as Hub playback URLs.
5. Imported CareBase courses currently remain drafts. The database rejects their
   publication until quiz behavior, provider/credit/renewal metadata, and completion
   reporting are preserved. Existing catalog launches continue into CareBase.
   Newly authored generic Hub courses can be reviewed and published. Validate enrollment, a failed and passing quiz,
   a resumed session, playback/captions, completion, and a second learner's isolation.
6. Migrate legacy assignments/history separately using verified user, tenant,
   product, and immutable source-version mappings. Do not assign history based
   solely on a matching display name or email. Preserve original completion,
   attestation, credit, and certificate evidence. This release does not import
   those records or create memberships from source claims.
7. Retire product-local authoring, enrollment, generation, and scheduled HeyGen
   jobs only after the corresponding replacement and outstanding jobs are verified.
   Revoke PennSync's HeyGen secret after the deployed consumers no longer use it.

The September 10 rehearsal validated 80 courses, 910 blocks, and 738 questions.
73 courses have no video transfer dependency; seven courses contain the 65 video
lessons. All 65 require caption-sidecar and media transfer review before publication.
CM Train also has six assignments for two employees, including one completion;
only three assignments reference the currently published catalog revisions.
Importing only the current 80 versions cannot preserve all legacy history.

PennSync's tenant-scoped course catalog is a separate migration source. Do not
import it as public shared content or infer tenant permissions from this catalog
importer. Keep its existing records accessible pending an explicit tenant mapping.

## Validation and deployment order

Run `npm run check`, the SDK tests, and `supabase test db` on an isolated stack.
CI runs pgTAP in Linux because Docker on the current Windows host is unavailable.
Run database/security advisors before production. Apply the learning migration and
`20260911142604_platform_admin_session_authorization.sql` before the frontend
deployment; API contract version 2 prevents a frontend without these RPCs from
deploying. Existing source routes remain usable during the transition.
Exercise a real authenticated course before enabling consuming-app cutover flags.

Rollback the frontend if needed while retaining the additive schema and immutable
records. Do not drop learning tables or delete source records to roll back a UI.
The runtime adds no HeyGen, OpenAI, or other provider-secret requirement.

Production CSP permits media only from the dedicated Hub storage origin. Other
app storage and provider URLs are not valid central playback destinations.
