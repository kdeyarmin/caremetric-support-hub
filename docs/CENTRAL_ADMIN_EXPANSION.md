# Portfolio administration connections

This increment extends the existing authenticated `/admin` workspace with application selection, capability discovery, organizations, users, and subscription records. It retains the existing CareBase course browser and shared Hub learning/support entry points. It does not complete the portfolio implementation by itself.

## Contract and authority

The browser submits a flat `{ product, operation, ...parameters }` request to the Hub server's same-origin `POST /api/admin/read`, authorized by the owner's Hub sign-in; the server issues a one-use capability for that exact read (`server/delegations.mjs`). The `platform-admin` Edge function remains only for older JWT integrations. Omitting `product` retains the deployed CareBase behavior. The proxy validates current Hub authorization, resolves a checked-in destination, strips the product selector before forwarding the native operation, and validates the returned product, operation, page window, and declared fields. Unconfigured products never receive the Hub token. Existing browser-origin restrictions, deadlines, body bounds, session revocation checks, and native account mappings remain in force.

| Product | Native route | New reads | User scope |
| --- | --- | --- | --- |
| CareBase | `https://cmcarebase.com/api/platform-admin/read` | capabilities, organizations, profiles | Native profiles; profile activity is not a claim about Auth eligibility |
| Breathe | `https://cmbreathe.com/resupply-api/central-admin/read` | capabilities, overview, organizations, staff, phone-line messages | Active/inactive staff accounts with native `admin` or `agent` roles; customer/patient accounts are excluded |
| CareMetric Intel | `https://www.caremetricintel.com/functions/centralAdminRead` | capabilities, overview, registered users ([connection](INTEL_ADMIN_CONNECTION.md)) | Registered application users; no organizations |
| Healthcare Advisors | `https://caremetricadvisors.com/api/hub/admin-read` | capabilities, overview, consultation requests ([connection](ADVISORS_ADMIN_CONNECTION.md)) | No software accounts |
| EMR, PennSync, Go | Not connected; these applications use their own support | No calls forwarded | No records or totals invented |

Applications' own billing reads are no longer requested: platform billing moved into the Hub (the CareMetric Stripe account, [platform billing](PLATFORM_BILLING.md)), and the control center reads subscriptions from there.

Breathe native user IDs are case-sensitive TEXT values; its legacy bounded alphanumeric, underscore, and hyphen IDs are preserved. Hub actor IDs and Breathe organization/subscription IDs remain UUIDs. Native grants are checked separately; a directory record never grants authority.

The UI requests capabilities before exposing supported controls, isolates failures by selected application, cancels and discards old results on selection/search changes, and bounds page sizes and offsets. The 97-entry source inventory remains an inventory, not a claim of 97 integrated controls.

## Release gates

1. Native CareBase and Breathe changes pass their own authorization, contract, ingress and existing application checks.
2. Hub protocol/proxy checks prove fixed destination routing, rejected response mismatches, projection of unreviewed fields, native identity compatibility, exact page windows, and complete billing-state counts.
3. Release native adapters before the Hub proxy and frontend. Configure only independently verified owner mappings using server deployment variables; retain each app's own server credentials.
4. Deploy the Edge function with `index.ts`, `handler.ts`, `adminProtocol.ts`, `portfolioProtocol.ts`, and `adminRegistry.ts`. This increment requires no database migration and retains backend contract 2.
5. Check deployed source revisions, public/anonymous denial, and the owner's real MFA-authorized reads. Automated fixtures are recorded separately from production-user evidence.

Following increments add audited preview/apply access controls, the remaining native adapters, governed learning publication and completion receipts, shared billing entitlements, identity and support cutovers. Each has its own acceptance gates; read-only deployment does not satisfy them.
