import { z } from "zod";
import { validatePublicationText } from "../imports/publicationImportPreview.ts";

// Bulk transfer of reviewed lesson videos into private Hub media
// (docs/MEDIA_IMPORT.md). The browser parses the manifest and reads the caption
// and transcript files beside it; the server re-validates every row, fetches the
// MP4 itself from an allowlisted host and never trusts a client-reported hash.

export const MEDIA_IMPORT_COLUMNS = Object.freeze([
  "product", "course_title", "lesson_title", "source_record", "duration_seconds",
  "mp4_url", "poster_url", "captions_file", "transcript_file", "heygen_video_id",
] as const);
export const MEDIA_IMPORT_LIMITS = Object.freeze({
  manifestBytes: 524288, rows: 500, fieldChars: 4096,
  videoBytes: 268435456, captionBytes: 2000000, transcriptBytes: 1000000,
  // Captions may end up to one second after a whole-second manifest duration.
  captionToleranceMs: 1000,
});

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const moduleId = /^[a-f0-9]{24}$/;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(uuid);

/** An absolute https URL with no credentials, port, or fragment. Host policy is the server's. */
export function mediaImportUrl(value: string): URL | null {
  if (value.length > 2048 || /\s/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !url.hostname.includes(".")) return null;
  return url;
}
const httpsUrl = z.string().max(2048).refine(value => mediaImportUrl(value) !== null, "must be an https URL without credentials, port or fragment");
const sidecarPath = (extension: string) => z.string().min(5).max(240).refine(value =>
  !value.startsWith("/") && !value.includes("\\") && value.toLowerCase().endsWith(extension)
  && value.split("/").every(part => part.length > 0 && part !== "." && part !== "..")
  && /^[A-Za-z0-9 ._()/-]+$/.test(value), `must be a relative ${extension} file name beside the manifest`);

export const mediaImportRowSchema = z.strictObject({
  product: z.enum(["pennsync", "carebase"]),
  courseTitle: z.string().trim().min(1).max(500),
  lessonTitle: z.string().trim().min(2).max(180),
  sourceRecord: z.string().refine(value => moduleId.test(value) || uuid.test(value), "must be a PennSync TrainingModule id or a Hub draft item id"),
  durationSeconds: z.number().positive().max(14400),
  mp4Url: httpsUrl,
  posterUrl: httpsUrl.nullable(),
  captionsFile: sidecarPath(".vtt"),
  transcriptFile: sidecarPath(".txt"),
  heygenVideoId: z.string().regex(/^[A-Za-z0-9_-]{6,128}$/, "must be the render id"),
}).superRefine((row, ctx) => {
  if (moduleId.test(row.sourceRecord) && row.product !== "pennsync") {
    ctx.addIssue({ code: "custom", path: ["sourceRecord"], message: "a TrainingModule id can only name a PennSync lesson" });
  }
});
export type MediaImportRow = z.infer<typeof mediaImportRowSchema>;
export type MediaImportManifestRow = MediaImportRow & { line: number };
export type MediaImportManifest = { rows: MediaImportManifestRow[]; errors: { line: number; message: string }[] };

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. Malformed quoting is an error, never a guess. */
export function parseCsv(text: string): string[][] {
  if (text.length > MEDIA_IMPORT_LIMITS.manifestBytes) throw new Error("The manifest is larger than 512 KB.");
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, afterQuote = false;
  const pushField = () => {
    if (field.length > MEDIA_IMPORT_LIMITS.fieldChars) throw new Error(`Line ${rows.length + 1} has a field longer than ${MEDIA_IMPORT_LIMITS.fieldChars} characters.`);
    row.push(field); field = ""; afterQuote = false;
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    if (rows.length > MEDIA_IMPORT_LIMITS.rows + 1) throw new Error(`A manifest can list at most ${MEDIA_IMPORT_LIMITS.rows} videos.`);
    row = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; afterQuote = true; }
      } else field += char;
      continue;
    }
    if (char === ",") pushField();
    else if (char === "\n" || char === "\r") { if (char === "\r" && source[index + 1] === "\n") index += 1; pushRow(); }
    else if (char === '"') {
      if (field.length || afterQuote) throw new Error(`Line ${rows.length + 1} has a quote inside an unquoted field.`);
      quoted = true;
    } else {
      if (afterQuote) throw new Error(`Line ${rows.length + 1} has text after a closing quote.`);
      field += char;
    }
  }
  if (quoted) throw new Error("The manifest ends inside a quoted field.");
  if (field.length || row.length || afterQuote) pushRow();
  return rows;
}

const issueText = (issues: readonly { path: readonly PropertyKey[]; message: string }[]) =>
  issues.map(issue => `${issue.path.map(String).join(".") || "row"} ${issue.message}`).join("; ");

/** Exact columns (any order), every row valid, and no video, lesson or sidecar listed twice. */
export function parseMediaManifest(text: string): MediaImportManifest {
  const errors: MediaImportManifest["errors"] = [];
  let table: string[][];
  try { table = parseCsv(text); } catch (error) { return { rows: [], errors: [{ line: 0, message: error instanceof Error ? error.message : "The manifest is not valid CSV." }] }; }
  const header = (table[0] ?? []).map(name => name.trim().toLowerCase());
  const missing = MEDIA_IMPORT_COLUMNS.filter(name => !header.includes(name));
  const unexpected = header.filter(name => !(MEDIA_IMPORT_COLUMNS as readonly string[]).includes(name));
  if (missing.length || unexpected.length || new Set(header).size !== header.length) {
    return { rows: [], errors: [{ line: 1, message: `The manifest columns must be exactly: ${MEDIA_IMPORT_COLUMNS.join(", ")}.` }] };
  }
  if (table.length < 2) return { rows: [], errors: [{ line: 1, message: "The manifest lists no videos." }] };
  const rows: MediaImportManifestRow[] = [];
  const seen = new Map<string, number>();
  const once = (key: string, line: number, label: string) => {
    const prior = seen.get(key);
    if (prior !== undefined) errors.push({ line, message: `${label} is already listed on line ${prior}.` });
    else seen.set(key, line);
  };
  table.slice(1).forEach((cells, index) => {
    const line = index + 2;
    if (cells.length !== header.length) { errors.push({ line, message: `Expected ${header.length} fields, found ${cells.length}.` }); return; }
    const value = (name: (typeof MEDIA_IMPORT_COLUMNS)[number]) => (cells[header.indexOf(name)] ?? "").trim();
    const duration = value("duration_seconds");
    const parsed = mediaImportRowSchema.safeParse({
      product: value("product").toLowerCase(), courseTitle: value("course_title"), lessonTitle: value("lesson_title"),
      sourceRecord: value("source_record").toLowerCase(),
      durationSeconds: /^\d{1,5}(\.\d{1,3})?$/.test(duration) ? Number(duration) : Number.NaN,
      mp4Url: value("mp4_url"), posterUrl: value("poster_url") || null,
      captionsFile: value("captions_file"), transcriptFile: value("transcript_file"), heygenVideoId: value("heygen_video_id"),
    });
    if (!parsed.success) { errors.push({ line, message: issueText(parsed.error.issues) }); return; }
    const row = parsed.data;
    once(`video:${row.heygenVideoId}`, line, "This render");
    once(`url:${row.mp4Url}`, line, "This MP4 URL");
    once(`target:${mediaImportTargetKey(row)}`, line, "This lesson");
    once(`file:${row.captionsFile}`, line, "This captions file");
    once(`file:${row.transcriptFile}`, line, "This transcript file");
    rows.push({ ...row, line });
  });
  return { rows: errors.length ? [] : rows, errors };
}

/** One video per lesson: a PennSync module, or a lesson title within a named Hub draft. */
export function mediaImportTargetKey(row: Pick<MediaImportRow, "sourceRecord" | "lessonTitle">): string {
  return moduleId.test(row.sourceRecord) ? row.sourceRecord : `${row.sourceRecord}:${row.lessonTitle.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/**
 * Match a manifest-relative sidecar to exactly one chosen file: by folder-relative path when a folder was
 * chosen, otherwise by file name. Two candidates are never guessed between.
 */
export function matchSidecar<T extends { name: string; webkitRelativePath?: string }>(path: string, files: readonly T[]): T | null {
  const name = path.split("/").pop();
  const matches = files.filter(file => file.webkitRelativePath
    ? file.webkitRelativePath === path || file.webkitRelativePath.endsWith(`/${path}`)
    : file.name === name);
  return matches.length === 1 ? matches[0] : null;
}

/** The server repeats these checks; running them first saves a fetch for a row that cannot stage. */
export function validateSidecars(row: Pick<MediaImportRow, "durationSeconds">, captions: string, transcript: string): string | null {
  const encoder = new TextEncoder();
  const captionBytes = encoder.encode(captions), transcriptBytes = encoder.encode(transcript);
  if (captionBytes.byteLength > MEDIA_IMPORT_LIMITS.captionBytes) return "Captions are larger than 2 MB.";
  if (transcriptBytes.byteLength > MEDIA_IMPORT_LIMITS.transcriptBytes) return "Transcript is larger than 1 MB.";
  try { validatePublicationText(captionBytes, "captions", Math.ceil(row.durationSeconds * 1000) + MEDIA_IMPORT_LIMITS.captionToleranceMs); }
  catch (error) { return `Captions: ${error instanceof Error ? error.message.replace(/^assets\.captions:?\s*/, "") : "invalid WebVTT"}`; }
  try { validatePublicationText(transcriptBytes, "transcript"); }
  catch (error) { return `Transcript: ${error instanceof Error ? error.message.replace(/^assets\.transcript:?\s*/, "") : "invalid text"}`; }
  return null;
}

export const mediaImportRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list") }),
  z.strictObject({ operation: z.literal("stage"), manifestSha256: sha256, row: mediaImportRowSchema,
    captions: z.string().min(1).max(MEDIA_IMPORT_LIMITS.captionBytes), transcript: z.string().min(1).max(MEDIA_IMPORT_LIMITS.transcriptBytes) }),
  z.strictObject({ operation: z.literal("register"), mediaId: id, reviewed: z.literal(true) }),
  z.strictObject({ operation: z.literal("attach"), mediaId: id }),
]);
export type MediaImportRequest = z.infer<typeof mediaImportRequestSchema>;

export const MEDIA_IMPORT_FAILURES = Object.freeze({
  host_not_allowed: "The MP4 URL is not on an approved HeyGen asset host.",
  redirect_not_allowed: "The MP4 URL redirected to a host that is not approved.",
  source_unavailable: "The MP4 could not be downloaded. Check the URL and retry.",
  invalid_type: "The download is not an MP4 video.",
  too_large: "The MP4 is larger than 256 MB.",
  size_mismatch: "The download ended before its declared size.",
  hash_mismatch: "The stored copy does not match the downloaded video. It was not staged.",
  invalid_captions: "The captions are not usable WebVTT for this video.",
  invalid_transcript: "The transcript is not usable plain text.",
  storage_unavailable: "Private Hub storage did not accept the upload. Retry the row.",
  timeout: "The transfer took too long. Retry the row.",
} as const);
export type MediaImportFailure = keyof typeof MEDIA_IMPORT_FAILURES;
const failure = z.enum(Object.keys(MEDIA_IMPORT_FAILURES) as [MediaImportFailure, ...MediaImportFailure[]]);

export const MEDIA_IMPORT_TARGETS = Object.freeze({
  ready: "Ready to attach to this lesson.",
  attached: "Attached to this lesson.",
  occupied: "This lesson already has a different video. Choose in the course editor.",
  missing_draft: "No Hub draft has this course yet. Attach it in the course editor after the draft exists.",
  missing_lesson: "The draft has no lesson for this video. Attach it in the course editor.",
  ambiguous: "More than one lesson matches. Attach it in the course editor.",
  not_video: "The matching lesson is not a video lesson. Attach it in the course editor.",
} as const);
export type MediaImportTargetState = keyof typeof MEDIA_IMPORT_TARGETS;

export const mediaImportItemSchema = z.strictObject({
  itemKey: z.string().min(1).max(400), product: z.enum(["pennsync", "carebase"]),
  courseTitle: z.string(), lessonTitle: z.string(), sourceRecord: z.string(), heygenVideoId: z.string(),
  durationSeconds: z.number(), mp4Url: z.string(), captionsFile: z.string(), transcriptFile: z.string(),
  state: z.enum(["fetching", "staged", "failed", "registered"]), failureCode: failure.nullable(),
  mediaId: id.nullable(), sourceSha256: sha256.nullable(), byteSize: z.number().int().nullable(), attempts: z.number().int(),
  updatedAt: z.string(),
  target: z.strictObject({
    state: z.enum(Object.keys(MEDIA_IMPORT_TARGETS) as [MediaImportTargetState, ...MediaImportTargetState[]]),
    itemId: id.nullable(), draftTitle: z.string().nullable(), unitId: id.nullable(), unitTitle: z.string().nullable(),
  }),
});
export type MediaImportItem = z.infer<typeof mediaImportItemSchema>;
export const mediaImportListSchema = z.strictObject({ items: z.array(mediaImportItemSchema).max(2000) });
export const mediaImportResultSchema = z.strictObject({ item: mediaImportItemSchema, replayed: z.boolean() });
export type MediaImportResult = z.infer<typeof mediaImportResultSchema>;
