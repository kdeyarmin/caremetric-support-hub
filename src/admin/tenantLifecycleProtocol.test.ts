import { describe, expect, it } from "vitest";
import { projectTenantLifecycleResult, tenantLifecycleOperation } from "./tenantLifecycleProtocol";
import { commandId, envelope, lifecycleApplied, lifecycleContext, lifecyclePreview, organizationId, requestId, target } from "./testFixtures/tenantLifecycle";

const domain = "tenant.lifecycle.v1" as const;
const preview = tenantLifecycleOperation.parse({ domain, operation: "preview", requestId, targetId: organizationId, action: "organizations.setSuspension",
  parameters: { suspended: true }, expectedRevision: target.revision, reason: lifecyclePreview.reason });
const apply = tenantLifecycleOperation.parse({ domain, operation: "apply", commandId, expectedDigest: lifecyclePreview.previewDigest });

describe("Breathe organization lifecycle contract", () => {
  it("accepts only Breathe's closed operations", () => {
    expect(tenantLifecycleOperation.parse({ domain, operation: "context", targetId: organizationId.toUpperCase() })).toEqual({ domain, operation: "context", targetId: organizationId });
    for (const invalid of [
      { domain, operation: "context", targetId: organizationId, extra: true },
      { domain: "tenant.lifecycle.v2", operation: "context", targetId: organizationId },
      { ...preview, reason: "short" }, { ...preview, reason: " Account closed by the owner" }, { ...preview, reason: "Account closed\nby the owner" },
      { ...preview, action: "organizations.delete" }, { ...preview, parameters: { suspended: true, archive: true } }, { ...preview, expectedRevision: "c".repeat(63) },
      { ...apply, expectedDigest: "D".repeat(64) }, { domain, operation: "delete", targetId: organizationId },
    ]) expect(tenantLifecycleOperation.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
  });

  it("keeps only the reviewed fields of Breathe's answer and checks it answers what was asked", () => {
    const context = tenantLifecycleOperation.parse({ domain, operation: "context", targetId: organizationId });
    expect(projectTenantLifecycleResult(envelope("context", lifecycleContext), context)).toEqual(lifecycleContext);
    expect(projectTenantLifecycleResult(envelope("preview", lifecyclePreview), preview)).toEqual(lifecyclePreview);
    expect(projectTenantLifecycleResult(envelope("apply", lifecycleApplied), apply)).toEqual(lifecycleApplied);
    // An answer with a field nobody reviewed, for another operation, organization or request, or an apply without a receipt, is refused.
    expect(() => projectTenantLifecycleResult(envelope("preview", { ...lifecyclePreview, staffEmails: ["x@agency.test"] }), preview)).toThrow();
    expect(() => projectTenantLifecycleResult(envelope("context", lifecyclePreview), preview)).toThrow();
    expect(() => projectTenantLifecycleResult({ ...envelope("preview", lifecyclePreview), product: "carebase" }, preview)).toThrow();
    expect(() => projectTenantLifecycleResult(envelope("preview", { ...lifecyclePreview, reason: "Another reason entirely" }), preview)).toThrow();
    expect(() => projectTenantLifecycleResult(envelope("preview", { ...lifecyclePreview, before: { ...target, revision: "f".repeat(64) } }), preview)).toThrow();
    expect(() => projectTenantLifecycleResult(envelope("apply", lifecyclePreview), apply)).toThrow();
    expect(() => projectTenantLifecycleResult(envelope("context", { ...lifecycleContext, target: { ...target, id: requestId } }), context)).toThrow();
  });

  it("refuses a review that would suspend the seed organization or outlive five minutes", () => {
    expect(() => projectTenantLifecycleResult(envelope("preview", { ...lifecyclePreview, before: { ...target, seedProtected: true } }), preview)).toThrow();
    expect(() => projectTenantLifecycleResult(envelope("preview", { ...lifecyclePreview, expiresAt: "2026-11-16T16:05:02+00:00" }), preview)).toThrow();
  });
});
