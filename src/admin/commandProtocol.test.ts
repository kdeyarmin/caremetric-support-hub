import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommandEnvelope, parsePortfolioCommand } from "../../supabase/functions/_shared/adminCommandProtocol";
import { createCommandProxy } from "../../supabase/functions/platform-command/handler";

const now = "2026-09-11T16:00:00.000Z";
const id = "99400000-0000-4000-8000-000000000001";
const target = "99400000-0000-4000-8000-000000000002";
const commandId = "99400000-0000-4000-8000-000000000003";
const sha = "a".repeat(64);
const draft = { product: "carebase", operation: "preview", requestId: id, action: "users.setActive", targetId: target, parameters: { active: false }, reason: "Deactivate departed fixture staff" };
const request = parsePortfolioCommand(draft);
const changes = [{ field: "active", before: "true", after: "false" }];
const preview = { commandId, action: draft.action, targetId: target, reason: draft.reason, expiresAt: "2026-09-11T16:05:00.000Z", previewDigest: sha, changes };
const envelope = (data: unknown = preview, operation = "preview") => ({ contractVersion: 1, product: "carebase", operation, generatedAt: now, data });
const actor = { user_id: id, role: "platform_admin", aal: "aal2", session_id: commandId, session_started_at: "2026-09-11T15:00:00.000Z", assurance_expires_at: "2026-09-11T23:00:00.000Z" };
const http = (body: unknown = draft, origin = "https://support-hub-web-production.up.railway.app") => new Request("https://example.invalid", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer header.payload.signature", origin }, body: JSON.stringify(body) });
afterEach(() => vi.useRealTimers());

describe("administrator command contracts", () => {
  it("preserves the preview identity and projects safe changes", () => {
    expect(parseCommandEnvelope(envelope({ ...preview, nativeEmail: "private@example.invalid", changes: [{ ...changes[0], password: "private" }] }), request).data).toEqual(preview);
  });
  it.each([
    { product: "breathe" }, { operation: "delete" }, { endpoint: "https://attacker.invalid" }, { targetId: "invalid" },
    { requestId: "same" }, { action: "users.resetMfa" }, { parameters: { active: "false" } },
    { parameters: { active: false, role: "platform_admin" } }, { reason: "short" }, { reason: "x".repeat(501) }, { reason: "a long\nreason" },
  ])("rejects unsupported preview %j", changes => expect(() => parsePortfolioCommand({ ...draft, ...changes })).toThrow());
  it("distinguishes native suspension from a billing access override", () => {
    expect(parsePortfolioCommand({ ...draft, action: "organizations.setSuspension", parameters: { suspended: true } }).command).toMatchObject({ parameters: { suspended: true } });
    expect(parsePortfolioCommand({ ...draft, action: "billing.setAccessOverride", parameters: { state: "provider", expiresAt: null } }).command).toMatchObject({ parameters: { state: "provider", expiresAt: null } });
    for (const parameters of [{ state: "canceled", expiresAt: null }, { state: "provider", expiresAt: now }, { state: "comped" }, { state: "comped", expiresAt: "bad" }, { state: "comped", expiresAt: "2026-09-11" }]) expect(() => parsePortfolioCommand({ ...draft, action: "billing.setAccessOverride", parameters })).toThrow();
  });
  it.each([{ action: "organizations.setSuspension" }, { targetId: id }, { reason: "different reason" }, { previewDigest: "invalid" }, { expiresAt: now }, { expiresAt: "2026-09-11T16:06:00Z" }, { changes: [{ field: "email", before: null, after: "private" }] }, { changes: [...changes, ...changes] }])("rejects a mismatched or unsafe preview %j", changes => expect(() => parseCommandEnvelope(envelope({ ...preview, ...changes }), request)).toThrow());
  it("accepts only the referenced immutable apply command and preserves replay outcome", () => {
    const apply = parsePortfolioCommand({ product: "carebase", operation: "apply", commandId, expectedDigest: sha });
    const result = { commandId, action: draft.action, targetId: target, appliedAt: now, replayed: true, changes };
    expect(parseCommandEnvelope(envelope(result, "apply"), apply).data).toEqual(result);
    expect(() => parseCommandEnvelope(envelope({ ...result, commandId: id }, "apply"), apply)).toThrow();
    expect(() => parsePortfolioCommand({ operation: "apply", commandId, expectedDigest: sha, parameters: { active: true } })).toThrow();
    expect(() => parsePortfolioCommand({ operation: "apply", commandId, expectedDigest: "not-a-digest" })).toThrow();
  });
});

describe("privileged command gateway", () => {
  it("uses the fresh-command RPC and fixed native route without forwarding credentials or identity fields", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockResolvedValueOnce(Response.json(envelope()));
    const response = await createCommandProxy({ publishableKey: "sb_publishable_fixture", fetcher })(http());
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[0][0]).toBe("https://xgauehtwksmnoqhgqegm.supabase.co/rest/v1/rpc/authorize_platform_command");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(fetcher.mock.calls[1]).toMatchObject(["https://cmcarebase.com/api/platform-admin/command", { body: JSON.stringify(request.command), redirect: "manual", headers: { Authorization: "Bearer header.payload.signature", "Content-Type": "application/json" } }]);
    expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty("apikey");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(envelope());
  });
  it.each([
    { session_id: "bad" }, { session_started_at: undefined }, { session_started_at: "2026-09-11T07:59:59Z" },
    { session_started_at: "2026-09-11T16:06:00Z" }, { assurance_expires_at: now }, { assurance_expires_at: "2026-09-12T00:00:00Z" },
    { aal: "aal1" }, { role: "customer" },
  ])("never forwards an insufficient or stale command authority %j", async changes => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...actor, ...changes }));
    expect((await createCommandProxy({ publishableKey: "public", fetcher })(http())).status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects browser and destination overrides before any native mutation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(actor));
    const handler = createCommandProxy({ publishableKey: "public", fetcher });
    expect((await handler(http(draft, "https://attacker.invalid"))).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await handler(http({ ...draft, endpoint: "https://attacker.invalid" }))).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["conflict", "expired"])("preserves safe %s outcomes without exposing upstream details", async code => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockResolvedValueOnce(Response.json({ error: { code, detail: "private target" } }, { status: 409 }));
    const response = await createCommandProxy({ publishableKey: "public", fetcher })(http());
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: { code } });
  });
  it("never retries a timed-out command automatically", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockRejectedValueOnce(new Error("ambiguous network result"));
    const response = await createCommandProxy({ publishableKey: "public", fetcher })(http());
    expect(response.status).toBe(503); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({ error: { code: "upstream" } });
  });
});
