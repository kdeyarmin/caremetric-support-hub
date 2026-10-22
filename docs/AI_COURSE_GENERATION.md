# AI drafting, lesson regeneration and avatar video

CareBase PR #612 made its AI and video edge functions accept only calls relayed from the
Hub. The Hub reaches them through CareBase's `/api/learning-generation/run` route with a
one-use `carebase.learning` delegation bound to the exact operation. CareBase re-verifies
the mapped platform administrator when the call starts, and again when an AI result is
saved: if the session expires or access is removed while the AI runs, nothing is saved.

| Hub control | Operation | Where |
| --- | --- | --- |
| Draft a course with AI | `ai.generateCourse` | CareBase courses view |
| Regenerate a lesson with AI | `ai.regenerateBlock` | Course version controls, governed draft |
| Generate an avatar video | `video.options`, `video.generate`, `video.status` | Course version controls, governed draft |

## Drafting and regeneration

**Draft with AI** creates one new global draft course, flagged as AI-generated. It
cannot be published until an administrator approves it with the existing
`learning.reviewDraft` command. Source material is the authority for regulatory
specifics; without it, the draft's description says they are unverified. The panel
offers a link to open the new draft in the course editor.

Training plan mode, which creates a training plan inside an organization, is not
offered: whether the Hub should create records inside an organization is still an
open product decision. The Hub refuses that mode before it issues a delegation.

**Regenerate with AI** rewrites one text, video script or quiz lesson of a draft in
place, with the administrator's feedback. It marks the draft AI-generated again and
clears its review, and the source revision changes, so the administrator loads and
preserves the material again before another edit.

Both calls can take about two minutes and twenty seconds before CareBase answers. The
Hub server allows 160 seconds and the browser 175 seconds, and the controls show a
progress state that cannot be submitted twice. CareBase runs at most two generation
calls at once.

## Avatar video

The dialog loads HeyGen avatars and voices, listing AI twins and private avatars first
and preselecting an avatar's default voice. Each render is a paid provider call, so the
dialog creates one request ID when it opens and reuses it on every retry: a retry
returns the same attempt instead of paying again. The Hub polls `video.status` every 30
seconds while the dialog is open, and CareBase also finishes renders on its own
schedule.

- Avatar and voice previews are not shown. The Hub's content policy loads no
  third-party images or audio, so the Hub drops HeyGen's preview links.
- The Hub never loads a lesson's video link. It can render for a lesson with no video,
  or replace an uploaded video asset after the administrator confirms. A lesson with a
  linked video must have that link removed in CareBase first.
- A retry is offered only when the same request can resume it. When CareBase says the
  submission is still being confirmed, the dialog waits 45 seconds first. When the
  provider response is unresolved, no retry is offered: a person must reconcile it in
  CareBase before a new render.

CareBase writes its error messages for administrators, and the Hub shows them as
written. The route needs no Hub migration. It is unavailable until CareBase sets
`CAREMETRIC_ADMIN_ENABLED`, `CAREMETRIC_ADMIN_COMMANDS_ENABLED`,
`CAREMETRIC_LEARNING_AUTHORING_ENABLED` and `CAREBASE_LEARNING_DELEGATION_TOKEN`.
