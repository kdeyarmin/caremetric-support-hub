import { describe, expect, it } from "vitest";
import { draftDocumentSchema, learnerDocumentSchema, newDocument, newUnit, safeLearningPath } from "./model";
describe("learning input contracts", () => {
  it("requires completed course fields before save", () => {
    expect(draftDocumentSchema.safeParse(newDocument([])).success).toBe(false);
  });
  it("does not propagate author-only fields into learner state", () => {
    const unit = newUnit("quiz");
    if (unit.type !== "quiz") throw new Error("Fixture type");
    unit.questions[0].prompt = "Choose an option";
    unit.questions[0].options.forEach((o, i) => o.text = `Option ${i}`);
    const data = { ...newDocument([crypto.randomUUID()]), title: "Quiz course", units: [unit] };
    expect(JSON.stringify(learnerDocumentSchema.parse(data))).not.toContain("correctOptionId");
  });
  it.each(["//evil.example/learn", "/learn/../../library", "/learn?token=secret", "/learn/courses/patient-name", "/library/courses/new?email=someone@example.com"])("rejects unsafe login return path %s", value => {
    expect(safeLearningPath(value)).toBeNull();
  });
  it.each(["/learn", "/learn/my", "/library/courses/new", "/learn/courses/29c80fca-dfb6-440e-af91-632fab380423"])("preserves approved learning route %s", value => expect(safeLearningPath(value)).toBe(value));
});
