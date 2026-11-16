import { describe, expect, it } from "vitest";
import { breatheCommandOperation, projectStaffAccessResult, staffAccessOperation } from "./staffAccessProtocol";
import { staffApplied, staffCommandId, staffContext, staffEnvelope, staffPreview, staffRequestId, staffTarget, staffUserId } from "./testFixtures/staffAccess";

const domain = "staff.access.v1" as const;
const preview = staffAccessOperation.parse({ domain, operation: "preview", requestId: staffRequestId, targetId: staffUserId, action: "staff.setAccess",
  parameters: { active: false }, expectedRevision: staffTarget.revision, reason: staffPreview.reason });
const apply = staffAccessOperation.parse({ domain, operation: "apply", commandId: staffCommandId, expectedDigest: staffPreview.previewDigest });
const context = staffAccessOperation.parse({ domain, operation: "context", targetId: staffUserId });

describe("Breathe staff access contract", () => {
  it("accepts only Breathe's closed staff operations, and Breathe's capability takes either kind of change", () => {
    for (const invalid of [
      { ...context, targetId: "../users" }, { ...context, extra: true }, { ...preview, action: "staff.delete" },
      { ...preview, parameters: { active: false, role: "admin" } }, { ...preview, reason: "short" }, { ...apply, expectedDigest: "D".repeat(64) },
      { ...context, domain: "staff.access.v2" },
    ]) expect(staffAccessOperation.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    expect(breatheCommandOperation.safeParse(context).success).toBe(true);
    expect(breatheCommandOperation.safeParse({ domain: "tenant.lifecycle.v1", operation: "context", targetId: staffTarget.organizationId }).success).toBe(true);
    expect(breatheCommandOperation.safeParse({ domain: "tenant.lifecycle.v1", operation: "context", targetId: staffUserId.replace(/-/g, "_") }).success).toBe(false);
  });

  it("keeps only the reviewed fields of Breathe's answer and checks it answers what was asked", () => {
    expect(projectStaffAccessResult(staffEnvelope("context", staffContext), context)).toEqual(staffContext);
    expect(projectStaffAccessResult(staffEnvelope("preview", staffPreview), preview)).toEqual(staffPreview);
    expect(projectStaffAccessResult(staffEnvelope("apply", staffApplied), apply)).toEqual(staffApplied);
    expect(() => projectStaffAccessResult(staffEnvelope("preview", { ...staffPreview, sessionTokens: ["x"] }), preview)).toThrow();
    expect(() => projectStaffAccessResult({ ...staffEnvelope("preview", staffPreview), domain: "tenant.lifecycle.v1" }, preview)).toThrow();
    expect(() => projectStaffAccessResult(staffEnvelope("preview", { ...staffPreview, reason: "Another reason entirely" }), preview)).toThrow();
    expect(() => projectStaffAccessResult(staffEnvelope("apply", staffPreview), apply)).toThrow();
    expect(() => projectStaffAccessResult(staffEnvelope("context", { ...staffContext, target: { ...staffTarget, id: "someone_else" } }), context)).toThrow();
  });

  it("refuses a review of a change Breathe said is unavailable, or one that outlives five minutes", () => {
    const lastAdmin = { ...staffTarget, unavailable: { deactivate: "last_administrator" as const, reactivate: "no_change" as const } };
    expect(() => projectStaffAccessResult(staffEnvelope("preview", { ...staffPreview, before: lastAdmin }), { ...preview })).toThrow();
    expect(() => projectStaffAccessResult(staffEnvelope("preview", { ...staffPreview, after: { status: "active" } }), preview)).toThrow();
    expect(() => projectStaffAccessResult(staffEnvelope("preview", { ...staffPreview, expiresAt: "2026-11-16T16:05:02+00:00" }), preview)).toThrow();
  });
});
