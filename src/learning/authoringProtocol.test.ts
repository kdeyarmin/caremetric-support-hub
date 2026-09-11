import { expect, it } from "vitest";
import fixture from "../imports/fixtures/governedCourse.json";
import { sourceDigest } from "../imports/governedLearningImport";
import { authoringOperationSchema, draftPatchSchema, projectAuthoringResult, verifyAuthoringOutcome } from "./authoringProtocol";
const id = "aaaaaaaa-0000-0000-0000-000000000001", sha = "a".repeat(64);
const command = { operation: "preview" as const, requestId: id, action: "learning.cloneVersion" as const, courseId: fixture.sourceCourseId,
  parameters: { versionId: fixture.sourceVersionId, sourceRevision: sha, title: "New draft" }, reason: "Review source for the next revision" };
const preview = () => ({ commandId: id, courseId: fixture.sourceCourseId, action: command.action, reason: command.reason, previewDigest: sha,
  expiresAt: "2026-09-11T00:00:00Z", before: { courseId: fixture.sourceCourseId, versionId: fixture.sourceVersionId, sourceRevision: sha,
    status: "published" as const, versionNumber: 2, title: "Original", currentVersionId: fixture.sourceVersionId },
  after: { status: "draft" as const, versionNumber: 3, title: "New draft", sourceVersionId: fixture.sourceVersionId } });
it("bounds draft patches and forbids media, ownership, review flags and duplicate descendants", () => {
  expect(draftPatchSchema.parse({ version: { description: "Two lines\nreviewed" }, blocks: [{ blockId: id, content: "", estimatedMinutes: 0 }] })).toBeDefined();
  for (const patch of [{}, { version: {} }, { blocks: [] }, { blocks: [{ blockId: id }] },
    { version: { aiReviewedAt: "now" } }, { blocks: [{ blockId: id, videoUrl: "https://example.invalid" }] },
    { blocks: [{ blockId: id, content: "ok" }, { blockId: id.toUpperCase(), content: "other" }] },
    { version: { description: "😀".repeat(6500) } }, { blocks: [{ blockId: id, content: "bad\u0000value" }] },
    { blocks: [{ blockId: id, estimatedMinutes: 1.5 }] }, { blocks: [{ blockId: id, title: " leading space" }] },
    { blocks: [{ blockId: id, title: "Two\nlines" }] }]) expect(draftPatchSchema.safeParse(patch).success).toBe(false);
  expect(authoringOperationSchema.safeParse({ ...command, action: "learning.reviewDraft", parameters: { versionId: fixture.sourceVersionId, sourceRevision: sha, reviewed: false } }).success).toBe(false);
});
it.each(["learning.patchDraft", "learning.reviewDraft"] as const)("binds %s to the reviewed draft and requires the resulting source digest", async action => {
  const parameters = { versionId: fixture.sourceVersionId, sourceRevision: sha };
  const op = action === "learning.patchDraft" ? { ...command, action, parameters: { ...parameters, patch: { version: { title: "Edited" } } } }
    : { ...command, action, parameters: { ...parameters, reviewed: true as const } };
  const before = { ...preview().before, status: "draft" as const };
  const { sourceRevision: _old, ...identity } = before;
  expect(_old).toBe(sha);
  const after = { ...identity, title: action === "learning.patchDraft" ? "Edited" : before.title, aiReviewRequired: action === "learning.patchDraft" };
  const value = { ...preview(), action, before, after };
  const approved = await projectAuthoringResult(value, op);
  expect(approved).toEqual(value);
  for (const patch of [{ versionId: id }, { courseId: id }, { status: "published" }, { versionNumber: 500 }, { sourceRevision: sha }])
    await expect(projectAuthoringResult({ ...value, after: { ...after, ...patch } }, op)).rejects.toThrow();
  const result = { commandId: id, action, courseId: fixture.sourceCourseId, versionId: fixture.sourceVersionId,
    versionNumber: before.versionNumber, status: "draft", appliedAt: new Date().toISOString(), replayed: false, sourceRevision: "b".repeat(64) };
  expect(verifyAuthoringOutcome(result, value)).toEqual(result);
  const { sourceRevision: _new, ...withoutDigest } = result;
  expect(_new).toMatch(/^[0-9a-f]{64}$/);
  expect(() => verifyAuthoringOutcome(withoutDigest, value)).toThrow();
  expect(() => verifyAuthoringOutcome({ ...result, versionId: id }, value)).toThrow();
});
it("accepts only exact, bounded authoring operations", () => {
  expect(authoringOperationSchema.parse(command)).toEqual(command);
  for (const value of [{ ...command, url: "https://untrusted.invalid" }, { ...command, reason: "short" },
    { ...command, parameters: { ...command.parameters, title: " New draft " } },
    { operation: "apply", commandId: id, expectedDigest: sha, actor: id },
    { operation: "preserve_source", courseId: id, versionId: id, sourceRevision: sha, expectedHeadRevision: null, reviewed: false },
    { ...command, action: "learning.publishVersion" }]) expect(authoringOperationSchema.safeParse(value).success).toBe(false);
});
it("validates exact bytes, identity and credential exclusion before releasing source material", async () => {
  const payload = JSON.stringify(fixture), sourceRevision = await sourceDigest(payload);
  const op = { operation: "source" as const, courseId: fixture.sourceCourseId, versionId: fixture.sourceVersionId };
  const value = { courseId: op.courseId, versionId: op.versionId, sourceRevision, payload, private: "drop" };
  expect(await projectAuthoringResult(value, op)).not.toHaveProperty("private");
  for (const patch of [{ courseId: id }, { versionId: id }, { sourceRevision: sha }, { payload: payload + " " }])
    await expect(projectAuthoringResult({ ...value, ...patch }, op)).rejects.toThrow();
  const unsafe = JSON.stringify({ ...fixture, blocks: [{ ...fixture.blocks[0], body: { signed_url: "https://asset.invalid" } }] });
  await expect(projectAuthoringResult({ ...value, payload: unsafe, sourceRevision: await sourceDigest(unsafe) }, op)).rejects.toThrow("credentials");
});
it("binds preview to the requested source, title and native action", async () => {
  expect(await projectAuthoringResult({ ...preview(), private: "drop" }, command)).toEqual(preview());
  for (const patch of [{ courseId: id }, { action: "learning.publishVersion" }, { reason: "Different reason" },
    { before: { ...preview().before, sourceRevision: "b".repeat(64) } }, { after: { ...preview().after, title: "Changed title" } }])
    await expect(projectAuthoringResult({ ...preview(), ...patch }, command)).rejects.toThrow();
});
it("rejects substituted native command outcomes", () => {
  const result = { commandId: id, courseId: fixture.sourceCourseId, action: command.action, versionId: id, versionNumber: 3,
    status: "draft", appliedAt: "2026-09-11T00:00:00Z", replayed: false };
  expect(verifyAuthoringOutcome(result, preview())).toEqual(result);
  for (const patch of [{ commandId: fixture.sourceCourseId }, { courseId: id }, { versionNumber: 4 }, { status: "published" }, { action: "learning.publishVersion" }])
    expect(() => verifyAuthoringOutcome({ ...result, ...patch }, preview())).toThrow();
});
it("accepts only an unchanged publication state with the intended version becoming current", async () => {
  const op = { ...command, action: "learning.publishVersion" as const, parameters: { versionId: fixture.sourceVersionId, sourceRevision: sha } };
  const before = { ...preview().before, status: "draft" as const };
  const value = { ...preview(), action: op.action, before, after: { ...before, status: "published" as const, currentVersionId: fixture.sourceVersionId } };
  expect(await projectAuthoringResult(value, op)).toEqual(value);
  for (const after of [{ ...value.after, title: "Unreviewed title" }, { ...value.after, versionNumber: 99 },
    { ...value.after, versionId: id }, { ...value.after, currentVersionId: id }, { ...value.after, courseId: id }])
    await expect(projectAuthoringResult({ ...value, after }, op)).rejects.toThrow();
  await expect(projectAuthoringResult({ ...value, expiresAt: "September 11, 2099" }, op)).rejects.toThrow();
  await expect(projectAuthoringResult({ ...value, expiresAt: new Date(Date.now() + 600_000).toISOString() }, op)).rejects.toThrow();
});
