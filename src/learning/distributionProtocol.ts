import { z } from "zod";
import { prepareGovernedImport } from "../imports/governedLearningImport.ts";

export const distributionDomain = "course.distribution.v1";
export const distributionCapability = "learning.distribution.context";
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime({ offset: true }).max(100);
// eslint-disable-next-line no-control-regex -- Closed single-line catalog labels.
const text = (minimum: number, maximum: number) => z.string().min(minimum).max(maximum).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const state = z.enum(["draft", "published", "archived"]);
export const nativeDistributionOperationSchema = z.object({ domain: z.literal(distributionDomain), operation: z.literal("context"), courseId: uuid }).strict();
export type NativeDistributionOperation = z.infer<typeof nativeDistributionOperationSchema>;
export const distributionSourceSchema = z.object({ payload: z.string().min(1).max(2_000_000), sourceRevision: sha }).strict();
export const nativeDistributionContextSchema = z.object({ courseId: uuid, publicationState: state, currentVersionId: uuid.nullable(), currentVersionState: state.nullable(), source: distributionSourceSchema.nullable() }).strict()
  .refine(value => (value.currentVersionId === null) === (value.currentVersionState === null)
    && (value.source !== null) === (value.publicationState === "published" && value.currentVersionId !== null && value.currentVersionState === "published"));
export type NativeDistributionContext = z.infer<typeof nativeDistributionContextSchema>;
const envelope = z.object({ contractVersion: z.literal(1), product: z.literal("carebase"), domain: z.literal(distributionDomain), operation: z.literal("context"), generatedAt: instant, data: nativeDistributionContextSchema }).strict();
export async function projectDistributionContext(input: unknown, request: NativeDistributionOperation, now = Date.now()): Promise<NativeDistributionContext> {
  const value = envelope.parse(input), result = value.data;
  if (request.courseId !== result.courseId || Date.parse(value.generatedAt) > now + 30_000 || Date.parse(value.generatedAt) < now - 120_000) throw new Error("Distribution source course or observation time differs");
  if (result.source) {
    const [source] = await prepareGovernedImport({ contract: "carebase.catalog-snapshot.v1", scope: "global-courses-with-current-version", courses: [result.source] });
    if (source.course.sourceCourseId.toLowerCase() !== result.courseId || source.course.sourceVersionId.toLowerCase() !== result.currentVersionId
      || source.course.publicationState !== "published" || source.course.sourceVersionState !== "published") throw new Error("Distribution source is not the current published version");
  }
  return result;
}

export const distributionMetadataSchema = z.object({ title: text(2, 180), summary: text(0, 500), category: text(1, 200).nullable(), durationMinutes: z.number().int().min(0).max(2147483647).nullable() }).strict();
const productIds = z.array(uuid).min(1).max(6).refine(values => new Set(values).size === values.length);
const removedIds = z.array(uuid).max(6).refine(values => new Set(values).size === values.length);
export const distributionPlanSchema = z.object({ courseId: uuid, versionId: uuid, sourceRevision: sha, expectedCatalogDigest: sha,
  metadata: distributionMetadataSchema, productIds, removedProductIds: removedIds, accessLevel: z.enum(["public", "customer", "staff"]),
  reason: text(10, 500), reviewed: z.literal(true), confirmReplacement: z.boolean(), confirmRetirements: z.boolean() }).strict()
  .refine(value => value.removedProductIds.every(id => !value.productIds.includes(id)) && (!value.removedProductIds.length || value.confirmRetirements));
export type DistributionPlan = z.infer<typeof distributionPlanSchema>;
export const distributionOperationSchema = z.union([
  z.object({ operation: z.literal("context"), courseId: uuid }).strict(),
  z.object({ operation: z.literal("preview"), requestId: uuid, plan: distributionPlanSchema }).strict(),
  z.object({ operation: z.literal("commit"), requestId: uuid, expectedDigest: sha }).strict(),
  z.object({ operation: z.literal("resume"), requestId: uuid }).strict(),
]);
export type DistributionOperation = z.infer<typeof distributionOperationSchema>;

export const distributionReceiptSchema = z.object({ requestId: uuid, itemId: uuid, revisionId: uuid, revisionNumber: z.number().int().positive(), courseId: uuid,
  versionId: uuid, sourceRevision: sha, productIds, accessLevel: z.enum(["public", "customer", "staff"]), publishedAt: instant }).strict();
export type DistributionReceipt = z.infer<typeof distributionReceiptSchema>;
export const distributionPreviewSchema = z.object({ requestId: uuid, plan: distributionPlanSchema, previewDigest: sha, createdAt: instant, expiresAt: instant,
  replacesPublished: z.boolean(), canCommitThisSession:z.boolean(), result: distributionReceiptSchema.nullable() }).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.createdAt) && Date.parse(value.expiresAt) <= Date.parse(value.createdAt) + 300001
    && (!value.result || !value.canCommitThisSession) && (!value.replacesPublished || value.plan.confirmReplacement) && (!value.result || value.result.requestId === value.requestId && value.result.courseId === value.plan.courseId
      && value.result.versionId === value.plan.versionId && value.result.sourceRevision === value.plan.sourceRevision && value.result.accessLevel === value.plan.accessLevel
      && value.result.productIds.length === value.plan.productIds.length && value.result.productIds.every(id => value.plan.productIds.includes(id))));
export type DistributionPreview = z.infer<typeof distributionPreviewSchema>;
export const distributionAvailabilitySchema = z.object({ managed: z.boolean(), state: z.enum(["legacy", "unverified", "stale", "published", "changed", "unpublished", "missing"]),
  observedAt: instant.nullable(), validUntil: instant.nullable() }).strict().refine(value => value.managed !== (value.state === "legacy"));
export const distributionCatalogSchema = z.object({ itemId: uuid, status: z.enum(["draft", "review", "published", "retired"]), accessLevel: z.enum(["public", "customer", "staff"]),
  catalogDigest: sha, metadata: z.object({ title:z.string().min(2).max(180),summary:z.string().max(500),category:z.string().max(250000).nullable(),durationMinutes:z.number().int().min(0).max(2147483647).nullable() }).strict().nullable(), productIds: z.array(uuid).max(6), legacy: z.boolean(), availability: distributionAvailabilitySchema }).strict();
export const distributionContextSchema = z.object({ native: nativeDistributionContextSchema.nullable(), catalog: distributionCatalogSchema,
  products: z.array(z.object({ id: uuid, slug: text(1, 100), name: text(1, 200), eligible: z.boolean() }).strict()).max(6),
  observerConfigured: z.boolean(), legacyOptInAllowed: z.boolean(), requests: z.array(distributionPreviewSchema).max(20) }).strict();
export type DistributionContext = z.infer<typeof distributionContextSchema>;

export const distributionStatusDomain = "course.distribution.status.v1";
export const distributionStatusRequestSchema = z.object({ domain: z.literal(distributionStatusDomain), operation: z.literal("status"),
  courseIds: z.array(uuid).min(1).max(10).refine(values => new Set(values).size === values.length) }).strict();
export const distributionStatusSchema = z.object({ courseId: uuid, publicationState: z.enum(["draft", "published", "archived", "missing"]),
  currentVersionId: uuid.nullable(), currentVersionState: state.nullable(), sourceRevision: sha.nullable() }).strict()
  .refine(value => (value.currentVersionId === null) === (value.currentVersionState === null)
    && (value.publicationState !== "missing" || value.currentVersionId === null && value.sourceRevision === null)
    && (value.sourceRevision !== null) === (value.publicationState === "published" && value.currentVersionId !== null && value.currentVersionState === "published"));
export type DistributionStatus = z.infer<typeof distributionStatusSchema>;
const statusEnvelope = z.object({ contractVersion: z.literal(1), product: z.literal("carebase"), domain: z.literal(distributionStatusDomain), operation: z.literal("status"), generatedAt: instant,
  data: z.object({ items: z.array(distributionStatusSchema).min(1).max(10) }).strict() }).strict();
export function projectDistributionStatuses(input: unknown, courseIds: string[], now = Date.now()): DistributionStatus[] {
  const request = distributionStatusRequestSchema.parse({ domain: distributionStatusDomain, operation: "status", courseIds });
  const value = statusEnvelope.parse(input), generated = Date.parse(value.generatedAt), received = value.data.items.map(item => item.courseId);
  if (generated > now + 30_000 || generated < now - 120_000 || new Set(received).size !== received.length
    || received.length !== request.courseIds.length || received.some(id => !request.courseIds.includes(id))) throw new Error("Distribution observation differs from its bounded request");
  return value.data.items;
}
