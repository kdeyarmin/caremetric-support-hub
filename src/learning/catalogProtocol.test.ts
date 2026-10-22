import { describe, expect, it } from "vitest";
import { catalogOperationSchema, projectCatalogResult } from "./catalogProtocol";
const id = "dddddddd-0000-0000-0000-000000000001", course = "dddddddd-0000-0000-0000-000000000002", other = "dddddddd-0000-0000-0000-000000000003";
const collection = { id, title: "Wound care electives", description: "Line one\nLine two", interests: ["wound care"], jobTitles: ["LPN"], published: true, courseIds: [course] };
const lesson = { id, courseId: null, title: "Hand hygiene refresher", body: "Clean hands before and after every resident contact.\tAlways.", question: "When do you clean your hands?",
  choices: ["Before and after contact", "Only after contact"], correctChoice: 0, explanation: "Both times protect the resident.", minutes: 3, published: true };
const metadata = { courseId: course, language: "English", creditStatement: "Approved for 1 hour.", creditEvidenceUrl: "https://example.org/approval" };
const kit = { id, revision: null, name: "New PCH hire", description: "", items: [{ courseId: course, isRequired: true }], published: true };
const save = <T extends string, K extends string, R>(operation: T, key: K, record: R) => ({ operation, requestId: id, [key]: record });
describe("training library operations", () => {
  it("accepts complete records exactly as CareBase does", () => {
    for (const value of [save("collections.save", "collection", collection), save("refreshers.save", "lesson", lesson), save("metadata.save", "metadata", metadata),
      save("starterKits.save", "kit", kit), save("metadata.save", "metadata", { courseId: course, language: null, creditStatement: null, creditEvidenceUrl: null }),
      { operation: "catalog.read", section: "starterKits", after: null }, { operation: "catalog.read", section: "lessons", after: course }])
      expect(catalogOperationSchema.parse(value)).toEqual(value);
  });
  it("refuses records CareBase would refuse", () => {
    for (const value of [
      save("collections.save", "collection", { ...collection, courseIds: [] }),
      save("collections.save", "collection", { ...collection, courseIds: [course, course.toUpperCase()] }),
      save("collections.save", "collection", { ...collection, title: " padded" }),
      save("collections.save", "collection", { ...collection, interests: ["two\nlines"] }),
      save("refreshers.save", "lesson", { ...lesson, body: "too short" }),
      save("refreshers.save", "lesson", { ...lesson, correctChoice: 2 }),
      save("refreshers.save", "lesson", { ...lesson, choices: ["only one"] }),
      save("refreshers.save", "lesson", { ...lesson, minutes: 6 }),
      save("metadata.save", "metadata", { ...metadata, creditEvidenceUrl: null }),
      save("metadata.save", "metadata", { ...metadata, creditEvidenceUrl: "http://example.org/approval" }),
      save("starterKits.save", "kit", { ...kit, items: [] }),
      save("starterKits.save", "kit", { ...kit, name: "A" }),
      save("starterKits.save", "kit", { ...kit, items: [{ courseId: course, isRequired: true }, { courseId: course, isRequired: false }] }),
      save("starterKits.save", "kit", { ...kit, description: "https://cdn.example.org/a.mp4?token=abc" }),
      { ...save("starterKits.save", "kit", kit), requestId: "not-an-id" },
      { operation: "catalog.read", section: "collections", after: null, extra: true },
      { operation: "catalog.read", section: "users", after: null },
    ]) expect(catalogOperationSchema.safeParse(value).success).toBe(false);
    // Every field within its character limit, but three-byte characters overrun the 48 KB request cap.
    const huge = save("refreshers.save", "lesson", { ...lesson, body: "€".repeat(12_000), explanation: "€".repeat(3000), question: "€".repeat(1000),
      choices: ["€".repeat(1000), "€".repeat(1000), "€".repeat(1000), "€".repeat(1000)] });
    expect(catalogOperationSchema.safeParse(huge).success).toBe(false);
  });
  it("checks pages continue from their last record and saves return their own record", () => {
    const stored = { ...collection, updatedAt: "2026-10-22T12:00:00Z" };
    const read = { operation: "catalog.read" as const, section: "collections" as const, after: null };
    expect(projectCatalogResult({ section: "collections", items: [stored], nextAfter: id }, read)).toEqual({ section: "collections", items: [stored], nextAfter: id });
    expect(() => projectCatalogResult({ section: "collections", items: [stored], nextAfter: other }, read)).toThrow();
    expect(() => projectCatalogResult({ section: "collections", items: [], nextAfter: id }, read)).toThrow();
    expect(() => projectCatalogResult({ section: "lessons", items: [], nextAfter: null }, read)).toThrow();
    expect(() => projectCatalogResult({ section: "collections", items: [{ ...stored, secret: "x" }], nextAfter: null }, read)).toThrow();
    const metadataRead = { operation: "catalog.read" as const, section: "metadata" as const, after: null };
    expect(projectCatalogResult({ section: "metadata", items: [metadata], nextAfter: course }, metadataRead)).toEqual({ section: "metadata", items: [metadata], nextAfter: course });
    const kitSave = catalogOperationSchema.parse(save("starterKits.save", "kit", kit));
    const storedKit = { ...kit, revision: 1, updatedAt: "2026-10-22T12:00:00Z" };
    expect(projectCatalogResult({ kit: storedKit }, kitSave)).toEqual({ kit: storedKit });
    expect(() => projectCatalogResult({ kit: { ...storedKit, id: other } }, kitSave)).toThrow();
    const metadataSave = catalogOperationSchema.parse(save("metadata.save", "metadata", metadata));
    expect(projectCatalogResult({ id: course.toUpperCase() }, metadataSave)).toEqual({ id: course.toUpperCase() });
    expect(() => projectCatalogResult({ id }, metadataSave)).toThrow();
  });
});
