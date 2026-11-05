// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { externalEmailRequestKey } from "./externalEmailDraft";
import type { ExternalEmailProposal } from "./teamProtocol";

beforeEach(() => { sessionStorage.clear(); vi.stubGlobal("crypto", webcrypto); });
afterEach(() => vi.unstubAllGlobals());

describe("owner email request identity", () => {
  it("keeps one request for the exact draft across reloads without storing the recipient or message", async () => {
    const draft = { to: "support@example.org", subject: "Source access", body: "Hello,\n\nPlease review these import failures.\n" };
    const first = await externalEmailRequestKey(draft);
    expect(await externalEmailRequestKey({ ...draft })).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionStorage.length).toBe(1);
    const key = sessionStorage.key(0)!;
    expect(key).toMatch(/^caremetric:team:external-email:[0-9a-f]{64}$/);
    expect(sessionStorage.getItem(key)).toBe(first);
    const stored = key + sessionStorage.getItem(key);
    for (const text of Object.values(draft)) expect(stored).not.toContain(text);
  });

  it("gives changed wording or a changed recipient a different identity, preserving whitespace differences", async () => {
    const draft = { to: "support@example.org", subject: "Source access", body: "Please help.\n" };
    const first = await externalEmailRequestKey(draft);
    for (const changed of [{ ...draft, to: "another@example.org" }, { ...draft, subject: "Source access " }, { ...draft, body: "Please help." }]) {
      expect(await externalEmailRequestKey(changed)).not.toBe(first);
    }
    expect(await externalEmailRequestKey(draft)).toBe(first);
  });

  it("does not accept a malformed request key from browser storage", async () => {
    const draft = { to: "support@example.org", subject: "Source access", body: "Please help." };
    await externalEmailRequestKey(draft);
    sessionStorage.setItem(sessionStorage.key(0)!, "not-a-request-id");
    expect(await externalEmailRequestKey(draft)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each(["rejected", "expired"] as const)("replaces a confirmed %s request once and reuses its replacement for stale calls and reloads", async status => {
    const draft = { to: "support@example.org", subject: "Source access", body: "Please help.\n" };
    const original = await externalEmailRequestKey(draft);
    const confirmation = { requestKey: original, status };
    const replacement = await externalEmailRequestKey(draft, confirmation);
    expect(replacement).not.toBe(original);
    expect(await externalEmailRequestKey(draft, confirmation)).toBe(replacement);
    expect(await externalEmailRequestKey(draft)).toBe(replacement);
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(replacement);
  });

  it.each(["proposed", "approved", "executing", "executed", "failed", "unknown"])("never renews a %s outcome", async status => {
    const draft = { to: "support@example.org", subject: "Source access", body: "Please help." };
    const original = await externalEmailRequestKey(draft);
    await expect(externalEmailRequestKey(draft, { requestKey: original, status: status as ExternalEmailProposal["status"] })).rejects.toThrow("Only a rejected or expired");
    expect(await externalEmailRequestKey(draft)).toBe(original);
  });
});
