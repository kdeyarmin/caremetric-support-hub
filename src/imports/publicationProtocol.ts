import { z } from "zod";
import {
  PUBLICATION_IMPORT_PLAN_SCHEMA,
  PUBLICATION_PRODUCT_SLUGS,
  validatePublicationManifest,
  type PublicationImportAction,
  type PublicationImportPlan,
  type PublicationManifest,
} from "./publicationImportPreview.ts";

export const PUBLICATION_UPLOAD_LIMITS = Object.freeze({ article: 2 * 1024 * 1024, video: 512 * 1024 * 1024, captions: 10 * 1024 * 1024, transcript: 10 * 1024 * 1024 });
export const publicationId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const identity = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const revision = z.number().int().min(1).max(100);
const placement = {
  revision,
  productSlug: z.enum(PUBLICATION_PRODUCT_SLUGS),
  audience: z.array(z.enum(["all", "customer", "customer-admin", "manager"])).min(1).max(4),
  routePattern: z.string().max(240).nullable(),
};
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), revision: z.literal(1), revisionIdentity: identity, artifactIdentity: identity }).strict(),
  z.object({ type: z.literal("new_immutable_revision"), previousRevision: revision, revision, revisionIdentity: identity, artifactIdentity: identity }).strict(),
  z.object({ type: z.literal("place"), ...placement }).strict(),
  z.object({ type: z.literal("replace_placement"), previousRevision: revision, ...placement, requiresExplicitApproval: z.literal(true) }).strict(),
  z.object({ type: z.literal("retire_preview"), ...placement, requiresExplicitApproval: z.literal(true) }).strict(),
  z.object({ type: z.literal("retire_content_preview"), revision, requiresExplicitApproval: z.literal(true) }).strict(),
  z.object({ type: z.literal("reactivate_content_preview"), previousRevision: revision, revision, requiresExplicitApproval: z.literal(true) }).strict(),
  z.object({ type: z.literal("no_op"), revision, reason: z.literal("identical_revision_and_placements") }).strict(),
]);
const planSchema = z.object({
  schemaVersion: z.literal(PUBLICATION_IMPORT_PLAN_SCHEMA), mode: z.literal("preview"), contentKey: z.string().min(3).max(120),
  targetRevision: revision, artifactIdentity: identity, revisionIdentity: identity, baseSnapshotIdentity: identity, planIdentity: identity,
  actions: z.array(actionSchema).min(1).max(24), writesPerformed: z.literal(false), deletesPlanned: z.literal(0),
}).strict();
export const publicationPart = z.enum(["primary", "captions", "transcript"]);
export type PublicationPart = z.infer<typeof publicationPart>;

export interface PublicationStage {
  id: string;
  expiresAt: string;
  manifest: PublicationManifest;
  uploadedParts: PublicationPart[];
  plan: PublicationImportPlan | null;
}
const instant = z.iso.datetime({ offset: true });
const stageSchema = z.object({ id: publicationId, expiresAt: instant, manifest: z.unknown(), uploadedParts: z.array(publicationPart).max(3), plan: planSchema.nullable() }).strict();
export function parsePublicationStage(value: unknown): PublicationStage {
  const stage = stageSchema.parse(value);
  if (new Set(stage.uploadedParts).size !== stage.uploadedParts.length) throw new Error("Duplicated uploaded part.");
  const manifest = validatePublicationManifest(stage.manifest);
  const declared = publicationParts(manifest);
  if (stage.uploadedParts.some(part => !declared.includes(part))) throw new Error("Undeclared uploaded part.");
  if (stage.plan && stage.plan.contentKey !== manifest.source.content_key) throw new Error("Mismatched publication preview.");
  return { ...stage, manifest };
}

export const publicationCommitSchema = z.object({
  planIdentity: identity,
  idempotencyKey: publicationId,
  confirmedActions: z.array(z.string().regex(/^\d{1,2}:(replace_placement|retire_preview|retire_content_preview|reactivate_content_preview)$/)).max(24),
  reviewConfirmed: z.literal(true),
}).strict();
export type PublicationCommitRequest = z.infer<typeof publicationCommitSchema>;
export const publicationReceiptSchema = z.object({
  importId: publicationId, itemId: publicationId, revisionId: publicationId, revision,
  planIdentity: identity, committedAt: instant, outcome: z.enum(["published", "retired", "unchanged"]),
}).strict();
export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;

export function parsePublicationStageRequest(value: unknown): { manifest: PublicationManifest; sourceReviewConfirmed: true } {
  const request = z.object({ manifest: z.unknown(), sourceReviewConfirmed: z.literal(true) }).strict().parse(value);
  return { manifest: validatePublicationManifest(request.manifest), sourceReviewConfirmed: true };
}
export function publicationParts(manifest: PublicationManifest): PublicationPart[] {
  return ["primary", ...(manifest.artifact.captions_sha256 ? ["captions"] : []), ...(manifest.artifact.transcript_sha256 ? ["transcript"] : [])] as PublicationPart[];
}
export function publicationPartRules(manifest: PublicationManifest, part: PublicationPart): { contentType: string; maxBytes: number; sha256: string; byteLength: number | null } {
  if (!publicationParts(manifest).includes(part)) throw new Error("The manifest does not declare this asset.");
  if (part === "primary") return { contentType: manifest.artifact.media_type, maxBytes: PUBLICATION_UPLOAD_LIMITS[manifest.content.kind], sha256: manifest.artifact.sha256, byteLength: manifest.artifact.byte_length };
  return { contentType: part === "captions" ? "text/vtt" : "text/plain", maxBytes: PUBLICATION_UPLOAD_LIMITS[part], sha256: manifest.artifact[`${part}_sha256`]!, byteLength: null };
}
export function publicationConfirmationIds(plan: PublicationImportPlan): string[] {
  return plan.actions.flatMap((action, index) => "requiresExplicitApproval" in action ? [`${index}:${action.type}`] : []);
}
export function assertPublicationConfirmations(plan: PublicationImportPlan, submitted: string[]): void {
  const expected = publicationConfirmationIds(plan);
  if (submitted.length !== expected.length || new Set(submitted).size !== submitted.length || submitted.some(value => !expected.includes(value))) throw new Error("Confirm every replacement and retirement in this exact preview.");
}
export function publicationActionLabel(action: PublicationImportAction): string {
  switch (action.type) {
    case "create": return "Create a new shared catalog item";
    case "new_immutable_revision": return `Add revision ${action.revision}; preserve revision ${action.previousRevision}`;
    case "place": return `Publish in ${action.productSlug}`;
    case "replace_placement": return `Replace ${action.productSlug} placement with revision ${action.revision}`;
    case "retire_preview": return `Retire the ${action.productSlug} placement`;
    case "retire_content_preview": return "Retire this content from all products";
    case "reactivate_content_preview": return `Reactivate this content using revision ${action.revision}`;
    case "no_op": return "Content and placements are already identical";
  }
}
