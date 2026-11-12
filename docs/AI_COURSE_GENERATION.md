# AI drafting, lesson regeneration and avatar video

CareBase PR #612 made its AI and video edge functions accept only calls relayed from the
Hub. The Hub reaches them through CareBase's `/api/learning-generation/run` route with a
one-use `carebase.learning` delegation bound to the exact operation. CareBase re-verifies
the mapped platform administrator when the call starts, and again when an AI result is
saved: if the session expires or access is removed while the AI runs, nothing is saved.

## One-step course creation

**Course authoring → Create a course** is the owner's everyday way to make a course: type a title. CareBase's AI
(`generate-course-curriculum`) writes the whole course: lesson text, spoken narration scripts for video lessons, and
quizzes with answers. Two optional inputs steer it:

- **Anything specific to cover or add** goes to the AI as the administrator's notes (`notes`), for example the
  audience, topics that must be covered, or the length of the quiz.
- **Your own policy or reference text** (up to 100,000 characters) goes as `source_material`. The AI treats it as
  authoritative: it grounds the course in it and does not add regulations that are not in it. Without it, the AI
  flags in the course description that regulatory specifics have not been verified.

The AI decides which lessons are video and which are text, so the Hub always adds one instruction to the notes:
include at least one video module with a complete spoken narration script for a HeyGen presenter. If a draft still
has no video lesson, the preview says so plainly.

The Hub then runs the existing governed steps in order:

1. `ai.generateCourse` drafts one global course from the title (`title_hint`), the notes and any source material.
2. The draft's exact material is loaded, and every video lesson's script is sent to HeyGen with
   `video.generate`, using the owner's preselected presenter (their AI twin unless they picked another). One paid
   render per video lesson. The Hub checks `video.status` every 30 seconds until each is done.
3. The finished course is shown lesson by lesson. Nothing is live yet.
4. **Publish course** preserves the exact material the owner looked at, approves the AI content
   (`learning.reviewDraft`) and publishes it (`learning.publishVersion`). It refuses if the material changed after
   the owner looked at it.

The job is saved after every step and keeps running while the owner uses other pages, so leaving and coming back
picks it up where it left off. Video retries reuse the same request ID, so a retry never pays HeyGen twice; only a
render that HeyGen reports as failed gets a new request. The AI drafting call has no request ID, so if the page was
reloaded while a draft may still be running, the Hub does not repeat it on its own and asks the owner to check the
full course editor first. **Edit in the full course editor** opens the controls below for anything more.

## Individual controls

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

An avatar or voice that HeyGen lists without a name, gender or language is still offered,
with that detail left blank. Until Nov 2026 a missing field failed the whole list, and the
dialog could not load its choices even though CareBase had answered.

CareBase writes its error messages for administrators, and the Hub shows them as
written. Whenever the Hub answers a generation request with 503, its server log gets one
`hub_learning_generation_unavailable` line with the operation, CareBase's status (when it
answered) and the reason: `carebase_status` (CareBase answered with an error, and its
error code), `invalid_result` (CareBase answered, but not in the shape the operation
expects, and the first field that did not match), `response_too_large`,
`carebase_unreachable`, `response_unreadable`, `delegation_failed` or
`session_recheck_failed`. The line carries no message text, avatar or voice names, or
scripts. The route needs no Hub migration. It is unavailable until CareBase sets
`CAREMETRIC_ADMIN_ENABLED`, `CAREMETRIC_ADMIN_COMMANDS_ENABLED`,
`CAREMETRIC_LEARNING_AUTHORING_ENABLED` and `CAREBASE_LEARNING_DELEGATION_TOKEN`.
