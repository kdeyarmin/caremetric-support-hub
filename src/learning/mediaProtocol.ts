import { z } from "zod";
import { mediaExact, mediaSha, mediaUuid, parseMediaOperation, projectMediaContext, projectMediaIntent, projectMediaReceipt, projectMediaStage,
  type MediaContext, type MediaIntent, type MediaOperation, type MediaReceipt } from "../../supabase/functions/_shared/courseMediaProtocol.ts";
export * from "../../supabase/functions/_shared/courseMediaProtocol.ts";

export type HubMediaOperation = MediaOperation & { courseId: string; versionId: string; blockId: string };
export type MediaContextView = MediaContext & { headRevision: string | null; sourcePreserved: boolean };
export type MediaStage = { state: "staged"; operationId: string; assetId: string; versionId: string; blockId: string;
  contentSha256: string; mimeType: MediaReceipt["mimeType"]; byteSize: number; fileName: string } | { state: "committed"; result: MediaReceipt };
const invalid = (): never => { throw new Error("Invalid course media contract."); };
export function parseHubMediaOperation(value: unknown): HubMediaOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  if (!mediaUuid(input.courseId) || !mediaUuid(input.versionId) || !mediaUuid(input.blockId)) return invalid();
  const native = { ...input }; delete native.courseId;
  if (native.operation === "media.status" || native.operation === "media.finish") { delete native.versionId; delete native.blockId; }
  parseMediaOperation(native);
  return value as HubMediaOperation;
}
export function nativeMediaOperation(input: HubMediaOperation): MediaOperation {
  const value: Record<string, unknown> = { ...parseHubMediaOperation(input) }; delete value.courseId;
  if (value.operation === "media.status" || value.operation === "media.finish") { delete value.versionId; delete value.blockId; }
  return parseMediaOperation(value);
}
export const nativeMediaOperationSchema = z.custom<MediaOperation>(value => { try { parseMediaOperation(value); return true; } catch { return false; } });
export function projectMediaContextView(value: unknown, operation: HubMediaOperation): MediaContextView {
  if (!mediaExact(value, ["courseId", "versionId", "sourceRevision", "block", "intents", "headRevision", "sourcePreserved"])) return invalid();
  const { headRevision, sourcePreserved, ...raw } = value;
  const context = projectMediaContext(raw, operation);
  if (context.courseId !== operation.courseId || !(headRevision === null || mediaSha(headRevision))
    || sourcePreserved !== (headRevision === context.sourceRevision)) return invalid();
  return { ...context, headRevision, sourcePreserved } as MediaContextView;
}
export function projectMediaEnvelope(value: unknown, op: MediaOperation, now = Date.now()): MediaContext | MediaIntent | MediaReceipt | MediaStage | null {
  if (!mediaExact(value, ["contractVersion", "product", "operation", "generatedAt", "data"]) || value.contractVersion !== 1 || value.product !== "carebase"
    || value.operation !== op.operation || typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))
    || Math.abs(now - Date.parse(value.generatedAt)) > 300_000) return invalid();
  if (op.operation === "media.context") return projectMediaContext(value.data, op);
  if (op.operation === "media.status") {
    const result = value.data === null ? null : projectMediaIntent(value.data);
    if (result && result.operationId !== op.operationId) return invalid(); return result;
  }
  if (op.operation === "media.finish") {
    const result = projectMediaReceipt(value.data); if (result.operationId !== op.operationId) return invalid(); return result;
  }
  if (op.operation === "media.upload") return projectMediaStage(value.data, op);
  return invalid();
}
