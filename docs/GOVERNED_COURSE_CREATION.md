# Governed course creation

The CareBase course catalog in Hub administration now creates a native global course and its first governed draft through the common CareBase writer. It presents current global training types, a field review and an explicit create action. Native content, assessment, package, AI review and publication requirements remain authoritative.

The Hub stores the reviewed request before calling CareBase. Request, course and version identities survive uncertain responses. The native writer uses absence locks, immutable command receipts and transactional audit. The Hub's private catalog registration is a staff-only draft and creates no publication, product availability, enrollment, membership, credit or certificate.

An applied receipt can be recovered under a newly verified session belonging to the same Hub principal and native administrator. This uses a GET-only native status operation; it does not reuse the original session's apply capability. A confirmed unused identity can be reviewed again under a new request while retaining the original course and version IDs. Native identity locks prevent two courses from being created by racing requests. Older requests remain available for recovery.

If the exact original empty draft is still current, the Hub preserves its verified source SHA. If the course was edited before recovery, the Hub registers its identity without claiming an initial snapshot. The operator opens the course and reviews the current material through the existing source-preservation workflow. Existing catalog mappings cause an explicit conflict and are never overwritten.

The coordinator is `/api/admin/course-creation`. It uses one-use, exact-operation `carebase.learning` capabilities at the fixed CareBase authoring endpoint. Raw intentions and internal provisioning functions are unavailable to browser, anonymous and service-role clients. The current Hub editor and administrator checks run again before local persistence after each native response.

Verification includes request/result contracts, interrupted UI flows, actual disposable PostgreSQL/SMS/HTTP recovery across sessions, changed-source handling, mapping conflicts, current native and Hub revocation, private SQL grants and required-feature omission tests. Native CI separately exercises actual course creation, rollback, publication and historical-evidence rules. Production acceptance must use owner-selected material; synthetic courses are not created in production as a deployment check.
