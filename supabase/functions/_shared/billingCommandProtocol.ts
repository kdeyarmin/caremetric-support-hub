import { z } from "zod";

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const date = z.iso.datetime({ offset: true }).max(40);
const reason = z.string().max(500).refine(value => !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)).transform(value => value.trim()).pipe(z.string().min(10));
const action = z.literal("billing.portal.create");
export const billingPortalUrlSchema = z.string().max(4096).regex(/^https:\/\/billing[.]stripe[.]com\/p\/session(?:\/[A-Za-z0-9_-]{1,2048}|[?]secret=[A-Za-z0-9_-]{1,2048})$/).refine(value => {
  try {
    const url = new URL(value);
    return url.origin === "https://billing.stripe.com" && !url.username && !url.password && !url.hash && url.href === value;
  } catch { return false; }
}, "Invalid billing portal URL");
export const billingPreviewRequestSchema = z.object({ operation: z.literal("preview"), requestId: id, action, targetId: id, parameters: z.object({}).strict(), reason }).strict();
export const billingApplyRequestSchema = z.object({ operation: z.literal("apply"), commandId: id, expectedDigest: digest }).strict();
export const nativeBillingCommandSchema = z.union([billingPreviewRequestSchema, billingApplyRequestSchema]);
export const billingCommandSchema = z.union([
  nativeBillingCommandSchema,
  z.object({ operation: z.literal("resume"), targetId: id }).strict(),
  z.object({ operation: z.literal("discard"), requestId: id }).strict(),
]);
export const billingPreviewSchema = z.object({
  commandId: id, action, targetId: id, reason, expiresAt: date, previewDigest: digest,
  summary: z.object({ kind: z.literal("portal"), organizationName: z.string().max(500), providerCustomerId: z.string().regex(/^cus_[A-Za-z0-9]+$/),
    providerConfigurationId: z.string().regex(/^bpc_[A-Za-z0-9]+$/), returnPath: z.literal("/admin/enterprise") }).strict(),
}).strict();
const sessionMetadata = z.object({ kind: z.literal("portal"), id: z.string().regex(/^bps_[A-Za-z0-9]+$/), expiresAt: z.null(), livemode: z.boolean() }).strict();
const session = sessionMetadata.extend({ url: billingPortalUrlSchema }).strict();
const common = { commandId: id, action, targetId: id, replayed: z.boolean() };
const pending = z.object({ ...common, outcome: z.literal("pending"), completedAt: z.null(), retryAfterSeconds: z.literal(30), session: z.null() }).strict();
const failed = z.object({ ...common, outcome: z.literal("failed"), completedAt: date, retryAfterSeconds: z.null(), session: z.null() }).strict();
const created = z.object({ ...common, outcome: z.literal("created"), completedAt: date, retryAfterSeconds: z.null(), session }).strict();
export const billingResultSchema = z.union([pending, failed, created]);
export const billingResultMetadataSchema = z.union([pending, failed, created.extend({ session: sessionMetadata })]);
export const billingIntentSchema = z.object({
  request: billingPreviewRequestSchema, preview: billingPreviewSchema.nullable(), result: billingResultMetadataSchema.nullable(),
  createdAt: date, expiresAt: date, previewDispatchedAt: date.nullable(), dispatchedAt: date.nullable(), retryAt: date.nullable(),
}).strict().refine(value => !value.preview || value.preview.targetId === value.request.targetId && value.preview.reason === value.request.reason)
  .refine(value => !value.result || value.preview !== null && value.result.commandId === value.preview.commandId && value.result.targetId === value.preview.targetId);
export type BillingPreviewRequest = z.infer<typeof billingPreviewRequestSchema>;
export type BillingApplyRequest = z.infer<typeof billingApplyRequestSchema>;
export type NativeBillingCommand = z.infer<typeof nativeBillingCommandSchema>;
export type BillingPreview = z.infer<typeof billingPreviewSchema>;
export type BillingResult = z.infer<typeof billingResultSchema>;
export type BillingResultMetadata = z.infer<typeof billingResultMetadataSchema>;
export type BillingIntent = z.infer<typeof billingIntentSchema>;

/** URLs are response capabilities; never persist them in the Hub's intent or audit. */
export function billingResultMetadata(input: BillingResult): BillingResultMetadata {
  if (input.outcome !== "created") return billingResultMetadataSchema.parse(input);
  const { kind, id, expiresAt, livemode } = input.session;
  const metadata = { kind, id, expiresAt, livemode };
  return billingResultMetadataSchema.parse({ ...input, session: metadata });
}
export function verifyBillingOutcome(input: unknown, preview: BillingPreview): BillingResult {
  const result = billingResultSchema.parse(input);
  if (result.commandId !== preview.commandId || result.action !== preview.action || result.targetId !== preview.targetId) throw new Error("Unbound billing result");
  return result;
}
export function projectBillingCommand(input: unknown, command: NativeBillingCommand): BillingPreview | BillingResult {
  const envelope = z.object({ contractVersion: z.literal(1), product: z.literal("carebase"), operation: z.enum(["preview", "apply"]), generatedAt: date, data: z.unknown() }).strict().parse(input);
  if (envelope.operation !== command.operation) throw new Error("Mismatched billing operation");
  if (command.operation === "preview") {
    const preview = billingPreviewSchema.parse(envelope.data);
    const lifetime = Date.parse(preview.expiresAt) - Date.parse(envelope.generatedAt);
    if (preview.targetId !== command.targetId || preview.reason !== command.reason || lifetime <= 0 || lifetime > 301000) throw new Error("Unbound billing preview");
    return preview;
  }
  const result = billingResultSchema.parse(envelope.data);
  if (result.commandId !== command.commandId) throw new Error("Mismatched billing command");
  return result;
}
