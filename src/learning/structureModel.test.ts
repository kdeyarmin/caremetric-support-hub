import { expect, it } from "vitest";
import fixture from "../imports/fixtures/governedCourse.json";
import { validateGovernedCourse } from "../imports/governedLearningImport";
import { move, structureDiff, updateBody } from "./structureModel";
import { structureChangesSchema } from "./structureProtocol";

it("preserves media and legacy fields while atomically replacing a weighted question's answer set", () => {
  const original = validateGovernedCourse(fixture).blocks, current = structuredClone(original);
  const quizBlock = current.find(block => block.quiz)!;
  const question = quizBlock.quiz!.questions[0]!;
  const removed = question.options[0]!.id;
  question.options = question.options.slice(1);
  question.options[0]!.correct = true;
  question.prompt += " Revised"; question.points = 101; question.explanation = "The exact reviewed explanation.";
  const changes = structureChangesSchema.parse(structureDiff(original, current));
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ operation: "saveQuestion", questionId: question.id, points: 101, removedAnswerIds: [removed] });
  expect(JSON.stringify(changes)).not.toContain("videoLocatorSha256");
  expect(current.filter(block => block.type !== "quiz")).toEqual(original.filter(block => block.type !== "quiz"));
});
it("makes descendant removals explicit and orders the complete surviving set after deletion", () => {
  const original = validateGovernedCourse(fixture).blocks;
  const removed = original.find(block => block.quiz)!;
  const surviving = original.filter(block => block.id !== removed.id);
  const changes = structureChangesSchema.parse(structureDiff(original, move(surviving, 0, 1)));
  expect(changes).toEqual([
    { operation: "removeLesson", blockId: removed.id, removedQuestionIds: removed.quiz!.questions.map(question => question.id) },
    { operation: "reorderLessons", blockIds: move(surviving, 0, 1).map(block => block.id) },
  ]);
});
it("emits sparse typed body changes and does not reset untouched authored fields", () => {
  const original = validateGovernedCourse(fixture).blocks;
  const attestation = original.find(block => block.type === "attestation")!;
  const edited = updateBody(attestation, "attestationText", "I verified this revised practice.");
  const changes = structureChangesSchema.parse(structureDiff(original, original.map(block => block.id === edited.id ? edited : block)));
  expect(changes).toEqual([{ operation: "editLesson", blockId: edited.id, patch: { attestationText: "I verified this revised practice." } }]);
  expect(structureDiff(original, structuredClone(original))).toEqual([]);
});
