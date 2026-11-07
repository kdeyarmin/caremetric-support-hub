import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./config", () => ({ config: { demoMode: false } }));
import { appRequest } from "./appSession";

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
});
