# Initial backend contract

Version `0.1.0` uses RLS-governed reads and narrow atomic RPCs in the `hub` schema.

## Reads

- `hub.products`: active product registry.
- `hub.support_contacts`: verified public product/contact routing only.
- `hub.support_case_queue`: requester/tenant-scoped or staff-permission-scoped safe case rows.
- `hub.published_content`: authorized published article, video, and course revisions with product placements.
- `hub.get_support_actor_context()`: current profile, role, and first active tenant context.
- `hub.get_support_case_thread(case_id)`: customer correspondence plus internal notes only for authorized staff.

## Commands

- `hub.create_support_case(...)`: validates active exact tenant/product membership and creates the case, participant, first message, and audit metadata atomically.
- `hub.reply_to_support_case(...)`: validates current access, keeps staff notes private, updates case state, and appends metadata-only audit history.
- `hub.update_support_case(...)`: requires `case.write`, verifies assignee product authorization, and changes only operational fields.

Every command derives the actor from `auth.uid()`. No caller may set requester identity, requester display name, staff role, data classification, or audit actor.

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
