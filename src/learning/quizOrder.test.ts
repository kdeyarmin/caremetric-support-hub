import { describe, expect, it } from "vitest";
import { questionOrder } from "./quizOrder";

const questions = Array.from({ length: 8 }, (_, index) => ({ id: `q${index + 1}` }));
const attempt = (attemptNumber: number) => ({ enrollmentId: "enrollment-1", unitId: "quiz-1", attemptNumber });
const ids = (list: { id: string }[]) => list.map(question => question.id);

describe("quiz question order", () => {
  it("keeps every question exactly once", () => {
    for (let attemptNumber = 0; attemptNumber < 20; attemptNumber += 1) {
      expect([...ids(questionOrder(questions, attempt(attemptNumber)))].sort()).toEqual(ids(questions).sort());
    }
  });

  it("is the same for the same attempt, so the screen and a reload agree", () => {
    expect(ids(questionOrder(questions, attempt(3)))).toEqual(ids(questionOrder(questions, attempt(3))));
  });

  it("changes from one attempt to the next", () => {
    const orders = new Set(Array.from({ length: 10 }, (_, attemptNumber) => ids(questionOrder(questions, attempt(attemptNumber))).join(",")));
    expect(orders.size).toBeGreaterThan(5);
    expect(ids(questionOrder(questions, attempt(0)))).not.toEqual(ids(questionOrder(questions, attempt(1))));
  });

  it("does not change the questions it is given", () => {
    const original = ids(questions);
    questionOrder(questions, attempt(1));
    expect(ids(questions)).toEqual(original);
    expect(questionOrder([], attempt(1))).toEqual([]);
  });
});
