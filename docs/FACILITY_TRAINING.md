# Facility training in the Super Admin Hub

Open **Admin → CareBase → Facility training**. The owner uses the Hub sign-in throughout these controls. CareBase remains the authority for its organizations, students, enrollments and certificates; the Hub does not copy these records into a second learning database.

## Owner workflow

1. Create a new complimentary training facility, choosing PCH or ALF, or search for an existing organization and facility. Creation grants only the training package and its independent complimentary term.
2. Invite its organization administrator. The role is fixed to organization administrator. For students, add their staff record, explicitly invite them, then assign a published course. Adding a record does not send a message by itself.
3. Manage student details and active status, assign courses, or cancel unfinished enrollments. Completed training and certificate history remain retained. Student employment changes use the existing native lifecycle; they are not a shortcut around login or session controls.
4. Review enrollments, completion counts, progress and issued certificates. Select dates and statuses and run the report. The date basis is enrollment, completion or certificate issuance in Pennsylvania time. Repeated annual assignments are separate enrollments; canceled enrollments are excluded from the completion denominator.
5. Export a complete CSV or print the complete report. Both request one database snapshot, capped at 10,000 matching enrollments. Larger results require narrower filters. No partial export is presented as complete. Ready certificate PDFs open through scoped, short-lived native Storage links, without an application sign-in. Pending and failed PDF jobs remain visibly pending or failed.
6. Review complimentary or executed-contract module terms, then grant or revoke one exact term. These controls do not charge a card or change Stripe subscriptions. Use the Hub's Billing workspace for configured checkout and subscription controls. An administrative suspension continues to override module access.

Each change presents the exact intended target, fields and reason. Retrying an uncertain change uses the same request identity. Native receipts prevent duplicate writes. Invitations reserve their request before sending; an unknown provider outcome must not be interpreted as delivered or automatically resent.

## Other owner workspaces

The Admin workspace also links directly to the Hub's support cases, AI phone inbox, phone-number registry and routing, course authoring/distribution, learning videos/imports, knowledge articles, product contacts, customer onboarding and account security. These are internal Hub routes using the current sign-in.

The application selector continues to expose the operations actually supported by each connected app. CareBase has billing, access, learning, job, release and audit controls. A directory or subscription read from another app does not imply that app supports every mutation. **All app functions** distinguishes connected controls from source inventory and unavailable connections. No generic app impersonation or external application password is introduced.

## Connection and deployment contract

- Browser: same-origin `POST /api/admin/training`, HttpOnly Hub session, existing CSRF/origin boundary.
- Hub: validates the dependency-free `training.v1` contract, issues an operation-bound `carebase.command` capability, and calls only `https://cmcarebase.com/api/platform-admin/training`.
- CareBase: rejects browser-origin calls, consumes the exact one-use capability, revalidates current Hub permission/session assurance and the explicitly mapped active native administrator, and invokes service-only, audited organization-scoped operations. No native JWT is fabricated and no service credential enters the browser.
- Hub rechecks current permission after native I/O before releasing the response. Reports may use a larger bounded response only for the complete export; other controls keep their existing limits. Response projection excludes unexpected upstream fields.
- Deploy the PennTrain native migrations and adapter first, with the existing administrator/command configuration, then this Hub version. The UI requires the native `training.v1` capability. No new external credentials or application accounts are collected by the Hub.

## Verification boundaries

Protocol/server tests cover explicit scope, response projection, certificate destinations, invalid request rejection, cancellation and permission revocation. The disposable Hub PostgreSQL/SMS/HTTP integration exercises a fresh owner session, real one-use delegation, request identity recovery and complete report transport; its remote CareBase response is a fixture. CareBase CI separately exercises the actual delegated SQL mutations, authorization and invitation behavior. UI tests exercise owner workflows with injected clients.

Live owner access, real email activation and production certificate generation still require verification after deployment. Training activity reports are not a DHS approval or a determination that a facility meets every requirement.
