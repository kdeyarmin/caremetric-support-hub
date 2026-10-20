import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COURSE_PLACEMENT_PRODUCT_SLUGS, coursePlacementProductIds, prepareLearningImport } from "./learningImport";

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

const placementProducts = [
  { id: "10000000-0000-4000-8000-000000000001", slug: "carebase", status: "active" },
  { id: "10000000-0000-4000-8000-000000000002", slug: "pennsync", status: "active" },
  { id: "10000000-0000-4000-8000-000000000003", slug: "breathe", status: "pilot" },
  { id: "10000000-0000-4000-8000-000000000004", slug: "caremetric-emr", status: "retired" },
  { id: "10000000-0000-4000-8000-000000000005", slug: "caremetric-go", status: "active" },
  { id: "10000000-0000-4000-8000-000000000006", slug: "caremetric-intel", status: "active" },
  { id: "10000000-0000-4000-8000-000000000007", slug: "advisors", status: "active" },
];
const eligibleProductIds = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000005",
  "10000000-0000-4000-8000-000000000006",
];
describe("course placement products", () => {
  it("keeps only the non-retired placement-eligible products", () => {
    expect(coursePlacementProductIds(placementProducts)).toEqual(eligibleProductIds);
  });
  it("places imported documents on exactly that set", () => {
    const [result] = prepareLearningImport(source, coursePlacementProductIds(placementProducts));
    expect(result.document.productIds).toEqual(eligibleProductIds);
  });
  it("keeps the client placement allowlist inside the server validator's allowlist", () => {
    const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
    const functionStart = schema.indexOf("create function private.validate_learning_document");
    expect(functionStart).toBeGreaterThan(-1);
    const bodyStart = schema.indexOf("$$", functionStart);
    const validatorBody = schema.slice(bodyStart, schema.indexOf("$$", bodyStart + 2));
    const allowlist = validatorBody.match(/p\.slug in \(([^)]*)\)/)?.[1] ?? "";
    const serverSlugs = [...allowlist.matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect(serverSlugs.length).toBeGreaterThan(0);
    for (const slug of COURSE_PLACEMENT_PRODUCT_SLUGS) expect(serverSlugs).toContain(slug);
  });
});
