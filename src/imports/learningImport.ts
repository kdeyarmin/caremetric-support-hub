import { z } from "zod";
import { draftDocumentSchema, type DraftDocument, type DraftUnit } from "../learning/model.ts";

// Field-limited source export. No employee, organization, assignment, or account data.
const sourceOption = z.object({ id: z.uuid(), text: z.string(), correct: z.boolean() });
const sourceQuestion = z.object({ id: z.uuid(), prompt: z.string(), type: z.literal("single_choice"), points: z.number().int().positive(), options: z.array(sourceOption).min(2) });
const sourceUnit = z.object({ id: z.uuid(), type: z.enum(["text", "quiz", "video", "attestation"]), title: z.string(), body: z.string().nullable(), script: z.string().nullable(), attestation: z.string().nullable(), videoUrl: z.string().nullable(), quiz: z.object({ passingScore: z.number(), maxAttempts: z.number().nullable(), kind: z.string(), questions: z.array(sourceQuestion).min(1) }).nullable() });
export const sourceCoursesSchema = z.array(z.object({ id: z.uuid(), versionId: z.uuid(), versionNumber: z.number().int(), title: z.string(), description: z.string().nullable(), category: z.string().nullable(), durationMinutes: z.number().int().positive(), units: z.array(sourceUnit).min(1) }));
export interface LearningImport { sourceCourseId: string; sourceVersionId: string; document: DraftDocument; pendingVideoIds: string[] }

// Mirrors the product-slug allowlist in private.validate_learning_document
// (supabase/schema.sql), which is the authority on course placements: the
// server rejects any imported document placed on a product outside this set,
// including products that are registered but not course-placement eligible.
// Change this list only together with that validator.
export const COURSE_PLACEMENT_PRODUCT_SLUGS: readonly string[] = [
  "carebase",
  "pennsync",
  "breathe",
  "caremetric-emr",
  "caremetric-go",
  "caremetric-intel",
];

export function coursePlacementProductIds(products: ReadonlyArray<{ id: string; slug: string; status: string }>): string[] {
  return products
    .filter(product => product.status !== "retired" && COURSE_PLACEMENT_PRODUCT_SLUGS.includes(product.slug))
    .map(product => product.id);
}

export function prepareLearningImport(snapshot: unknown, productIds: string[], approvedMedia: Readonly<Record<string, string>> = {}): LearningImport[] {
  return sourceCoursesSchema.parse(snapshot).map(course => {
    const pendingVideoIds: string[] = [];
    const units: DraftUnit[] = course.units.map(unit => {
      const base = { id: unit.id, title: unit.title };
      if (unit.type === "quiz") {
        if (!unit.quiz) throw new Error(`Quiz configuration missing for ${unit.id}.`);
        return { ...base, type: "quiz", body: unit.body ?? "", passingScore: unit.quiz.passingScore, maxAttempts: unit.quiz.maxAttempts, questions: unit.quiz.questions.map(question => {
          const correct = question.options.filter(option => option.correct);
          if (correct.length !== 1) throw new Error(`Question ${question.id} needs exactly one correct answer.`);
          return { id: question.id, prompt: question.prompt, points: question.points, correctOptionId: correct[0].id, options: question.options.map(option => ({ id: option.id, text: option.text })) };
        }) };
      }
      if (unit.type === "video") {
        const asset = approvedMedia[unit.id] ?? null;
        if (!asset) pendingVideoIds.push(unit.id);
        return { ...base, type: "video", body: unit.script ?? "", mediaAssetId: asset };
      }
      return { ...base, type: unit.type, body: unit.type === "attestation" ? unit.attestation ?? unit.body ?? "" : unit.body ?? "" };
    });
    return { sourceCourseId: course.id, sourceVersionId: course.versionId, pendingVideoIds, document: draftDocumentSchema.parse({
      title: course.title, summary: (course.description ?? "").slice(0,500), overview: course.description ?? "", category: course.category ?? "", durationMinutes: course.durationMinutes, accessLevel: "public", productIds, units,
    }) };
  });
}
