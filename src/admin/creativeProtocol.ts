import { z } from "zod";

/**
 * What the Creative screen reads (hub.get_creative_studio) and the words it shows. The server integration test parses the real
 * database output with these schemas, so a change to the stored JSON cannot reach one side without the other.
 */
const instant = z.string().min(1);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable();
export const creativeProducts = ["caremetric-intel", "carebase"] as const;
export const creativePlatforms = ["meta", "linkedin", "google", "youtube"] as const;
export const creativeStatuses = ["draft", "rendering", "ready", "proposed", "approved", "rejected", "expired", "live", "retired", "failed"] as const;
export const videoLengthKeys = ["6s", "15s", "30s", "45-60s"] as const;

const reason = z.object({ rule: z.string(), level: z.enum(["warn", "block"]), message: z.string() });
export const complianceSchema = z.object({ verdict: z.enum(["pass", "warn", "block"]).optional(), reasons: z.array(reason).optional(), version: z.string().optional() });
const overlaySchema = z.object({
  kicker: z.string().optional(), stat: z.string().optional(), statLabel: z.string().optional(), statSource: z.string().optional(), quote: z.string().optional(),
  quoteSource: z.string().optional(), offerLine: z.string().optional(), checklist: z.array(z.string()).optional(), screenshotId: z.string().optional(), beats: z.array(z.string()).optional(),
});

export const assetSchema = z.object({
  id: uuid, briefId: uuid, product: z.enum(creativeProducts), platform: z.enum(creativePlatforms), placement: z.string(), kind: z.enum(["static", "video"]), layout: z.string(),
  width: z.number().int(), height: z.number().int(), durationSeconds: z.number().nullable(), lengthKey: z.enum(videoLengthKeys).nullable(), variantLabel: z.string(),
  hookType: z.enum(["problem", "proof", "offer", "curiosity", "demo"]), concept: z.string(), headline: z.string(), primaryText: z.string(), description: z.string(), cta: z.string(),
  landingUrl: z.string().nullable(), altText: z.string(), captions: z.string(), overlay: overlaySchema, provider: z.enum(["internal", "heygen"]), status: z.enum(creativeStatuses),
  compliance: complianceSchema, performance: z.record(z.string(), z.unknown()), revisionNotes: z.string(), actionId: uuid.nullable(), actionStatus: z.string().nullable(),
  contentType: z.enum(["image/png", "video/mp4"]).nullable(), fileBytes: z.number().int().nullable(), renderError: z.string().nullable(), renderAttempts: z.number().int(),
  createdAt: instant, updatedAt: instant, renderedAt: instant.nullable(), approvedAt: instant.nullable(), liveAt: instant.nullable(), retiredAt: instant.nullable(),
});
export const briefSchema = z.object({
  id: uuid, product: z.enum(creativeProducts), goal: z.string(), audience: z.string(), offerCode: z.string().nullable(), platforms: z.array(z.enum(creativePlatforms)),
  formats: z.array(z.enum(["static", "video"])), videoLengths: z.array(z.enum(videoLengthKeys)), angle: z.string(),
  source: z.enum(["social.plan", "growth.plan", "sweep", "owner", "refresh", "revision"]), status: z.enum(["open", "drafting", "done", "cancelled", "skipped"]),
  planRef: z.string().nullable(), parentAssetId: uuid.nullable(), revisionNote: z.string(), result: z.record(z.string(), z.unknown()), createdAt: instant, updatedAt: instant,
  created: z.boolean().optional(),
});
export const screenshotSchema = z.object({ id: uuid, label: z.string(), contentType: z.string(), bytes: z.number().int() });
export const brandKitSchema = z.object({
  product: z.enum(creativeProducts), brandName: z.literal("CareMetric"), logoFileId: uuid.nullable(), primaryColor: color, secondaryColor: color, accentColor: color,
  textColor: color, backgroundColor: color, headingFont: z.string().nullable(), bodyFont: z.string().nullable(), voiceNotes: z.string(),
  requiredDisclaimers: z.array(z.string()), bannedPhrases: z.array(z.string()), videoAvatarId: z.string().nullable(), videoVoiceId: z.string().nullable(),
  captionsDefault: z.boolean(), version: z.number().int().min(1), updatedAt: instant, screenshots: z.array(screenshotSchema),
});
export const learningSchema = z.object({
  product: z.enum(creativeProducts), platform: z.enum(creativePlatforms), kind: z.enum(["hook", "format", "length", "layout", "color"]), value: z.string(),
  verdict: z.enum(["win", "lose", "neutral"]), samples: z.number().int(), score: z.number(), observedAt: instant,
});
const themeColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
/** A product's brand theme (server/agents/creative/themes.mjs): what every blank brand kit field uses. The server adds these to the studio read. */
export const themeSchema = z.object({
  product: z.enum(creativeProducts), name: z.string(), mode: z.enum(["dark", "light"]), tagline: z.string().nullable(), font: z.string(), source: z.string(),
  colors: z.object({ primaryColor: themeColor, secondaryColor: themeColor, accentColor: themeColor, textColor: themeColor, backgroundColor: themeColor }),
});
export const studioSchema = z.object({
  assets: z.array(assetSchema), total: z.number().int().min(0), statusCounts: z.record(z.string(), z.number().int()), blocked: z.number().int().min(0),
  briefs: z.array(briefSchema), brandKits: z.array(brandKitSchema), learnings: z.array(learningSchema), themes: z.array(themeSchema).optional(),
});

export type CreativeAsset = z.infer<typeof assetSchema>;
export type CreativeBrief = z.infer<typeof briefSchema>;
export type BrandKit = z.infer<typeof brandKitSchema>;
export type CreativeLearning = z.infer<typeof learningSchema>;
export type CreativeStudio = z.infer<typeof studioSchema>;
export type CreativeTheme = z.infer<typeof themeSchema>;
export type CreativeProduct = typeof creativeProducts[number];
export type CreativePlatform = typeof creativePlatforms[number];
export type CreativeStatus = typeof creativeStatuses[number];

export const productLabels: Record<CreativeProduct, string> = { "caremetric-intel": "CareMetric Intel", carebase: "CareMetric CareBase" };
export const platformLabels: Record<CreativePlatform, string> = { meta: "Meta", linkedin: "LinkedIn", google: "Google display", youtube: "YouTube" };
export const statusLabels: Record<CreativeStatus, string> = {
  draft: "In production", rendering: "Rendering", ready: "Ready to propose", proposed: "Waiting for you", approved: "Approved", rejected: "Rejected",
  expired: "Expired", live: "Live", retired: "Retired", failed: "Could not render",
};
export const hookLabels = { problem: "Problem", proof: "Proof", offer: "Offer", curiosity: "Curiosity", demo: "Demo" } as const;
export const sourceLabels: Record<CreativeBrief["source"], string> = {
  "social.plan": "Weekly social plan", "growth.plan": "Marketing content brief", sweep: "Daily sweep", owner: "Your brief", refresh: "Variants of a winner", revision: "Your changes",
};
const renderErrors: Record<string, string> = {
  renderer_unavailable: "The image renderer could not load on the server. It is tried again.",
  video_unavailable: "Video rendering is not available on the server (no ffmpeg). It is tried again.",
  render_stalled: "Rendering stopped three times without finishing.",
  video_encode_failed: "ffmpeg could not make the video.",
  heygen_failed: "HeyGen could not make the video.", heygen_timeout: "HeyGen did not finish within three hours.", heygen_refused: "HeyGen refused the request.",
  heygen_download_refused: "The finished HeyGen file was not on HeyGen's own asset hosts.", heygen_too_large: "The HeyGen file was larger than 60 MB.",
};
export const renderErrorLabel = (code: string | null) => (code ? renderErrors[code] ?? code.replaceAll("_", " ") : "");
export const placementLabel = (placement: string) => placement.split(".").slice(1).join(" ").replaceAll("_", " ");
export const fileUrl = (assetId: string, download = false) => `/api/admin/creative/file/${assetId}${download ? "?download=1" : ""}`;
export const sizeLabel = (bytes: number | null) => (bytes === null ? "" : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
export const healthWords = /\b(diagnos[ei]s|conditions?|diseases?|medications?|patients?|symptoms?|disabilit(y|ies)|pregnanc(y|ies)|cancers?|diabetes|depression|hiv)\b/i;
