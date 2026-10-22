# Training library

CareBase PR #612 moved training library curation out of the CareBase owner console. The
Hub's **CareBase courses** view now includes a **Training library** panel with four
sections, each backed by CareBase's `/api/learning-admin/catalog` route:

| Section | CareBase operation | Saved by |
| --- | --- | --- |
| Elective collections | `collections.save` | collection ID |
| Refresher lessons | `refreshers.save` | lesson ID |
| Discovery metadata | `metadata.save` | course ID |
| Starter kits | `starterKits.save` | kit ID and revision |

CareBase owns every record. Each request goes through the Hub server with a one-use
`carebase.learning` delegation bound to the exact operation, so CareBase re-verifies the
mapped platform administrator before it reads or saves anything. The Hub checks each
record against the same limits CareBase enforces before it issues the delegation, and
checks CareBase's response against the operation it sent.

- **Reads** load one section at a time, page by page, following each page's `nextAfter`
  key until it is `null`. The Hub sorts records for display and reloads the section
  after every save.
- **Saves** send the whole record. The Hub generates the ID of a new record and one
  request ID per exact record, so a retry after a timeout returns CareBase's first result
  instead of saving twice. There is no delete: to withdraw a record, unpublish it.
- **Starter kits** use optimistic locking. A save sends the revision that was loaded;
  if someone else saved the kit since, CareBase answers `conflict`, and the Hub reloads
  the section for the administrator to edit again.
- **Course pickers** offer published global courses for collections, starter kits and
  linked refresher courses, and any global course for discovery metadata. CareBase checks
  each course's eligibility again, including that an AI-generated current version has
  been reviewed.

The route needs no Hub migration. It is unavailable until CareBase sets
`CAREMETRIC_ADMIN_ENABLED`, `CAREMETRIC_ADMIN_COMMANDS_ENABLED` and
`CAREMETRIC_LEARNING_AUTHORING_ENABLED`.
