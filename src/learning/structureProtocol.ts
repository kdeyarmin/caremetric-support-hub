import { z } from "zod";
import { containsGovernedCredentials } from "../imports/governedLearningImport.ts";

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
const line = (min: number, max: number) => z.string().min(min).max(max).refine(value => value === value.trim() && !/\p{Cc}/u.test(value));
const prose = z.string().max(12_000).refine(value => !/\p{Cc}/u.test(value.replaceAll("\n", "").replaceAll("\r", "").replaceAll("\t", "")));
const nonblank = prose.refine(value => value.trim().length > 0);
const ids = (min: number, max: number) => z.array(id).min(min).max(max).refine(values => new Set(values).size === values.length);
const title = line(0, 300).nullable();
export const blockTypeSchema = z.enum(["text", "video", "pdf", "scorm", "quiz", "attestation"]);
export const activityTypeSchema = z.enum(["objectives", "instruction", "guided_instruction", "scenario", "practice", "facility_verification", "sources", "assessment", "attestation"]);
const bodyCommon = { estimatedMinutes: z.number().int().min(0).max(1440).optional(), activityType: activityTypeSchema.optional() };
const bodyFields = { ...bodyCommon, content: prose.optional(), transcript: prose.optional(), attestationText: prose.optional(), attestationVersion: line(1, 128).optional() };
const body = z.strictObject(bodyFields);
const addLesson = z.strictObject({ operation: z.literal("addLesson"), blockId: id, blockType: blockTypeSchema, title, body })
  .refine(value => Object.keys(value.body).every(key => ["estimatedMinutes", "activityType",
    ...(value.blockType === "text" ? ["content"] : value.blockType === "video" ? ["transcript"] : value.blockType === "attestation" ? ["attestationText", "attestationVersion"] : [])].includes(key)));
export const editLessonPatchSchema = z.strictObject({ title: title.optional(), ...bodyFields }).refine(value => Object.keys(value).length > 0);
export const quizConfigurationSchema = z.strictObject({ operation: z.literal("configureQuiz"), blockId: id, quizId: id,
  title: line(1, 300), kind: z.enum(["assessment", "knowledge_check", "final_exam"]), passingScore: z.number().int().min(0).max(100),
  maxAttempts: z.number().int().min(1).max(2147483647).nullable(), shuffleQuestions: z.boolean(), shuffleAnswers: z.boolean(), revealsAnswersAfterAttempt: z.boolean() })
  .refine(value => !value.revealsAnswersAfterAttempt || value.kind === "knowledge_check");
export const questionChangeSchema = z.strictObject({ operation: z.literal("saveQuestion"), quizId: id, questionId: id,
  prompt: nonblank, type: z.enum(["single_choice", "multiple_choice", "true_false"]), points: z.number().int().min(1).max(2147483647),
  topicCode: line(1, 128).nullable(), topicLabel: line(1, 300).nullable(), explanation: prose.nullable(),
  answers: z.array(z.strictObject({ answerId: id, text: nonblank, correct: z.boolean() })).min(2).max(100), removedAnswerIds: ids(0, 100) })
  .refine(value => new Set(value.answers.map(answer => answer.answerId)).size === value.answers.length)
  .refine(value => value.removedAnswerIds.every(removed => !value.answers.some(answer => answer.answerId === removed)))
  .refine(value => value.type === "multiple_choice" ? value.answers.some(answer => answer.correct) : value.answers.filter(answer => answer.correct).length === 1);
export const structureChangeSchema = z.union([
  addLesson,
  z.strictObject({ operation: z.literal("editLesson"), blockId: id, patch: editLessonPatchSchema }),
  z.strictObject({ operation: z.literal("removeLesson"), blockId: id, removedQuestionIds: ids(0, 500) }),
  z.strictObject({ operation: z.literal("reorderLessons"), blockIds: ids(1, 500) }),
  quizConfigurationSchema, questionChangeSchema,
  z.strictObject({ operation: z.literal("removeQuestion"), quizId: id, questionId: id }),
  z.strictObject({ operation: z.literal("reorderQuestions"), quizId: id, questionIds: ids(1, 500) }),
]);
export const structureChangesSchema = z.array(structureChangeSchema).min(1).max(20)
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 24_576)
  .refine(value => !containsGovernedCredentials(JSON.stringify(value)));
export type StructureChange = z.infer<typeof structureChangeSchema>;
export type QuestionChange = z.infer<typeof questionChangeSchema>;
export type QuizConfiguration = z.infer<typeof quizConfigurationSchema>;
export type LessonPatch = z.infer<typeof editLessonPatchSchema>;
