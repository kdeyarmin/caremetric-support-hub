import { afterEach, expect, it, vi } from "vitest";
import { packageClient, encodePackageHeader, hashPackage } from "./packageClient";
import { packageContext, packageCourseId, packageVersionId, packageRequestId, packageSha } from "./packageFixtures";
import { PACKAGE_RESPONSE_BYTES } from "./packageProtocol";
vi.mock("../lib/config", () => ({ config: { demoMode: false } }));
vi.mock("../admin/portfolioClient", () => ({ portfolioClient: { capabilities: vi.fn() } }));
afterEach(() => { vi.unstubAllGlobals(); });
const operation = { operation: "context" as const, courseId: packageCourseId, versionId: packageVersionId, packageId: null };
it("uses only the same-origin session gateway and rejects private response fields", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(packageContext)).mockResolvedValueOnce(Response.json({ ...packageContext, signedUrl: "https://private.test" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await packageClient.context(operation, new AbortController().signal)).toEqual(packageContext);
  expect(fetcher).toHaveBeenCalledWith("/api/admin/packages", expect.objectContaining({ method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", body: JSON.stringify(operation) }));
  await expect(packageClient.context(operation, new AbortController().signal)).rejects.toThrow();
});
it("hashes original exact file bytes and sends canonical closed metadata alongside the unchanged File", async () => {
  const file = new File([new Uint8Array([80, 75, 0, 255])], "authored.zip", { type: "application/zip" });
  const sourceSha256 = await hashPackage(file);
  expect(sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  const upload = { operation: "upload" as const, courseId: packageCourseId, versionId: packageVersionId, requestId: packageRequestId, sourceRevision: packageSha,
    sourceSha256, sourceBytes: file.size, reason: "Review résumé package bytes", standard: "xapi" as const };
  const header = encodePackageHeader(upload); expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual(upload);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: "busy", body: "private upstream details" } }, { status: 503 }));
  vi.stubGlobal("fetch", fetcher); await expect(packageClient.stage(upload, file, new AbortController().signal)).rejects.toMatchObject({ code: "busy" });
  expect(fetcher).toHaveBeenCalledWith("/api/admin/packages", expect.objectContaining({ body: file, headers: { "Content-Type": "application/zip", "x-caremetric-package-request": header } }));
  await expect(hashPackage(new File([], "empty.zip"))).rejects.toMatchObject({ code: "payload_too_large" });
});
it("caps response bytes and cancels an interrupted response read", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(" ".repeat(PACKAGE_RESPONSE_BYTES + 1))));
  await expect(packageClient.context(operation, new AbortController().signal)).rejects.toMatchObject({ code: "upstream" });
  const cancelled = vi.fn(); let begun!: () => void; const ready = new Promise<void>(resolve => { begun = resolve; });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { begun(); return new Response(new ReadableStream({ cancel: cancelled })); }));
  const controller = new AbortController(), request = packageClient.context(operation, controller.signal); await ready;
  controller.abort(); await expect(request).rejects.toThrow(); expect(cancelled).toHaveBeenCalledOnce();
});
