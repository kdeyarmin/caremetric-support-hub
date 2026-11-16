import {
  parsePublicationStage, publicationCommitSchema, publicationId, publicationPart, publicationPartRules,
  publicationReceiptSchema, type PublicationCommitRequest, type PublicationPart, type PublicationReceipt, type PublicationStage,
} from "./publicationProtocol.ts";
import { validatePublicationManifest, type PublicationManifest } from "./publicationImportPreview.ts";
import { sendInParts } from "../lib/uploadParts.ts";

export class PublicationError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export interface PublicationClient {
  access(signal?: AbortSignal): Promise<{ maxVideoBytes: number }>;
  stage(manifest: PublicationManifest, signal?: AbortSignal): Promise<PublicationStage>;
  /** Sends the file in parts; onProgress gets the bytes the Hub has received after each part. */
  upload(stage: PublicationStage, part: PublicationPart, file: File, signal?: AbortSignal, onProgress?: (received: number, total: number) => void): Promise<PublicationStage>;
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
  function answer(response: Response) {
    if (!response.ok) throw new PublicationError(response.status, messages[response.status] ?? "The publication service is temporarily unavailable. If you submitted a commit, retry the same publication to retrieve its result.");
    return response.json() as Promise<unknown>;
  }
  async function call(path: string, options: RequestInit) {
    return answer(await fetcher(`/api/publications/${path}`, { ...options, credentials: "same-origin", redirect: "error", cache: "no-store" }));
  }
  const post = (path: string, body: unknown, signal?: AbortSignal) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  return {
    async access(signal) {
      let result: unknown;
      try { result = await call("access", { method: "GET", signal }); }
      catch (cause) {
        if (cause instanceof PublicationError && [401, 403].includes(cause.status)) throw cause;
        throw new PublicationError(503, "Publication import is not available in this environment. Its backend must be connected first.");
      }
      if (!result || typeof result !== "object" || Object.keys(result).sort().join(",") !== "canImport,maxVideoBytes" || !("canImport" in result) || result.canImport !== true
        || !("maxVideoBytes" in result) || typeof result.maxVideoBytes !== "number" || !Number.isSafeInteger(result.maxVideoBytes) || result.maxVideoBytes < 1048576 || result.maxVideoBytes > 536870912) throw new Error("Invalid publication access response.");
      return { maxVideoBytes: result.maxVideoBytes };
    },
    async stage(manifest, signal) { return parsePublicationStage(await post("imports/stage", { manifest: validatePublicationManifest(manifest), sourceReviewConfirmed: true }, signal)); },
    async upload(stage, part, file, signal, onProgress) {
      publicationId.parse(stage.id); publicationPart.parse(part);
      const rule = publicationPartRules(stage.manifest, part);
      if (!file.size || file.size > rule.maxBytes || (rule.byteLength !== null && file.size !== rule.byteLength)) throw new PublicationError(422, "The selected file size does not match the manifest or upload limit.");
      let response: Response;
      try { response = await sendInParts(fetcher, `/api/publications/imports/${stage.id}/assets/${part}`, file, { "Content-Type": rule.contentType }, { signal, onProgress }); }
      catch (cause) {
        if (signal?.aborted) throw cause;
        throw new PublicationError(503, "The upload lost its connection to the Hub. Retry the same file; the Hub keeps what it received for ten minutes.");
      }
      return parsePublicationStage(await answer(response));
    },
    async preview(id, signal) { return parsePublicationStage(await post(`imports/${publicationId.parse(id)}/preview`, {}, signal)); },
    async commit(id, request, signal) { return publicationReceiptSchema.parse(await post(`imports/${publicationId.parse(id)}/commit`, publicationCommitSchema.parse(request), signal)); },
  };
}
export const publicationClient = createPublicationClient();
