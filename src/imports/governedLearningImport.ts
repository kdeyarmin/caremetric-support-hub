import { z } from "zod";

// Source UUIDs are opaque identifiers; older native seeds need not be RFC v4.
const id = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const text = z.string().max(250_000);
const nullableText = text.nullable();
const integer = z.number().int().min(-2147483648).max(2147483647);
const positive = integer.min(1);
const option = z.strictObject({ id, sortOrder: integer, text, correct: z.boolean() });
const question = z.strictObject({ id, sortOrder: integer, prompt: text, type: z.enum(["single_choice", "multiple_choice", "true_false"]), points: positive,
  topicCode: nullableText, topicLabel: nullableText, explanation: nullableText, options: z.array(option).max(100) });
const quiz = z.strictObject({ id, title: text, passingScore: integer.min(0).max(100), maxAttempts: positive.nullable(),
  kind: z.enum(["assessment", "knowledge_check", "final_exam"]), shuffleQuestions: z.boolean(), shuffleAnswers: z.boolean(), revealsAnswersAfterAttempt: z.boolean(), questions: z.array(question).max(500) });

// Authoring body/manifest JSON is retained verbatim, never rendered or projected to learners.
// Asset tables, storage location columns, learner records and account IDs are not exported.
// Recognized credential/storage fields inside authored JSON fail validation, too.
export const governedCourseSchema = z.strictObject({
  contract: z.literal("carebase.course.v1"), sourceCourseId: id, sourceVersionId: id, sourceVersionNumber: integer,
  publicationState: z.enum(["draft", "published", "archived"]), sourceVersionState: z.enum(["draft", "published"]),
  course: z.strictObject({ title: text, description: nullableText, category: nullableText, estimatedDurationMinutes: integer.min(0).nullable(),
    catalogCode: nullableText, recurrenceIntervalDays: positive.nullable(), legacyTrainingTypeId: id.nullable(), renewalTrainingTypeId: id.nullable(), creditedDurationCheckExempt: z.boolean() }),
  version: z.strictObject({ title: text, description: nullableText, label: nullableText, contentStandard: z.enum(["legacy", "comprehensive"]),
    creditedDurationRationale: nullableText, aiGenerated: z.boolean(), aiReviewedAt: nullableText }),
  blocks: z.array(z.strictObject({ id, type: z.enum(["text", "video", "pdf", "scorm", "quiz", "attestation"]), sortOrder: integer, title: nullableText,
    body: z.json(), documentId: id.nullable(), videoLocatorSha256: hash.nullable(), quiz: quiz.nullable() })).max(500),
  credits: z.array(z.strictObject({ id, trainingTypeId: id, topicCode: text, creditHours: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/),
    mode: z.enum(["automatic", "verified_only"]), citationNote: text, active: z.boolean() })).max(100),
  provider: z.strictObject({ id, fullName: text, professionalTitle: nullableText, credential: nullableText, credentialNumber: nullableText,
    credentialIssuingOrganization: nullableText, credentialExpiresOn: nullableText, courseAuthor: nullableText, signatureName: nullableText,
    signatureRecordedAt: nullableText, contentVersion: nullableText, lastClinicalReviewDate: nullableText, reviewedBy: nullableText,
    nextReviewDue: nullableText, regulationReviewDate: nullableText, reviewNotes: nullableText }).nullable(),
  packages: z.array(z.strictObject({ id, standard: z.enum(["scorm_1_2", "scorm_2004_4th", "xapi", "lti_1_3"]), contentSha256: hash,
    entryPoint: nullableText, manifest: z.json(), capabilities: z.array(text).max(100), connectivityMode: z.enum(["online_only", "offline_supported"]),
    validationStatus: z.enum(["pending", "validating", "accepted", "rejected", "quarantined"]) })).max(100),
});
export type GovernedCourse = z.infer<typeof governedCourseSchema>;
export const governedExportSchema = z.strictObject({ contract: z.literal("carebase.catalog-snapshot.v1"),
  scope: z.literal("global-courses-with-current-version"), courses: z.array(z.strictObject({ sourceRevision: hash, payload: z.string().max(2_000_000) })).max(1000) });
export interface GovernedImport { sourceRevision: string; payload: string; course: GovernedCourse }
export const governedStageResultSchema = z.object({ snapshotId: id, sourceRevision: hash, headRevision: hash, sequence: positive, replayed: z.boolean() });

export async function sourceDigest(payload: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

// A SHA is provenance/integrity, not source authentication. Only a verified
// portfolio editor can stage; no snapshot can change live ownership or completion.
export function validateGovernedCourse(value: unknown): GovernedCourse {
  const course = governedCourseSchema.parse(value);
  const seen = new Set<string>();
  function unique(kind: string, value: string) {
    const key = kind + value.toLowerCase();
    if (seen.has(key)) throw new Error("The source snapshot repeats a content identifier.");
    seen.add(key);
  }
  for (const block of course.blocks) {
    unique("block", block.id);
    if ((block.type !== "quiz" && block.quiz !== null) || (block.type === "quiz" && block.quiz === null && course.sourceVersionState !== "draft")) {
      throw new Error("Source quiz blocks and configuration do not agree.");
    }
    if (!block.quiz) continue;
    unique("quiz", block.quiz.id);
    if (block.quiz.revealsAnswersAfterAttempt && block.quiz.kind !== "knowledge_check") throw new Error("Source answer visibility is invalid.");
    for (const question of block.quiz.questions) {
      unique("question", question.id);
      for (const answer of question.options) unique("answer", answer.id);
    }
  }
  course.credits.forEach(credit => unique("credit", credit.id));
  course.packages.forEach(pkg => unique("package", pkg.id));
  // Reject provider playback credentials anywhere in authored JSON, too. Source
  // video URLs are represented by a hash and a source block ID, never fetched.
  const serialized = JSON.stringify(course);
  if (/(?:[?&](?:token|access_token|signature|sig|key|policy|jwt|auth|h|hdnts|hdnea|key-pair-id|api_key|apikey|x-amz-[a-z-]+|x-goog-[a-z-]+)=|"(?:access_?token|refresh_?token|service_?role_?key|authorization|password|client_?secret|storage_?(path|bucket)|video_?url|playback_?(url|token)|signed_?url|api_?key|token|secret|secret_?key|signing_?secret)"\s*:)/i.test(serialized)) {
    throw new Error("Remove playback credentials from the source export before staging.");
  }
  return course;
}

export async function prepareGovernedImport(value: unknown): Promise<GovernedImport[]> {
  const snapshot = governedExportSchema.parse(value);
  const seen = new Set<string>();
  const result: GovernedImport[] = [];
  for (const entry of snapshot.courses) {
    if (new TextEncoder().encode(entry.payload).byteLength > 2_000_000) throw new Error("A source course exceeds 2 MB.");
    if (await sourceDigest(entry.payload) !== entry.sourceRevision) throw new Error("Source revision checksum does not match its payload.");
    const course = validateGovernedCourse(JSON.parse(entry.payload));
    const key = course.sourceCourseId.toLowerCase();
    if (seen.has(key)) throw new Error("The export repeats a source course.");
    seen.add(key);
    result.push({ ...entry, course });
  }
  return result;
}

export function governedImportSummary(imports: GovernedImport[]) {
  const courses = imports.map(item => item.course);
  return { courses: courses.length, archived: courses.filter(c => c.publicationState === "archived").length,
    blocks: courses.reduce((n, c) => n + c.blocks.length, 0), quizzes: courses.reduce((n, c) => n + c.blocks.filter(b => b.quiz).length, 0),
    questions: courses.reduce((n, c) => n + c.blocks.reduce((m, b) => m + (b.quiz?.questions.length ?? 0), 0), 0),
    creditRules: courses.reduce((n, c) => n + c.credits.length, 0), providers: courses.filter(c => c.provider).length,
    mediaReferences: courses.reduce((n, c) => n + c.blocks.filter(b => b.videoLocatorSha256 || b.documentId).length + c.packages.length, 0) };
}
