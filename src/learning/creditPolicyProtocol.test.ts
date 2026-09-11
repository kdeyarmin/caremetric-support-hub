import { expect, it } from "vitest";
import fixture from "../imports/fixtures/governedCourse.json";
import { validateGovernedCourse } from "../imports/governedLearningImport";
import { creditPolicyParametersSchema } from "./creditPolicyProtocol";
import { canonicalCreditHours, creditPolicyChanges, editableCredit, initialCreditPolicy } from "./creditPolicyModel";
import { authoringOperationSchema, projectAuthoringResult, verifyAuthoringOutcome } from "./authoringProtocol";

const material = validateGovernedCourse(fixture), sha = "a".repeat(64);
const parameters = () => ({ versionId: material.sourceVersionId, sourceRevision: sha, policy: {}, credits: material.credits.map(editableCredit), removedCreditIds: [] });
it("preserves legacy citations and inactive associations losslessly while changing one policy field", () => {
  const legacy = structuredClone(material); legacy.credits[1]!.citationNote = "Legacy line\n".repeat(2000);
  const form = initialCreditPolicy(legacy); form.versionLabel = "Reviewed label";
  const changes = creditPolicyChanges(legacy, form)!;
  expect(changes).toEqual({ policy: { versionLabel: "Reviewed label" }, credits: legacy.credits.map(row => ({ creditId: row.id, preserve: true })), removedCreditIds: [] });
  expect(creditPolicyParametersSchema.safeParse({ ...changes, versionId: legacy.sourceVersionId, sourceRevision: sha }).success).toBe(true);
  expect(JSON.stringify(changes)).not.toContain("Legacy line");
  expect(creditPolicyChanges(legacy, initialCreditPolicy(legacy))).toBeNull();
});
it("makes removals explicit and forbids reassociating an existing credit identity", () => {
  const form = initialCreditPolicy(material); form.credits = [editableCredit(material.credits[0]!)];
  const changes = creditPolicyChanges(material, form)!;
  expect(changes.removedCreditIds).toEqual([material.credits[1]!.id]);
  expect(changes.credits).toEqual([{ creditId: material.credits[0]!.id, preserve: true }]);
  form.credits = [{ ...editableCredit(material.credits[0]!), trainingTypeId: material.credits[1]!.trainingTypeId }];
  expect(() => creditPolicyChanges(material, form)).toThrow(/Remove the old rule/);
  form.credits = [{ creditId: crypto.randomUUID(), preserve: true }];
  expect(() => creditPolicyChanges(material, form)).toThrow(/existing credit/);
});
it("pads exact credit decimals without rounding, exponent or floating point conversion", () => {
  expect(canonicalCreditHours("0.1")).toBe("0.10"); expect(canonicalCreditHours("9999.99")).toBe("9999.99");
  expect(canonicalCreditHours("4")).toBe("4.00");
  for (const value of ["0", "0.00", "10000", "01.00", "1e2", "1.001", "NaN", "-1.00", " 1.00"])
    expect(() => canonicalCreditHours(value)).toThrow();
  const form = initialCreditPolicy(material); form.credits[0] = { ...editableCredit(material.credits[0]!), creditHours: "0.1" };
  expect(creditPolicyChanges(material, form)?.credits[0]).toMatchObject({ creditHours: "0.10" });
});
it("closes policy, credit and removal fields, Unicode controls and UTF8 payload bounds", () => {
  const valid = parameters(); expect(creditPolicyParametersSchema.safeParse(valid).success).toBe(true);
  for (const patch of [
    { policy: { contentStandard: "legacy" } }, { policy: { providerId: crypto.randomUUID() } },
    { policy: { versionLabel: " trimmed " } }, { policy: { creditedDurationRationale: "too short" } },
    { policy: { creditedDurationRationale: "a".repeat(40) + "\u0000" } },
    { credits: [{ creditId: material.credits[0]!.id, preserve: true, creditHours: "1.00" }] },
    { credits: [valid.credits[0], valid.credits[0]] }, { removedCreditIds: [material.credits[0]!.id] },
    { removedCreditIds: [crypto.randomUUID(), "invalid"] },
    { credits: [{ ...valid.credits[0], topicCode: "not-upper" }] },
    { credits: [{ ...valid.credits[0], creditHours: 1 }] }, { credits: [{ ...valid.credits[0], creditHours: "1.0" }] },
    { credits: [{ ...valid.credits[0], citationNote: " \n " }] }, { credits: [{ ...valid.credits[0], isActive: "true" }] },
    { credits: [{ ...valid.credits[0], citationNote: "😀".repeat(6000) }, { ...valid.credits[1], citationNote: "😀".repeat(6000) }] },
    { policy: { creditedDurationRationale: "Private playback credential https://private.invalid?token=do-not-export" } },
  ]) expect(creditPolicyParametersSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
});
it("binds credit policy preview to the exact draft identity and requires the resulting digest", async () => {
  const op = { operation: "preview" as const, action: "learning.editCreditPolicy" as const, requestId: crypto.randomUUID(), courseId: material.sourceCourseId,
    parameters: parameters(), reason: "Review training policy with exact credit rules" };
  expect(authoringOperationSchema.parse(op)).toEqual(op);
  const before = { courseId: op.courseId, versionId: material.sourceVersionId, sourceRevision: sha, currentVersionId: null, status: "draft" as const, title: material.version.title, versionNumber: 3 };
  const { sourceRevision: _sha, ...after } = before; expect(_sha).toBe(sha);
  const preview = { commandId: crypto.randomUUID(), courseId: op.courseId, action: op.action, reason: op.reason, previewDigest: sha,
    expiresAt: new Date(Date.now() + 240000).toISOString(), before, after: { ...after, aiReviewRequired: false } };
  expect(await projectAuthoringResult(preview, op)).toEqual(preview);
  for (const patch of [{ versionId: crypto.randomUUID() }, { title: "Unreviewed" }, { sourceRevision: sha }, { status: "published" }, { versionNumber: 4 }])
    await expect(projectAuthoringResult({ ...preview, after: { ...preview.after, ...patch } }, op)).rejects.toThrow();
  const result = { commandId: preview.commandId, courseId: op.courseId, action: op.action, versionId: before.versionId, versionNumber: 3,
    status: "draft", appliedAt: new Date().toISOString(), replayed: false, sourceRevision: "b".repeat(64) };
  expect(verifyAuthoringOutcome(result, preview)).toEqual(result);
  const { sourceRevision: _new, ...missing } = result; expect(_new).toBe("b".repeat(64));
  expect(() => verifyAuthoringOutcome(missing, preview)).toThrow();
});
