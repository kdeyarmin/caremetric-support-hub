Only CareBase, Breathe, and Intel use centralized customer self-service.
PennSync, EMR, Go, and Healthcare Advisors use native support. Historical product
identities, memberships, cases, and learning records are retained. New Hub
connections, intake, delegated operations, and purchases are disabled for those apps.

`guides.json` is the maintained input for current instructions and printable
manuals. Run `npm run generate:guides` and `npm run check:docs` after edits.
The current generated migration is `20261028221000_three_app_self_service_guidance.sql`.
Previously released migrations remain immutable; future content changes require
another forward migration and reviewed content revision.

`20261028220500_limit_central_hub_to_three_apps.sql` closes the excluded apps,
revokes credentials and capabilities, and preserves current members' historical
case access with its existing privacy and suspension checks. PennSync's earlier
payment retirement remains in place; no Stripe connection or payment authority
is restored.
