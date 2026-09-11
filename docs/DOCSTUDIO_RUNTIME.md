# Central content authoring

`/docstudio` owns new shared articles and tutorial videos in the Support Hub.
The six eligible product scopes are Breathe, CareBase, CareMetric EMR,
CareMetric Go, CareMetric Intel and PennSync. Every authoring read or write
requires the current app-owned SMS session and `content.write` for every
affected product, including products removed by an edit. No authenticator
enrollment or Supabase verification is involved.

An editor creates a draft, saves an immutable revision, submits it for review,
and explicitly approves the exact content and its PHI-free status. Video scenes
contain captions and transcript text, with optional verified images and recorded
narration. Approval does not itself publish anything. Completed content is
prepared through the existing immutable publication importer, where the editor
reviews audience and product placements before committing to the shared catalog.
Course authoring and delivery remain the separate central learning workflow.

Edits create a new revision, require a fresh approval, cancel active renders and
invalidate pending exports. Command request IDs and receipts survive ambiguous
responses. Retrying a command retrieves its result without another draft or job.
Completed publication revisions remain immutable and are not deleted by an edit.

## Paired services

The renderer is `kdeyarmin/DocStudio`'s `Dockerfile.render-worker`. Pull request
6 adds a real Remotion render of the committed TutorialVideo composition and
independent ffprobe verification of actual 1080p, 30fps H264 output. It accepts
the closed `caremetric.docstudio.render.v1` protocol. It does not accept shell
commands, filesystem paths, source URLs, native credentials or reported browser
completion. The production image test renders real bytes and checks the MP4,
captions and transcript; it does not simulate progress.

The worker has no database credentials. It uses a dedicated 32-byte random
base64url token (43 characters), held only in server environment variables.
`DOCSTUDIO_WORKER_TOKEN` must match on the Hub and the renderer. The renderer
also requires `HUB_ORIGIN=https://support-hub-web-production.up.railway.app` and
the deployment's `RAILWAY_GIT_COMMIT_SHA`. `PORT` is supplied by Railway. Its
health check is `GET /health`, which returns ready only after the Hub accepts
its heartbeat. Keep the service continuously running with one replica and a
bounded restart policy. No public worker domain is needed.

Database writes use the Hub's existing restricted `hub_app_server` role and
fixed private functions. All `private.docstudio_*` tables use RLS, with no raw
table grants to application, browser or service-role callers. Render claims use
row locks, renewable 45-second leases and at most three attempts. Each attempt
has separate immutable output keys. Completion requires exact verified output
records and the saved scene duration. Current issuer SMS identity, permissions,
project revision and approval are rechecked on lease use and completion.

## Private media

`docstudio-media` is a Hub Storage Edge Function that receives only one-use
capabilities from the app server. Deploy with gateway JWT verification disabled:
its own fixed Hub authorization callback consumes and validates the capability.
Origin/Cookie-bearing requests are denied. Its shared immutable-media handler
also serves the established publication workflow under a separate fixed profile.
No arbitrary destination or bucket can be supplied by the caller.

The private `hub-docstudio` bucket contains only these object namespaces:

- `assets/<project UUID>/<asset UUID>`: exact verified PNG, JPEG, MP3 or WAV.
- `renders/<job UUID>/<attempt 1..3>/<primary|captions|transcript>`: exact output.

Uploads are bounded, hashed and immutable. A lost response may be reconciled by
reading and hashing the exact existing key; it cannot cause an overwrite. Video
exports also obey the existing publication upload ceiling, initially 25 MiB.
Source files total at most 32 MiB per video. A project may retain at most 100
source assets / 128 MiB, with no automatic deletion of revision evidence.

Include this bucket's exact object bytes in the production backup plan. The
logical Hub recovery drill automatically includes its private database tables,
but database backups alone do not back up Storage object bytes. Revoke restored
SMS sessions, media tokens and worker leases before reopening a restored service.

## Release order and verification

1. Require green Hub CI, including the actual PostgreSQL/SMS/HTTP integration,
   private media handler tests, complete runtime image and recovery drills.
2. Apply the exact reviewed `20260911220747_hub_docstudio_runtime.sql` migration
   and align its immutable checksum with migration history. It adds
   `knowledge.docstudio.v1` without removing independently released features.
3. Deploy `docstudio-media` with its exact shared handler source. Configure the
   paired token and deploy the reviewed Hub commit.
4. Deploy the green DocStudio main commit using `Dockerfile.render-worker`,
   `/health` and the environment above. Confirm its actual deployment revision.
5. Through the owner's actual Hub SMS session, verify the studio, eligible app
   choices, saved inventory and worker readiness. Do not create customer drafts,
   publish synthetic content, or send test SMS as production acceptance checks.

The removed EMR DocStudio schema and its legacy executor endpoints stay unused.
This release does not claim to recover missing historical projects or configure
an AI generation vendor. HeyGen is not required for this rendering workflow.
