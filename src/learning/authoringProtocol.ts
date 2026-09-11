import { z } from "zod";
import { receiptUuid as id } from "./receiptProtocol.ts";
import { prepareGovernedImport, governedStageResultSchema } from "../imports/governedLearningImport.ts";
import { structureChangesSchema } from "./structureProtocol.ts";
import { creditPolicyParametersSchema } from "./creditPolicyProtocol.ts";

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const text = (min: number, max: number) => z.string().min(min).max(max).refine(v => v === v.trim() && !/\p{Cc}/u.test(v));
const instant = z.iso.datetime({ offset: true }).max(40).refine(v => Number.isFinite(Date.parse(v)));
const action = z.enum(["learning.cloneVersion", "learning.publishVersion", "learning.patchDraft", "learning.reviewDraft", "learning.editStructure", "learning.editCreditPolicy"]);
const draftText = z.string().max(12_000).refine(v => !/\p{Cc}/u.test(v.replaceAll("\n", "").replaceAll("\r", "").replaceAll("\t", "")));
export const draftPatchSchema = z.strictObject({
  version: z.strictObject({ title: text(1, 300).optional(), description: draftText.nullable().optional() }).refine(v => Object.keys(v).length > 0).optional(),
  blocks: z.array(z.strictObject({ blockId: id, title: text(0, 300).nullable().optional(), content: draftText.optional(),
    transcript: draftText.optional(), estimatedMinutes: z.number().int().min(0).max(1440).optional() }).refine(v => Object.keys(v).length > 1))
    .min(1).max(20).refine(v => new Set(v.map(b => b.blockId.toLowerCase())).size === v.length).optional(),
}).refine(v => Object.keys(v).length > 0 && new TextEncoder().encode(JSON.stringify(v)).byteLength <= 24_576);
export type DraftPatch = z.infer<typeof draftPatchSchema>;
const previewOperation = z.union([
  z.strictObject({ operation: z.literal("preview"), requestId: id, action: z.literal("learning.cloneVersion"), courseId: id,
    parameters: z.strictObject({ versionId: id, sourceRevision: sha, title: text(1, 300) }), reason: text(10, 500) }),
  z.strictObject({ operation: z.literal("preview"), requestId: id, action: z.literal("learning.publishVersion"), courseId: id,
    parameters: z.strictObject({ versionId: id, sourceRevision: sha }), reason: text(10, 500) }),
  z.strictObject({ operation: z.literal("preview"), requestId: id, action: z.literal("learning.patchDraft"), courseId: id,
    parameters: z.strictObject({ versionId: id, sourceRevision: sha, patch: draftPatchSchema }), reason: text(10, 500) }),
  z.strictObject({ operation: z.literal("preview"), requestId: id, action: z.literal("learning.reviewDraft"), courseId: id,
    parameters: z.strictObject({ versionId: id, sourceRevision: sha, reviewed: z.literal(true) }), reason: text(10, 500) }),
  z.strictObject({ operation: z.literal("preview"), requestId: id, action: z.literal("learning.editStructure"), courseId: id,
    parameters: z.strictObject({ versionId: id, sourceRevision: sha, changes: structureChangesSchema }), reason: text(10, 500) }),
  z.strictObject({ operation: z.literal("preview"), requestId: id, action: z.literal("learning.editCreditPolicy"), courseId: id,
    parameters: creditPolicyParametersSchema, reason: text(10, 500) }),
]);
export const nativeAuthoringOperationSchema = z.union([
  z.strictObject({ operation: z.literal("inspect"), courseId: id }),
  z.strictObject({ operation: z.literal("source"), courseId: id, versionId: id }),
  previewOperation,
  z.strictObject({ operation: z.literal("apply"), commandId: id, expectedDigest: sha }),
]);
export const authoringOperationSchema = z.union([nativeAuthoringOperationSchema,
  z.strictObject({ operation: z.literal("preserve_source"), courseId: id, versionId: id, sourceRevision: sha,
    expectedHeadRevision: sha.nullable(), reviewed: z.literal(true) }),
]);
export type AuthoringOperation = z.infer<typeof authoringOperationSchema>;
export type NativeAuthoringOperation = z.infer<typeof nativeAuthoringOperationSchema>;
export const versionStateSchema = z.object({ courseId: id.optional(), versionId: id.optional(), currentVersionId: id.nullable().optional(),
  sourceVersionId: id.optional(), sourceRevision: sha.optional(), aiReviewRequired: z.boolean().optional(),
  status: z.enum(["draft", "published", "archived"]), title: text(1, 300), versionNumber: z.number().int().positive() });
export const authoringInspectSchema = z.object({ courseId: id, title: text(1, 300), currentVersionId: id.nullable(),
  versions: z.array(versionStateSchema.extend({ versionId: id, sourceRevision: sha, governed: z.boolean(), aiReviewRequired: z.boolean(),
    unresolvedPackages: z.number().int().min(0) })).max(20) });
export const authoringPreviewSchema = z.object({ commandId: id, courseId: id, action, reason: text(10, 500), previewDigest: sha,
  expiresAt: instant, before: versionStateSchema, after: versionStateSchema });
export const authoringResultSchema = z.object({ commandId: id, courseId: id, action, versionId: id,
  versionNumber: z.number().int().positive(), status: z.enum(["draft", "published"]), appliedAt: instant, replayed: z.boolean(), sourceRevision: sha.optional() })
  .refine(v => (["learning.patchDraft", "learning.reviewDraft", "learning.editStructure", "learning.editCreditPolicy"].includes(v.action)) === Object.hasOwn(v, "sourceRevision"));
export const authoringSourceSchema = z.object({ courseId: id, versionId: id, sourceRevision: sha, payload: z.string().max(2_000_000) });
export const authoringSourceViewSchema = authoringSourceSchema.extend({ headRevision: sha.nullable(), snapshotId: id.nullable() });
export type AuthoringPreview = z.infer<typeof authoringPreviewSchema>;
export type AuthoringResult = z.infer<typeof authoringResultSchema>;
export type AuthoringSourceView = z.infer<typeof authoringSourceViewSchema>;
const sameId = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
export async function projectAuthoringResult(value: unknown, op: NativeAuthoringOperation) {
  if (op.operation === "source") {
    const result = authoringSourceSchema.parse(value);
    const [entry] = await prepareGovernedImport({ contract: "carebase.catalog-snapshot.v1", scope: "global-courses-with-current-version", courses: [result] .map(({ sourceRevision, payload }) => ({ sourceRevision, payload })) });
    if (!sameId(result.courseId, op.courseId) || !sameId(result.versionId, op.versionId) || !sameId(entry.course.sourceCourseId, op.courseId) || !sameId(entry.course.sourceVersionId, op.versionId)) throw new Error("Source identity mismatch");
    return result;
  }
  if (op.operation === "inspect") {
    const result = authoringInspectSchema.parse(value);
    if (!sameId(result.courseId, op.courseId) || new Set(result.versions.map(v => v.versionId.toLowerCase())).size !== result.versions.length) throw new Error("Course identity mismatch");
    return result;
  }
  if (op.operation === "preview") {
    const result = authoringPreviewSchema.parse(value);
    if (!sameId(result.courseId, op.courseId) || result.action !== op.action || result.reason !== op.reason ||
      !sameId(result.before.courseId, op.courseId) || !sameId(result.before.versionId, op.parameters.versionId) || result.before.sourceRevision !== op.parameters.sourceRevision ||
      result.after.status !== (op.action === "learning.publishVersion" ? "published" : "draft") ||
      (op.action === "learning.cloneVersion" && (result.after.title !== op.parameters.title || !sameId(result.after.sourceVersionId, op.parameters.versionId)))) throw new Error("Preview identity mismatch");
    if (Date.parse(result.expiresAt) > Date.now() + 305_000) throw new Error("Preview expiry exceeds native lifetime");
    if (op.action === "learning.cloneVersion") {
      if (result.before.status !== "published" || !sameId(result.before.currentVersionId ?? undefined, op.parameters.versionId) ||
        result.after.versionNumber <= result.before.versionNumber || ["courseId", "versionId", "currentVersionId", "sourceRevision"].some(key => Object.hasOwn(result.after, key))) throw new Error("Clone preview mismatch");
    } else if (op.action === "learning.publishVersion") {
      const expected = { ...result.before, status: "published", currentVersionId: result.before.versionId };
      if (result.before.status !== "draft" || Object.keys(expected).length !== Object.keys(result.after).length ||
        Object.entries(expected).some(([key, value]) => result.after[key as keyof typeof result.after] !== value)) throw new Error("Publication preview mismatch");
    } else {
      const expected = { ...result.before, title: op.action === "learning.patchDraft" ? op.parameters.patch.version?.title ?? result.before.title : result.before.title,
        aiReviewRequired: op.action === "learning.reviewDraft" ? false : result.after.aiReviewRequired };
      delete expected.sourceRevision;
      if (result.before.status !== "draft" || typeof expected.aiReviewRequired !== "boolean" ||
        Object.keys(expected).length !== Object.keys(result.after).length ||
        Object.entries(expected).some(([key, value]) => result.after[key as keyof typeof result.after] !== value)) throw new Error("Draft preview mismatch");
    }
    return result;
  }
  const result = authoringResultSchema.parse(value);
  if (!sameId(result.commandId, op.commandId)) throw new Error("Command identity mismatch");
  return result;
}
export function verifyAuthoringOutcome(value: unknown, preview: AuthoringPreview): AuthoringResult {
  const result = authoringResultSchema.parse(value);
  if (!sameId(result.commandId, preview.commandId) || !sameId(result.courseId, preview.courseId) || result.action !== preview.action ||
    result.status !== preview.after.status || result.versionNumber !== preview.after.versionNumber ||
    (preview.action !== "learning.cloneVersion" && !sameId(result.versionId, preview.before.versionId!)) ||
    (preview.action === "learning.cloneVersion" && sameId(result.versionId, preview.before.versionId!))) throw new Error("Command outcome mismatch");
  return result;
}
export { governedStageResultSchema };
