import type { GovernedCourse } from "../imports/governedLearningImport";
import type { LessonPatch, StructureChange } from "./structureProtocol";

export type Lesson = GovernedCourse["blocks"][number];
export type Quiz = NonNullable<Lesson["quiz"]>;
export type Question = Quiz["questions"][number];
const bodyKeys = { estimatedMinutes: "estimated_minutes", activityType: "activity_type", content: "content", transcript: "transcript", attestationText: "attestation_text", attestationVersion: "attestation_version" } as const;
export type BodyKey = keyof typeof bodyKeys;
export function bodyObject(block: Lesson): Record<string, unknown> | null {
  return block.body == null ? {} : typeof block.body === "object" && !Array.isArray(block.body) ? block.body : null;
}
export function bodyValue(block: Lesson, field: BodyKey) { return bodyObject(block)?.[bodyKeys[field]]; }
export function fieldEditable(block: Lesson, field: BodyKey) {
  const body = bodyObject(block), value = body?.[bodyKeys[field]];
  return body !== null && (value == null || typeof value === (field === "estimatedMinutes" ? "number" : "string"));
}
export function updateBody(block: Lesson, field: BodyKey, value: string | number): Lesson {
  return { ...block, body: { ...bodyObject(block), [bodyKeys[field]]: value } as Lesson["body"] };
}
function fields(block: Lesson): BodyKey[] {
  return ["estimatedMinutes", "activityType", ...(block.type === "text" ? ["content" as const] : block.type === "video" ? ["transcript" as const] : block.type === "attestation" ? ["attestationText" as const, "attestationVersion" as const] : [])];
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function quizConfiguration(block: Lesson) {
  const quiz = block.quiz!;
  return { operation: "configureQuiz" as const, blockId: block.id, quizId: quiz.id, title: quiz.title, kind: quiz.kind,
    passingScore: quiz.passingScore, maxAttempts: quiz.maxAttempts, shuffleQuestions: quiz.shuffleQuestions,
    shuffleAnswers: quiz.shuffleAnswers, revealsAnswersAfterAttempt: quiz.revealsAnswersAfterAttempt };
}
function questionChange(quizId: string, question: Question, original?: Question) {
  return { operation: "saveQuestion" as const, quizId, questionId: question.id, prompt: question.prompt, type: question.type,
    points: question.points, topicCode: question.topicCode, topicLabel: question.topicLabel, explanation: question.explanation,
    answers: question.options.map(answer => ({ answerId: answer.id, text: answer.text, correct: answer.correct })),
    removedAnswerIds: original?.options.filter(answer => !question.options.some(current => current.id === answer.id)).map(answer => answer.id) ?? [] };
}
export function structureDiff(original: Lesson[], current: Lesson[]): StructureChange[] {
  const changes: StructureChange[] = [];
  for (const block of original) if (!current.some(value => value.id === block.id)) {
    changes.push({ operation: "removeLesson", blockId: block.id, removedQuestionIds: block.quiz?.questions.map(question => question.id) ?? [] });
  }
  for (const block of current) {
    const before = original.find(value => value.id === block.id);
    const body: Record<string, unknown> = {};
    for (const field of fields(block)) {
      const value = bodyValue(block, field);
      if (value !== undefined && (!before || !same(value, bodyValue(before, field)))) body[field] = value;
    }
    if (!before) changes.push({ operation: "addLesson", blockId: block.id, blockType: block.type, title: block.title, body } as StructureChange);
    else {
      const patch = { ...(block.title !== before.title ? { title: block.title } : {}), ...body } as LessonPatch;
      if (Object.keys(patch).length) changes.push({ operation: "editLesson", blockId: block.id, patch });
    }
    if (!block.quiz) continue;
    if (!before?.quiz || !same(quizConfiguration(block), quizConfiguration(before))) changes.push(quizConfiguration(block));
    const oldQuestions = before?.quiz?.questions ?? [];
    for (const question of oldQuestions) if (!block.quiz.questions.some(value => value.id === question.id)) {
      changes.push({ operation: "removeQuestion", quizId: block.quiz.id, questionId: question.id });
    }
    for (const question of block.quiz.questions) {
      const old = oldQuestions.find(value => value.id === question.id);
      if (!old || !same(questionChange(block.quiz.id, question, old), questionChange(block.quiz.id, old, old))) changes.push(questionChange(block.quiz.id, question, old));
    }
    const natural = [...oldQuestions.filter(question => block.quiz!.questions.some(value => value.id === question.id)), ...block.quiz.questions.filter(question => !oldQuestions.some(value => value.id === question.id))].map(question => question.id);
    const wanted = block.quiz.questions.map(question => question.id);
    if (wanted.length && !same(natural, wanted)) changes.push({ operation: "reorderQuestions", quizId: block.quiz.id, questionIds: wanted });
  }
  const natural = [...original.filter(block => current.some(value => value.id === block.id)), ...current.filter(block => !original.some(value => value.id === block.id))].map(block => block.id);
  const wanted = current.map(block => block.id);
  if (wanted.length && !same(natural, wanted)) changes.push({ operation: "reorderLessons", blockIds: wanted });
  return changes;
}
export function move<T>(values: T[], index: number, offset: -1 | 1): T[] {
  if (index + offset < 0 || index + offset >= values.length) return values;
  const next = [...values]; [next[index], next[index + offset]] = [next[index + offset]!, next[index]!]; return next;
}
