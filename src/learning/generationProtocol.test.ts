import { describe, expect, it } from "vitest";
import { generationMessage, generationOperationSchema, projectGenerationResult } from "./generationProtocol";
const id = "ffffffff-0000-0000-0000-000000000001", other = "ffffffff-0000-0000-0000-000000000002";
const video = { course_block_id: id, request_id: other, avatar_id: "avatar-1", voice_id: "voice-1", script: "Welcome to fire safety." };
describe("generation operations", () => {
  it("accepts single global course drafts, block regeneration and video operations", () => {
    for (const value of [
      { operation: "ai.generateCourse", request: { generation_mode: "course", title_hint: "Fire safety" } },
      { operation: "ai.generateCourse", request: { generation_mode: "course", source_material: "55 Pa. Code 2600.", desired_module_count: 6, desired_duration_minutes: 60, category: "Safety" } },
      { operation: "ai.regenerateBlock", request: { course_block_id: id, feedback: "Shorter, with one example." } },
      { operation: "video.options", request: {} },
      { operation: "video.generate", request: { ...video, title: "", replace_existing: true, expected_video_url: null, expected_media_asset_id: id } },
      { operation: "video.status", request: { course_block_id: id } },
    ]) expect(generationOperationSchema.parse(value)).toEqual(value);
  });
  it("refuses training plans, empty drafts and video links the Hub cannot know", () => {
    for (const value of [
      { operation: "ai.generateCourse", request: { generation_mode: "training_plan", organization_id: id, plan_name: "Onboarding", course_count: 3 } },
      { operation: "ai.generateCourse", request: { generation_mode: "course", category: "Safety" } },
      { operation: "ai.generateCourse", request: { generation_mode: "course", title_hint: "   " } },
      { operation: "ai.generateCourse", request: { generation_mode: "course", title_hint: "x", desired_module_count: 31 } },
      { operation: "ai.generateCourse", request: { generation_mode: "course", title_hint: "x", organization_id: id } },
      { operation: "ai.regenerateBlock", request: { course_block_id: id, feedback: " " } },
      { operation: "video.options", request: { page: 1 } },
      { operation: "video.generate", request: { ...video, expected_video_url: "https://cdn.invalid/old.mp4" } },
      { operation: "video.generate", request: { ...video, script: "  " } },
      { operation: "video.generate", request: { ...video, avatar_id: "a".repeat(201) } },
      { operation: "video.status", request: { course_block_id: id, extra: true } },
    ]) expect(generationOperationSchema.safeParse(value).success).toBe(false);
    expect(generationOperationSchema.safeParse({ operation: "ai.generateCourse", request: { generation_mode: "course", source_material: "€".repeat(100_000) } }).success).toBe(false);
  });
});
describe("generation results", () => {
  it("checks the envelope and projects only reviewed fields", () => {
    const draft = generationOperationSchema.parse({ operation: "ai.generateCourse", request: { generation_mode: "course", title_hint: "Fire safety" } });
    expect(projectGenerationResult({ operation: "ai.generateCourse", result: { success: true, course_id: id, course_version_id: other, generation_id: id } }, draft))
      .toEqual({ courseId: id, versionId: other, generationId: id });
    expect(() => projectGenerationResult({ operation: "video.status", result: { success: true, status: "processing" } }, draft)).toThrow();
    expect(() => projectGenerationResult({ operation: "ai.generateCourse", result: { success: false } }, draft)).toThrow();
    const regenerate = generationOperationSchema.parse({ operation: "ai.regenerateBlock", request: { course_block_id: id, feedback: "Shorter." } });
    expect(() => projectGenerationResult({ operation: "ai.regenerateBlock", result: { success: true, course_block_id: other, generation_id: id } }, regenerate)).toThrow();
    const options = generationOperationSchema.parse({ operation: "video.options", request: {} });
    expect(projectGenerationResult({ operation: "video.options", result: { success: true,
      avatars: [{ id: "a1", name: "Dr. Kim", preview_image_url: "https://cdn.heygen.invalid/a1.png", gender: 7, avatar_type: "twin", is_ai_twin: true, is_private: true, default_voice_id: "v1" }],
      voices: [{ voice_id: "v1", name: "Calm", language: "English", gender: null, preview_audio_url: "https://cdn.heygen.invalid/v1.mp3" }] } }, options))
      .toEqual({ avatars: [{ id: "a1", name: "Dr. Kim", gender: null, aiTwin: true, private: true, defaultVoiceId: "v1" }], voices: [{ id: "v1", name: "Calm", language: "English", gender: null }] });
    const status = generationOperationSchema.parse({ operation: "video.status", request: { course_block_id: id } });
    expect(projectGenerationResult({ operation: "video.status", result: { success: true, status: "completed", video_url: "https://cdn.invalid/v.mp4" } }, status)).toEqual({ status: "completed", error: null });
    expect(projectGenerationResult({ operation: "video.status", result: { success: true, status: "failed", error: "Avatar unavailable" } }, status)).toEqual({ status: "failed", error: "Avatar unavailable" });
  });
  it("keeps an avatar or voice that HeyGen sent without a name, gender or language", () => {
    // CareBase's list-heygen-options copies these fields from HeyGen as they come; one HeyGen leaves out is undefined there, so the
    // JSON it sends has no key at all. A missing key used to fail the whole list, and the Hub answered 503 to a good response.
    const look = { id: "look-1", status: "completed", avatar_type: "instant_avatar", default_voice_id: "v1" };
    const voice = { voice_id: "v2", gender: "female" };
    const asCareBaseSendsIt = JSON.parse(JSON.stringify({ operation: "video.options", result: { success: true,
      avatars: [{ id: look.id, name: undefined, preview_image_url: undefined, gender: undefined, avatar_type: look.avatar_type, group_name: null,
        is_ai_twin: true, is_private: true, default_voice_id: look.default_voice_id }],
      voices: [{ voice_id: voice.voice_id, name: undefined, language: undefined, gender: voice.gender, preview_audio_url: undefined }] } }));
    expect(Object.keys(asCareBaseSendsIt.result.avatars[0])).not.toContain("gender");
    const options = { operation: "video.options" as const, request: {} };
    expect(projectGenerationResult(asCareBaseSendsIt, options)).toEqual({
      avatars: [{ id: "look-1", name: null, gender: null, aiTwin: true, private: true, defaultVoiceId: "v1" }],
      voices: [{ id: "v2", name: null, language: null, gender: "female" }],
    });
    // An avatar with no default voice is still offered; one with no id cannot be chosen and still fails the list.
    const noDefault = { operation: "video.options", result: { success: true, avatars: [{ id: "look-2", is_ai_twin: false, is_private: false }], voices: [] } };
    expect(projectGenerationResult(noDefault, options).avatars[0]).toEqual({ id: "look-2", name: null, gender: null, aiTwin: false, private: false, defaultVoiceId: null });
    expect(() => projectGenerationResult({ operation: "video.options", result: { success: true, avatars: [{ name: "No id", is_ai_twin: false, is_private: false }], voices: [] } }, options)).toThrow();
  });
  it("shows only bounded administrator messages", () => {
    expect(generationMessage("AI course generation is currently disabled by the platform administrator.")).toBe("AI course generation is currently disabled by the platform administrator.");
    for (const value of [undefined, 7, "", "x".repeat(1001), "bad\u0007bell"]) expect(generationMessage(value)).toBeNull();
  });
});
