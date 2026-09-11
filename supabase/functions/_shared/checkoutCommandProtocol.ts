import { z } from "zod";
import { billingApplyRequestSchema, billingPreviewRequestSchema } from "./billingCommandProtocol.ts";
import { checkoutMetrics } from "./checkoutCatalogProtocol.ts";

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
const date = z.iso.datetime({ offset: true }).max(40);
const createAction = z.literal("billing.checkout.create");
const action = z.enum(["billing.checkout.create", "billing.checkout.recover"]);
const interval = z.enum(["month", "year"]);
export const checkoutPreviewRequestSchema = billingPreviewRequestSchema.extend({
  action: createAction, parameters: z.object({ packageId: id, billingInterval: interval }).strict(),
});
export const checkoutApplyRequestSchema = billingApplyRequestSchema.extend({ action: createAction });
export const checkoutCheckRequestSchema = checkoutApplyRequestSchema.extend({ operation: z.literal("check"), action });
export const checkoutRecoverRequestSchema = z.object({ operation: z.literal("recover"), action: z.literal("billing.checkout.recover"), requestId: id, targetId: id, reason: checkoutPreviewRequestSchema.shape.reason }).strict();
export const checkoutRequestSchema = z.union([checkoutPreviewRequestSchema, checkoutRecoverRequestSchema]);
export const nativeCheckoutCommandSchema = z.union([checkoutPreviewRequestSchema, checkoutApplyRequestSchema, checkoutCheckRequestSchema, checkoutRecoverRequestSchema]);
export const checkoutCommandSchema = z.union([nativeCheckoutCommandSchema,
  z.object({ operation: z.literal("resume"), targetId: id }).strict(),
  z.object({ operation: z.literal("discard"), requestId: id }).strict(),
]);
export const checkoutPreviewSchema = z.object({
  commandId: id, action, targetId: id, reason: checkoutPreviewRequestSchema.shape.reason,
  expiresAt: date, previewDigest: billingApplyRequestSchema.shape.expectedDigest,
  summary: z.object({ kind: z.literal("checkout"), organizationName: z.string().max(500),
    packageId: id, billingInterval: interval, intervalCount: z.number().int().min(1).max(36), currency: z.string().regex(/^[a-z]{3}$/),
    billingMetric: z.enum(checkoutMetrics), quantity: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    providerPriceId: z.string().max(255).regex(/^price_[A-Za-z0-9]+$/),
    providerCustomerId: z.string().max(255).regex(/^cus_[A-Za-z0-9]+$/).nullable(), trialDays: z.number().int().min(0).max(90),
  }).strict(),
}).strict();
const sessionId = z.string().max(255).regex(/^cs_(?:test|live)_[A-Za-z0-9]+$/);
/** Match Stripe's documented raw hosted URL and its opaque fragment to this session. */
export function parseCheckoutUrl(value: unknown, expectedSessionId: string): string {
  sessionId.parse(expectedSessionId);
  const prefix = `https://checkout.stripe.com/c/pay/${expectedSessionId}`;
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith(prefix)) throw new Error("Invalid checkout URL");
  const rest = value.slice(prefix.length);
  if (rest !== "" && (!/^#[A-Za-z0-9%._~!$&()*+,;=:/?@-]+$/.test(rest) || /%(?![0-9a-f]{2})/i.test(rest))) throw new Error("Invalid checkout URL");
  const parsed = new URL(value);
  if (parsed.href !== value || parsed.origin !== "https://checkout.stripe.com" || parsed.search || parsed.username || parsed.password) throw new Error("Invalid checkout URL");
  return value;
}
const sessionMetadataSchema = z.object({ kind: z.literal("checkout"), id: sessionId, expiresAt: date, livemode: z.boolean() }).strict()
  .refine(value => value.id.startsWith("cs_live_") === value.livemode);
const sessionSchema = sessionMetadataSchema.safeExtend({ url: z.string().max(4096) })
  .refine(value => { try { parseCheckoutUrl(value.url, value.id); return true; } catch { return false; } });
const resultFields = {
  commandId: id, action, targetId: id, outcome: z.enum(["open", "complete", "expired", "pending", "failed"]),
  replayed: z.boolean(), checkedAt: date.nullable(), providerStatus: z.enum(["open", "complete", "expired"]).nullable(),
  availability: z.enum(["available", "unavailable"]), canStartNewCheckout: z.boolean(), retryAfterSeconds: z.literal(30).nullable(),
};
const shape = z.object({ ...resultFields, session: sessionSchema.nullable() }).strict();
const metadataShape = z.object({ ...resultFields, session: sessionMetadataSchema.nullable() }).strict();
function validResult(value: z.infer<typeof metadataShape>): boolean {
  if (value.outcome === "pending") return value.session === null && value.retryAfterSeconds === 30 && !value.canStartNewCheckout;
  if (value.availability !== "available" || value.checkedAt === null || value.retryAfterSeconds !== null) return false;
  if (value.outcome === "open") return !value.canStartNewCheckout && value.providerStatus === "open" && value.session !== null
    && Date.parse(value.session.expiresAt) > Date.parse(value.checkedAt);
  return value.session === null && value.providerStatus === (value.outcome === "failed" ? null : value.outcome);
}
export const checkoutResultSchema = shape.refine(validResult);
export const checkoutResultMetadataSchema = metadataShape.refine(validResult);
export const checkoutIntentSchema = z.object({
  request: checkoutRequestSchema, preview: checkoutPreviewSchema.nullable(), result: checkoutResultMetadataSchema.nullable(),
  recovery: z.object({ checkedAt: date, canStartNewCheckout: z.boolean() }).strict().nullable(),
  createdAt: date, expiresAt: date, previewDispatchedAt: date.nullable(), dispatchedAt: date.nullable(), retryAt: date.nullable(),
}).strict().refine(value => !value.preview || value.preview.targetId === value.request.targetId && value.preview.reason === value.request.reason
  && value.preview.action === value.request.action
  && (value.request.operation === "recover" || value.preview.summary.packageId === value.request.parameters.packageId && value.preview.summary.billingInterval === value.request.parameters.billingInterval))
  .refine(value => !value.result || !!value.preview && value.result.commandId === value.preview.commandId && value.result.targetId === value.preview.targetId && value.result.action === value.preview.action)
  .refine(value => value.request.operation === "recover" ? !value.recovery || !!value.dispatchedAt && (!value.result || value.result.canStartNewCheckout === value.recovery.canStartNewCheckout) : value.recovery === null)
  .refine(value => value.request.operation !== "recover" || !value.preview || !!value.dispatchedAt && !!value.recovery && !!value.result);
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;
export type CheckoutRecoverRequest = z.infer<typeof checkoutRecoverRequestSchema>;
export type CheckoutPreviewRequest = z.infer<typeof checkoutPreviewRequestSchema>;
export type CheckoutApplyRequest = z.infer<typeof checkoutApplyRequestSchema>;
export type CheckoutCheckRequest = z.infer<typeof checkoutCheckRequestSchema>;
export type NativeCheckoutCommand = z.infer<typeof nativeCheckoutCommandSchema>;
export type CheckoutPreview = z.infer<typeof checkoutPreviewSchema>;
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;
export type CheckoutResultMetadata = z.infer<typeof checkoutResultMetadataSchema>;
export type CheckoutIntent = z.infer<typeof checkoutIntentSchema>;
export function checkoutResultMetadata(input: CheckoutResult): CheckoutResultMetadata {
  const value = checkoutResultSchema.parse(input);
  return checkoutResultMetadataSchema.parse({ ...value, session: value.session ? {
    kind: value.session.kind, id: value.session.id, expiresAt: value.session.expiresAt, livemode: value.session.livemode,
  } : null });
}
export function verifyCheckoutOutcome(input: unknown, preview: CheckoutPreview): CheckoutResult {
  const value = checkoutResultSchema.parse(input);
  if (value.commandId !== preview.commandId || value.targetId !== preview.targetId || value.action !== preview.action) throw new Error("Unbound checkout result");
  return value;
}
export const checkoutRecoverySchema = z.object({ targetId: id, preview: checkoutPreviewSchema.nullable(), result: checkoutResultSchema.nullable(), canStartNewCheckout: z.boolean() }).strict().refine(value => {
  if (value.preview === null || value.result === null) return value.preview === null && value.result === null;
  return value.preview.action === "billing.checkout.recover" && value.result.action === "billing.checkout.recover"
    && value.preview.targetId === value.targetId && value.result.targetId === value.targetId
    && value.preview.commandId === value.result.commandId && value.canStartNewCheckout === value.result.canStartNewCheckout;
});
export type CheckoutRecovery = z.infer<typeof checkoutRecoverySchema>;
export function checkoutRecoveryMetadata(input: CheckoutRecovery) {
  return { ...input, result: input.result ? checkoutResultMetadata(input.result) : null };
}
export function projectCheckoutCommand(input: unknown, command: NativeCheckoutCommand): CheckoutPreview | CheckoutResult | CheckoutRecovery {
  const envelope = z.object({ contractVersion: z.literal(1), product: z.literal("carebase"),
    operation: z.enum(["preview", "apply", "check", "recover"]), generatedAt: date, data: z.unknown() }).strict().parse(input);
  if (envelope.operation !== command.operation) throw new Error("Mismatched checkout operation");
  if (command.operation === "recover") {
    const value = checkoutRecoverySchema.parse(envelope.data);
    if (value.targetId !== command.targetId || value.preview && (value.preview.reason !== command.reason
      || Date.parse(value.preview.expiresAt) > Date.parse(envelope.generatedAt) + 301000)
      || value.result?.session && Date.parse(value.result.session.expiresAt) <= Date.parse(envelope.generatedAt)) throw new Error("Unbound checkout recovery");
    return value;
  }
  if (command.operation === "preview") {
    const preview = checkoutPreviewSchema.parse(envelope.data), lifetime = Date.parse(preview.expiresAt) - Date.parse(envelope.generatedAt);
    if (preview.action !== command.action || preview.targetId !== command.targetId || preview.reason !== command.reason || preview.summary.packageId !== command.parameters.packageId
      || preview.summary.billingInterval !== command.parameters.billingInterval || lifetime <= 0 || lifetime > 301000) throw new Error("Unbound checkout preview");
    return preview;
  }
  const result = checkoutResultSchema.parse(envelope.data);
  if (result.action !== command.action || result.commandId !== command.commandId || result.session && Date.parse(result.session.expiresAt) <= Date.parse(envelope.generatedAt)) throw new Error("Invalid current checkout result");
  return result;
}
