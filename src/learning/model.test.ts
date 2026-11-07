import { describe, expect, it } from "vitest";
import { draftDocumentSchema, draftSchema, learnerDocumentSchema, newDocument, newUnit, safeLearningPath } from "./model";
describe("learning input contracts", () => {
  it("requires completed course fields before save", () => {
    expect(draftDocumentSchema.safeParse(newDocument([])).success).toBe(false);
  });
  it("accepts seeded catalog ids whose UUID variant nibble is not RFC 4122", () => {
    const unit = newUnit("text");
    if (unit.type !== "text") throw new Error("Fixture type");
    unit.body = "Lesson body";
    const document = { ...newDocument([crypto.randomUUID()]), title: "Imported course", units: [unit] };
    // Postgres returns this id happily; z.uuid() rejected it, which made the
    // import loop report 0 imported after the server had already succeeded.
    const draft = { itemId: "afff6e38-7c82-2cd7-2a8b-cc1eb91289c7", draftVersion: 1, document, published: false };
    expect(draftSchema.safeParse(draft).success).toBe(true);
    expect(draftSchema.safeParse({ ...draft, itemId: "not-a-uuid" }).success).toBe(false);
  });
  it("accepts a draft document placed on all seven registered products", () => {
    const unit = newUnit("text");
    if (unit.type !== "text") throw new Error("Fixture type");
    unit.body = "Lesson body";
    // The registry grew to seven products after the schema capped placements
    // at six, which made the import panel reject every imported course.
    const productIds = Array.from({ length: 7 }, () => crypto.randomUUID());
    const document = { ...newDocument(productIds), title: "Imported course", units: [unit] };
    expect(draftDocumentSchema.safeParse(document).success).toBe(true);
  });
  it("does not propagate author-only fields into learner state", () => {
    const unit = newUnit("quiz");
    if (unit.type !== "quiz") throw new Error("Fixture type");
    unit.questions[0].prompt = "Choose an option";
    unit.questions[0].options.forEach((o, i) => o.text = `Option ${i}`);
    const data = { ...newDocument([crypto.randomUUID()]), title: "Quiz course", units: [unit] };
    expect(JSON.stringify(learnerDocumentSchema.parse(data))).not.toContain("correctOptionId");
  });
  it("holds select-all questions with a set of correct options and keeps the set out of learner state", () => {
    const unit = newUnit("quiz");
    if (unit.type !== "quiz") throw new Error("Fixture type");
    const [a, b] = unit.questions[0].options.map((o, i) => ({ ...o, text: `Option ${i}` }));
    const c = { id: crypto.randomUUID(), text: "Option 2" };
    const selectAll = { id: unit.questions[0].id, prompt: "Choose every correct option", points: 1, options: [a, b, c], correctOptionIds: [a.id, c.id] };
    const data = { ...newDocument([crypto.randomUUID()]), title: "Select-all course", units: [{ ...unit, questions: [selectAll] }] };
    const parsed = draftDocumentSchema.parse(data);
    expect(parsed.units[0].type === "quiz" && parsed.units[0].questions[0]).toEqual(selectAll);
    const withKeys = (keys: string[]) => draftDocumentSchema.safeParse({ ...data, units: [{ ...unit, questions: [{ ...selectAll, correctOptionIds: keys }] }] }).success;
    expect(withKeys([])).toBe(false);
    expect(withKeys([a.id, a.id])).toBe(false);
    expect(withKeys([a.id, crypto.randomUUID()])).toBe(false);
    const learner = learnerDocumentSchema.parse({ ...data, units: [{ ...unit, questions: [{ ...selectAll, correctOptionIds: undefined, multiple: true }] }] });
    expect(learner.units[0].type === "quiz" && learner.units[0].questions[0].multiple).toBe(true);
    expect(JSON.stringify(learnerDocumentSchema.parse(data))).not.toContain("correctOptionIds");
  });
  it.each(["//evil.example/learn", "/learn/../../library", "/learn?token=secret", "/learn/courses/patient-name", "/library/courses/new?email=someone@example.com"])("rejects unsafe login return path %s", value => {
    expect(safeLearningPath(value)).toBeNull();
  });
  it.each(["/learn", "/learn/my", "/library/courses/new", "/learn/courses/29c80fca-dfb6-440e-af91-632fab380423"])("preserves approved learning route %s", value => expect(safeLearningPath(value)).toBe(value));
});
