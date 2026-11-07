import { appRequest } from "../lib/appSession";
import { MEDIA_IMPORT_FAILURES, mediaImportListSchema, mediaImportResultSchema, type MediaImportResult, type MediaImportRow } from "./mediaImportProtocol";

const fallback: Record<string, string> = {
  unauthenticated: "Sign in with an SMS code to continue.",
  forbidden: "Bulk media import requires shared-course editor access.",
  conflict: "This video changed or is already transferring. Refresh the list, then retry.",
  notfound: "This video is no longer staged. Refresh the list.",
  invalid_request: "The request was not accepted. Check the manifest row.",
  payload_too_large: "The captions or transcript are too large.",
  unavailable: "Bulk media import is not available yet.",
  ...MEDIA_IMPORT_FAILURES,
};

async function post(body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch("/api/admin/learning-media-import", {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  const data = await response.json().catch(() => null) as { error?: string | { code?: string; message?: string } } | null;
  if (!response.ok) {
    const error = data?.error;
    if (typeof error === "string") throw new Error(error);
    throw new Error(error?.message || (error?.code && fallback[error.code]) || "The media import request did not complete.");
  }
  return data;
}

export const mediaImportClient = {
  list: async () => mediaImportListSchema.parse(await post({ operation: "list" })).items,
  stage: async (input: { manifestSha256: string; row: MediaImportRow; captions: string; transcript: string }, signal?: AbortSignal): Promise<MediaImportResult> =>
    mediaImportResultSchema.parse(await post({ operation: "stage", ...input }, signal)),
  register: async (mediaId: string) => mediaImportResultSchema.parse(await post({ operation: "register", mediaId, reviewed: true })),
  attach: async (mediaId: string) => mediaImportResultSchema.parse(await post({ operation: "attach", mediaId })),
  /** Ten-minute signed playback for review, plus the stored transcript text. */
  async review(mediaId: string) {
    const [video, captions] = await Promise.all(["video.mp4", "captions.vtt"].map(name =>
      appRequest<{ signedUrl: string }>("media/sign", { path: `learning/${mediaId}/${name}` })));
    const transcript = await fetch(`/api/media/learning/${mediaId}/transcript.txt`, { credentials: "same-origin", cache: "no-store", redirect: "error" });
    if (!transcript.ok) throw new Error("The stored transcript could not be read. Refresh and try again.");
    return { video: video.signedUrl, captions: captions.signedUrl, transcript: await transcript.text() };
  },
};
