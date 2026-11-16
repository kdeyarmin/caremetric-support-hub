# Central access commands

The Hub exposes CareBase access controls only when the native adapter advertises both `commands.preview` and `commands.apply`. Organization/user and subscription rows open a shared review form. The administrator chooses the desired state and provides a reason, then separately applies the exact native preview. Existing read-only connections retain their behavior.

| Command | Effect | Native authority |
| --- | --- | --- |
| `users.setActive` | Activate/deactivate a native profile; native deactivation revokes its sessions | Existing profile update semantics, with self/platform-admin targets excluded |
| `organizations.setSuspension` | Set/remove manual application suspension | Shared native organization and billing-account suspension rules |

## Security and retry behavior

The browser uses the Hub's SMS sign-in and an opaque HttpOnly session cookie at the same-origin `/api/admin/command` endpoint. The application server calls `hub.authorize_app_command()` through its restricted database role. This verifies the live SMS session, current account and global administrator permission, and the original eight-hour session limit. Each request receives a separate 30-second, single-use `carebase.command` capability. The native adapter introspects it at the fixed Hub command authorization endpoint, checks the exact parsed operation, and rechecks the explicitly mapped native administrator. The capability reports `method:sms`; it never claims Supabase AAL2. Authentication method, actor and original session bind preview and apply.

Existing JWT integrations retain the separate `platform-command` Edge route and `hub.authorize_platform_command()` RPC. That path still requires actual current TOTP/AAL2 and the original 480-minute session limit. Both transports enforce bounded requests, deadlines, fixed destinations and projected responses. A read authorization never authorizes a command.

Native previews expire after five minutes and bind their command ID, actor/session, action, target, reason, parameters and current state digest. The native transaction owns the idempotency ledger, state comparison, mutation and audit. A changed target is a conflict; replay returns the stored result. Failed audit recording must roll back the mutation. The Hub never creates a native user JWT or sets `auth.uid()` to impersonate the administrator.

The UI reuses the preview request key only for identical inputs. After an ambiguous apply response it retries the same immutable command ID/digest; it does not automatically issue another command. The response must match the preview's command, action, target and changes before the UI confirms success. Internal exception text and arbitrary native fields do not cross the gateway. Source tests cover actual boundary behavior; positive production changes are not executed merely for testing.

## Deployment order

1. Replay the combined migration history and all native/Hub tests, including the HTTP/PostgreSQL SMS test and existing native billing reconciliation suites. Preserve already-applied migrations exactly.
2. Configure the restricted `hub_app_server` connection and verify TLS/role identity. See `APP_SMS_SIGNIN.md`; no Node production release is valid while its connection is unavailable.
3. Apply the reviewed remaining snapshots, command authorization, SMS audience and combined feature migrations. API version 4 must advertise every required feature: learning runtime, administrator reads, app SMS, source preservation and administrator commands. An integer alone is insufficient; future additive features retain version 4.
4. Deploy native SQL/backend, including operation-bound SMS authorization. Enable `CAREMETRIC_ADMIN_COMMANDS_ENABLED` only for that reviewed release with its verified identity mapping.
5. Deploy the checked-in Edge functions for retained JWT integrations, preserving gateway verification. Release the combined Node server/frontend only after its feature manifest and database connection checks pass.
6. Verify the owner's actual SMS sign-in and administrative review. Use disposable fixtures for changes and retry/revocation tests; production access changes require an intended administrative action.

This is an access-control increment. Subscriptions and invoices are the Hub's own (Billing); customer identity federation and learning/support writer cutovers retain their own workstreams.

## Breathe and CareMetric Intel

The same review-then-apply rules now cover two more applications. Each application keeps its own receipts and checks its own
mapped administrator again; the Hub never holds an application credential.

| Application | What changes | Native endpoint | Hub audience | Switched on by |
| --- | --- | --- | --- | --- |
| Breathe | Suspend or restore an organization (`tenant.lifecycle.v1`: context, preview, apply, resume) | `https://cmbreathe.com/resupply-api/central-admin/tenant-lifecycle` | `breathe.command` | `CAREMETRIC_ADMIN_TENANT_COMMANDS_ENABLED=true` on Breathe |
| CareMetric Intel | Turn an account off or back on (`users.setActive`, this contract) | `https://www.caremetricintel.com/functions/centralAdminCommand` | `intel.command` | `CAREMETRIC_ADMIN_COMMANDS_ENABLED=true` on Intel |

- **Where:** Applications → Breathe → Organizations ("Suspend or restore") and Applications → CareMetric Intel → Users
  ("Change access"). The control center's application cards and the portfolio coverage matrix say, per application, whether
  changes are available or the application is view only, from what its live connection advertises.
- **Authority:** the browser calls `POST /api/admin/tenant-lifecycle` or `POST /api/admin/command` (`product: "intel"`). The
  server issues a 30-second, one-use capability of the application's command audience, bound to the exact operation. The
  application redeems it at `/api/internal/command/breathe/authorize` or `/api/internal/command/intel/authorize` and receives
  exactly `user_id`, `role`, `method`, `session_id`, `session_started_at`, `assurance_expires_at` and `operation`. A read
  capability can never authorize a change, and a capability for one application never authorizes another.
- **Refusals:** an application refuses a change it does not allow with 422 and a closed reason code (own account, protected
  administrator, last administrator, invited account, seat limit, no change, shared sign-in). The Hub shows its own fixed wording
  for the code and never forwards the application's text. Breathe shows its seed organization and archived organizations as not
  changeable before any review.
- **Retries:** a lost answer is recovered from the saved review (Breathe's `resume`; Intel's `apply` replays the stored result
  with `replayed: true`), never by sending another change.
- **Release order:** apply `20261117100000_app_command_audiences.sql` and `20261117100100_app_command_audiences_contract.sql`,
  deploy this Hub, then switch each application's flag on. Before the Hub's database declares `platform.admin.app-commands.v1`,
  the server refuses both audiences and hides the capabilities, so the applications can be released in any order. Verify on a
  real record with a preview only; never apply a change as a smoke test.
