import { describe, expect, it } from "vitest";
import { creationRequestSchema, nativeCreationOperationSchema, projectCreationResult, verifyCreationPreview, verifyCreationResult, creationRegistrationSchema } from "./creationProtocol";

const courseId = "aaaa0000-0000-0000-0000-000000000001", versionId = "aaaa0000-0000-0000-0000-000000000002";
const request = creationRequestSchema.parse({ operation: "preview", requestId: crypto.randomUUID(), action: "learning.createCourse", courseId,
  parameters: { versionId, course: { title: "New shared course", description: "Line one\nLine two", category: null, estimatedDurationMinutes: null, trainingTypeId: null },
    version: { title: "First draft", description: null } }, reason: "Create reviewed training material" });
const preview = { commandId: crypto.randomUUID(), courseId, action: "learning.createCourse", reason: request.reason, previewDigest: "a".repeat(64),
  expiresAt: new Date(Date.now() + 240000).toISOString(), before: { courseId, versionId, exists: false },
  after: { courseId, versionId, courseStatus: "draft", status: "draft", versionNumber: 1, title: "First draft", currentVersionId: null, aiReviewRequired: false, contentStandard: "comprehensive" } };
const result = { commandId: preview.commandId, courseId, versionId, action: "learning.createCourse", versionNumber: 1, status: "draft", appliedAt: new Date().toISOString(),
  replayed: false, courseStatus: "draft", currentVersionId: null, contentStandard: "comprehensive", sourceRevision: "b".repeat(64) };
describe("governed new course identity and recovery", () => {
  it("accepts an absent preview and exact new draft receipt without inventing prior source provenance", () => {
    const checked = verifyCreationPreview(preview, request);
    expect(verifyCreationResult(result, checked).sourceRevision).toBe("b".repeat(64));
    expect(() => verifyCreationPreview({ ...preview, before: { ...preview.before, sourceRevision: "a".repeat(64) } }, request)).toThrow();
  });
  it.each(["https://example.invalid/file?token=private", "https://example.invalid/file?X-Amz-Signature=private", "x\u0000y"])("rejects credential locators or control characters in prose: %s", description => {
    expect(creationRequestSchema.safeParse({ ...request, parameters: { ...request.parameters, version: { ...request.parameters.version, description } } }).success).toBe(false);
  });
  it("rejects byte overflow and extra authority or evidence fields", () => {
    expect(creationRequestSchema.safeParse({ ...request, organizationId: crypto.randomUUID() }).success).toBe(false);
    expect(creationRequestSchema.safeParse({ ...request, parameters: { ...request.parameters, course: { ...request.parameters.course, title: "界".repeat(300), description: "界".repeat(12000) } } }).success).toBe(false);
    expect(creationRequestSchema.safeParse({ ...request, parameters: { ...request.parameters, versionId: courseId } }).success).toBe(false);
  });
  it("rejects changed identity, publication, approval and source receipt", () => {
    for (const value of [{ ...result, courseId: crypto.randomUUID() }, { ...result, versionId: crypto.randomUUID() }, { ...result, status: "published" },
      { ...result, currentVersionId: versionId }, { ...result, contentStandard: "legacy" }, { ...result, sourceRevision: undefined }]) {
      expect(() => verifyCreationResult(value, verifyCreationPreview(preview, request))).toThrow();
    }
    expect(() => verifyCreationPreview({ ...preview, after: { ...preview.after, aiReviewRequired: true } }, request)).toThrow();
  });
  it("allows only current structured recovery and exact options pagination", () => {
    const op = nativeCreationOperationSchema.parse({ operation: "creationStatus", courseId, versionId, requestId: request.requestId });
    expect(projectCreationResult({ status: "applied", result }, op)).toEqual({ status: "applied", result });
    expect(() => projectCreationResult({ status: "applied", result: { ...result, versionId: crypto.randomUUID() } }, op)).toThrow();
    expect(nativeCreationOperationSchema.safeParse({ ...op, url: "https://example.invalid" }).success).toBe(false);
    expect(() => projectCreationResult({ trainingTypes: [{ id: courseId, label: "Training" }], nextOffset: 100 }, { operation: "creationOptions", offset: 0 })).toThrow();
    expect(projectCreationResult({ trainingTypes: [], nextOffset: null }, { operation: "creationOptions", offset: 0 })).toEqual({ trainingTypes: [], nextOffset: null });
  });
  it("permits identity-only registration without claiming a nonexistent source snapshot", () => {
    expect(creationRegistrationSchema.parse({ itemId: courseId, snapshotId: null, sourceRevision: null }).snapshotId).toBeNull();
    expect(creationRegistrationSchema.safeParse({ itemId: courseId, snapshotId: null, sourceRevision: "a".repeat(64) }).success).toBe(false);
  });
});
