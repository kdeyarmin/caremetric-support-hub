import type { GovernedCourse } from "../imports/governedLearningImport";
import { creditHoursSchema, creditPolicyChangesSchema, type CreditDefinition, type CreditEntry, type CreditPolicyChanges } from "./creditPolicyProtocol";

export type SourceCredit = GovernedCourse["credits"][number];
export interface CreditPolicyForm { versionLabel: string; creditedDurationRationale: string; credits: CreditEntry[] }
const key = (id: string) => id.toLowerCase();

/** Pad a decimal string without rounding or passing through a floating point number. */
export function canonicalCreditHours(value: string): string {
  const match = /^(0|[1-9][0-9]{0,3})(?:\.([0-9]{1,2}))?$/.exec(value);
  if (!match) throw new Error("Enter credit hours from 0.01 to 9999.99, with at most two decimal places.");
  return creditHoursSchema.parse(`${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`);
}
export function initialCreditPolicy(material: GovernedCourse): CreditPolicyForm {
  return { versionLabel: material.version.label ?? "", creditedDurationRationale: material.version.creditedDurationRationale ?? "",
    credits: material.credits.map(row => ({ creditId: row.id, preserve: true })) };
}
export function editableCredit(row: SourceCredit): CreditDefinition {
  return { creditId: row.id, trainingTypeId: row.trainingTypeId, topicCode: row.topicCode, creditHours: canonicalCreditHours(row.creditHours),
    creditMode: row.mode, citationNote: row.citationNote, isActive: row.active };
}
function unchanged(row: SourceCredit, entry: CreditDefinition) {
  return key(row.id) === key(entry.creditId) && key(row.trainingTypeId) === key(entry.trainingTypeId) && row.topicCode === entry.topicCode &&
    canonicalCreditHours(row.creditHours) === entry.creditHours && row.mode === entry.creditMode && row.citationNote === entry.citationNote && row.active === entry.isActive;
}
export function creditPolicyChanges(material: GovernedCourse, form: CreditPolicyForm): CreditPolicyChanges | null {
  const prior = new Map(material.credits.map(row => [key(row.id), row]));
  const policy: CreditPolicyChanges["policy"] = {};
  if (form.versionLabel !== (material.version.label ?? "")) policy.versionLabel = form.versionLabel.trim() || null;
  if (form.creditedDurationRationale !== (material.version.creditedDurationRationale ?? "")) policy.creditedDurationRationale = form.creditedDurationRationale || null;
  const credits: CreditEntry[] = form.credits.map(entry => {
    const source = prior.get(key(entry.creditId));
    if ("preserve" in entry) {
      if (!source) throw new Error("Only an existing credit rule can be preserved.");
      return entry;
    }
    const next = { ...entry, creditHours: canonicalCreditHours(entry.creditHours) };
    if (source && key(source.trainingTypeId) !== key(next.trainingTypeId)) throw new Error("Remove the old rule and add a new rule to change its training type.");
    return source && unchanged(source, next) ? { creditId: source.id, preserve: true } : next;
  });
  const retained = new Set(credits.map(row => key(row.creditId)));
  const removedCreditIds = material.credits.filter(row => !retained.has(key(row.id))).map(row => row.id);
  const trainingTypes = credits.map(row => "preserve" in row ? key(prior.get(key(row.creditId))!.trainingTypeId) : key(row.trainingTypeId));
  if (new Set(trainingTypes).size !== trainingTypes.length) throw new Error("Keep only one credit rule per training type.");
  const result = creditPolicyChangesSchema.parse({ policy, credits, removedCreditIds });
  if (!Object.keys(policy).length && !removedCreditIds.length && credits.every(row => "preserve" in row)) return null;
  return result;
}
