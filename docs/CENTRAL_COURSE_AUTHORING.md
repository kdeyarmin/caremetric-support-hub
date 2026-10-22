# Central course authoring commands

CareBase PR #612 removed every in-app course authoring path; the Hub is now the only
place course content changes. This page tracks the Hub screens for the CareBase
commands that PR added. Each one uses the existing SMS delegation, so CareBase
re-verifies the mapped platform administrator on every call and writes its own
audit row.

| Command | Hub screen | Status |
| --- | --- | --- |
| `learning.unpublishCourse` | Course version controls: **Unpublish this course** | Shipped |
| `learning.correctPublishedBlock` | Course version controls: **Correct a published lesson** | Shipped |
| Training library curation (`/api/learning-admin/catalog`) | Training library | Not yet |
| AI drafting and block regeneration (`/api/learning-generation/run`) | **Draft a course with AI** and **Regenerate a lesson with AI** ([details](AI_COURSE_GENERATION.md)) | Shipped, single courses only |
| Avatar video generation (`/api/learning-generation/run`) | **Generate an avatar video** ([details](AI_COURSE_GENERATION.md#avatar-video)) | Shipped |
| Package dependency resolution (`/api/learning-admin/package`) | Replace packages | Not yet |

## Unpublish and published-lesson corrections

Both are two-step commands on the existing course version controls, and both apply
only to the current published version of an active global course. The administrator
loads the course versions, loads the current published version's exact material,
reviews and preserves it, and enters a reason of 10 to 500 characters. As with every
other authoring action, the Hub refuses a preview unless the preserved source head
matches the material being changed, and it records the native preview and outcome in
`private.learning_authoring_intents`.

- **Unpublish** archives the course. The preview shows the course status changing
  from `published` to `archived`. The published version, enrollments, completions and
  certificates do not change.
- **Correct a published lesson** fixes one lesson in place without a new version: its
  title, a text lesson's text or a video lesson's transcript. The editor shows the
  before and after text of each changed field. Questions, answers, media and lesson
  order still need a new draft version. The correction changes the source revision,
  so the administrator loads and preserves the material again before another change.

CareBase refuses a correction while a video for that lesson is still generating, and
refuses text that looks like a credential. The preview expires after five minutes; the
confirmation shows a countdown. Retrying a confirmation returns the original result.

`20261022120000_learning_catalog_authoring_intents.sql` adds the two actions to the
Hub's intent ledger and requires both results to carry the resulting source digest.
`20261022120100_learning_catalog_authoring_contract.sql` declares
`learning.catalog-authoring.v1`, which connected builds require.
