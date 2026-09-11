import { expect, it } from "vitest";
import fixture from "../imports/fixtures/governedCourse.json";
import { validateGovernedCourse } from "../imports/governedLearningImport";
import { questionChangeSchema, structureChangesSchema } from "./structureProtocol";
const quiz = fixture.blocks[1].quiz!, question = quiz.questions[0];
const change = { operation: "saveQuestion", quizId: quiz.id, questionId: question.id, prompt: question.prompt,
  type: question.type, points: question.points, topicCode: question.topicCode, topicLabel: question.topicLabel, explanation: question.explanation,
  answers: question.options.map(option => ({ answerId: option.id, text: option.text, correct: option.correct })), removedAnswerIds: [] };
it("preserves native quiz weights and requires an atomic explicit answer set", () => {
  expect(questionChangeSchema.parse(change).points).toBe(101);
  for (const value of [{ ...change, type: "single_choice" }, { ...change, points: 0 },
    { ...change, answers: change.answers.map(answer => ({ ...answer, correct: false })) },
    { ...change, answers: [...change.answers, { ...change.answers[0], answerId: change.answers[0].answerId.toUpperCase() }] },
    { ...change, removedAnswerIds: [change.answers[0].answerId] }, { ...change, organizationId: "forged" },
    { ...change, prompt: " \n " }, { ...change, explanation: "bad\u0000text" }]) expect(questionChangeSchema.safeParse(value).success).toBe(false);
  expect(questionChangeSchema.parse({ ...change, answers: change.answers.slice(0, 2), removedAnswerIds: [change.answers[2].answerId] })).toBeDefined();
});
it("bounds compound structure changes and rejects native media or ownership fields", () => {
  const lesson = { operation: "addLesson", blockId: fixture.blocks[0].id, blockType: "text", title: null, body: {} };
  expect(structureChangesSchema.parse([lesson])).toHaveLength(1);
  for (const values of [[], Array.from({ length: 21 }, () => lesson),
    [{ ...lesson, body: { transcript: "wrong lesson type" } }], [{ ...lesson, body: { videoUrl: "https://example.invalid" } }],
    [{ ...lesson, organizationId: fixture.sourceCourseId }], [{ ...lesson, title: " untrimmed " }],
    [{ ...lesson, body: { content: "日".repeat(9000) } }],
    [{ ...lesson, body: { content: "https://media.test/video?token=private" } }],
    [{ operation: "reorderLessons", blockIds: [fixture.blocks[0].id, fixture.blocks[0].id.toUpperCase()] }],
    [{ operation: "editLesson", blockId: fixture.blocks[0].id, patch: {} }]]) expect(structureChangesSchema.safeParse(values).success).toBe(false);
});
it("permits incomplete quiz configuration only in draft source material", () => {
  const blocks = fixture.blocks.map(block => block.type === "quiz" ? { ...block, quiz: null } : block);
  expect(validateGovernedCourse({ ...fixture, sourceVersionState: "draft", blocks }).blocks[1].quiz).toBeNull();
  expect(() => validateGovernedCourse({ ...fixture, blocks })).toThrow("configuration");
  expect(() => validateGovernedCourse({ ...fixture, sourceVersionState: "draft", blocks: [{ ...fixture.blocks[0], quiz }] })).toThrow("configuration");
});
