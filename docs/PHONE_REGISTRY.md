# Phone number registry

Platform administrators can open `/phone-numbers` to add and maintain business
phone records. The registry starts with the four Twilio numbers inspected on
September 24, 2026. It does not claim to discover numbers from other accounts or
providers automatically.

Each record includes the number, display name, provider/account, purpose, apps,
responsible owner, lifecycle, voice/text configuration, routing descriptions,
last known use date, review date, usage evidence and notes. Search and lifecycle/
review filters make inactive or unverified numbers easy to find. Retired records
remain visible; there is no deletion or provider-change operation.

Configured routing is separate from observed usage. Only the shared 877 line
had a completed call verified in the initial audit. Exact last-call dates were
not retained, so the seed leaves them blank. The three patient lines start with
unknown usage. The 877 texting feature is pending an updated registration and
the 833 number's SMS verification was rejected. These are dated observations,
not live provider health or automatic traffic monitoring.

The private RLS-enabled table has no direct client/app-server grants. Closed
RPCs use the Hub's existing current SMS session and relational platform-admin
authorization. Save validates every field, rejects duplicates and unexpected
keys, and uses version checks to prevent stale overwrites. Existing phone numbers
cannot be renamed; add another record instead. Audits contain only the entity ID,
action, and version, without free-text content.

Deployment order: apply `20260925020325_phone_number_registry.sql` and
`20260925022151_phone_registry_contract.sql`, then deploy the web/server image.
The startup/build compatibility gate requires `phone.registry.v1`; its declaration
checks the private table, RLS, direct grants and guarded RPCs while preserving
other backend features. These migrations are additive and grant no new staff roles.
Run the UI/validation suite and `server/phone-registry-integration.mjs` against
the isolated Supabase stack before release. The integration exercises real
session authorization, customer denial, revoked/banned users, private-table
denial, field validation, duplicates, stale updates and retirement.
