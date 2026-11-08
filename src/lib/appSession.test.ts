// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./config", () => ({ config: { demoMode: false } }));
import { appRequest, sessionEvent } from "./appSession";

const answer = (status: number, body: unknown) => vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));
afterEach(() => vi.restoreAllMocks());

describe("appRequest errors", () => {
  it("shows the server's message, plain or attached to a code the server marked as safe to show", async () => {
    answer(400, { error: "Choose a conversation." });
    await expect(appRequest("communications/get", {})).rejects.toThrow("Choose a conversation.");
    answer(502, { error: { code: "delivery_unsettled", message: "Check the conversation before sending again." } });
    await expect(appRequest("communications/reply", {})).rejects.toThrow("Check the conversation before sending again.");
  });
  it("falls back to a generic message for a bare code", async () => {
    answer(503, { error: { code: "upstream" } });
    await expect(appRequest("communications/sync", {})).rejects.toThrow("The request could not be completed.");
  });
  it("handles non-JSON gateway failures without showing a parser error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(appRequest("communications/get", {})).rejects.toThrow("The request could not be completed. Please try again.");
  });
  it("reports session expiry even if the unauthorized response is empty", async () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    await expect(appRequest("communications/get", {})).rejects.toThrow("The request could not be completed.");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: sessionEvent }));
  });
  it("handles a JSON null error body", async () => {
    answer(503, null);
    await expect(appRequest("communications/get", {})).rejects.toThrow("The request could not be completed.");
  });
});
