# Reviewed training credit policy

The Hub's existing course version controls now include `learning.editCreditPolicy`.
An administrator loads and preserves the exact native draft, records a reason,
reviews the proposed rules, and confirms the existing native authoring command.
CareBase owns the transactional draft writer, revision comparison, training type
validation, publication requirements and learner evidence. This change adds no
second course writer or completion writer.

The form edits only the version label, credited duration rationale and credit
rules. It leaves course duration, duration exemptions, content standard, provider
credentials, media locations and package acceptance to their respective native
authorities. It exposes no URL or generic JSON editor for those fields.

Unchanged credit rules cross the request as `{creditId,preserve:true}`. Native
source comparison resolves their exact stored values, including legacy citations
and inactive training associations. Edited or new rules include their complete
definition and require a currently active global training type. The chooser uses
the existing authenticated, paginated `creationOptions` read. An existing rule
cannot change training type; its removal and replacement require distinct IDs.
The complete retained set and exact removed IDs are reviewed together.

Credit hours are canonical decimal strings from `0.01` to `9999.99`. The form
pads one or zero fractional digits using string operations; it never rounds an
extra digit or converts through floating point. Requests are limited to 100
retained rules, 100 explicit removals and 24,576 compact UTF-8 bytes. Unchanged
source prose is preserved by ID instead of being truncated to new input limits.

The Hub reuses the current SMS delegation, source snapshots and authoring intent
ledger. Native response recording checks current Hub authority again, validates
the command's source identity, and requires the resulting source SHA. A lost
response retries the same command; native replay checks current native authority.
The UI keeps field, lesson and credit edits in separate review groups and clears
an obsolete preview when any reviewed value changes.

CLI migrations `20260911215749_learning_credit_policy_intents.sql` and
`20260911215751_learning_credit_policy_contract.sql` extend the closed Hub action
validator and add `learning.credit-policy.v1` to the existing API 4 feature set.
The gate checks the actual source, session, result digest and current-authority
functions. It does not declare that a native deployment is ready. Release is
paired with the reviewed CareBase credit-policy writer; production remains under
the release owner's control.

Verification includes exact decimal and closed-protocol tests, preservation of
legacy rows, active-option error handling, explicit review and identical retry,
actual PostgreSQL/SMS/HTTP receipt recording and post-provider permission
revocation, plus nine omitted-boundary gate tests. Native tests separately prove
the actual training catalog, course credit writes, history and transaction rules.
