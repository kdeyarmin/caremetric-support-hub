import type { StaffAccessContext, StaffAccessPreview, StaffAccessReceipt, StaffAccessTarget } from "../staffAccessProtocol";

// The shapes Breathe's resupply.staff_access_command returns (kdeyarmin/PennFit migration 0567), timestamps as Postgres writes them.
export const staffUserId = "0f9c2d4e-6b1a-4c3d-8e5f-7a6b5c4d3e2f";
export const staffRequestId = "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d";
export const staffCommandId = "3c4d5e6f-7081-4b9c-8d0e-1f2a3b4c5d6e";
export const staffTarget: StaffAccessTarget = {
  id: staffUserId, email: "robin@lakeside.test", displayName: "Robin Reyes", role: "agent", status: "active", emailVerified: true,
  organizationId: "5b0c5a0e-2f4e-4d7a-9a3b-0a6c1e2d3f40", seatRole: "csr", seatStatus: "active",
  unavailable: { deactivate: null, reactivate: "no_change" }, revision: "c".repeat(64),
};
export const staffPreview: StaffAccessPreview = {
  commandId: staffCommandId, requestId: staffRequestId, action: "staff.setAccess", targetId: staffUserId, parameters: { active: false },
  reason: "Left the company last week", createdAt: "2026-11-16T16:00:00.000001+00:00", expiresAt: "2026-11-16T16:05:00.000001+00:00",
  previewDigest: "d".repeat(64), before: staffTarget, after: { status: "revoked" }, canApplyThisSession: true, result: null,
};
export const staffReceipt: StaffAccessReceipt = { commandId: staffCommandId, requestId: staffRequestId, targetId: staffUserId, action: "staff.setAccess",
  beforeStatus: "active", afterStatus: "revoked", appliedAt: "2026-11-16T16:01:00.5+00:00", revision: "e".repeat(64) };
export const staffApplied: StaffAccessPreview = { ...staffPreview, canApplyThisSession: false, result: staffReceipt };
export const staffContext: StaffAccessContext = { target: staffTarget, requests: [] };
export const staffEnvelope = (operation: string, data: unknown) => ({ contractVersion: 1, product: "breathe", domain: "staff.access.v1", operation, generatedAt: "2026-11-16T16:00:01.000Z", data });
