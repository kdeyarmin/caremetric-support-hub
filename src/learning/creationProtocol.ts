import { z } from "zod";
import { receiptUuid as id } from "./receiptProtocol.ts";
import { containsGovernedCredentials } from "../imports/governedLearningImport.ts";

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime({ offset: true }).max(40).refine(v => Number.isFinite(Date.parse(v)));
const text = (max: number, min = 1) => z.string().min(min).max(max).refine(v => v === v.trim() && !/\p{Cc}/u.test(v));
const prose = z.string().max(12_000).refine(v => !/\p{Cc}/u.test(v.replaceAll("\n", "").replaceAll("\r", "").replaceAll("\t", "")));
export const creationParametersSchema = z.strictObject({
  versionId: id,
  course: z.strictObject({ title: text(300), description: prose.nullable(), category: text(300).nullable(),
    estimatedDurationMinutes: z.number().int().min(1).max(1440).nullable(), trainingTypeId: id.nullable() }),
  version: z.strictObject({ title: text(300), description: prose.nullable() }),
}).refine(v => new TextEncoder().encode(JSON.stringify(v)).byteLength <= 24_576 && !containsGovernedCredentials(JSON.stringify(v)));
export const creationRequestSchema = z.strictObject({ operation: z.literal("preview"), requestId: id,
  action: z.literal("learning.createCourse"), courseId: id, parameters: creationParametersSchema, reason: text(500, 10) })
  .refine(v => v.courseId.toLowerCase() !== v.parameters.versionId.toLowerCase());
export const creationOptionsOperationSchema = z.strictObject({ operation: z.literal("creationOptions"), offset: z.number().int().min(0).max(10_000) });
const applyOperationSchema = z.strictObject({ operation: z.literal("apply"), commandId: id, expectedDigest: sha });
const creationStatusOperationSchema = z.strictObject({ operation: z.literal("creationStatus"), courseId: id, versionId: id, requestId: id });
export const nativeCreationOperationSchema = z.union([creationRequestSchema, creationOptionsOperationSchema, applyOperationSchema, creationStatusOperationSchema]);
export const creationOperationSchema = z.union([creationRequestSchema, creationOptionsOperationSchema, applyOperationSchema,
  z.strictObject({ operation: z.literal("resume"), offset: z.number().int().min(0).max(10000).optional() }),
  z.strictObject({ operation: z.literal("discard"), requestId: id }),
  z.strictObject({ operation: z.literal("recover"), requestId: id }),
]);
export const creationOptionsSchema = z.strictObject({ trainingTypes: z.array(z.strictObject({ id, label: text(500) })).max(100),
  nextOffset: z.number().int().min(1).max(10_000).nullable() });
const beforeSchema = z.strictObject({ courseId: id, versionId: id, exists: z.literal(false) });
const afterSchema = z.strictObject({ courseId: id, versionId: id, courseStatus: z.literal("draft"), status: z.literal("draft"),
  versionNumber: z.literal(1), title: text(300), currentVersionId: z.null(), aiReviewRequired: z.literal(false), contentStandard: z.literal("comprehensive") });
export const creationPreviewSchema = z.strictObject({ commandId: id, courseId: id, action: z.literal("learning.createCourse"),
  reason: text(500, 10), previewDigest: sha, expiresAt: instant, before: beforeSchema, after: afterSchema });
export const creationResultSchema = z.strictObject({ commandId: id, courseId: id, action: z.literal("learning.createCourse"),
  versionId: id, versionNumber: z.literal(1), status: z.literal("draft"), appliedAt: instant, replayed: z.boolean(),
  courseStatus: z.literal("draft"), currentVersionId: z.null(), contentStandard: z.literal("comprehensive"), sourceRevision: sha });
export const creationStatusSchema = z.union([z.strictObject({ status: z.literal("absent"), result: z.null() }),
  z.strictObject({ status: z.literal("applied"), result: creationResultSchema.extend({ replayed: z.literal(false) }) })]);
export const creationRegistrationSchema = z.strictObject({ itemId: id, snapshotId: id.nullable(), sourceRevision: sha.nullable() })
  .refine(v => (v.snapshotId === null) === (v.sourceRevision === null));
export const creationIntentSchema = z.strictObject({ request: creationRequestSchema, preview: creationPreviewSchema.nullable(),
  result: creationResultSchema.nullable(), registration: creationRegistrationSchema.nullable(), createdAt: instant, dispatchedAt: instant.nullable() });
export const creationResumeSchema = z.strictObject({ rows: z.array(creationIntentSchema).max(20), nextOffset: z.number().int().min(1).max(10000).nullable() });
export type CreationRequest = z.infer<typeof creationRequestSchema>;
export type CreationOperation = z.infer<typeof creationOperationSchema>;
export type CreationIntent = z.infer<typeof creationIntentSchema>;
export type CreationPreview = z.infer<typeof creationPreviewSchema>;
export type CreationResult = z.infer<typeof creationResultSchema>;
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function verifyCreationPreview(value: unknown, request: CreationRequest): CreationPreview {
  const v = creationPreviewSchema.parse(value);
  if (!sameId(v.courseId, request.courseId) || !sameId(v.before.courseId, request.courseId) || !sameId(v.after.courseId, request.courseId) ||
    !sameId(v.before.versionId, request.parameters.versionId) || !sameId(v.after.versionId, request.parameters.versionId) ||
    v.reason !== request.reason || v.after.title !== request.parameters.version.title || Date.parse(v.expiresAt) > Date.now() + 305_000) throw new Error("Creation preview mismatch");
  return v;
}
export function verifyCreationResult(value: unknown, preview: CreationPreview): CreationResult {
  const v = creationResultSchema.parse(value);
  if (!sameId(v.commandId, preview.commandId) || !sameId(v.courseId, preview.courseId) || !sameId(v.versionId, preview.after.versionId)) throw new Error("Creation result mismatch");
  return v;
}
export function projectCreationResult(value: unknown, operation: z.infer<typeof nativeCreationOperationSchema>) {
  if (operation.operation === "creationStatus") {
    const v = creationStatusSchema.parse(value);
    if (v.status === "applied" && (!sameId(v.result.courseId, operation.courseId) || !sameId(v.result.versionId, operation.versionId))) throw new Error("Creation recovery mismatch");
    return v;
  }
  if (operation.operation === "creationOptions") {
    const v = creationOptionsSchema.parse(value);
    if (new Set(v.trainingTypes.map(t => t.id.toLowerCase())).size !== v.trainingTypes.length ||
      (v.nextOffset !== null && (v.nextOffset !== operation.offset + 100 || v.trainingTypes.length !== 100))) throw new Error("Creation options pagination mismatch");
    return v;
  }
  if (operation.operation === "preview") return verifyCreationPreview(value, operation);
  const v = creationResultSchema.parse(value);
  if (!sameId(v.commandId, operation.commandId)) throw new Error("Creation command mismatch");
  return v;
}
