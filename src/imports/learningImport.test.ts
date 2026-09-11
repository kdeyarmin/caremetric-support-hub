import { describe, expect, it } from "vitest";
import { prepareLearningImport } from "./learningImport";

const courseId = "e4e3090e-19cb-4d83-99e3-ec8aea17304a";
const unitId = "29c80fca-dfb6-440e-af91-632fab380423";
const source = [{ id: courseId, versionId: unitId, versionNumber: 1, title: "Fixture course", description: "A".repeat(700), category: "Testing", durationMinutes: 10, units: [{ id: unitId, type: "video", title: "Video lesson", body: null, script: "Reviewed transcript", attestation: null, videoUrl: "storage://private-source/lesson.mp4", quiz: null }] }];
describe("central course import", () => {
  it("keeps full source descriptions and blocks publication until video transfer is approved", () => {
    const [result] = prepareLearningImport(source, [courseId]);
    expect(result.document.overview).toHaveLength(700);
    expect(result.document.summary).toHaveLength(500);
    expect(result.pendingVideoIds).toEqual([unitId]);
    expect(result.document.units[0].type === "video" && result.document.units[0].mediaAssetId).toBeNull();
    expect(JSON.stringify(result)).not.toContain("storage://");
  });
  it("uses reviewed central media mappings and preserves unit ids", () => {
    const [result] = prepareLearningImport(source, [courseId], { [unitId]: courseId });
    expect(result.pendingVideoIds).toEqual([]);
    expect(result.document.units[0]).toMatchObject({ id: unitId, mediaAssetId: courseId });
  });
  it("rejects unsupported source blocks rather than silently omitting content", () => {
    expect(() => prepareLearningImport([{ ...source[0], units: [{ ...source[0].units[0], type: "scenario" }] }], [courseId])).toThrow();
  });
});
