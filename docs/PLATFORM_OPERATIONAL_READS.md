# CareBase operational reads

The Hub administrator workspace adds Jobs, Releases and Audit views when the current CareBase adapter advertises their individual capabilities. Each view uses the existing fixed CareBase read endpoint and bounded literal search (100 characters, no control characters or wildcard asterisk), 20-row UI pages, a maximum native page size of 50 and offset at most 10,000.

| Operation | Source and limits |
| --- | --- |
| `operations.jobs.list` | The native shared job control-plane reader. Edge/worker execution records remain distinct from successful cron dispatch. Never recorded and unknown freshness/counters stay explicit. PostgreSQL cron starting, connecting and sending are in progress. Counts and duration are exact decimal strings. |
| `operations.releases.list` | Native feature definitions, optional recorded rollout configuration and unexpired stop switches. A definition with no rollout record is unconfigured. Stored configuration does not prove that a consumer checks it or that a particular organization receives a feature. |
| `operations.audit.list` | Newest-first audit event/action/entity and actor identifiers. No raw metadata, old/new values, error bodies, patient records or arbitrary payload inspection. Search covers actions and entity types. |

All three are CareBase-only; other product requests are rejected and their capability lists cannot advertise these operations in the Hub. The strict shared parser rejects unexpected row/page/envelope fields, inconsistent pagination, duplicate identifiers, unsafe counters and contradictory rollout metadata.

## Current authority

The SMS gateway issues the existing `carebase` read audience. For these three operations only, issue and single-use consume call the existing `hub.authorize_app_command()` authority reader to include the original session UUID, original sign-in time and bounded assurance expiry. This grants no command audience, new role or mutation. Ordinary read responses retain their existing four-field actor contract. The native adapter independently validates the bound operation, explicit identity mapping, current native profile/Auth authority and its database delegate.

After every generic native administration read returns, the Hub re-enters the original current session and current authorization before returning data to the browser. Logout, replaced identity, expired assurance or permission revocation during an operational read suppresses the result. The fixed target, bounded response/timeout, redirect rejection and private error projection remain in the shared transport.

## Verification and release

No Hub database migration, new secret, provider configuration or backend feature is added. This uses `platform.admin.read.v1`; the paired native adapter and its existing operational-read migration must be reviewed and released before it advertises the operations.

`operationsProtocol.test.ts` and `OperationalRecords.test.tsx` exercise adversarial contracts, exact counters, truthful states, capability gating, search, pagination and abandoned responses. `server/operations-integration.mjs` runs only against the disposable Supabase stack and exercises the real SMS/PostgreSQL/HTTP issue/consume paths with synthetic native network records, including current authority before and after dispatch, audience separation and private-field rejection. It is part of database CI. No test creates a production job, rollout or audit mutation.
