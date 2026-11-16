import { z } from "zod";
import { config } from "../lib/config";
import { sessionEvent, responseErrorMessage } from "../lib/appSession";
import { brandKitSchema, briefSchema, studioSchema, uploadResultSchema } from "./creativeProtocol";
import type { BrandKit, CreativeBrief, CreativePlatform, CreativeProduct, CreativeStatus, CreativeStudio, UploadResult } from "./creativeProtocol";
import { TeamApiError, teamClient } from "./teamClient";
import type { Decision } from "./teamProtocol";

async function post<S extends z.ZodType>(path: string, body: unknown, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
  if (config.demoMode) throw new TeamApiError(503, "The Creative Director is not available in the preview.");
  const response = await fetch(`/api/admin/creative/${path}`, {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(sessionEvent));
    const message = responseErrorMessage(data) ?? "The request could not be completed.";
    throw new TeamApiError(response.status, message);
  }
  return schema.parse(data);
}

export interface StudioFilter { product: CreativeProduct | null; platform: CreativePlatform | null; status: CreativeStatus | null; offset: number; limit: number }
export interface NewBrief {
  product: CreativeProduct; goal: string; audience: string; platforms: CreativePlatform[]; formats: Array<"static" | "video">;
  videoLengths: Array<"6s" | "15s" | "30s" | "45-60s">; angle: string; offerCode: string | null; requestKey: string;
}
export type BrandKitPatch = Partial<Pick<BrandKit, "primaryColor" | "secondaryColor" | "accentColor" | "textColor" | "backgroundColor" | "headingFont" | "bodyFont" | "videoAvatarId" | "videoVoiceId">> & {
  voiceNotes?: string; requiredDisclaimers?: string[]; bannedPhrases?: string[]; captionsDefault?: boolean;
};

export interface CreativeClient {
  studio(filter: StudioFilter, options: { signal: AbortSignal }): Promise<CreativeStudio>;
  setBrandKit(input: { product: CreativeProduct; kit: Record<string, unknown>; expectedVersion: number }): Promise<BrandKit>;
  addBrandFile(input: { product: CreativeProduct; kind: "logo" | "screenshot"; data: string; label?: string; attested: boolean }): Promise<BrandKit>;
  removeBrandFile(input: { id: string }): Promise<BrandKit>;
  createBrief(input: NewBrief): Promise<CreativeBrief>;
  /** Approve, reject or ask for changes (a rejection with a note), through the AI team's own decide route. */
  decide(input: { actionId: string; decision: "approve" | "reject"; note?: string }): Promise<Decision>;
  /** The owner's own finished video, sent as the raw MP4; it becomes approved creative for each chosen placement. */
  uploadVideo(input: { product: CreativeProduct; placements: string[]; label: string; attested: boolean; requestKey: string; file: File }): Promise<UploadResult>;
  /** A picked video's size and length, as the browser reads them (the server reads them again from the file). */
  videoInfo(file: File): Promise<{ width: number; height: number; durationSeconds: number }>;
}

export const creativeClient: CreativeClient = {
  studio: (filter, { signal }) => post("studio", Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== null)), studioSchema, signal),
  setBrandKit: input => post("brandKit", input, brandKitSchema),
  addBrandFile: input => post("brandFile", input, brandKitSchema),
  removeBrandFile: input => post("removeBrandFile", input, brandKitSchema),
  createBrief: ({ offerCode, ...input }) => post("brief", offerCode ? { ...input, offerCode } : input, briefSchema),
  decide: input => teamClient.decide(input),
  uploadVideo: async ({ product, placements, label, attested, requestKey, file }) => {
    if (config.demoMode) throw new TeamApiError(503, "The Creative Director is not available in the preview.");
    const response = await fetch("/api/admin/creative/video", {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "video/mp4", "X-Creative-Product": product, "X-Creative-Placements": placements.join(","), "X-Creative-Label": encodeURIComponent(label),
        "X-Creative-Attested": attested ? "true" : "false", "X-Creative-Request": requestKey },
      body: file, signal: AbortSignal.timeout(600000),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event(sessionEvent));
      const message = responseErrorMessage(data) ?? "The video could not be added.";
      throw new TeamApiError(response.status, message);
    }
    return uploadResultSchema.parse(data);
  },
  videoInfo: file => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const done = () => { URL.revokeObjectURL(url); video.removeAttribute("src"); };
    video.preload = "metadata";
    video.onloadedmetadata = () => { const info = { width: video.videoWidth, height: video.videoHeight, durationSeconds: Math.round(video.duration * 100) / 100 }; done(); resolve(info); };
    video.onerror = () => { done(); reject(new TeamApiError(400, "This file could not be read as a video.")); };
    video.src = url;
  }),
};

/** A file the owner picked, as base64 for the JSON body. */
export async function fileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
