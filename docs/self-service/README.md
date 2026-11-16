Only CareBase, Breathe, and Intel use centralized customer self-service.
PennSync, EMR, Go, and Healthcare Advisors use native support. Historical product
identities, memberships, cases, and learning records are retained. New Hub
connections, intake, delegated operations, and purchases are disabled for those apps.

`guides.json` is the maintained input for current instructions and printable
manuals. After an edit, run `npm run generate:guides`: it writes a new migration
(`supabase/migrations/<timestamp>_self_service_guides.sql`) that publishes the
guides as the file states them, and `npm run check:docs` fails until it exists.
Apply that migration to production like any other; the guides change only then.

A migration that has run is never run again, so the generator never rewrites
one. Each generated migration states every guide in full and brings the
database to it (`scripts/self-service-guides.mjs`): a guide gets a new revision
only when its text changed (revisions are kept), is published at that revision
in exactly the applications it names, and is unpublished when the file no
longer has it. `20261027145524_self_service_guidance.sql` and
`20261028221000_three_app_self_service_guidance.sql` were written by the
earlier generator and stay as released; the second could add placements but
never remove them, so the guides stayed in PennSync, EMR and Advisors until
`20261117100100_self_service_guides.sql`.

`20261028220500_limit_central_hub_to_three_apps.sql` closes the excluded apps,
revokes credentials and capabilities, and preserves current members' historical
case access with its existing privacy and suspension checks. PennSync's earlier
payment retirement remains in place; no Stripe connection or payment authority
is restored.
