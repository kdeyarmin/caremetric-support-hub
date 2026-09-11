# Governed draft editing

The CareBase course panel edits an existing governed draft after its exact source has been loaded, reviewed and preserved. The first editing contract changes version title/description and existing lesson titles, text, video transcript and estimated minutes. It retains native block IDs and other body fields. It does not replace quizzes, accepted packages, media locations, provider rules or learner records.

Each action uses the existing source/session-bound preview and explicit confirmation. An uncertain retry retains its request ID; apply uses the same native command ID. The native database locks the source, checks its digest again and owns the write. Hub stores the original reviewed source and exact native outcome, including the resulting source digest for edit/review actions. A completed replay still checks current native and Hub authority.

AI drafts require explicit approval of the complete saved material. Unsaved edits disable approval and publication in the UI. After saving, load and preserve the current material before approval. Native review records the human actor and material digest; later material edits invalidate approval. Non-AI drafts retain the native publishing policy. No approval or course mutation happens while loading the editor.

Patches allow at most 20 distinct existing blocks and 24 KiB of encoded changes. The authoring HTTP route accepts at most 32 KiB; the separate learning receipt route retains its 4 KiB limit. Source evidence remains bounded to 2 MB. All transport destinations and delegation audiences are fixed.

Release requires the paired native draft-edit/review migration and server before enabling this UI. The Hub's forward intent migration extends the existing authority and immutable-outcome checks. CI exercises the real disposable PostgreSQL/SMS/HTTP chain, including source preservation after edits, large bounded patches, exact-result replay and revocation. Native CI separately validates the actual write and review transactions. Production acceptance must not invent a reviewed course, customer mapping, certificate or payment.
