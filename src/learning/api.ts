import { z } from "zod";
import { supabase } from "../lib/supabase";
import { catalogSchema, certificateSchema, courseSchema, draftListSchema, draftSchema, myLearningSchema, submissionSchema, type DraftDocument } from "./model";
import { governedStageResultSchema } from "../imports/governedLearningImport";

async function rpc<T>(name: string, schema: z.ZodType<T>, args?: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error("Course editing and learning require a connected Support Hub account.");
  const { data, error } = await supabase.schema("hub").rpc(name, args);
  if (error) throw new Error(error.message);
  return schema.parse(data);
}
export const learningApi = {
  sourceHeads: () => rpc("list_learning_source_heads", z.array(z.object({ sourceCourseId: z.string(), sourceRevision: z.string() }))),
  stageSource: (payload: string, sourceRevision: string, expectedRevision: string | null) => rpc("stage_learning_source", governedStageResultSchema,
    { p_payload: payload, p_source_revision: sourceRevision, p_expected_revision: expectedRevision }),
  importDraft: (sourceCourseId: string, sourceVersionId: string, document: DraftDocument) => rpc("import_learning_draft", draftSchema, { p_source_course_id: sourceCourseId, p_source_version_id: sourceVersionId, p_document: document }),
  mediaList: () => rpc("list_learning_media", z.array(z.object({ id: z.uuid(), title: z.string() }))),
  async uploadMedia(title: string, video: File, captions: File, transcript: File, reviewed: boolean) {
    if (!supabase || !reviewed) throw new Error("Review all media files before uploading.");
    if (video.size === 0 || video.size > 268435456 || video.type !== "video/mp4") throw new Error("Choose an MP4 video under 256 MB.");
    if (captions.size > 2000000 || transcript.size > 1000000) throw new Error("Caption or transcript file is too large.");
    if (!(await captions.text()).trimStart().startsWith("WEBVTT") || !(await transcript.text()).trim()) throw new Error("Provide WebVTT captions and a nonempty text transcript.");
    const id = crypto.randomUUID();
    const digest = await crypto.subtle.digest("SHA-256", await video.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    // New object names and no upsert preserve previously published videos.
    for (const [name, file, mime] of [["video.mp4", video, "video/mp4"], ["captions.vtt", captions, "text/vtt"], ["transcript.txt", transcript, "text/plain"]] as const) {
      const { error } = await supabase.storage.from("hub-learning").upload(`learning/${id}/${name}`, file, { contentType: mime, upsert: false });
      if (error) throw new Error(`Upload did not complete: ${error.message}. Retry with a new upload.`);
    }
    const stored = await supabase.storage.from("hub-learning").download(`learning/${id}/video.mp4`);
    if (stored.error) throw new Error("Upload finished but checksum verification could not complete. Retry the upload.");
    const storedDigest = await crypto.subtle.digest("SHA-256", await stored.data.arrayBuffer());
    const storedHash = Array.from(new Uint8Array(storedDigest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (storedHash !== sha256) throw new Error("Stored video checksum does not match the source. The video was not approved.");
    return rpc("register_learning_media", z.uuid(), { p_id: id, p_title: title, p_sha256: sha256, p_reviewed: reviewed });
  },
  catalog: () => supabase ? rpc("list_learning_catalog", catalogSchema) : Promise.resolve([]),
  editorAccess: () => supabase ? rpc("get_learning_editor_access", z.boolean()) : Promise.resolve(false),
  drafts: () => rpc("list_learning_drafts", draftListSchema),
  draft: (itemId: string) => rpc("get_learning_draft", draftSchema, { p_item_id: itemId }),
  save: (itemId: string | null, document: DraftDocument, version: number) => rpc("save_learning_draft", draftSchema, { p_item_id: itemId, p_document: document, p_expected_version: version }),
  publish: (itemId: string, version: number, reviewed: boolean) => rpc("publish_learning_course", z.object({ itemId: z.uuid(), versionId: z.uuid() }), { p_item_id: itemId, p_expected_version: version, p_reviewed: reviewed }),
  course: (itemId: string, enrollmentId: string | null = null) => rpc("get_learning_course", courseSchema, { p_item_id: itemId, p_enrollment_id: enrollmentId }),
  enroll: (itemId: string) => rpc("enroll_learning_course", z.uuid(), { p_item_id: itemId }),
  submit: (enrollmentId: string, unitId: string, answers: Record<string, string>, attested: boolean, requestKey: string) => rpc("submit_learning_unit", submissionSchema, { p_enrollment_id: enrollmentId, p_unit_id: unitId, p_answers: answers, p_attested: attested, p_request_key: requestKey }),
  mine: () => rpc("list_my_learning", myLearningSchema),
  certificate: (enrollmentId: string) => rpc("get_learning_certificate", certificateSchema, { p_enrollment_id: enrollmentId }),
  async media(assetId: string, enrollmentId: string) {
    const paths = await rpc("get_learning_media_paths", z.object({ video: z.string(), captions: z.string() }), { p_asset_id: assetId, p_enrollment_id: enrollmentId });
    if (!supabase) throw new Error("Sign in to play this lesson.");
    const signed = await Promise.all([paths.video, paths.captions].map(path => supabase!.storage.from("hub-learning").createSignedUrl(path, 600)));
    for (const response of signed) if (response.error) throw response.error;
    return { video: signed[0].data!.signedUrl, captions: signed[1].data!.signedUrl };
  },
};
