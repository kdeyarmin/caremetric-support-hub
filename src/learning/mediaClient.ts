import { AdminApiError } from "../admin/transport";
import { parseHubMediaOperation, projectMediaContextView, projectMediaIntent, projectMediaReceipt, projectMediaStage,
  type HubMediaOperation, type MediaContextView, type MediaIntent, type MediaReceipt, type MediaStage } from "./mediaProtocol";
async function responseJson(response: Response) {
  if (!response.ok) throw new AdminApiError(({ 400: "invalid_request", 401: "401", 403: "403", 404: "notfound", 409: "conflict", 413: "payload_too_large" } as Record<number,string>)[response.status] ?? "upstream");
  const reader = response.body?.getReader(); if (!reader) throw new AdminApiError("upstream");
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > 262144) { await reader.cancel(); throw new AdminApiError("upstream"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
export async function runMedia(input: HubMediaOperation, signal: AbortSignal): Promise<MediaContextView | MediaIntent | MediaReceipt | null> {
  const op = parseHubMediaOperation(input);
  if (op.operation === "media.upload" || op.operation === "media.read") throw new AdminApiError("invalid_request");
  const response = await fetch("/api/course-media", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(op), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  const value = await responseJson(response);
  if (op.operation === "media.context") return projectMediaContextView(value, op);
  const result = op.operation === "media.status" ? value === null ? null : projectMediaIntent(value) : projectMediaReceipt(value);
  if (result && (result.versionId !== op.versionId || result.blockId !== op.blockId || result.operationId !== op.operationId)) throw new AdminApiError("upstream");
  return result;
}
export async function uploadMedia(input: HubMediaOperation, file: File, signal: AbortSignal): Promise<MediaStage> {
  const op = parseHubMediaOperation(input);
  if (op.operation !== "media.upload" || file.size !== op.sourceBytes || file.type !== op.mimeType) throw new AdminApiError("invalid_request");
  const encoded = btoa(Array.from(new TextEncoder().encode(JSON.stringify(op)), byte => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const response = await fetch("/api/course-media/upload", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "Content-Type": op.mimeType, "x-caremetric-media-request": encoded }, body: file,
    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
  return projectMediaStage(await responseJson(response), op);
}
export function courseMediaPath(courseId: string, versionId: string, blockId: string, assetId: string): string {
  parseHubMediaOperation({ operation: "media.read", courseId, versionId, blockId, assetId, range: null });
  return `/api/course-media/${courseId}/${versionId}/${blockId}/${assetId}`;
}
