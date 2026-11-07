import { z } from "zod";

// Postgres uuid columns accept any version/variant nibbles, but z.uuid()
// enforces the RFC 4122 bits; seeded catalog ids such as
// afff6e38-7c82-2cd7-2a8b-cc1eb91289c7 (variant nibble "2") fail it, so RPC
// responses carrying those ids were rejected after the server had succeeded.
// Validate the 8-4-4-4-12 hex shape only, matching what the database returns.
export const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Expected a UUID");
const option = z.object({ id, text: z.string().min(1).max(2000) });
const question = z.object({ id, prompt: z.string().min(2).max(3000), options: z.array(option).min(2).max(8), points: z.number().int().min(1).max(100).default(1) });
const unitBase = { id, title: z.string().min(2).max(180) };
const lesson = z.object({ ...unitBase, type: z.enum(["text", "attestation"]), body: z.string().min(1).max(60000) });
const video = z.object({ ...unitBase, type: z.literal("video"), body: z.string().min(1).max(60000), mediaAssetId: id.nullable() });
const quizBase = { ...unitBase, type: z.literal("quiz"), body: z.string().max(60000).default(""), passingScore: z.number().int().min(1).max(100), maxAttempts: z.number().int().min(1).max(10).nullable() };
// productIds carries no count cap: the registry decides how many products
// exist (seven today), so a hardcoded maximum rejects valid documents.
const meta = {
  title: z.string().min(2).max(180), summary: z.string().max(500), overview: z.string().max(60000).default(""), category: z.string().max(100),
  durationMinutes: z.number().int().min(1).max(1440), accessLevel: z.enum(["public", "customer", "staff"]), productIds: z.array(id).min(1),
};
// A question names one correct option, or, for select all that apply, the set of correct options.
// The server grades a select-all answer as correct only when the learner chose exactly that set.
const draftQuestion = z.union([
  question.extend({ correctOptionId: id }),
  question.extend({ correctOptionIds: z.array(id).min(1).max(8) }),
]).superRefine((value, context) => {
  const options = new Set(value.options.map(option => option.id));
  const keys = "correctOptionIds" in value ? value.correctOptionIds : [value.correctOptionId];
  if (new Set(keys).size !== keys.length || keys.some(key => !options.has(key))) context.addIssue({ code: "custom", message: "Choose valid correct answers from the question's options." });
});
export type DraftQuestion = z.infer<typeof draftQuestion>;
export const draftDocumentSchema = z.object({ ...meta, units: z.array(z.discriminatedUnion("type", [lesson, video, z.object({ ...quizBase, questions: z.array(draftQuestion).min(1).max(100) })])).min(1).max(150) });
export const learnerDocumentSchema = z.object({ ...meta, units: z.array(z.discriminatedUnion("type", [lesson, video, z.object({ ...quizBase, questions: z.array(question.extend({ multiple: z.boolean().optional() })).min(1) })])) });
export type DraftDocument = z.infer<typeof draftDocumentSchema>;
export type DraftUnit = DraftDocument["units"][number];
export type LearnerDocument = z.infer<typeof learnerDocumentSchema>;
export type LearnerUnit = LearnerDocument["units"][number];
export const draftSchema = z.object({ itemId: id, draftVersion: z.number().int(), document: draftDocumentSchema, published: z.boolean() });
export type Draft = z.infer<typeof draftSchema>;
export const draftListSchema = z.array(z.object({ itemId: id, title: z.string(), draftVersion: z.number(), published: z.boolean(), updatedAt: z.string() }));
export const catalogSchema = z.array(z.object({ itemId: id, versionId: id, title: z.string(), summary: z.string().nullable(), category: z.string().nullable(), durationMinutes: z.number(), productIds: z.array(id), unitCount: z.number() }));
export const courseSchema = z.object({ itemId: id, versionId: id, document: learnerDocumentSchema, enrollmentId: id.nullable(), completedAt: z.string().nullable(), certificateId: id.nullable(), progress: z.array(z.object({ unitId: id, completedAt: z.string().nullable(), attemptCount: z.number(), bestScore: z.number().nullable() })) });
export type Course = z.infer<typeof courseSchema>;
export const submissionSchema = z.object({ passed: z.boolean(), score: z.number().nullable(), attemptCount: z.number(), completedAt: z.string().nullable(), certificateId: id.nullable() });
export const myLearningSchema = z.array(z.object({ enrollmentId: id, itemId: id, title: z.string(), versionId: id, startedAt: z.string(), completedAt: z.string().nullable(), certificateId: id.nullable(), durationMinutes: z.number(), completedUnits: z.number(), totalUnits: z.number() }));
export const certificateSchema = z.object({ certificateId: id, learnerName: z.string(), courseTitle: z.string(), completedAt: z.string(), durationMinutes: z.number(), versionId: id, finalScore: z.number().nullish(), passingScore: z.number().nullish() });
export function newUnit(type: DraftUnit["type"]): DraftUnit {
  const base = { id: crypto.randomUUID(), title: "New lesson" };
  if (type === "quiz") {
    const correct = crypto.randomUUID();
    return { ...base, title: "Knowledge check", type, body: "", passingScore: 80, maxAttempts: null, questions: [{ id: crypto.randomUUID(), prompt: "", points: 1, correctOptionId: correct, options: [{ id: correct, text: "" }, { id: crypto.randomUUID(), text: "" }] }] };
  }
  return type === "video" ? { ...base, type, body: "", mediaAssetId: null } : { ...base, type, body: "" };
}
// Units open in course order, as the server enforces: everything through the
// first incomplete unit is available, and the final quiz is the post-test.
export function courseSteps(course: Course) {
  const units = course.document.units;
  const firstOpen = units.findIndex(unit => !course.progress.some(p => p.unitId === unit.id && p.completedAt));
  return { lastOpen: firstOpen === -1 ? units.length - 1 : firstOpen, postTest: units.map(unit => unit.type).lastIndexOf("quiz") };
}
export function newDocument(products: string[]): DraftDocument {
  return { title: "", summary: "", overview: "", category: "", durationMinutes: 10, accessLevel: "customer", productIds: products, units: [newUnit("text")] };
}

// Keep login return paths local, bounded, and free of learner identifiers.
export function safeLearningPath(path: string): string | null {
  return /^\/(?:learn(?:\/my|\/courses\/[0-9a-f-]{36}|\/certificates\/[0-9a-f-]{36})?|library(?:\/courses\/(?:new|[0-9a-f-]{36}))?)$/i.test(path) ? path : null;
}
