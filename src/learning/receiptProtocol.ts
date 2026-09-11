import { z } from "zod";

export const receiptUuid = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/);
export const learningReceiptSchema = z.strictObject({
  contract: z.literal("caremetric.learning-receipt.v1"), source: z.literal("carebase"), eventId: receiptUuid,
  kind: z.enum(["completed", "retracted"]), sequence: z.number().int().min(1).max(2147483647), mappingId: receiptUuid,
  assignmentId: receiptUuid, sourceCourseId: receiptUuid, sourceVersionId: receiptUuid,
  mappingRevision: digest, assignmentRevision: digest, completionRevision: digest,
  hubTenantId: receiptUuid, hubUserId: receiptUuid, completedAt: instant, evidenceSha256: digest,
  finalExamScore: z.number().min(0).max(100).nullable(),
  certificate: z.strictObject({ id: receiptUuid, issuedAt: instant, expiresAt: instant.nullable(), providerEvidenceSha256: digest }),
  credits: z.array(z.strictObject({ id: receiptUuid, trainingTypeId: receiptUuid, topicCode: z.string().max(200),
    hours: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/), year: z.number().int().min(2000).max(2200), creditedAt: instant })).max(100),
  attestations: z.array(z.strictObject({ blockId: receiptUuid, version: z.string().max(500), statementSha256: digest, attestedAt: instant })).max(500),
  quizEvidenceSha256: digest, renewalEvidenceSha256: digest,
});
export type LearningReceipt = z.infer<typeof learningReceiptSchema>;
export const sourceReceiptBatchSchema = z.array(z.strictObject({ eventId: receiptUuid, payload: z.string().max(100_000), sourceDigest: digest,
  state: z.enum(["pending", "quarantined", "delivered"]), reason: z.enum(["mapping_disabled", "policy_drift", "missing_renewal_evidence", "binding_identity_drift", "receipt_retracted", "receipt_limits"]).nullable() })).max(25);

export const receiptMappingInputSchema = z.strictObject({ mappingId: receiptUuid, sourceSnapshotId: receiptUuid,
  nativeOrganizationId: receiptUuid, nativeEmployeeId: receiptUuid, hubTenantId: receiptUuid, hubUserId: receiptUuid });
export const learningReceiptOperationSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("status") }),
  z.strictObject({ operation: z.literal("provision_access"), nativeOrganizationId: receiptUuid, nativeEmployeeId: receiptUuid,
    hubTenantId: receiptUuid, tenantName: z.string().trim().min(2).max(180), hubUserId: receiptUuid }),
  receiptMappingInputSchema.extend({ operation: z.literal("provision") }),
  z.strictObject({ operation: z.literal("revoke"), mappingId: receiptUuid }),
  z.strictObject({ operation: z.literal("reconcile"), limit: z.number().int().min(1).max(10) }),
  z.strictObject({ operation: z.literal("retract"), assignmentId: receiptUuid, expectedSequence: z.number().int().min(1).max(2147483647) }),
]);
export type LearningReceiptOperation = z.infer<typeof learningReceiptOperationSchema>;
export const nativeLearningOperationSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("resolve_identity"), organizationId: receiptUuid, employeeId: receiptUuid }),
  z.strictObject({ operation: z.literal("provision"), mappingId: receiptUuid, organizationId: receiptUuid, employeeId: receiptUuid,
    hubTenantId: receiptUuid, hubUserId: receiptUuid, courseId: receiptUuid, versionId: receiptUuid, sourceRevision: digest }),
  z.strictObject({ operation: z.literal("revoke"), mappingId: receiptUuid }),
  z.strictObject({ operation: z.literal("list"), limit: z.number().int().min(1).max(10) }),
  z.strictObject({ operation: z.literal("acknowledge"), eventId: receiptUuid, sourceDigest: digest }),
  z.strictObject({ operation: z.literal("retract"), assignmentId: receiptUuid, expectedSequence: z.number().int().min(1).max(2147483647) }),
]);

// Response projection deliberately drops unapproved upstream fields at every level.
export const receiptStatusSchema = z.object({
  mappings: z.array(z.object({ mappingId: receiptUuid, state: z.enum(["pending", "active", "revoked"]), hubTenantId: receiptUuid,
    hubUserId: receiptUuid, sourceSnapshotId: receiptUuid })).max(100),
  receipts: z.array(z.object({ assignmentId: receiptUuid, kind: z.enum(["completed", "retracted"]), sequence: z.number().int().positive(),
    eventId: receiptUuid, mappingId: receiptUuid, completedAt: instant })).max(100),
  tenants: z.array(z.object({ nativeOrganizationId: receiptUuid, hubTenantId: receiptUuid, name: z.string().max(180) })).max(100),
  users: z.array(z.object({ id: receiptUuid, displayName: z.string().max(120) })).max(100),
  snapshots: z.array(z.object({ id: receiptUuid, sourceCourseId: receiptUuid, sourceVersionId: receiptUuid, sourceRevision: digest, title: z.string().max(1000) })).max(100),
  mappingTotal: z.number().int().nonnegative(), receiptTotal: z.number().int().nonnegative(),
});
export const receiptAccessResultSchema = z.object({ hubTenantId: receiptUuid, hubUserId: receiptUuid,
  nativeOrganizationId: receiptUuid, nativeEmployeeId: receiptUuid, nativeProfileId: receiptUuid });
export const receiptReconciliationSchema = z.object({ accepted: z.number().int().min(0).max(10),
  quarantined: z.number().int().min(0).max(10), failed: z.number().int().min(0).max(10),
  quarantineDetails: z.array(z.object({ eventId: receiptUuid, reason: z.enum(["mapping_disabled","policy_drift","missing_renewal_evidence","binding_identity_drift","receipt_retracted", "receipt_limits","needs_review"]) })).max(10),
  retryEvents: z.array(receiptUuid).max(10) });
export function projectReceiptResult(value: unknown, operation: LearningReceiptOperation): unknown {
  if (operation.operation === "status") return receiptStatusSchema.parse(value);
  if (operation.operation === "provision_access") return receiptAccessResultSchema.parse(value);
  if (operation.operation === "reconcile") return receiptReconciliationSchema.parse(value);
  return z.object({ success: z.literal(true) }).parse(value);
}
