import { expect, it } from "vitest";
import { parseHubMediaOperation, nativeMediaOperation, projectMediaContextView, projectMediaEnvelope, projectMediaStage } from "./mediaProtocol";
import { nativeAuthoringOperationSchema } from "./authoringProtocol";
import { nativeCreationOperationSchema } from "./creationProtocol";
import { mediaBase, mediaFixture } from "./testFixtures/media";
import fixture from "../imports/fixtures/governedCourse.json";
import { validateGovernedCourse } from "../imports/governedLearningImport";
it("keeps each media capability exact and distinct from authoring and creation", () => {
  for (const operation of [{ ...mediaBase, operation: "media.context" }, { ...mediaBase, operation: "media.finish", operationId: mediaBase.blockId }]) {
    const parsed = parseHubMediaOperation(operation); const native = nativeMediaOperation(parsed);
    expect(native).not.toHaveProperty("courseId"); expect(nativeAuthoringOperationSchema.safeParse(native).success).toBe(false);
    expect(nativeCreationOperationSchema.safeParse(native).success).toBe(false);
    expect(() => parseHubMediaOperation({ ...operation, actorId: mediaBase.courseId })).toThrow();
  }
  expect(() => parseHubMediaOperation({ operation: "apply", commandId: mediaBase.courseId, expectedDigest: "a".repeat(64) })).toThrow();
});
it("binds stage and receipt responses to the exact submitted bytes and current source context", () => {
  const f = mediaFixture(); if (f.upload.operation !== "media.upload") throw Error();
  expect(projectMediaStage({ state: "committed", result: f.receipt }, f.upload)).toHaveProperty("result.assetId", f.receipt.assetId);
  expect(() => projectMediaStage({ state: "committed", result: { ...f.receipt, contentSha256: "e".repeat(64) } }, f.upload)).toThrow();
  expect(() => projectMediaContextView({ ...f.context, sourcePreserved: false }, parseHubMediaOperation({ ...mediaBase, operation: "media.context" }))).toThrow();
  expect(() => projectMediaEnvelope({ contractVersion: 1, product: "carebase", operation: "media.finish", generatedAt: new Date().toISOString(), data: f.receipt },
    { operation: "media.finish", operationId: mediaBase.blockId })).toThrow();
});
it("accepts optional immutable media without changing existing source shape and rejects contradictory references", () => {
  expect(validateGovernedCourse(fixture)).toEqual(fixture);
  const original = validateGovernedCourse(fixture); const block = original.blocks.find(row => row.type === "pdf")!;
  const { receipt } = mediaFixture(); block.documentId = null;
  block.mediaAsset = { id: receipt.assetId, contentSha256: receipt.contentSha256, mimeType: receipt.mimeType, byteSize: receipt.byteSize, fileName: receipt.fileName };
  expect(validateGovernedCourse(original)).toEqual(original);
  block.documentId = block.id; expect(() => validateGovernedCourse(original)).toThrow("media"); block.documentId = null;
  block.mediaAsset.fileName = "../lesson.pdf"; expect(() => validateGovernedCourse(original)).toThrow();
  block.mediaAsset.fileName = "lesson.pdf"; block.mediaAsset.byteSize = 26214401; expect(() => validateGovernedCourse(original)).toThrow();
  block.mediaAsset.byteSize = 8; block.mediaAsset.mimeType = "video/mp4"; expect(() => validateGovernedCourse(original)).toThrow();
});
