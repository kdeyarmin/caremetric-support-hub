import { z } from "zod";

export const providerFields = ["providerFullName", "courseAuthor", "signatureName", "contentVersion", "lastClinicalReviewDate", "reviewedBy", "nextReviewDue", "regulationReviewDate", "reviewNotes"] as const;
export type ProviderField = typeof providerFields[number];
export const providerLabels: Record<ProviderField, string> = {
  providerFullName: "Provider name", courseAuthor: "Course author", signatureName: "Recorded signature name", contentVersion: "Content version",
  lastClinicalReviewDate: "Last clinical review", reviewedBy: "Reviewed by", nextReviewDue: "Next review due", regulationReviewDate: "Regulation review date", reviewNotes: "Review notes",
};
export const providerDateFields = new Set<ProviderField>(["lastClinicalReviewDate", "nextReviewDue", "regulationReviewDate"]);
const id = z.string().uuid();
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.string().refine(value => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)));
const count = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value => BigInt(value) <= 9223372036854775807n);
const legacy = z.string().max(200000).refine(value => !value.includes("\0"));
const line = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/\p{Cc}/u.test(value));
export const providerDateSchema = z.string().regex(/^\d{4}-\d\d-\d\d$/).refine(value => {
  if (value.startsWith("0000")) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const credentials = /([?&](token|access_token|signature|sig|key|policy|jwt|auth|h|hdnts|hdnea|key-pair-id|api_key|apikey|x-amz-[a-z-]+|x-goog-[a-z-]+)=|"(access_?token|refresh_?token|service_?role_?key|authorization|password|client_?secret|storage_?(path|bucket)|video_?url|playback_?(url|token)|signed_?url|api_?key|token|secret|secret_?key|signing_?secret)"\s*:)/i;
export const providerPatchSchema = z.object({
  providerFullName: line(500).optional(), courseAuthor: line(500).nullable().optional(), signatureName: line(500).nullable().optional(),
  contentVersion: line(300).nullable().optional(), lastClinicalReviewDate: providerDateSchema.nullable().optional(), reviewedBy: line(500).nullable().optional(),
  nextReviewDue: providerDateSchema.nullable().optional(), regulationReviewDate: providerDateSchema.nullable().optional(),
  reviewNotes: z.string().max(12000).refine(value => value.trim().length > 0 && !/[^\P{Cc}\t\r\n]/u.test(value)).nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0 && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 24576
  && !credentials.test(JSON.stringify(value)) && Object.values(value).every(field => typeof field !== "string" || !credentials.test(field)));
export type ProviderPatch = z.infer<typeof providerPatchSchema>;
export function providerFormPatch(selected:ReadonlySet<ProviderField>,values:Partial<Record<ProviderField,string>>,cleared:ReadonlySet<ProviderField>):ProviderPatch {
  const patch:Record<string,string|null>={};
  for(const field of selected)patch[field]=cleared.has(field)?null:field==="reviewNotes"?(values[field]??""):(values[field]??"").trim();
  return providerPatchSchema.parse(patch);
}
const impactSchema = z.object({
  versionCount: count, legacyFallbackCertificates: count,
  governedDrafts: z.array(z.object({versionId:id,title:legacy,aiGenerated:z.boolean(),reviewInvalidated:z.boolean()}).strict()).max(100),
}).strict().refine(value => new Set(value.governedDrafts.map(draft => draft.versionId.toLowerCase())).size === value.governedDrafts.length);
export const providerContextSchema = z.object({
  courseId:id,courseTitle:legacy,courseStatus:z.enum(["draft","published","archived"]),providerContextRevision:sha,
  profile:z.object({id,providerFullName:legacy,courseAuthor:legacy.nullable(),signatureName:legacy.nullable(),contentVersion:legacy.nullable(),
    lastClinicalReviewDate:legacy.nullable(),reviewedBy:legacy.nullable(),nextReviewDue:legacy.nullable(),regulationReviewDate:legacy.nullable(),reviewNotes:legacy.nullable(),signatureRecordedAt:instant.nullable(),
  }).strict().refine(value => (value.signatureName === null) === (value.signatureRecordedAt === null)).nullable(),
  impact:impactSchema,
}).strict();
export type ProviderContext = z.infer<typeof providerContextSchema>;
export const providerPreviewSchema = z.object({
  commandId:id,courseId:id,action:z.literal("learning.editProviderPolicy"),reason:line(500).refine(value=>value.length>=10),
  providerContextRevision:sha,previewDigest:sha,expiresAt:instant,
  changes:z.array(z.object({field:z.enum(providerFields),before:legacy.nullable(),after:legacy.nullable()}).strict()).min(1).max(9),
  signatureTimestampAction:z.enum(["retain","record","clear"]),impact:impactSchema,
}).strict().refine(value => new Set(value.changes.map(change=>change.field)).size === value.changes.length && value.changes.every(change => change.before !== change.after && providerPatchSchema.safeParse({[change.field]:change.after}).success));
export type ProviderPreview = z.infer<typeof providerPreviewSchema>;
export const providerResultSchema = z.object({commandId:id,courseId:id,action:z.literal("learning.editProviderPolicy"),providerId:id,providerContextRevision:sha,appliedAt:instant,replayed:z.boolean()}).strict();
export type ProviderResult = z.infer<typeof providerResultSchema>;
const domain = z.literal("course.provider.v1");
export const providerOperationSchema = z.discriminatedUnion("operation",[
  z.object({domain,operation:z.literal("context"),courseId:id}).strict(),
  z.object({domain,operation:z.literal("preview"),requestId:id,courseId:id,providerContextRevision:sha,patch:providerPatchSchema,reason:line(500).refine(value=>value.length>=10)}).strict(),
  z.object({domain,operation:z.literal("apply"),commandId:id,expectedDigest:sha}).strict(),
  z.object({domain,operation:z.literal("status"),commandId:id,expectedDigest:sha}).strict(),
  z.object({domain,operation:z.literal("commands"),courseId:id,offset:z.number().int().min(0).max(10000)}).strict(),
]);
export type ProviderOperation = z.infer<typeof providerOperationSchema>;
export const providerCommandsSchema = z.object({items:z.array(z.object({commandId:id,expectedDigest:sha,expiresAt:instant,appliedAt:instant.nullable()}).strict()).max(20),nextOffset:z.number().int().min(1).max(10000).nullable()}).strict()
  .refine(value=>new Set(value.items.map(item=>item.commandId.toLowerCase())).size===value.items.length);
export const providerStatusSchema = z.object({preview:providerPreviewSchema,result:providerResultSchema.nullable(),canApplyThisSession:z.boolean()}).strict()
  .refine(value=>value.result===null || (value.result.commandId===value.preview.commandId && value.result.courseId===value.preview.courseId && !value.result.replayed && !value.canApplyThisSession));
export type ProviderStatus=z.infer<typeof providerStatusSchema>;
export function projectProviderResult(value:unknown,operation:ProviderOperation) {
  if(operation.operation==="context") {
    const context=providerContextSchema.parse(value);
    if(context.courseId.toLowerCase()!==operation.courseId.toLowerCase())throw new Error("Provider course mismatch.");
    return context;
  }
  if(operation.operation==="commands") {
    const page=providerCommandsSchema.parse(value);
    if(page.nextOffset!==null && (page.nextOffset!==operation.offset+20 || page.items.length!==20))throw new Error("Provider pagination mismatch.");
    return page;
  }
  if(operation.operation==="status") {
    const status=providerStatusSchema.parse(value);
    if(status.preview.commandId.toLowerCase()!==operation.commandId.toLowerCase() || status.preview.previewDigest!==operation.expectedDigest)throw new Error("Provider receipt mismatch.");
    if(status.result)verifyProviderResult(status.result,status.preview);
    return status;
  }
  if(operation.operation==="apply") {
    const result=providerResultSchema.parse(value);
    if(result.commandId.toLowerCase()!==operation.commandId.toLowerCase())throw new Error("Provider command mismatch.");
    return result;
  }
  const preview=providerPreviewSchema.parse(value);
  if(preview.courseId.toLowerCase()!==operation.courseId.toLowerCase() || preview.reason!==operation.reason || preview.providerContextRevision!==operation.providerContextRevision
    || preview.changes.some(change=>!Object.hasOwn(operation.patch,change.field) || operation.patch[change.field]!==change.after))throw new Error("Provider preview mismatch.");
  return preview;
}
export function verifyProviderPreview(value: unknown, context: ProviderContext, patch: ProviderPatch, reason: string): ProviderPreview {
  const preview=providerPreviewSchema.parse(value);
  const changes=Object.entries(patch).filter(([field,after]) => (context.profile?.[field as ProviderField]??null)!==after);
  if(preview.courseId.toLowerCase()!==context.courseId.toLowerCase() || preview.providerContextRevision!==context.providerContextRevision || preview.reason!==reason
    || preview.changes.length!==changes.length || changes.some(([field,after]) => !preview.changes.some(change=>change.field===field && change.before===(context.profile?.[field as ProviderField]??null) && change.after===after))
    || JSON.stringify(preview.impact)!==JSON.stringify(context.impact)) throw new Error("Provider review does not match the selected changes.");
  const signatureChange=preview.changes.find(change=>change.field==="signatureName");
  if(preview.signatureTimestampAction!==(signatureChange?(signatureChange.after===null?"clear":"record"):"retain")) throw new Error("Provider signature review does not match the selected change.");
  return preview;
}
export function verifyProviderResult(value:unknown,preview:ProviderPreview):ProviderResult {
  const result=providerResultSchema.parse(value);
  if(result.commandId!==preview.commandId || result.courseId!==preview.courseId || result.providerContextRevision===preview.providerContextRevision) throw new Error("Provider outcome does not match the reviewed command.");
  return result;
}
