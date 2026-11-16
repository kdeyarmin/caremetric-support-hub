# Intel live administration bridge

CareMetric Intel runs on Railway as an Express API with its own Postgres database (`kdeyarmin/intel`; see that repository's
`docs/INTEL_HUB_CONNECTION.md` and `docs/BASE44_CUTOVER.md`). The earlier Base44 runtime has been retired. The bridge
(`server/lib/centralAdminRead.ts`, mounted at `/functions/centralAdminRead`) provides capabilities, the registered-user
overview, the user directory and support identity checks. Organizations and active-account totals are explicitly
unavailable through it; no billing operation is advertised, because Intel's subscriptions are billed by the Hub.

The Hub uses the fixed `https://www.caremetricintel.com/functions/centralAdminRead` destination and
`X-CareMetric-Hub-Authorization`. The bare `caremetricintel.com` host answers with a redirect to `www`, which the Hub's
`redirect: 'error'` call refuses, so the destination names the `www` host directly. Only the current app-owned SMS or
password session can issue a one-use `intel` capability, and Intel redeems it at
`/api/internal/admin/intel/authorize`. Legacy JWT proxy requests stop before forwarding. The bridge then requires the
Hub user to be listed in Intel's `CAREMETRIC_ADMIN_IDENTITY_MAP_JSON` and the mapped Intel account to still be an active
admin; `CAREMETRIC_ADMIN_ENABLED` switches it on.

Apply `20260911184616_hub_intel_admin_audience.sql` before this runtime. The constraint preserves Go, publication,
learning, command and media audiences. A deployed bridge alone is not proof of a working authorized connection: confirm
"Connection verified" under **Applications → CareMetric Intel** with the owner's own sign-in.

## Account changes

Intel's `/functions/centralAdminCommand` turns an account off or back on from **Applications → CareMetric Intel → Users**, with
the same review-then-apply contract CareBase uses and an `intel.command` capability redeemed at
`/api/internal/command/intel/authorize`. It uses Intel's own disable and enable rules (never your own account, never the last
active admin, never an invitation not yet accepted; turning an account back on needs a free seat) and is off until
`CAREMETRIC_ADMIN_COMMANDS_ENABLED=true` on Intel. See [central access commands](CENTRAL_ADMIN_COMMANDS.md#breathe-and-caremetric-intel).

