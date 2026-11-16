# Go administration connection

> **Retired.** Go was disconnected from the Hub on 2026-10-28
> (`20261028220500_limit_central_hub_to_three_apps.sql`) and uses its own support. Its registry destination is empty and the
> Hub refuses every Go capability (`server/delegations.mjs`), so nothing below is reachable today. This page records how the
> connection worked, for a possible reconnection.

Go uses the existing EMR backend at `ubbtgcaosuebrlwcvihw`; verified CM-Go
configuration points to that project. The Hub labels its organization, staff and
application entitlement records as shared with EMR. Do not aggregate these as
independent customer or subscription records.

The native `central-go-admin-read` entry point shares the EMR read implementation
but uses fixed product `caremetric-go`, its own activation and exact identity map.
The Hub issues a separate one-use `caremetric-go` capability and consumes it only
through `/api/internal/admin/go/authorize`. An EMR capability cannot authorize a
Go read, and a Go capability cannot authorize an EMR read.

Release order:

1. Review and deploy the native Go adapter from `kdeyarmin/CMbackup`, with
   `CAREMETRIC_GO_ADMIN_ENABLED` absent/false.
2. Apply `20260911181026_hub_go_admin_audience.sql`, preserving all existing
   command, learning, publication and media audiences.
3. Deploy the reviewed Hub source, including the shared registry/protocol files.
4. Configure a separately verified existing native super-administrator mapping
   and activate Go only after that identity review. EMR's map is never a fallback.
5. Verify actual owner capabilities, directories and entitlement reads. Confirm
   unmapped, revoked, banned and cross-audience requests fail.

The connection exposes no patient identities, clinical records, or mutations.
Native Expo/EAS app publication remains a separate release responsibility.
