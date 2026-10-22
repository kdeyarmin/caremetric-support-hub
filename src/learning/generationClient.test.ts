import { afterEach, expect, it, vi } from "vitest";
import { GenerationError, generationFailure, runGeneration } from "./generationClient";
vi.mock("../lib/config", () => ({ config: { demoMode: false } }));
const id = "ffffffff-0000-0000-0000-000000000001";
const status = { operation: "video.status" as const, request: { course_block_id: id } };
afterEach(() => { vi.unstubAllGlobals(); });
it("posts the exact operation to the Hub and checks the result", async () => {
  const fetchMock = vi.fn(async () => Response.json({ operation: "video.status", result: { success: true, status: "processing" } }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await runGeneration(status, new AbortController().signal)).toEqual({ status: "processing", error: null });
  expect(fetchMock).toHaveBeenCalledWith("/api/admin/learning-generation", expect.objectContaining({ method: "POST", body: JSON.stringify(status), redirect: "error", credentials: "same-origin" }));
});
it("keeps a reviewed code and CareBase's administrator message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "conflict", message: "Another render is pending for this lesson." } }, { status: 409 })));
  const caught = await runGeneration(status, new AbortController().signal).catch(error => error);
  expect(caught).toBeInstanceOf(GenerationError); expect(caught).toMatchObject({ code: "conflict", detail: "Another render is pending for this lesson." });
  expect(generationFailure(caught, "fallback")).toBe("Another render is pending for this lesson.");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "private_code", message: 7 } }, { status: 502 })));
  expect(await runGeneration(status, new AbortController().signal).catch(error => error)).toMatchObject({ code: "upstream", detail: null });
  expect(generationFailure(new GenerationError("timeout", null), "fallback")).toMatch(/time limit/);
  expect(generationFailure(new Error("other"), "fallback")).toBe("fallback");
});
