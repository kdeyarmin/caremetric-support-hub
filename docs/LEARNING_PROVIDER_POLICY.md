# Governed course provider details

The Hub lets the current CareBase platform administrator review and change the
nine documentation fields of a course provider profile. The provider profile
belongs to the course and affects every version. It does not assert approval,
accreditation, or a credential. Credential fields are retained by the native
writer and cannot be supplied in this request.

Open a CareBase course under Administrator → Courses → Course authoring →
Provider details for all course versions. Load current details and saved requests,
select only fields to change, and enter a reason. Unselected fields preserve their
exact stored values, including legacy prose beyond current edit limits. Nullable
fields have explicit clear controls. Preview lists the precise before/after
values, affected draft approvals, signature-time action, and older certificates
that display the live provider name. Confirm only after reviewing that impact.

Issued certificates with captured provider snapshots retain those snapshots.
Legacy certificates without a snapshot continue their existing live-name fallback;
the preview reports their exact count when the provider name changes. The system
does not fabricate a historical snapshot. Signature timestamps come from the
native database: retain an unchanged signature, record a changed name, and clear
the time when its name is cleared.

The private native ledger is the sole provider command owner. Each operation
requires `domain: course.provider.v1`; same-audience authoring and creation DTOs
cannot be substituted. The fixed `/api/admin/provider` Hub endpoint issues an
opaque one-use `carebase.learning` capability to the fixed CareBase
`/api/learning-admin/provider` endpoint. Current Hub role/session/identity and
native Auth/profile checks apply before the request, at capability consumption,
inside the native writer, and again in the Hub after network I/O. No fabricated
JWT or AAL2 claim is involved in the SMS flow.

The native course-wide revision covers the current provider row, relevant course
and version state, and legacy certificate count. A changed context rejects the
preview's compare-and-set. The browser retains the request UUID after an
uncertain preview, and an uncertain apply locks navigation to its original
command until status is checked. A fresh session for the same owner can inspect
pending or completed commands, but cannot apply the prior session's review.
Completed status reports the original immutable receipt. Reload the current
course source and explicitly preserve it before further version editing.

Requests are closed, 32 KiB at HTTP ingress, with a 24 KiB sparse patch. Edits
validate real dates, text limits, control characters, and credential-bearing text.
Responses have exact projections, decimal-string counts and a 1 MiB byte bound.
Command pages contain at most 20 rows. The 12-second overall request deadline
also covers waiting for a database connection or ticket issuance.

Validation includes UI confirmation and uncertain-write recovery, all five
operation contracts, actual Hub PostgreSQL/SMS/HTTP capabilities and revocations,
and the production runtime image import graph. Native SQL tests cover row locks,
CAS, rollback, native and delegated callers, signature timestamps, source review
invalidation and unchanged issued certificate rows. Deploy the matching native
provider service before publishing these Hub controls. No new Hub database
objects, environment variables or Edge functions are required.
