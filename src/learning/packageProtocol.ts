import { z } from "zod";
import { learningPackageCapabilities } from "../../supabase/functions/_shared/portfolioProtocol.ts";

export const PACKAGE_MAX_BYTES = 50 * 1024 * 1024;
export const PACKAGE_RESPONSE_BYTES = 262144;
export const packageCapabilities = learningPackageCapabilities;
const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().max(100).regex(/^\d{4}-\d\d-\d\dT/).refine(value => Number.isFinite(Date.parse(value)));
const controls = (value: string) => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const reason = z.string().min(8).max(500).refine(value => value === value.trim() && !controls(value));
export const packagePath = z.string().min(1).max(1024).refine(value => !controls(value) && !value.includes("\\")
  && !value.startsWith("/") && !/^[a-zA-Z]:/.test(value) && value.split("/").every(part => part !== "." && part !== ".." && part !== ""));
const standard = z.enum(["scorm_1_2", "scorm_2004_4th", "xapi"]);
const upload = z.object({ operation: z.literal("upload"), requestId: id, versionId: id, sourceRevision: sha,
  reason, standard, sourceSha256: sha, sourceBytes: z.number().int().min(1).max(PACKAGE_MAX_BYTES) }).strict();
const accept = z.object({ operation: z.literal("accept"), requestId: id, packageId: id, sourceRevision: sha, reason, entryPoint: packagePath.nullable() }).strict();
const context = z.object({ operation: z.literal("context"), versionId: id.nullable(), packageId: id.nullable() }).strict()
  .refine(value => (value.versionId === null) !== (value.packageId === null));
const status = z.object({ operation: z.literal("status"), requestId: id }).strict();
const finish = z.object({ operation: z.literal("finish"), operationId: id }).strict();
// A cloned draft lists the source packages it still depends on, then names the separately
// accepted artifact in the same draft that replaces each one.
const dependencies = z.object({ operation: z.literal("dependencies"), versionId: id }).strict();
const resolveFields = z.object({ operation: z.literal("resolve"), versionId: id, sourcePackageId: id, replacementPackageId: id }).strict();
const separate = (value: { sourcePackageId: string; replacementPackageId: string }) => value.sourcePackageId !== value.replacementPackageId;
export const nativePackageOperationSchema = z.union([upload, accept, context, status, finish, dependencies, resolveFields.refine(separate)]);
export type NativePackageOperation = z.infer<typeof nativePackageOperationSchema>;
export const packageOperationSchema = z.union([
  upload.extend({ courseId: id }).strict(),
  accept.extend({ courseId: id, versionId: id }).strict(),
  z.object({ operation: z.literal("context"), courseId: id, versionId: id, packageId: id.nullable() }).strict(),
  status.extend({ courseId: id, versionId: id }).strict(),
  finish.extend({ courseId: id, versionId: id, requestId: id }).strict(),
  dependencies.extend({ courseId: id }).strict(),
  resolveFields.extend({ courseId: id }).strict().refine(separate),
]);
export type PackageOperation = z.infer<typeof packageOperationSchema>;
export type PackageUpload = Extract<PackageOperation, { operation: "upload" }>;

export const packageResultSchema = z.object({
  operationId: id, packageId: id, versionId: id, sourceRevision: sha, status: z.enum(["pending", "accepted"]),
  sourceSha256: sha, runtimeSha256: sha.nullable(), entryPoint: packagePath.nullable(),
}).strict().refine(value => value.status === "pending" ? value.runtimeSha256 === null && value.entryPoint === null : value.runtimeSha256 !== null && value.entryPoint !== null);
export type PackageResult = z.infer<typeof packageResultSchema>;
export const packageStageSchema = z.union([
  z.object({ state: z.literal("committed"), result: packageResultSchema }).strict(),
  z.object({ state: z.literal("staged"), operationId: id, packageId: id, versionId: id, sourceSha256: sha, runtimeSha256: sha.nullable(), entryPoint: packagePath.nullable() }).strict()
    .refine(value => (value.runtimeSha256 === null) === (value.entryPoint === null)),
]);
export type PackageStage = z.infer<typeof packageStageSchema>;
const intentSchema = z.object({
  requestId: id, operationId: id, operation: z.enum(["upload", "accept"]), packageId: id, versionId: id, sourceRevision: sha,
  sourceSha256: sha, runtimeSha256: sha.nullable(), entryPoint: packagePath.nullable(), createdAt: timestamp, expiresAt: timestamp,
  state: z.enum(["prepared", "staged", "committed", "expired"]), canFinishThisSession: z.boolean(), result: packageResultSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.state === "committed") !== (value.result !== null) || (value.runtimeSha256 === null) !== (value.entryPoint === null)
    || value.operation === "upload" && value.runtimeSha256 !== null
    || value.operation === "accept" && ["staged", "committed"].includes(value.state) && value.runtimeSha256 === null
    || value.canFinishThisSession && value.state !== "staged"
    || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) ctx.addIssue({ code: "custom", message: "Inconsistent package intent" });
  if (value.result && (value.result.operationId !== value.operationId || value.result.packageId !== value.packageId || value.result.versionId !== value.versionId
    || value.result.sourceSha256 !== value.sourceSha256 || value.result.runtimeSha256 !== value.runtimeSha256 || value.result.entryPoint !== value.entryPoint
    || value.result.status !== (value.operation === "upload" ? "pending" : "accepted"))) ctx.addIssue({ code: "custom", message: "Inconsistent package receipt" });
});
export type PackageIntent = z.infer<typeof intentSchema>;
export const packageContextSchema = z.object({
  courseId: id, versionId: id, sourceRevision: sha,
  package: z.object({ id, status: z.enum(["pending", "validating", "accepted", "rejected", "quarantined"]), contentSha256: sha,
    entryPoint: packagePath.nullable(), standard: z.enum(["scorm_1_2", "scorm_2004_4th", "xapi", "lti_1_3"]) }).strict().nullable(),
  intents: z.object({ items: z.array(intentSchema).max(20), hasMore: z.boolean() }).strict(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.intents.items.map(item => item.operationId)).size !== value.intents.items.length
    || value.intents.items.some(item => item.versionId !== value.versionId || item.canFinishThisSession && item.sourceRevision !== value.sourceRevision
      || value.package !== null && item.packageId !== value.package.id)) ctx.addIssue({ code: "custom", message: "Package context identity differs" });
});
export type PackageContext = z.infer<typeof packageContextSchema>;
export const packageContextViewSchema = packageContextSchema.safeExtend({ headRevision: sha.nullable(), sourcePreserved: z.boolean() }).strict()
  .refine(value => value.sourcePreserved === (value.headRevision === value.sourceRevision));
export type PackageContextView = z.infer<typeof packageContextViewSchema>;
const statusResult = z.object({ requestId: id, operation: z.enum(["upload", "accept"]), packageId: id, versionId: id, sourceRevision: sha,
  expiresAt: timestamp, status: z.enum(["pending", "expired", "committed"]), result: packageResultSchema.nullable() }).strict()
  .refine(value => (value.status === "committed") === (value.result !== null) && (!value.result || value.result.packageId === value.packageId
    && value.result.versionId === value.versionId && value.result.status === (value.operation === "upload" ? "pending" : "accepted")));
export const packageStatusSchema = statusResult.nullable();
export type PackageStatus = z.infer<typeof packageStatusSchema>;
export const packageDependenciesSchema = z.array(z.object({ sourcePackageId: id, sourceSha256: sha, standard: z.string().max(50).nullable(),
  replacementPackageId: id.nullable(), resolved: z.boolean() }).strict()).max(100)
  .refine(rows => new Set(rows.map(row => row.sourcePackageId)).size === rows.length && rows.every(row => !row.resolved || row.replacementPackageId !== null));
export type PackageDependency = z.infer<typeof packageDependenciesSchema>[number];
export const packageResolutionSchema = z.object({ versionId: id, sourcePackageId: id, replacementPackageId: id, replacementSha256: sha }).strict();
export type PackageResolution = z.infer<typeof packageResolutionSchema>;
const envelope = z.object({ contractVersion: z.literal(1), product: z.literal("carebase"), operation: z.enum(["context", "status", "finish", "upload", "accept", "dependencies", "resolve"]),
  generatedAt: timestamp, data: z.unknown() }).strict();
export function projectPackageResponse(input: unknown, operation: NativePackageOperation): PackageContext | PackageStatus | PackageResult | PackageStage | PackageDependency[] | PackageResolution {
  const value = envelope.parse(input);
  if (value.operation !== operation.operation) throw new Error("Mismatched package operation");
  if (operation.operation === "context") {
    const result = packageContextSchema.parse(value.data);
    if (operation.versionId !== null && result.versionId !== operation.versionId || operation.packageId !== null && result.package?.id !== operation.packageId) throw new Error("Mismatched package context");
    return result;
  }
  if (operation.operation === "status") {
    const result = packageStatusSchema.parse(value.data);
    if (result && result.requestId !== operation.requestId) throw new Error("Mismatched package status");
    return result;
  }
  if (operation.operation === "dependencies") return packageDependenciesSchema.parse(value.data);
  if (operation.operation === "resolve") {
    const result = packageResolutionSchema.parse(value.data);
    if (result.versionId !== operation.versionId || result.sourcePackageId !== operation.sourcePackageId || result.replacementPackageId !== operation.replacementPackageId) throw new Error("Mismatched package resolution");
    return result;
  }
  if (operation.operation === "finish") {
    const result = packageResultSchema.parse(value.data);
    if (result.operationId !== operation.operationId) throw new Error("Mismatched package result");
    return result;
  }
  const result = packageStageSchema.parse(value.data), metadata = result.state === "committed" ? result.result : result;
  if (operation.operation === "upload" && (metadata.versionId !== operation.versionId || metadata.sourceSha256 !== operation.sourceSha256
    || metadata.runtimeSha256 !== null || metadata.entryPoint !== null)
    || operation.operation === "accept" && (metadata.packageId !== operation.packageId || metadata.runtimeSha256 === null || metadata.entryPoint === null)) throw new Error("Mismatched staged artifact");
  return result;
}
export function verifyPackageReceipt(result: unknown, intent: PackageIntent): PackageResult {
  const value = packageResultSchema.parse(result);
  if (value.operationId !== intent.operationId || value.packageId !== intent.packageId || value.versionId !== intent.versionId
    || value.sourceSha256 !== intent.sourceSha256 || value.runtimeSha256 !== intent.runtimeSha256 || value.entryPoint !== intent.entryPoint
    || value.status !== (intent.operation === "upload" ? "pending" : "accepted")
    || intent.result && value.sourceRevision !== intent.result.sourceRevision) throw new Error("Package receipt differs from staged intent");
  return value;
}
