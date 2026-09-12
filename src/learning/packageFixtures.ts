import type { PackageContextView, PackageIntent, PackageResult } from "./packageProtocol";
export const packageCourseId = "c1000000-0000-4000-8000-000000000001";
export const packageVersionId = "c1000000-0000-4000-8000-000000000002";
export const packageRequestId = "c1000000-0000-4000-8000-000000000003";
export const packageOperationId = "c1000000-0000-4000-8000-000000000004";
export const packageId = "c1000000-0000-4000-8000-000000000005";
export const packageSha = "a".repeat(64), archiveSha = "b".repeat(64), runtimeSha = "c".repeat(64);
export const packageIntent: PackageIntent = {
  requestId: packageRequestId, operationId: packageOperationId, operation: "upload", packageId, versionId: packageVersionId,
  sourceRevision: packageSha, sourceSha256: archiveSha, runtimeSha256: null, entryPoint: null,
  createdAt: "2026-09-11T12:00:00.000Z", expiresAt: "2026-09-11T12:15:00.000Z", state: "staged", canFinishThisSession: true, result: null,
};
export const packageReceipt: PackageResult = { operationId: packageOperationId, packageId, versionId: packageVersionId, sourceRevision: "d".repeat(64), status: "pending", sourceSha256: archiveSha, runtimeSha256: null, entryPoint: null };
export const packageContext: PackageContextView = {
  courseId: packageCourseId, versionId: packageVersionId, sourceRevision: packageSha, package: null,
  intents: { items: [packageIntent], hasMore: false }, headRevision: packageSha, sourcePreserved: true,
};
