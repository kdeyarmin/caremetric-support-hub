import type { MediaContextView, MediaIntent, MediaReceipt, HubMediaOperation } from "../mediaProtocol";
export const mediaCourse = "d1900000-0000-4000-8000-000000000001";
export const mediaVersion = "d1900000-0000-4000-8000-000000000002";
export const mediaBlock = "d1900000-0000-4000-8000-000000000003";
export const mediaAssetId = "d1900000-0000-4000-8000-000000000004";
export const mediaOperationId = "d1900000-0000-4000-8000-000000000005";
export const mediaRevision = "a".repeat(64);
export const mediaHash = "b".repeat(64);
export const mediaBase = { courseId: mediaCourse, versionId: mediaVersion, blockId: mediaBlock };
export function mediaFixture() {
  const receipt: MediaReceipt = { operationId: mediaOperationId, assetId: mediaAssetId, versionId: mediaVersion, blockId: mediaBlock,
    sourceRevision: "c".repeat(64), contentSha256: mediaHash, mimeType: "application/pdf", byteSize: 8, fileName: "lesson.pdf", attachedAt: new Date().toISOString() };
  const intent: MediaIntent = { ...receipt, sourceRevision: mediaRevision, requestId: "d1900000-0000-4000-8000-000000000006",
    reason: "Reviewed synthetic lesson", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    state: "staged", canFinishThisSession: true, result: null } as MediaIntent;
  delete (intent as MediaIntent & { attachedAt?: string }).attachedAt;
  const context: MediaContextView = { courseId: mediaCourse, versionId: mediaVersion, sourceRevision: mediaRevision,
    block: { id: mediaBlock, type: "pdf", title: "Synthetic lesson", mediaAsset: null, legacyDocumentId: null, legacyVideoSha256: null, generationState: "none" },
    intents: { items: [intent], hasMore: false }, headRevision: mediaRevision, sourcePreserved: true };
  const upload: HubMediaOperation = { ...mediaBase, operation: "media.upload", requestId: intent.requestId, sourceRevision: mediaRevision,
    reason: intent.reason, mimeType: receipt.mimeType, sourceSha256: mediaHash, sourceBytes: receipt.byteSize, fileName: receipt.fileName };
  return { context, intent, receipt, upload };
}
