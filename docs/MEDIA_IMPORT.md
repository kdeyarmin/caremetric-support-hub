# Bulk lesson-video import

A shared-course editor can bring many approved lesson videos into private Hub media
in one reviewed pass, instead of uploading each MP4, WebVTT caption file and
transcript by hand. The panel is **Import lesson videos from a manifest** in
`/library`. It is the bulk form of the reviewed upload in
[CENTRAL_LEARNING.md](CENTRAL_LEARNING.md#data-and-media-controls): the same private
`hub-learning` bucket, the same approval, and the same draft editing. Nothing it does
publishes a course.

Implementation: `supabase/migrations/20261106220000_learning_media_import.sql`,
its contract migration `20261106220100_learning_media_import_contract.sql`
(backend feature `learning.media-import.v1`), `server/learning-media-import.mjs`,
`src/learning/mediaImportProtocol.ts` and `src/learning/MediaImportPanel.tsx`.

## Manifest

A CSV with exactly these columns, in any order, and one row per video:

| Column | Meaning |
| --- | --- |
| `product` | `pennsync` or `carebase` |
| `course_title` | Shown in review; the draft's own title is shown next to it |
| `lesson_title` | The approved media title, and for a Hub draft item the video lesson it fills |
| `source_record` | A PennSync TrainingModule id (24 hex characters, PennSync rows only) or a Hub draft item id (UUID) |
| `duration_seconds` | The render length; captions must end within it, plus one second |
| `mp4_url` | Permanent `https` URL of the rendered MP4 |
| `poster_url` | Optional `https` URL, recorded for provenance only; it is not fetched |
| `captions_file` | WebVTT file beside the manifest |
| `transcript_file` | Plain-text transcript beside the manifest |
| `heygen_video_id` | The render id |

The PennSync repository keeps the current manifest at
`docs/hub-media-2026/manifest.csv` with its sidecar files. Choose the manifest
folder, or the manifest together with its `.vtt` and `.txt` files. A manifest with
any invalid row, missing column, unexpected column, or a render, URL, lesson or
sidecar listed twice transfers nothing; every problem is listed with its line.
Before any transfer the browser also runs the server's caption and transcript
checks, so a row that cannot stage is caught early.

## Transfer

Rows transfer one at a time while the panel stays open. For each row the Hub
server:

1. Re-validates the row and its captions and transcript. Captions must be the
   plain WebVTT profile the publication importer accepts (timed cues within the
   video, no markup, links, e-mail addresses or provider names). Transcripts get the
   same text checks.
2. Refuses an `mp4_url` whose host is not on the allowlist, before recording or
   fetching anything. The allowlist is exact host names in `HUB_MEDIA_IMPORT_HOSTS`
   (comma separated). Empty means HeyGen's asset hosts: `resource2.heygen.ai`,
   `files.heygen.ai` and `files2.heygen.ai`. Wildcards, schemes and ports are
   refused; an unusable value refuses every source.
3. Fetches the MP4 itself, with no cookies or credentials and `Accept-Encoding:
   identity`. It follows at most three redirects, by hand, and only to `https`
   allowlisted hosts.
4. Checks the response: status 200, `video/mp4` (or a generic octet-stream type),
   no content encoding, at most 256 MB, a body exactly as long as any declared
   length, and an ISO BMFF/MP4 `ftyp` signature. It hashes the body with SHA-256
   while spooling it to a private temporary file.
5. Stores `video.mp4`, `captions.vtt` and `transcript.txt` under
   `learning/<media id>/` through the same one-use media capability as the
   single-file uploader. Its `can_upload_learning_object` policy and the bucket's
   no-overwrite upload still apply.
6. Downloads each stored object and compares its SHA-256 and size with what was
   verified. The database separately checks that the three stored objects have
   exactly those sizes. Any difference fails the row as `hash_mismatch`, and the row
   is not staged.

A failed row records why: host or redirect refused, source unavailable, wrong type,
too large, truncated, hash mismatch, storage unavailable, or timeout. Other rows
continue. **Retry** in the panel resends only the failed rows.

### Retry identity

A row's identity is `product:source_record:heygen_video_id`. The media id, and so the
storage prefix, is derived from that identity plus the SHA-256 of the video,
captions and transcript:

- Re-running identical content for a staged or approved row fetches and stores
  nothing. The response says it was replayed.
- Re-running the same bytes after a failure reuses the same prefix. When the bucket
  answers that an object already exists, the stored copy is hashed and accepted only
  if it matches.
- Changed captions, transcript or video for a row that is not yet approved get a new
  prefix, never an overwrite. The superseded objects remain private and
  unregistered.
- Approved media cannot be replaced. Changed content for an approved row is refused.
- Only one transfer of a row runs at a time. A transfer that was interrupted can be
  retried after its 15-minute lease ends.

## Review, approval and attachment

Each staged video lists its course, lesson, duration, size, checksum and target
lesson. **Review video, captions and transcript** plays the private video with its
captions through a ten-minute signed URL and shows the stored transcript. The editor
must confirm the review before **Approve** is enabled.

Approval calls `hub.register_learning_media` with the checksum the server verified,
never a browser value. That function enforces the reviewed flag and the presence of
all three stored objects, and it writes the `learning.media.approved` audit event.
The import adds `learning.media.import.staged`, `.failed`, `.registered` and
`.attached` events.

The approved video is then attached to its target lesson through
`hub.save_learning_draft`, which keeps its editor check, document validation and
revision-conflict check:

- **PennSync TrainingModule id:** the draft lesson whose id is
  `learningSourceId('lesson', moduleId)` (`src/imports/pennsyncCourseImport.ts`).
  The PennSync conversion derives lesson ids this way, and the SQL resolver computes
  the same UUID; the contract migration checks a fixed vector. Until a converted
  PennSync course exists as a Hub draft, the approved video waits as **No Hub draft
  has this course yet**. Use **Attach to lesson** once the draft exists.
- **Hub draft item id:** the one video lesson in that draft whose title matches
  `lesson_title`, ignoring case and repeated spaces.

Attachment only fills an empty `mediaAssetId`. It never replaces a lesson's
existing video, never changes the lesson's transcript text, and never picks between
two matching lessons. A text lesson, a missing lesson, an ambiguous title or an
occupied lesson is reported, and the editor attaches the video in the course
editor. For imported CareBase drafts, a media reference is the one edit the
[publication bridge](CENTRAL_LEARNING.md#existing-course-transfer) permits, so
attaching does not block publication. Publishing remains a separate, reviewed
action in the course editor.

## Authority

Every import call goes through the dedicated Hub server connection, a verified Hub
SMS session, and `private.require_learning_editor()`, which currently admits only
platform administrators (`20261015130000_course_creation_super_admin_only.sql`).
Content permission alone is refused. The staged-import table and its functions are
closed to browser, service-role and direct server access. The route answers
`503 unavailable` until the database declares `learning.media-import.v1`.

## Release order

1. Apply `20261106220000_learning_media_import.sql`, then
   `20261106220100_learning_media_import_contract.sql`. The contract migration fails
   closed unless the privilege boundary, server-only entry points and PennSync
   identity parity hold.
2. Deploy the Hub server and web. Features are read at boot, so restart the server
   after the migration if it deployed first.
3. Optionally set `HUB_MEDIA_IMPORT_HOSTS`, if the manifest's MP4 URLs or their
   redirects use another HeyGen host. A refused hop names `redirect_not_allowed`.

## Verification

`npm run check` covers the manifest parser, the browser panel, and the server's
allowlist, redirects, type and size checks, hash mismatch, partial failure and retry
identity, against an in-memory store. CI's database job runs
`supabase/tests/064_learning_media_import.test.sql` and
`server/media-import-integration.mjs`. The integration test runs twice, against
actual PostgreSQL, local Supabase Storage, SMS sessions and HTTP. It covers host
refusal, partial failure, a stored-copy hash mismatch and its retry, replay without
refetching, reviewed approval with the server checksum, attachment through the
draft save, an occupied lesson, a not-yet-converted PennSync course, editor-only
access, and that nothing publishes.

Failed or superseded transfers can leave private, unregistered objects, as with the
single-file uploader. Remove them only after confirming they are not registered.
