import { z } from "zod";

/**
 * Breathe's organization suspend/restore contract, tenant.lifecycle.v1 (kdeyarmin/PennFit:
 * artifacts/resupply-api/src/lib/tenant-lifecycle-protocol.ts, docs/central-admin-tenant-lifecycle.md). The Hub sends one
 * operation to Breathe's fixed endpoint with a one-use breathe.command capability; Breathe redeems it at
 * /api/internal/command/breathe/authorize, compares the operation exactly, checks its mapped administrator again, and records
 * an immutable receipt in the same transaction as the change. These schemas mirror Breathe's, so a shape drift fails here
 * before anything reaches the browser.
 */
export const tenantLifecycleDomain = "tenant.lifecycle.v1";
export const tenantLifecycleAction = "organizations.setSuspension";
export const tenantLifecycleCapabilities = ["organizations.lifecycle.context", "organizations.lifecycle.preview", "organizations.lifecycle.apply", "organizations.lifecycle.resume"] as const;
export const tenantLifecycleEndpoint = "https://cmbreathe.com/resupply-api/central-admin/tenant-lifecycle";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.string().max(100).refine(value => /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
const reason = z.string().min(10).max(500).refine(value => value === value.trim() && !/\p{Cc}/u.test(value));
const parameters = z.object({ suspended: z.boolean() }).strict();
const domain = z.literal(tenantLifecycleDomain);

export const tenantLifecycleOperation = z.discriminatedUnion("operation", [
  z.object({ domain, operation: z.literal("context"), targetId: uuid }).strict(),
  z.object({ domain, operation: z.literal("preview"), requestId: uuid, targetId: uuid, action: z.literal(tenantLifecycleAction), parameters, expectedRevision: digest, reason }).strict(),
  z.object({ domain, operation: z.literal("apply"), commandId: uuid, expectedDigest: digest }).strict(),
  z.object({ domain, operation: z.literal("resume"), requestId: uuid }).strict(),
]);
export type TenantLifecycleOperation = z.infer<typeof tenantLifecycleOperation>;

const status = z.enum(["active", "suspended", "archived"]);
export const tenantLifecycleTarget = z.object({
  id: uuid, slug: z.string().min(1).max(63).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/), name: z.string().max(1000).nullable(),
  status, updatedAt: instant.nullable(), seedProtected: z.boolean(), revision: digest,
}).strict();
export type TenantLifecycleTarget = z.infer<typeof tenantLifecycleTarget>;
export const tenantLifecycleReceipt = z.object({
  commandId: uuid, requestId: uuid, targetId: uuid, action: z.literal(tenantLifecycleAction),
  beforeStatus: z.enum(["active", "suspended"]), afterStatus: z.enum(["active", "suspended"]), appliedAt: instant, revision: digest,
}).strict().refine(value => value.beforeStatus !== value.afterStatus);
export type TenantLifecycleReceipt = z.infer<typeof tenantLifecycleReceipt>;
export const tenantLifecyclePreview = z.object({
  commandId: uuid, requestId: uuid, action: z.literal(tenantLifecycleAction), targetId: uuid, parameters, reason,
  createdAt: instant, expiresAt: instant, previewDigest: digest, before: tenantLifecycleTarget,
  after: z.object({ status: z.enum(["active", "suspended"]) }).strict(), canApplyThisSession: z.boolean(), result: tenantLifecycleReceipt.nullable(),
}).strict().refine(value => value.targetId === value.before.id && value.before.status !== "archived" && value.before.status !== value.after.status
  && value.after.status === (value.parameters.suspended ? "suspended" : "active") && (!value.parameters.suspended || !value.before.seedProtected)
  && Date.parse(value.expiresAt) > Date.parse(value.createdAt) && Date.parse(value.expiresAt) <= Date.parse(value.createdAt) + 300001
  && (!value.result || (!value.canApplyThisSession && value.result.commandId === value.commandId && value.result.requestId === value.requestId
    && value.result.targetId === value.targetId && value.result.beforeStatus === value.before.status && value.result.afterStatus === value.after.status)));
export type TenantLifecyclePreview = z.infer<typeof tenantLifecyclePreview>;
export const tenantLifecycleContext = z.object({ target: tenantLifecycleTarget, requests: z.array(tenantLifecyclePreview).max(20) }).strict()
  .refine(value => value.requests.every(item => item.targetId === value.target.id) && new Set(value.requests.map(item => item.requestId)).size === value.requests.length);
export type TenantLifecycleContext = z.infer<typeof tenantLifecycleContext>;
export type TenantLifecycleResult = TenantLifecycleContext | TenantLifecyclePreview;

/** Breathe's answer for one operation: its envelope, then only the reviewed fields, cross-checked against what was asked. */
export function projectTenantLifecycleResult(input: unknown, operation: TenantLifecycleOperation): TenantLifecycleResult {
  const envelope = z.object({ contractVersion: z.literal(1), product: z.literal("breathe"), domain, operation: z.literal(operation.operation), generatedAt: instant, data: z.unknown() }).strict().parse(input);
  if (operation.operation === "context") {
    const context = tenantLifecycleContext.parse(envelope.data);
    if (context.target.id !== operation.targetId) throw new Error("Organization differs");
    return context;
  }
  const preview = tenantLifecyclePreview.parse(envelope.data);
  if (operation.operation === "preview" && (preview.requestId !== operation.requestId || preview.targetId !== operation.targetId || preview.reason !== operation.reason
    || preview.parameters.suspended !== operation.parameters.suspended || preview.before.revision !== operation.expectedRevision)) throw new Error("Organization review differs");
  if (operation.operation === "apply" && (preview.commandId !== operation.commandId || preview.previewDigest !== operation.expectedDigest || !preview.result)) throw new Error("Organization result differs");
  if (operation.operation === "resume" && preview.requestId !== operation.requestId) throw new Error("Organization request differs");
  return preview;
}
