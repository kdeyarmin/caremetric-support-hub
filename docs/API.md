# Initial backend contract

The original API inventory below predates the current app-owned SMS gateway. The implemented DocStudio import endpoints, permissions, exact-file requirements, and deployment gates are documented in [Publication imports](PUBLICATION_IMPORTS.md). Its executor is separate from the pure preview function described here.

Version `0.1.0` uses RLS-governed reads and narrow atomic RPCs in the `hub` schema.

## Reads

- `hub.get_backend_contract()`: anonymous/authenticated, security-invoker
  release metadata, currently `{ "api_version": 4 }` (the frontend requires exactly this via `REQUIRED_BACKEND_CONTRACT` in `src/lib/backendContract.ts`). It reads no
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

## AI case assistance (server endpoints)

Implemented in the app server (`server/ai-assistance.mjs`, `server/ai-case-assistance.mjs`,
`server/ai-automation.mjs`); the Anthropic key is server-only (`ANTHROPIC_API_KEY`) and never
reaches the browser. Without the key, every AI endpoint refuses with
`503 {"error":{"code":"AI_NOT_CONFIGURED"}}` and the rest of the Hub is unaffected.

Staff actions (SMS session required; the caller must hold a staff role in
`get_support_actor_context` and see the case in their queue). All three are advisory:
none of them posts, sends, or updates anything.

- `POST /api/ai/cases/{caseId}/summary` — `{}` → `{ summary }` for the case thread.
- `POST /api/ai/cases/{caseId}/draft-reply` — `{ qualityTier?: "draft" | "quality" }` →
  `{ draft }`, generated from the thread plus published knowledge articles the caller
  may read. The draft is returned for the staffer's reply box; sending stays manual.
- `POST /api/ai/cases/{caseId}/triage-suggestion` — `{}` → `{ category, priority }`,
  validated against the case enums. Applying it is the staffer's action through the
  normal `update_support_case` path.

Customer auto-resolution (portal cases only) runs as an in-server sweep when
`HUB_AI_AUTOMATION_ENABLED=true`: up to two automated attempts authored by the
CareMetric AI Assistant identity, a follow-up nudge after
`HUB_AI_FOLLOW_UP_DELAY_HOURS` (default 24), then permanent escalation to staff.
The customer's explicit answer goes through the gateway RPC
`hub.record_ai_resolution_response(p_case_id, p_fixed, p_request_key)` (idempotent,
customer-side only); free-text replies are classified by the sweep as a fallback.
Loop state lives in `hub.case_ai_automation`; the queue view exposes `ai_stage` /
`ai_attempts` (backend features `support.ai-assistance.v1`, `support.ai-automation.v1`).

## AI go-live readiness (server endpoint)

Implemented in the app server (`server/go-live-readiness.mjs`) for the admin
panel at `/admin/go-live-readiness` (backend feature `support.go-live-readiness.v1`).

- `POST /api/admin/go-live-readiness` — `{}` → the four go-live prerequisites,
  each evaluated during the request, never stored: the two AI migrations
  (`20261015120000` proven by the objects it creates in the connected
  database, `20261015120100` by the backend contract features it registers),
  Anthropic key presence on this service (a boolean only — the key's value,
  length, and prefix are never returned or logged), the
  `HUB_AI_AUTOMATION_ENABLED === "true"` toggle state, and a live DNS lookup
  for `help.caremetric.ai` including what it resolves to. SMS session
  required; the caller must be the platform administrator
  (`get_support_actor_context` role `platform_admin`), everyone else gets 403.
  The endpoint reports only: it applies nothing and changes nothing.

## Unified communications (server endpoints)

Implemented in `server/communications.mjs` (backend feature
`support.communications.v1`). See [UNIFIED_COMMUNICATIONS.md](UNIFIED_COMMUNICATIONS.md).

Provider webhooks (POST only; any `Origin`, `Cookie` or query string is refused):

- `POST /api/channels/sms/twilio` — Twilio form post, verified with
  `X-Twilio-Signature` against `HUB_PUBLIC_ORIGIN`. Returns empty TwiML.
- `POST /api/channels/email/inbound` — SendGrid Inbound Parse (parsed mode,
  signed webhook, at most 10 MiB), verified with
  `X-Twilio-Email-Event-Webhook-Signature` and `-Timestamp` (ten-minute window).

Website chat (same-origin; the visitor's token is the `__Host-caremetric_chat` cookie):

- `GET /api/chat/availability` — `{ chat: boolean }`.
- `POST /api/chat/start` — `{ name, email, product?, message, noPhi: true }` →
  `{ reference }` and the chat cookie. 503 unless `HUB_CHAT_ENABLED=true`.
- `GET /api/chat/thread` — the visitor's messages and staff replies; never notes.
- `POST /api/chat/message` — `{ message }`.
- `POST /api/chat/end` — `{}`; clears the cookie.

Staff (same-origin, SMS session, `case.read`/`case.write` for the application):

- `POST /api/communications/list` — `{ status?, channel?, productId?, search?, offset, limit ≤ 50 }`.
- `POST /api/communications/get` — `{ id }` → conversation with messages and notes.
- `POST /api/communications/update` — `{ id, expectedUpdatedAt, status?, inquiryType?, changeProduct?, productId?, changeAssignment?, assignedTo? }`; a stale `expectedUpdatedAt` returns 409.
- `POST /api/communications/note` — `{ id, body, requestKey }`.
- `POST /api/communications/reply` — `{ id, body, requestKey }` → `{ delivery, deliveryChannel, replay }`.
  A `requestKey` replays only the exact text it first carried; reusing it with different text returns 400.
- `POST /api/communications/sync` — `{ source: "breathe.phone" | "advisors.web", offset? }` →
  `{ source, read, created, skipped, nextOffset }`; platform administrator only. Reads up to 200 messages from
  `offset` (default 0); `nextOffset` is where the next batch starts, or `null` when none remain.
- `GET /api/communications/channels` — which channels are configured, as booleans only.

## Healthcare Advisors administration reads

`POST /api/admin/read` with `product: "advisors"` accepts only `capabilities`,
`overview` and `inquiries.list` (`{ search?, limit ≤ 50, offset }`). See
[ADVISORS_ADMIN_CONNECTION.md](ADVISORS_ADMIN_CONNECTION.md) (backend feature
`platform.admin.advisors.v1`).
