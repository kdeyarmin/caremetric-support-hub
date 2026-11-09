# Security and compliance boundary

## Non-negotiable controls

- Use a dedicated hosted Supabase High Compliance project before accepting PHI.
- Execute the applicable BAA and enable the required HIPAA controls before data entry.
- Require a verified SMS sign-in session for every CareMetric staff principal. Authenticator apps (TOTP) are turned off in this project.
- Expose `hub` only; never expose `private`.
- Use a publishable browser key. Secret/service-role keys belong only in controlled server functions.
- Authorize from current relational membership, permission, and Auth-account state—not `user_metadata`, email domains, URL parameters, or app-supplied tenant IDs. Deleted, banned, and anonymous Auth principals fail closed even while an older JWT remains unexpired.
- Never place patient identifiers, case bodies, filenames, raw payloads, access tokens, or signed URLs in logs or audit metadata.
- Keep internal notes physically separate from customer correspondence.
- Treat every inbound free-text body as `possible_phi` until classified.
- Customer message text reaches a model only through the AI team's Support Concierge, only while the owner has switched on **Let agents send customer messages to the AI** (Settings → AI team), only for a plain first question that the identifier screen did not flag, and only after links, email addresses, phone numbers, dates, long numbers and street addresses are removed ([details](docs/AI_TEAM.md)). The staff case assistant is a separate path with its own switch.
- Keep production case intake disabled for every tenant/product until that exact entitlement is explicitly activated and an active support writer with a verified SMS sign-in number is available.
- Require a caller-generated UUID request key for retryable case creation and replies. The private ledger may contain only keyed digests and entity identifiers, never subjects or message bodies.

## Current release restrictions

Version `0.1.0` may serve the public non-PHI Help and Learning pages. It must not accept production customer cases or PHI. It intentionally omits attachments, telephone recording, search indexing of case bodies, and federated login exchange.

[Unified communications](docs/UNIFIED_COMMUNICATIONS.md) can receive inbound text messages, email and website chat, but each stays off until its provider credentials are set or, for chat, **Website chat** is switched on in Settings. Do not enable them for production traffic until the controls above are operationally verified. Inbound bodies are stored as `possible_phi` in private tables reachable only through reviewed functions; webhooks require the provider's signature (Twilio HMAC, SendGrid ECDSA); attachments are never stored; and message text never enters logs or audit metadata.

[Website leads](docs/LEAD_INTAKE.md) arrive server to server from CareBase, Intel and Healthcare Advisors at `POST /api/leads`, each signed with that product's own secret (HMAC-SHA256 over the timestamp and exact raw body, a 300-second window, constant-time comparison); a product without a secret of at least 32 characters is refused. A lead row holds contact details and short facts only, in a private table with no direct grant to any role. The visitor's message is treated as `possible_phi`: it is stored only as the inbound message of the lead's conversation, and never on the lead, in logs, audit metadata or responses. A lead is deleted twelve months after it arrives, and a website conversation twelve months after its last message ([retention](docs/LEAD_INTAKE.md#retention)).

The production web client signs staff in with a registered mobile number and a six-digit SMS code, and provides safe sign-out ([details](docs/APP_SMS_SIGNIN.md)). Authenticator apps (TOTP) are turned off in the Supabase project, so no authenticator factor can be enrolled or used. Migration `20260907202818_require_aal2_for_authenticated_support.sql` enforces a verified session below the UI for staff and for any customer with a verified second factor, redacts their tenant context before verification, and prevents dual-role staff from falling through customer membership policies; migration `20260911160622_app_sms_sessions.sql` lets the server-issued SMS session satisfy those checks, and legacy AAL2 sessions are still accepted for existing integrations. Number recovery is an operator action: verify the account holder through the established support process before changing a registered number.

Migration `20260907222641_gate_case_intake_and_add_idempotency.sql` adds a private, default-off activation gate for each tenant/product and keyed RPC overloads for safe retries. Activation also fails closed if the entitlement, tenant, or product is inactive, or if no unrevoked `case.write`/`platform.admin` principal on a usable non-anonymous account has both a Support Hub profile and a verified SMS sign-in number. Runtime authorization rechecks current deleted/banned/anonymous Auth state. Staff and membership grants cannot be composed to exceed either grant, and persisted message roles come from the path that actually authorized the write. Existing cases remain replyable by currently authorized principals when new intake is disabled. The request-key ledger is private, RLS-protected, and stores a SHA-256 request digest plus identifiers; the digest is still sensitive derived data and follows the case-retention boundary.

Migration `20260908004000_return_all_actor_memberships.sql` returns active
tenant/product memberships as indivisible pairs so the client cannot combine a
tenant from one entitlement with a product from another. Migration
`20260908004500_restrict_case_assignees_to_usable_staff.sql` prevents assignment
to deleted, banned, anonymous, or unprofiled staff principals.

## Required production checks

1. Run `npm run check`.
2. Run `supabase test db` against the isolated local stack.
3. Run Supabase database and security advisors.
4. Verify all `hub` tables have RLS and explicit grants.
5. Verify all exposed views use `security_invoker=true`.
6. Verify every exposed `SECURITY DEFINER` RPC authenticates the caller, performs relational authorization, pins `search_path=''`, and has public execution revoked.
7. Test tenant A/product A against tenant A/product B and tenant B/product A.
8. Test own-case, tenant-case, product-agent, content-editor, auditor, and platform-admin roles.
9. Confirm suspended memberships and deleted, banned, or anonymous Auth principals lose access immediately with an unexpired JWT.
10. Confirm the production bundle contains no secret/service-role key.
11. Confirm every tenant/product without an explicit approved activation row rejects case creation, and revoke intake immediately if the last qualified support route becomes unavailable.
12. Confirm repeated delivery of the same keyed request returns the original entity, while reuse of that key with changed content fails.

## Attachments (future release)

Attachments require three separate private stages: upload quarantine, malware/DLP inspection, and clean-file storage. Clients must never receive direct write policies to the clean bucket. Original filenames must not be used in object paths. A database cascade does not delete a Storage object, so retention must verify object deletion before removing metadata.

## Federation (future release)

Each product backend will create a short-lived asymmetric token containing issuer, audience, subject, expiry, nonce, product, opaque tenant reference, app version, environment, route template, and correlation ID. The exchange service must validate the signature and atomically consume the nonce, then map the external identity and tenant to verified private records. A token claim never creates a membership.

## Reporting a vulnerability

Do not open a public GitHub issue containing a vulnerability, credential, customer record, or support case. Use the verified private security contact after it is entered in the product/contact registry.
