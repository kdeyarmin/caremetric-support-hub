# Security and compliance boundary

## Non-negotiable controls

- Use a dedicated hosted Supabase High Compliance project before accepting PHI.
- Execute the applicable BAA and enable the required HIPAA controls before data entry.
- Require MFA/AAL2 for every CareMetric staff principal and every customer who has enrolled a verified TOTP factor.
- Expose `hub` only; never expose `private`.
- Use a publishable browser key. Secret/service-role keys belong only in controlled server functions.
- Authorize from current relational membership and permission rows—not `user_metadata`, email domains, URL parameters, or app-supplied tenant IDs.
- Never place patient identifiers, case bodies, filenames, raw payloads, access tokens, or signed URLs in logs or audit metadata.
- Keep internal notes physically separate from customer correspondence.
- Treat every inbound free-text body as `possible_phi` until classified.

## Current release restrictions

Version `0.1.0` may serve the public non-PHI Help and Learning pages. It must not accept production customer cases or PHI. It intentionally omits attachments, inbound email, telephone recording, AI case processing, search indexing of case bodies, and federated login exchange.

The production web client now provides explicit TOTP enrollment, multi-factor challenge selection, factor management, and safe sign-out. Migration `20260907202818_require_aal2_for_authenticated_support.sql` enforces AAL2 below the UI for staff and opted-in customers, redacts tenant context during the AAL1 bootstrap, and prevents dual-role staff from falling through customer membership policies. Supabase does not issue MFA recovery codes, so administrators must keep a second verified authenticator and use a controlled Auth-admin recovery process if all authenticators are lost.

## Required production checks

1. Run `npm run check`.
2. Run `supabase test db` against the isolated local stack.
3. Run Supabase database and security advisors.
4. Verify all `hub` tables have RLS and explicit grants.
5. Verify all exposed views use `security_invoker=true`.
6. Verify every exposed `SECURITY DEFINER` RPC authenticates the caller, performs relational authorization, pins `search_path=''`, and has public execution revoked.
7. Test tenant A/product A against tenant A/product B and tenant B/product A.
8. Test own-case, tenant-case, product-agent, content-editor, auditor, and platform-admin roles.
9. Confirm suspended membership loses access immediately with an unexpired JWT.
10. Confirm the production bundle contains no secret/service-role key.

## Attachments (future release)

Attachments require three separate private stages: upload quarantine, malware/DLP inspection, and clean-file storage. Clients must never receive direct write policies to the clean bucket. Original filenames must not be used in object paths. A database cascade does not delete a Storage object, so retention must verify object deletion before removing metadata.

## Federation (future release)

Each product backend will create a short-lived asymmetric token containing issuer, audience, subject, expiry, nonce, product, opaque tenant reference, app version, environment, route template, and correlation ID. The exchange service must validate the signature and atomically consume the nonce, then map the external identity and tenant to verified private records. A token claim never creates a membership.

## Reporting a vulnerability

Do not open a public GitHub issue containing a vulnerability, credential, customer record, or support case. Use the verified private security contact after it is entered in the product/contact registry.
