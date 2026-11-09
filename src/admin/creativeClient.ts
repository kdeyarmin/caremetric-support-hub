import { z } from "zod";
import { config } from "../lib/config";
import { sessionEvent } from "../lib/appSession";
import { brandKitSchema, briefSchema, studioSchema } from "./creativeProtocol";
import type { BrandKit, CreativeBrief, CreativePlatform, CreativeProduct, CreativeStatus, CreativeStudio } from "./creativeProtocol";
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
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "The request could not be completed.";
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
}

export const creativeClient: CreativeClient = {
  studio: (filter, { signal }) => post("studio", Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== null)), studioSchema, signal),
  setBrandKit: input => post("brandKit", input, brandKitSchema),
  addBrandFile: input => post("brandFile", input, brandKitSchema),
  removeBrandFile: input => post("removeBrandFile", input, brandKitSchema),
  createBrief: ({ offerCode, ...input }) => post("brief", offerCode ? { ...input, offerCode } : input, briefSchema),
  decide: input => teamClient.decide(input),
};

/** A file the owner picked, as base64 for the JSON body. */
export async function fileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
