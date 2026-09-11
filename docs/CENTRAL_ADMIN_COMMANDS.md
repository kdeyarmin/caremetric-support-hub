# Central access commands

The Hub exposes CareBase access controls only when the native adapter advertises both `commands.preview` and `commands.apply`. Organization/user and subscription rows open a shared review form. The administrator chooses the desired state and provides a reason, then separately applies the exact native preview. Existing read-only connections retain their behavior.

| Command | Effect | Native authority |
| --- | --- | --- |
| `users.setActive` | Activate/deactivate a native profile; native deactivation revokes its sessions | Existing profile update semantics, with self/platform-admin targets excluded |
| `organizations.setSuspension` | Set/remove manual application suspension | Shared native organization and billing-account suspension rules |
| `billing.setAccessOverride` | Set complimentary access (optional expiration) or restore provider-derived access | Existing native billing override rules; does not cancel, charge or alter a provider subscription |

## Security and retry behavior

The browser sends its current Hub JWT to `platform-command`. The shared Edge gateway validates exact origins, bounded bodies, deadlines, fixed native destinations, and projected response fields. Both Hub and native command handlers call `hub.authorize_platform_command()` on preview and apply. This RPC invokes the existing current-session/TOTP/global-platform-authority check and additionally requires the original session to be at most 480 minutes old. JWT refresh does not extend that window. It returns the actual session ID/creation time and the earlier of its session deadline and eight-hour limit. Read-only authorization remains unchanged.

Native previews expire after five minutes and bind their command ID, actor/session, action, target, reason, parameters and current state digest. The native transaction owns the idempotency ledger, state comparison, mutation and audit. A changed target is a conflict; replay returns the stored result. Failed audit recording must roll back the mutation. The Hub never creates a native user JWT or sets `auth.uid()` to impersonate the administrator.

The UI reuses the preview request key only for identical inputs. After an ambiguous apply response it retries the same immutable command ID/digest; it does not automatically issue another command. The response must match the preview's command, action, target and changes before the UI confirms success. Internal exception text and arbitrary native fields do not cross the gateway. Source tests cover actual boundary behavior; positive production changes are not executed merely for testing.

## Deployment order

1. Merge and deploy the portfolio read expansion (backend contract 2), then the governed source snapshot release (contract 3).
2. Replay/test the native command migration and its existing application suites; validate the Hub command authorization migration, pgTAP and Edge/client tests.
3. Apply the exact Hub authorization and contract-4 migrations and deploy the native command SQL/backend. Set `CAREMETRIC_ADMIN_COMMANDS_ENABLED` only for the reviewed native release and verified identity mapping.
4. Deploy both `platform-admin` and `platform-command` with the shared `adminGateway.ts`, their protocol dependencies and exact checked-in entrypoints. Gateway verification remains enabled; native adapters enforce the fixed Hub issuer themselves.
5. Release the Hub contract-4 frontend. Use isolated fixtures for changes and retry/revocation tests. The owner's real MFA session must separately pass preview/review; real production access changes require an intended administrative action.

This is an access-control increment. Provider subscription lifecycle and invoices, application-specific configuration/jobs, customer identity federation, and learning/support writer cutovers retain their own workstreams.
