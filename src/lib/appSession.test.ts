// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./config", () => ({ config: { demoMode: false } }));
import { appRequest, responseErrorMessage, sessionEvent } from "./appSession";

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

describe("session expiry from sign-in routes", () => {
  it("is reported when reading the password settings, but not for a wrong password", async () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    answer(401, { error: "Sign in to manage your password." });
    await expect(appRequest("auth/password/settings")).rejects.toThrow("Sign in to manage your password.");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: sessionEvent }));
    dispatch.mockClear();
    answer(401, { error: "The current password is incorrect." });
    await expect(appRequest("auth/password/settings", { username: "owner", password: "x".repeat(10) })).rejects.toThrow();
    await expect(appRequest("auth/password/login", { username: "owner", password: "x".repeat(10) })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("responseErrorMessage", () => {
  it("reads a plain message or one attached to a code, and nothing else", () => {
    expect(responseErrorMessage({ error: "Choose a conversation." })).toBe("Choose a conversation.");
    expect(responseErrorMessage({ error: { code: "conflict", message: "This changed." } })).toBe("This changed.");
    for (const value of [{ error: { code: "upstream" } }, { error: { message: 5 } }, { error: null }, { message: "not an error" }, null, "text", undefined]) expect(responseErrorMessage(value)).toBeNull();
  });
});
