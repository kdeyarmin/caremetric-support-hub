import {
  parsePublicationStage, publicationCommitSchema, publicationId, publicationPart, publicationPartRules,
  publicationReceiptSchema, type PublicationCommitRequest, type PublicationPart, type PublicationReceipt, type PublicationStage,
} from "./publicationProtocol.ts";
import { validatePublicationManifest, type PublicationManifest } from "./publicationImportPreview.ts";

export class PublicationError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export interface PublicationClient {
  access(signal?: AbortSignal): Promise<{ maxVideoBytes: number }>;
  stage(manifest: PublicationManifest, signal?: AbortSignal): Promise<PublicationStage>;
  upload(stage: PublicationStage, part: PublicationPart, file: File, signal?: AbortSignal): Promise<PublicationStage>;
  preview(id: string, signal?: AbortSignal): Promise<PublicationStage>;
  commit(id: string, request: PublicationCommitRequest, signal?: AbortSignal): Promise<PublicationReceipt>;
}
const messages: Record<number, string> = {
  400: "The publication package or confirmation is invalid. Review the manifest and files.",
  401: "Sign in with an SMS code before importing publications.",
  403: "Your current account cannot publish to every affected product.",
  404: "This import is unavailable or has expired. Start a new review.",
  409: "The catalog, upload, or request key changed. Start a fresh review before publishing.",
  413: "This publication exceeds the displayed upload limits.",
  415: "The file type does not match the publication manifest.",
  422: "The asset bytes, hash, or content checks failed. Export a corrected package from DocStudio.",
  429: "Another import is in progress. Try again when it finishes.",
};
export function createPublicationClient(fetcher: typeof fetch = fetch): PublicationClient {
  async function call(path: string, options: RequestInit) {
    const response = await fetcher(`/api/publications/${path}`, { ...options, credentials: "same-origin", redirect: "error", cache: "no-store" });
    if (!response.ok) throw new PublicationError(response.status, messages[response.status] ?? "Publication storage is temporarily unavailable. The catalog has not been changed.");
    return response.json() as Promise<unknown>;
  }
  const post = (path: string, body: unknown, signal?: AbortSignal) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  return {
    async access(signal) {
      const result = await call("access", { method: "GET", signal });
      if (!result || typeof result !== "object" || Object.keys(result).sort().join(",") !== "canImport,maxVideoBytes" || !("canImport" in result) || result.canImport !== true
        || !("maxVideoBytes" in result) || typeof result.maxVideoBytes !== "number" || !Number.isSafeInteger(result.maxVideoBytes) || result.maxVideoBytes < 1048576 || result.maxVideoBytes > 536870912) throw new Error("Invalid publication access response.");
      return { maxVideoBytes: result.maxVideoBytes };
    },
    async stage(manifest, signal) { return parsePublicationStage(await post("imports/stage", { manifest: validatePublicationManifest(manifest), sourceReviewConfirmed: true }, signal)); },
    async upload(stage, part, file, signal) {
      publicationId.parse(stage.id); publicationPart.parse(part);
      const rule = publicationPartRules(stage.manifest, part);
      if (!file.size || file.size > rule.maxBytes || (rule.byteLength !== null && file.size !== rule.byteLength)) throw new PublicationError(422, "The selected file size does not match the manifest or upload limit.");
      return parsePublicationStage(await call(`imports/${stage.id}/assets/${part}`, { method: "POST", headers: { "Content-Type": rule.contentType }, body: file, signal }));
    },
    async preview(id, signal) { return parsePublicationStage(await post(`imports/${publicationId.parse(id)}/preview`, {}, signal)); },
    async commit(id, request, signal) { return publicationReceiptSchema.parse(await post(`imports/${publicationId.parse(id)}/commit`, publicationCommitSchema.parse(request), signal)); },
  };
}
export const publicationClient = createPublicationClient();
