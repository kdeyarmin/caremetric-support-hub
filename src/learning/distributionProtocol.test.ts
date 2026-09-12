import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import fixture from "../imports/fixtures/governedCourse.json";
import { distributionDomain, nativeDistributionOperationSchema, projectDistributionContext, distributionPlanSchema, distributionStatusDomain, projectDistributionStatuses } from "./distributionProtocol";
const id = fixture.sourceCourseId, version = fixture.sourceVersionId, sha = (text: string) => createHash("sha256").update(text).digest("hex");
const request = nativeDistributionOperationSchema.parse({ domain: distributionDomain, operation: "context", courseId: id });
function reply() {
  const payload = JSON.stringify(fixture);
  return { contractVersion: 1, product: "carebase", domain: distributionDomain, operation: "context", generatedAt: new Date().toISOString(),
    data: { courseId: id, publicationState: "published", currentVersionId: version, currentVersionState: "published", source: { payload, sourceRevision: sha(payload) } } };
}
it("accepts only exact authenticated current published source bytes", async () => {
  const value = reply(); expect(await projectDistributionContext(value, request)).toEqual(value.data);
  await expect(projectDistributionContext({ ...value, data: { ...value.data, currentVersionId: id } }, request)).rejects.toThrow();
  await expect(projectDistributionContext({ ...value, data: { ...value.data, source: { ...value.data.source, payload: value.data.source.payload + " " } } }, request)).rejects.toThrow();
  await expect(projectDistributionContext({ ...value, data: { ...value.data, source: { ...value.data.source, signedUrl: "https://private.test" } } }, request)).rejects.toThrow();
});
it.each(["draft", "archived"])("withholds source for a %s course even if an old version was published", async publicationState => {
  const value = reply(); await expect(projectDistributionContext({ ...value, data: { ...value.data, publicationState } }, request)).rejects.toThrow();
  expect((await projectDistributionContext({ ...value, data: { ...value.data, publicationState, source: null } }, request)).source).toBeNull();
});
it("does not confuse a draft payload with a published current version", async () => {
  const value = reply(), payload = JSON.stringify({ ...fixture, sourceVersionState: "draft" });
  await expect(projectDistributionContext({ ...value, data: { ...value.data, source: { payload, sourceRevision: sha(payload) } } }, request)).rejects.toThrow();
  expect(nativeDistributionOperationSchema.safeParse({ ...request, versionId: version }).success).toBe(false);
});
it("freezes a closed reviewed placement set and explicit removals", () => {
  const value = { courseId: id, versionId: version, sourceRevision: "a".repeat(64), expectedCatalogDigest: "b".repeat(64), metadata: { title: "Published course", summary: "Reviewed catalog summary", category: null, durationMinutes: 60 },
    productIds: [id], removedProductIds: [version], accessLevel: "customer", reason: "Review current course distribution", reviewed: true, confirmReplacement: true, confirmRetirements: true };
  expect(distributionPlanSchema.parse(value)).toEqual(value);
  for (const change of [{ productIds: [id, id] }, { removedProductIds: [id] }, { confirmRetirements: false }, { reviewed: false }, { targetUrl: "https://evil.test" }]) expect(distributionPlanSchema.safeParse({ ...value, ...change }).success).toBe(false);
});
it("accepts only a fresh exact read-only status set including tombstones", () => {
  const now = Date.now(), row = { courseId: id, publicationState: "missing", currentVersionId: null, currentVersionState: null, sourceRevision: null };
  const value = { contractVersion: 1, product: "carebase", domain: distributionStatusDomain, operation: "status", generatedAt: new Date(now).toISOString(), data: { items: [row] } };
  expect(projectDistributionStatuses(value, [id], now)).toEqual([row]);
  for (const data of [{ items: [row, row] }, { items: [{ ...row, courseId: version }] }, { items: [{ ...row, sourceRevision: "a".repeat(64) }] }, { items: [{ ...row, payload: "private" }] }]) expect(() => projectDistributionStatuses({ ...value, data }, [id], now)).toThrow();
  expect(() => projectDistributionStatuses({ ...value, generatedAt: new Date(now - 121_000).toISOString() }, [id], now)).toThrow();
  expect(() => projectDistributionStatuses({ ...value, generatedAt: new Date(now + 31_000).toISOString() }, [id], now)).toThrow();
});
