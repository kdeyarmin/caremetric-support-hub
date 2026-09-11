import { z } from "zod";
import { receiptUuid as id } from "./receiptProtocol.ts";
import { containsGovernedCredentials } from "../imports/governedLearningImport.ts";

const prose = (min: number) => z.string().max(12_000).refine(value => value.trim().length >= min &&
  !/\p{Cc}/u.test(value.replaceAll("\n", "").replaceAll("\r", "").replaceAll("\t", "")));
export const creditHoursSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,3})\.[0-9]{2}$/).refine(value => value !== "0.00");
export const creditDefinitionSchema = z.strictObject({
  creditId: id, trainingTypeId: id, topicCode: z.string().min(1).max(128).regex(/^[A-Z0-9][A-Z0-9._-]*$/),
  creditHours: creditHoursSchema, creditMode: z.enum(["automatic", "verified_only"]), citationNote: prose(1), isActive: z.boolean(),
});
export const creditEntrySchema = z.union([z.strictObject({ creditId: id, preserve: z.literal(true) }), creditDefinitionSchema]);
export const creditPolicyChangesSchema = z.strictObject({
  policy: z.strictObject({
    versionLabel: z.string().min(1).max(300).refine(value => value === value.trim() && !/\p{Cc}/u.test(value)).nullable().optional(),
    creditedDurationRationale: prose(40).nullable().optional(),
  }),
  credits: z.array(creditEntrySchema).max(100), removedCreditIds: z.array(id).max(100),
}).refine(value => {
  const retained = value.credits.map(row => row.creditId.toLowerCase()), removed = value.removedCreditIds.map(row => row.toLowerCase());
  const trainingTypes = value.credits.flatMap(row => "preserve" in row ? [] : [row.trainingTypeId.toLowerCase()]);
  return new Set(retained).size === retained.length && new Set(removed).size === removed.length &&
    new Set(trainingTypes).size === trainingTypes.length && !removed.some(row => retained.includes(row));
});
export const creditPolicyParametersSchema = creditPolicyChangesSchema.safeExtend({ versionId: id, sourceRevision: z.string().regex(/^[0-9a-f]{64}$/) })
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 24_576 && !containsGovernedCredentials(JSON.stringify(value)));
export type CreditDefinition = z.infer<typeof creditDefinitionSchema>;
export type CreditEntry = z.infer<typeof creditEntrySchema>;
export type CreditPolicyChanges = z.infer<typeof creditPolicyChangesSchema>;
