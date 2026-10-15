# Initial backend contract

The original API inventory below predates the current app-owned SMS gateway. The implemented DocStudio import endpoints, permissions, exact-file requirements, and deployment gates are documented in [Publication imports](PUBLICATION_IMPORTS.md). Its executor is separate from the pure preview function described here.

Version `0.1.0` uses RLS-governed reads and narrow atomic RPCs in the `hub` schema.

## Reads

- `hub.get_backend_contract()`: anonymous/authenticated, security-invoker
  release metadata, currently exactly `{ "api_version": 2 }`. It reads no
  application tables and grants no actor access. Connected production builds
  check it before bundling. Required migrations must precede frontend rollout;
  increment the required contract when a future frontend requires a new
  incompatible backend capability. This is a compatibility marker, not an
  end-to-end health check or authorization mechanism.

- `hub.products`: active product registry.
- `hub.support_contacts`: verified public product/contact routing only.
- `hub.support_case_queue`: requester/tenant-scoped or staff-permission-scoped safe case rows.
- `hub.list_published_content()`: sanitized, audience-authorized article, video, and course revisions with exact product placements.
- `hub.get_support_actor_context()`: current profile, role, and every active
  tenant/product membership as an exact pair. Each pair includes its tenant
  name, membership role, and required boolean `intake_enabled` state. Legacy
  top-level tenant fields contain the first deterministic active membership for
  older clients.
- `hub.get_support_case_thread(case_id)`: customer correspondence plus internal notes only for authorized staff.

The actor bootstrap is intentionally callable before verification and reveals only the minimum identity and role. Deleted, banned, and anonymous Auth principals are rejected even if an older JWT remains unexpired. For staff, tenant context and every protected data path remain unavailable until the request carries a verified session: the Hub server's SMS app session ([details](APP_SMS_SIGNIN.md)) or, for existing integrations, a legacy AAL2 JWT. Customers without a verified second factor keep their tenant memberships at AAL1. Authenticator apps (TOTP) are turned off, so no new factor can be enrolled.

## Commands

The read-only central-admin pilot uses `hub.authorize_platform_admin()` and
the `platform-admin` Edge Function. It requires a live first-party AAL2 session
and current portfolio-wide relational permission. CareBase independently checks
an explicit native identity mapping and native authority before returning
projected counts/course metadata. See [the request and deployment contract](CENTRAL_ADMIN_PILOT.md).

- `hub.create_support_case(..., p_request_key uuid)`: validates active exact tenant/product membership and a private, explicit intake activation, then creates the case, participant, first message, and audit metadata atomically. A repeated identical key returns the original case; changed data with the same key fails.
- `hub.reply_to_support_case(..., p_request_key uuid)`: validates `case.write` independently from requester/participant/tenant-scoped membership authority, keeps staff notes private, derives the stored author role from the path that authorized the write, updates case state, and appends metadata-only audit history. A repeated identical key returns the original message or note.
- `hub.update_support_case(...)`: requires `case.write`, verifies assignee product authorization plus a currently usable non-anonymous Auth account and provisioned profile, and changes only operational fields.

The original nine-argument create and three-argument reply signatures remain as compatibility wrappers. They generate a server-side request key for each call, so only the keyed overloads provide caller-stable retry replay; new clients must use those keyed overloads and supply a non-null UUID. The private idempotency ledger contains a request digest and identifiers only; it has RLS enabled and no browser-role grants. New case intake defaults off per tenant/product and requires an active entitlement plus a currently usable staff route with a verified SMS sign-in number. Disabling intake does not strand already-created cases or prevent an authorized replay from returning a previously committed create result.

Every command derives the actor from `auth.uid()`. No caller may set requester identity, requester display name, staff role, data classification, or audit actor.

## Client launch contract

`@caremetric/help-sdk` 0.4 provides `buildHelpUrl`/`openHelp`, `buildLearningUrl`/`openLearning`, `buildCourseEditorUrl`, and `buildMyLearningUrl`. Learning links use `/learn` and may include only one compile-time registered product slug. Authoring uses `/library/courses/new`; personal learning uses `/learn/my`. Help links may additionally include only caller-allowlisted static route/feature context and format-validated app version, locale, and environment. Launchers require HTTPS, reject credentials and loopback destinations, and default to the permanent Railway Hub origin.

Course metadata never supplies an arbitrary destination. Published Hub-owned courses open at `/learn/courses/<uuid>`, including contextual-help links and courses retaining legacy provenance. Courses awaiting migration launch only when the configured origin is exactly `https://cmcarebase.com` and the stored relative path is exactly `/app/courses` or `/app/courses/<uuid>`.

## Central learning RPCs

The staged [central learning runtime](CENTRAL_LEARNING.md) adds editor, import,
publication, enrollment, grading, progress, certificate, and media RPCs in `hub`.
Answer keys and learner state remain in private tables without browser table
grants. Publication creates an immutable version; enrollment pins that version.
Every mutation derives identity from the current usable Auth principal and
checks the required permissions and MFA. Deploy the migration before the UI.

## Publication preview boundary

`previewPublicationImport()` is an in-process, credential-free validation and planning function, not an HTTP endpoint. It accepts the closed DocStudio v1 manifest, caller-supplied bytes, and a bounded catalog snapshot; requires the upstream PHI-review attestation plus usable, in-range timed WebVTT and transcript sidecars for video; and enforces a security-restricted plain-text caption profile. BOM, standard header text, HLS `X-TIMESTAMP-MAP`, comments, regions, safe cue settings, and non-fetching style rules are supported, while inline WebVTT/HTML tags and external-resource CSS are intentionally rejected. It rejects obvious identifier, HTML, and unsafe-link patterns in text; verifies asset hashes and a supported MP4 `ftyp` major brand; rejects same-version mutation, rollback, gaps, and unapproved next versions; and binds governance plus the canonical input catalog-snapshot hash into plan identities. It returns only deterministic `create`, `no_op`, `new_immutable_revision`, `place`, approval-required `replace_placement`, approval-required `retire_preview`, approval-required `retire_content_preview`, or approval-required `reactivate_content_preview` actions. The text scan is not PHI certification and cannot inspect video pixels. The function performs no fetch, upload, database/storage write, retirement, reactivation, or deletion; a future executor must re-check the authoritative snapshot identity and apply approved placement replacements, retirements, and reactivations transactionally against the existing unique product-publication row.

## Planned service endpoints

```text
GET  /api/v1/help/resolve
GET  /api/v1/content/{content_key}
GET  /api/v1/search
GET  /api/v1/courses
POST /api/v1/context/exchange
POST /api/v1/media/{asset_id}/playback-session
POST /internal/v1/imports
POST /internal/v1/video-renders
```

The HTTP layer will be added as authenticated Supabase Edge Functions after the dedicated project exists. It will never proxy a browser service-role key.
