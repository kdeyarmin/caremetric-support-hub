import { type PublicationManifest } from "./publicationImportPreview";
export const articleBytes = new TextEncoder().encode("# Workspace guide\n\nOpen the workspace and choose a product.\n");
export const videoBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 109, 112, 52, 50]);
export const captionBytes = new TextEncoder().encode("WEBVTT\n\n00:00.000 --> 00:00.900\nOpen the workspace.\n");
export const transcriptBytes = new TextEncoder().encode("Open the workspace.\n");
export async function fixtureManifest(kind: "article" | "video" = "article"): Promise<PublicationManifest> {
  const bytes = kind === "article" ? articleBytes : videoBytes;
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  const sidecarHash = async (value: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(value))), byte => byte.toString(16).padStart(2, "0")).join("");
  return {
    schema_version: "caremetric.support-hub.publication.v1", source_system: "docstudio",
    source: { content_key: "workspace-guide", version: "docstudio-v1" },
    content: { kind, title: "Workspace guide", summary: "Steps for using the shared workspace.", locale: "en-US", access_level: "staff" },
    artifact: { sha256: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join(""), media_type: kind === "article" ? "text/markdown" : "video/mp4", byte_length: bytes.length, ...(kind === "video" ? { duration_ms: 1000, captions_sha256: await sidecarHash(captionBytes), transcript_sha256: await sidecarHash(transcriptBytes) } : {}) },
    governance: { review_state: "approved", phi_review: "passed", approved_at: "2026-09-10T12:00:00Z", policy_version: "docstudio-phi-free-v1" },
    placements: [{ product_slug: "carebase", audience: ["all"], route_pattern: null }],
  };
}
