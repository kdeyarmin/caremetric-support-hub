import { describe, expect, it } from "vitest";
import { nativePackageOperationSchema, packageContextSchema, packageContextViewSchema, packageOperationSchema, packagePath, projectPackageResponse, verifyPackageReceipt, PACKAGE_MAX_BYTES } from "./packageProtocol";
import { parsePortfolioEnvelope, parsePortfolioRequest } from "../../supabase/functions/_shared/portfolioProtocol";
import { packageCourseId as courseId, packageVersionId as versionId, packageRequestId as requestId, packageId, packageSha, archiveSha, runtimeSha, packageIntent, packageReceipt, packageContext } from "./packageFixtures";
const upload = { operation: "upload" as const, requestId, versionId, sourceRevision: packageSha, reason: "Reviewed original archive", standard: "scorm_1_2", sourceSha256: archiveSha, sourceBytes: 123 };
const envelope = (operation: string, data: unknown) => ({ contractVersion: 1, product: "carebase", operation, generatedAt: "2026-09-11T12:00:00.000Z", data });
const nativeContext = () => { const { headRevision, sourcePreserved, ...value } = packageContext; void headRevision; void sourcePreserved; return structuredClone(value); };
describe("closed package transport", () => {
  it("separates browser course selectors from native delegated metadata", () => {
    const value = packageOperationSchema.parse({ ...upload, courseId });
    expect(value.operation).toBe("upload");
    expect(nativePackageOperationSchema.safeParse(value).success).toBe(false);
    expect(nativePackageOperationSchema.parse(upload)).toEqual(upload);
    expect(() => parsePortfolioRequest({ product: "carebase", ...upload })).toThrow();
  });
  it.each([{ sourceBytes: 0 }, { sourceBytes: PACKAGE_MAX_BYTES + 1 }, { sourceBytes: 1.5 }, { sourceBytes: "123" }, { standard: "lti_1_3" }, { sourceSha256: "A".repeat(64) },
    { reason: " short " }, { reason: "line\nbreak" }, { sourceRevision: "" }, { url: "https://evil.invalid" }, { actorId: requestId }])("rejects unsupported upload metadata %j", change => {
    expect(nativePackageOperationSchema.safeParse({ ...upload, ...change }).success).toBe(false);
  });
  it.each(["../index.html", "/index.html", "a//b", "a/./b", "a\\b", "C:file.html", "https://evil.test/index.html", "a\nb", "x".repeat(1025)])("rejects unsafe archive path %s", path => expect(packagePath.safeParse(path).success).toBe(false));
  it("keeps Unicode archive paths as identifiers without generating URLs", () => {
    expect(packagePath.parse("教材/第一课.html")).toBe("教材/第一课.html");
    expect(nativePackageOperationSchema.parse({ operation: "accept", requestId, packageId, sourceRevision: packageSha, reason: "Reviewed authored content", entryPoint: null }).operation).toBe("accept");
  });
  it("accepts only one native context selector and closed status/finish identities", () => {
    for (const value of [{ operation: "context", versionId, packageId }, { operation: "context", versionId: null, packageId: null }, { operation: "finish", operationId: requestId, force: true }, { operation: "status", requestId, url: "https://evil.test" }]) expect(nativePackageOperationSchema.safeParse(value).success).toBe(false);
    expect(nativePackageOperationSchema.parse({ operation: "context", versionId, packageId: null }).operation).toBe("context");
  });
  it("binds original and runtime artifacts to their operation", () => {
    const op = nativePackageOperationSchema.parse(upload);
    const staged = { state: "staged", operationId: packageIntent.operationId, packageId, versionId, sourceSha256: archiveSha, runtimeSha256: null, entryPoint: null };
    expect(projectPackageResponse(envelope("upload", staged), op)).toEqual(staged);
    for (const changed of [{ versionId: requestId }, { sourceSha256: packageSha }, { runtimeSha256: runtimeSha, entryPoint: "index.html" }, { raw: "PRIVATE" }]) expect(() => projectPackageResponse(envelope("upload", { ...staged, ...changed }), op)).toThrow();
    const accept = nativePackageOperationSchema.parse({ operation: "accept", requestId, packageId, sourceRevision: packageSha, reason: "Reviewed authored content", entryPoint: null });
    expect(() => projectPackageResponse(envelope("accept", staged), accept)).toThrow();
    expect(projectPackageResponse(envelope("accept", { ...staged, runtimeSha256: runtimeSha, entryPoint: "index.html" }), accept)).toMatchObject({ state: "staged" });
  });
  it("retains original pre-write and immutable post-write hashes independently of later source edits", () => {
    const value = nativeContext();
    value.sourceRevision = "e".repeat(64); value.intents.items = [{ ...packageIntent, canFinishThisSession: false, state: "committed", result: packageReceipt }];
    expect(packageContextSchema.parse(value).intents.items[0].result?.sourceRevision).toBe(packageReceipt.sourceRevision);
    expect(verifyPackageReceipt(packageReceipt, value.intents.items[0]).sourceRevision).not.toBe(value.sourceRevision);
    expect(() => verifyPackageReceipt({ ...packageReceipt, sourceRevision: value.sourceRevision }, value.intents.items[0])).toThrow();
  });
  it.each([{ canFinishThisSession: true, state: "expired" }, { canFinishThisSession: true, sourceRevision: "f".repeat(64) }, { versionId: requestId },
    { runtimeSha256: runtimeSha }, { result: packageReceipt }, { sessionId: requestId }, { createdAt: "not a date" }])("rejects contradictory or private intent metadata %j", change => {
    const value = nativeContext(); Object.assign(value.intents.items[0], change);
    expect(packageContextSchema.safeParse(value).success).toBe(false);
  });
  it("rejects duplicate/truncated identities and invented head preservation", () => {
    const value = nativeContext(); value.intents.items.push(value.intents.items[0]);
    expect(packageContextSchema.safeParse(value).success).toBe(false);
    expect(packageContextViewSchema.safeParse({ ...packageContext, headRevision: null }).success).toBe(false);
    expect(packageContextSchema.safeParse({ ...nativeContext(), storageUrl: "PRIVATE" }).success).toBe(false);
    expect(() => verifyPackageReceipt({ ...packageReceipt, sourceSha256: runtimeSha }, packageIntent)).toThrow();
  });
  it("retains equal request IDs from different original sessions using globally distinct operation IDs", () => {
    const value = nativeContext(); value.intents.items.push({ ...packageIntent, operationId: requestId, canFinishThisSession: false });
    expect(packageContextSchema.parse(value).intents.items).toHaveLength(2);
  });
  it("checks envelope, status identity and immutable committed result links", () => {
    const op = nativePackageOperationSchema.parse({ operation: "finish", operationId: packageIntent.operationId });
    expect(projectPackageResponse(envelope("finish", packageReceipt), op)).toEqual(packageReceipt);
    for (const change of [{ product: "breathe" }, { operation: "accept" }, { generatedAt: null }, { raw: "PRIVATE" }]) expect(() => projectPackageResponse({ ...envelope("finish", packageReceipt), ...change }, op)).toThrow();
    const status = nativePackageOperationSchema.parse({ operation: "status", requestId });
    expect(projectPackageResponse(envelope("status", null), status)).toBeNull();
    expect(() => projectPackageResponse(envelope("status", { requestId, operation: "accept", packageId, versionId, sourceRevision: packageSha, expiresAt: packageIntent.expiresAt, status: "committed", result: packageReceipt }), status)).toThrow();
  });
  it("only advertises package capability names for CareBase and never treats them as read operations", () => {
    for (const product of ["carebase", "breathe"] as const) {
      const value = parsePortfolioEnvelope({ ...envelope("capabilities", { apiVersion: 1, sourceRevision: null, operations: ["learning.packages.upload"] }), product }, parsePortfolioRequest({ product, operation: "capabilities" }));
      expect(value.data).toMatchObject({ operations: product === "carebase" ? ["learning.packages.upload"] : [] });
    }
    expect(() => parsePortfolioRequest({ product: "carebase", operation: "learning.packages.upload" })).toThrow();
  });
});
