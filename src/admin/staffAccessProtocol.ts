import { z } from "zod";
import { lifecycleDigest as digest, lifecycleInstant as instant, lifecycleReason as reason, lifecycleUuid as uuid, tenantLifecycleOperation } from "./tenantLifecycleProtocol";

/**
 * Breathe's staff sign-in contract, staff.access.v1 (kdeyarmin/PennFit: artifacts/resupply-api/src/lib/staff-access-protocol.ts,
 * migration 0567, docs/central-admin-staff-access.md). Deactivating is Breathe's own Team → Revoke: the sign-in and its seat are
 * revoked and every session ends. Reactivating is offered only for a sign-in the Hub deactivated that nothing has changed since,
 * and puts it back as it was, without its old sessions. Breathe decides what is unavailable for a sign-in before any preview and
 * says why. The same breathe.command capability and the same review, receipt and recovery rules as the organization lifecycle.
 */
export const staffAccessDomain = "staff.access.v1";
export const staffAccessAction = "staff.setAccess";
export const staffAccessCapabilities = ["staff.access.context", "staff.access.preview", "staff.access.apply", "staff.access.resume"] as const;
export const staffAccessEndpoint = "https://cmbreathe.com/resupply-api/central-admin/staff-access";

const userId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const parameters = z.object({ active: z.boolean() }).strict();
const domain = z.literal(staffAccessDomain);
export const staffAccessOperation = z.discriminatedUnion("operation", [
  z.object({ domain, operation: z.literal("context"), targetId: userId }).strict(),
  z.object({ domain, operation: z.literal("preview"), requestId: uuid, targetId: userId, action: z.literal(staffAccessAction), parameters, expectedRevision: digest, reason }).strict(),
  z.object({ domain, operation: z.literal("apply"), commandId: uuid, expectedDigest: digest }).strict(),
  z.object({ domain, operation: z.literal("resume"), requestId: uuid }).strict(),
]);
export type StaffAccessOperation = z.infer<typeof staffAccessOperation>;
/** Every change Breathe accepts through the breathe.command capability: an organization's lifecycle or a staff sign-in's access. */
export const breatheCommandOperation = z.union([tenantLifecycleOperation, staffAccessOperation]);

export const staffAccessUnavailableReasons = ["own_account", "protected_administrator", "unsupported_account", "shared_identity", "invited_account", "no_change", "last_administrator", "not_hub_deactivated", "unverified_email"] as const;
export type StaffAccessUnavailable = typeof staffAccessUnavailableReasons[number];
const unavailable = z.enum(staffAccessUnavailableReasons).nullable();
export const staffAccessTarget = z.object({
  id: userId, email: z.string().max(500), displayName: z.string().max(1000).nullable(), role: z.enum(["admin", "agent", "customer"]),
  status: z.enum(["active", "invited", "locked", "revoked"]), emailVerified: z.boolean(), organizationId: uuid.nullable(), seatRole: z.string().max(50).nullable(),
  seatStatus: z.enum(["pending", "active", "revoked"]).nullable(), unavailable: z.object({ deactivate: unavailable, reactivate: unavailable }).strict(), revision: digest,
}).strict();
export type StaffAccessTarget = z.infer<typeof staffAccessTarget>;
const accessStatus = z.enum(["active", "revoked"]);
export const staffAccessReceipt = z.object({
  commandId: uuid, requestId: uuid, targetId: userId, action: z.literal(staffAccessAction), beforeStatus: accessStatus, afterStatus: accessStatus, appliedAt: instant, revision: digest,
}).strict().refine(value => value.beforeStatus !== value.afterStatus);
export type StaffAccessReceipt = z.infer<typeof staffAccessReceipt>;
export const staffAccessPreview = z.object({
  commandId: uuid, requestId: uuid, action: z.literal(staffAccessAction), targetId: userId, parameters, reason, createdAt: instant, expiresAt: instant,
  previewDigest: digest, before: staffAccessTarget, after: z.object({ status: accessStatus }).strict(), canApplyThisSession: z.boolean(), result: staffAccessReceipt.nullable(),
}).strict().refine(value => value.targetId === value.before.id && value.after.status === (value.parameters.active ? "active" : "revoked")
  && value.before.unavailable[value.parameters.active ? "reactivate" : "deactivate"] === null
  && Date.parse(value.expiresAt) > Date.parse(value.createdAt) && Date.parse(value.expiresAt) <= Date.parse(value.createdAt) + 300001
  && (!value.result || (!value.canApplyThisSession && value.result.commandId === value.commandId && value.result.requestId === value.requestId
    && value.result.targetId === value.targetId && value.result.afterStatus === value.after.status)));
export type StaffAccessPreview = z.infer<typeof staffAccessPreview>;
export const staffAccessContext = z.object({ target: staffAccessTarget, requests: z.array(staffAccessPreview).max(20) }).strict()
  .refine(value => value.requests.every(item => item.targetId === value.target.id) && new Set(value.requests.map(item => item.requestId)).size === value.requests.length);
export type StaffAccessContext = z.infer<typeof staffAccessContext>;

/** Breathe's answer for one staff operation: its envelope, then only the reviewed fields, cross-checked against what was asked. */
export function projectStaffAccessResult(input: unknown, operation: StaffAccessOperation): StaffAccessContext | StaffAccessPreview {
  const envelope = z.object({ contractVersion: z.literal(1), product: z.literal("breathe"), domain, operation: z.literal(operation.operation), generatedAt: instant, data: z.unknown() }).strict().parse(input);
  if (operation.operation === "context") {
    const context = staffAccessContext.parse(envelope.data);
    if (context.target.id !== operation.targetId) throw new Error("Staff sign-in differs");
    return context;
  }
  const preview = staffAccessPreview.parse(envelope.data);
  if (operation.operation === "preview" && (preview.requestId !== operation.requestId || preview.targetId !== operation.targetId || preview.reason !== operation.reason
    || preview.parameters.active !== operation.parameters.active || preview.before.revision !== operation.expectedRevision)) throw new Error("Staff review differs");
  if (operation.operation === "apply" && (preview.commandId !== operation.commandId || preview.previewDigest !== operation.expectedDigest || !preview.result)) throw new Error("Staff result differs");
  if (operation.operation === "resume" && preview.requestId !== operation.requestId) throw new Error("Staff request differs");
  return preview;
}
