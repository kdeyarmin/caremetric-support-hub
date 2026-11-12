import { z } from "zod";
import { receiptUuid as id } from "./receiptProtocol.ts";

/**
 * CareBase's generation route (/api/learning-generation/run) relays AI drafting, block
 * regeneration and avatar video to its edge functions. Shapes mirror its closed checks.
 * The Hub drafts single global courses only: training plan mode creates records inside an
 * organization and waits on an owner decision, so it is not offered here.
 */
const words = (min: number, max: number) => z.string().min(min).max(max).refine(v => !v.includes("\0") && (min === 0 || v.trim().length > 0));
export const courseDraftRequestSchema = z.strictObject({ generation_mode: z.literal("course"), title_hint: words(0, 300).optional(), category: words(0, 100).optional(),
  training_type_id: id.optional(), source_material: words(0, 100_000).optional(), desired_module_count: z.number().int().min(1).max(30).optional(),
  desired_duration_minutes: z.number().int().min(1).max(1440).optional(), notes: words(0, 4000).optional() })
  .refine(v => [v.title_hint, v.source_material, v.notes].some(value => value?.trim()), { message: "Enter a title, source material or notes." });
export type CourseDraftRequest = z.infer<typeof courseDraftRequestSchema>;
export const videoRequestSchema = z.strictObject({ course_block_id: id, request_id: id, avatar_id: words(1, 200), voice_id: words(1, 200), script: words(1, 50_000),
  title: words(0, 1000).optional(), replace_existing: z.boolean().optional(),
  // The Hub never loads a block's video link, so it can only confirm there was none.
  expected_video_url: z.null().optional(), expected_media_asset_id: id.nullable().optional() });
export type VideoRequest = z.infer<typeof videoRequestSchema>;
export const generationOperationSchema = z.union([
  z.strictObject({ operation: z.literal("ai.generateCourse"), request: courseDraftRequestSchema }),
  z.strictObject({ operation: z.literal("ai.regenerateBlock"), request: z.strictObject({ course_block_id: id, feedback: words(1, 4000) }) }),
  z.strictObject({ operation: z.literal("video.options"), request: z.strictObject({}) }),
  z.strictObject({ operation: z.literal("video.generate"), request: videoRequestSchema }),
  z.strictObject({ operation: z.literal("video.status"), request: z.strictObject({ course_block_id: id }) }),
]).refine(v => new TextEncoder().encode(JSON.stringify(v)).byteLength <= 200_000);
export type GenerationOperation = z.infer<typeof generationOperationSchema>;

// Provider catalog text is display-only; anything unexpected becomes null rather than failing the list. That includes a field
// that is missing altogether: CareBase copies HeyGen's name, gender and language as they come, so a look or voice without one
// arrives with no key, and zod 4 rejects a missing key unless the schema is optional. That rejection turned a good list into a 503.
const label = (max: number) => z.unknown().optional().transform(v => typeof v === "string" && v.length <= max && !/\p{Cc}/u.test(v) ? v : null);
const avatar = z.object({ id: z.string().min(1).max(200), name: label(300), gender: label(50), is_ai_twin: z.boolean(), is_private: z.boolean(), default_voice_id: label(200) })
  .transform(({ id: avatarId, name, gender, is_ai_twin, is_private, default_voice_id }) => ({ id: avatarId, name, gender, aiTwin: is_ai_twin, private: is_private, defaultVoiceId: default_voice_id }));
const voice = z.object({ voice_id: z.string().min(1).max(200), name: label(300), language: label(100), gender: label(50) })
  .transform(({ voice_id, name, language, gender }) => ({ id: voice_id, name, language, gender }));
export type Avatar = z.output<typeof avatar>;
export type Voice = z.output<typeof voice>;
// Provider preview links are dropped: the Hub's content policy loads no third-party media.
const results = {
  "ai.generateCourse": z.object({ success: z.literal(true), course_id: id, course_version_id: id, generation_id: id })
    .transform(v => ({ courseId: v.course_id, versionId: v.course_version_id, generationId: v.generation_id })),
  "ai.regenerateBlock": z.object({ success: z.literal(true), course_block_id: id, generation_id: id })
    .transform(v => ({ blockId: v.course_block_id, generationId: v.generation_id })),
  "video.options": z.object({ success: z.literal(true), avatars: z.array(avatar).max(5000), voices: z.array(voice).max(5000) })
    .transform(v => ({ avatars: v.avatars, voices: v.voices })),
  "video.generate": z.object({ success: z.literal(true), attempt_id: id, video_id: z.string().max(200).nullable().optional(), status: z.enum(["processing", "completed"]), reused: z.literal(true).optional() })
    .transform(v => ({ attemptId: v.attempt_id, status: v.status, reused: v.reused === true })),
  "video.status": z.object({ success: z.literal(true), status: z.enum(["processing", "completed", "failed"]), error: z.string().max(1000).optional() })
    .transform(v => ({ status: v.status, error: v.status === "failed" ? v.error ?? "The video could not be generated." : null })),
};
export type GenerationResult<O extends GenerationOperation["operation"]> = z.output<typeof results[O]>;
/** Checks CareBase's `{operation, result}` envelope against the exact operation that was sent. */
export function projectGenerationResult<O extends GenerationOperation>(value: unknown, op: O): GenerationResult<O["operation"]> {
  const envelope = z.strictObject({ operation: z.literal(op.operation), result: z.unknown() }).parse(value);
  const result = results[op.operation].parse(envelope.result) as GenerationResult<O["operation"]>;
  if (op.operation === "ai.regenerateBlock" && (result as GenerationResult<"ai.regenerateBlock">).blockId.toLowerCase() !== op.request.course_block_id.toLowerCase())
    throw new Error("Regenerated block identity mismatch");
  return result;
}
/** CareBase writes these messages for administrators; anything else stays generic. */
export function generationMessage(value: unknown) {
  return typeof value === "string" && value.length <= 1000 && !/\p{Cc}/u.test(value.replace(/[\n\t]/g, "")) ? value.trim() || null : null;
}
