import type { TenantLifecycleContext, TenantLifecyclePreview, TenantLifecycleReceipt } from "../tenantLifecycleProtocol";

// The shapes Breathe's resupply.tenant_lifecycle_command returns (kdeyarmin/PennFit migration 0547), timestamps as Postgres writes them.
export const organizationId = "5b0c5a0e-2f4e-4d7a-9a3b-0a6c1e2d3f40";
export const requestId = "7d3c1b2a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const commandId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
export const target = { id: organizationId, slug: "lakeside-medical", name: "Lakeside Medical Supply", status: "active" as const,
  updatedAt: "2026-11-10T14:00:00.123456+00:00", seedProtected: false, revision: "c".repeat(64) };
export const lifecyclePreview: TenantLifecyclePreview = {
  commandId, requestId, action: "organizations.setSuspension", targetId: organizationId, parameters: { suspended: true }, reason: "Account closed by the owner",
  createdAt: "2026-11-16T16:00:00.000001+00:00", expiresAt: "2026-11-16T16:05:00.000001+00:00", previewDigest: "d".repeat(64),
  before: target, after: { status: "suspended" }, canApplyThisSession: true, result: null,
};
export const lifecycleReceipt: TenantLifecycleReceipt = { commandId, requestId, targetId: organizationId, action: "organizations.setSuspension",
  beforeStatus: "active", afterStatus: "suspended", appliedAt: "2026-11-16T16:01:00.5+00:00", revision: "e".repeat(64) };
export const lifecycleApplied: TenantLifecyclePreview = { ...lifecyclePreview, canApplyThisSession: false, result: lifecycleReceipt };
export const lifecycleContext: TenantLifecycleContext = { target, requests: [] };
export const envelope = (operation: string, data: unknown) => ({ contractVersion: 1, product: "breathe", domain: "tenant.lifecycle.v1", operation, generatedAt: "2026-11-16T16:00:01.000Z", data });
