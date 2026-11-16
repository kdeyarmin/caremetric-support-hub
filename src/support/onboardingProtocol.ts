import { z } from "zod";
import { adminRegistry } from "../../supabase/functions/_shared/adminRegistry.ts";

export const onboardingProducts = ["carebase", "breathe", "caremetric-emr", "caremetric-go", "pennsync", "intel"] as const;
export const onboardingProduct = z.enum(onboardingProducts);
/**
 * Applications whose administration connection can verify an account now: the ones with a reviewed destination. EMR, Go and
 * PennSync were disconnected on 2026-10-28, so linking or inviting their accounts can only fail; they stay in the enum above so
 * earlier links and invitations still read.
 */
export const connectedOnboardingProducts = onboardingProducts.filter(product => adminRegistry[product].endpoint !== null);
/** What an application select offers: the connected applications, and, first and unavailable, a disconnected one an earlier invitation names. */
export function applicationChoices(current: typeof onboardingProducts[number]): Array<typeof onboardingProducts[number]> {
  return connectedOnboardingProducts.includes(current) ? [...connectedOnboardingProducts] : [current, ...connectedOnboardingProducts];
}
const uuid = z.uuid().transform(value => value.toLowerCase());
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const nativeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const supportIdentityOperation = z.object({ operation: z.literal("support.identity.resolve"), sourceUserId: nativeId, sourceAccountId: nativeId }).strict();
export const supportIdentity = z.object({ product: onboardingProduct, sourceUserId: nativeId, sourceAccountId: nativeId,
  accountKind: z.enum(["organization", "agency", "individual"]), relationship: z.enum(["organization_member", "agency_member", "individual_owner"]),
  revision: digest }).strict().superRefine((value, ctx) => {
  const expected = value.product === "intel" ? ["individual", "individual_owner"] : value.product === "pennsync" ? ["agency", "agency_member"] : ["organization", "organization_member"];
  const sourcePattern = ["intel", "pennsync"].includes(value.product) ? /^[0-9a-f]{24}$/ : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (value.accountKind !== expected[0] || value.relationship !== expected[1] || !sourcePattern.test(value.sourceAccountId)
    || (value.product !== "breathe" && !sourcePattern.test(value.sourceUserId))
    || (value.product === "intel" && value.sourceUserId !== value.sourceAccountId)) ctx.addIssue({code:"custom",message:"Invalid native account relationship"});
});
export type SupportIdentity = z.infer<typeof supportIdentity>;
export const onboardingRequest = z.discriminatedUnion("operation", [
  z.object({operation:z.literal("preview"), product:onboardingProduct, sourceUserId:nativeId, sourceAccountId:nativeId,
    hubUserId:uuid, tenantName:z.string().trim().min(2).max(180)}).strict(),
  z.object({operation:z.literal("apply"), intentId:uuid, proofDigest:digest, requestId:uuid, reviewed:z.literal(true)}).strict(),
]);
export const onboardingPreview = z.object({intentId:uuid, proofDigest:digest, expiresAt:z.iso.datetime({offset:true}),
  identity:supportIdentity, hubUserId:uuid, hubDisplayName:z.string().min(1).max(120), hubTenantId:uuid,
  tenantName:z.string().min(2).max(180), access:z.literal("customer"), caseScope:z.literal("own"), intakeEnabled:z.literal(false)}).strict();
export type OnboardingPreview = z.infer<typeof onboardingPreview>;
export const onboardingResult = z.object({intentId:uuid, hubTenantId:uuid, hubUserId:uuid, product:onboardingProduct, replayed:z.boolean(),
  access:z.literal("customer"), caseScope:z.literal("own"), intakeEnabled:z.literal(false)}).strict();
export function projectSupportIdentity(input:unknown, product:z.infer<typeof onboardingProduct>, operation:z.infer<typeof supportIdentityOperation>) {
  const envelope=z.object({contractVersion:z.literal(1),product:onboardingProduct,operation:z.literal("support.identity.resolve"),generatedAt:z.iso.datetime({offset:true}),data:supportIdentity}).strict().parse(input);
  if (envelope.product!==product || envelope.data.product!==product || envelope.data.sourceUserId!==operation.sourceUserId || envelope.data.sourceAccountId!==operation.sourceAccountId) throw new Error("Mismatched support identity");
  return envelope.data;
}
