import { describe, expect, it, vi } from "vitest";
import { fixtureManifest, articleBytes } from "./publicationFixtures";
import { previewPublicationImport, previewPublicationImportWithVerifier, validatePublicationManifest } from "./publicationImportPreview";
import { assertPublicationConfirmations, parsePublicationStage, parsePublicationStageRequest, publicationCommitSchema, publicationConfirmationIds } from "./publicationProtocol";
import { createPublicationClient } from "./publicationClient";

describe("publication executor contract", () => {
  it("uses the same deterministic planner after a server verifier and propagates verification failure", async () => {
    const manifest = await fixtureManifest();
    const bytesPlan = await previewPublicationImport({ manifest, assets: { primary: articleBytes }, existing: null });
    const verify = vi.fn(async () => {});
    expect(await previewPublicationImportWithVerifier({ manifest, existing: null }, verify)).toEqual(bytesPlan);
    expect(verify).toHaveBeenCalledOnce();
    await expect(previewPublicationImportWithVerifier({ manifest, existing: null }, async () => { throw new Error("bad bytes"); })).rejects.toThrow("bad bytes");
  });
  it("does not treat export governance as Hub editor approval", async () => {
    const manifest = await fixtureManifest();
    expect(() => parsePublicationStageRequest({ manifest })).toThrow();
    expect(() => parsePublicationStageRequest({ manifest, sourceReviewConfirmed: false })).toThrow();
    expect(() => parsePublicationStageRequest({ manifest, sourceReviewConfirmed: true, role: "platform_admin" })).toThrow();
    expect(parsePublicationStageRequest({ manifest, sourceReviewConfirmed: true }).manifest).toEqual(manifest);
  });
  it("rejects copied URLs, unregistered products, and extra artifact selectors", async () => {
    const manifest = await fixtureManifest();
    for (const input of [
      { ...manifest, artifact: { ...manifest.artifact, url: "https://example.invalid/private" } },
      { ...manifest, content: { ...manifest.content, summary: "Read https://example.invalid/private" } },
      { ...manifest, placements: [{ product_slug: "unknown", audience: ["all"], route_pattern: null }] },
    ]) expect(() => validatePublicationManifest(input)).toThrow();
  });
  it("binds every destructive confirmation to its exact action index and rejects duplicates", async () => {
    const manifest = await fixtureManifest();
    const plan = await previewPublicationImport({ manifest, assets: { primary: articleBytes }, existing: null });
    const review = { ...plan, actions: [{ type: "retire_content_preview" as const, revision: 1, requiresExplicitApproval: true as const }] };
    expect(publicationConfirmationIds(review)).toEqual(["0:retire_content_preview"]);
    expect(() => assertPublicationConfirmations(review, [])).toThrow();
    expect(() => assertPublicationConfirmations(review, ["0:retire_content_preview", "0:retire_content_preview"])).toThrow();
    expect(() => assertPublicationConfirmations(review, ["1:retire_content_preview"])).toThrow();
    expect(() => assertPublicationConfirmations(review, ["0:retire_content_preview"])).not.toThrow();
  });
  it("rejects response paths, undeclared uploads and mismatched plan content keys", async () => {
    const manifest = await fixtureManifest();
    const plan = await previewPublicationImport({ manifest, assets: { primary: articleBytes }, existing: null });
    const stage = { id: crypto.randomUUID(), expiresAt: "2026-09-11T14:00:00Z", manifest, uploadedParts: ["primary"], plan };
    expect(parsePublicationStage(stage).plan).toEqual(plan);
    for (const input of [{ ...stage, storagePath: "private/object" }, { ...stage, uploadedParts: ["primary", "primary"] }, { ...stage, uploadedParts: ["transcript"] }, { ...stage, plan: { ...plan, contentKey: "other-guide" } }]) expect(() => parsePublicationStage(input)).toThrow();
  });
  it("keeps commit inputs closed and requires explicit final approval", () => {
    const request = { planIdentity: `sha256:${"a".repeat(64)}`, idempotencyKey: crypto.randomUUID(), confirmedActions: [], reviewConfirmed: true };
    expect(() => publicationCommitSchema.parse(request)).not.toThrow();
    for (const bad of [{ ...request, reviewConfirmed: false }, { ...request, uploaded: true }, { ...request, idempotencyKey: "arbitrary" }]) expect(() => publicationCommitSchema.parse(bad)).toThrow();
  });
  it("keeps every browser request same-origin and surfaces revocation instead of inventing a result", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 403 }));
    const client = createPublicationClient(fetcher);
    await expect(client.stage(await fixtureManifest())).rejects.toMatchObject({ status: 403 });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/publications/imports/stage");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", redirect: "error", cache: "no-store" });
  });
});
