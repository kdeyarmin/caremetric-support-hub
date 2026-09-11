import { describe, expect, it, vi } from "vitest";
import { createAdminProxy } from "../../supabase/functions/platform-admin/handler";
import { parseAdminEnvelope, parseAdminOperation } from "../../supabase/functions/_shared/adminProtocol";

const userId = "99000000-0000-4000-8000-000000000001";
const token = "Bearer header.payload.signature";
const actor = { user_id: userId, role: "platform_admin", aal: "aal2" };
const origin = "https://support-hub-web-production.up.railway.app";
const request = (body: unknown = { operation: "overview" }, extra: RequestInit = {}) => new Request("https://xgauehtwksmnoqhgqegm.supabase.co/functions/v1/platform-admin", {
  method: "POST", headers: { "Content-Type": "application/json", authorization: token, origin }, body: JSON.stringify(body), ...extra,
});
const overview = { contractVersion: 1, product: "carebase", operation: "overview", generatedAt: "2026-09-11T12:00:00Z", data: { organizationCount: 2, activeUserCount: 5, globalCourseCount: 80 } };

describe("central administrator boundary", () => {
  it("verifies current authority before forwarding only the user token and approved operation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockResolvedValueOnce(Response.json({ ...overview, data: { ...overview.data, secret: "must-not-cross" } }));
    const response = await createAdminProxy({ publishableKey: "sb_publishable_test", fetcher })(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(overview);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(fetcher.mock.calls[0][0]).toBe("https://xgauehtwksmnoqhgqegm.supabase.co/rest/v1/rpc/authorize_platform_admin");
    expect(fetcher.mock.calls[1]).toMatchObject(["https://cmcarebase.com/api/platform-admin/read", { method: "POST", redirect: "error", body: '{"operation":"overview"}', headers: { Authorization: token, "Content-Type": "application/json" } }]);
    expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty("apikey");
  });
  it.each([401, 403, 404, 503])("denies failed authority check %s without reaching CareBase", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private exception", { status }));
    const response = await createAdminProxy({ publishableKey: "public", fetcher })(request());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await response.text()).not.toContain("private exception");
  });
  it.each([{ ...actor, role: "customer" }, { ...actor, aal: "aal1" }, { ...actor, user_id: "other" }, null])("rejects unexpected authority response %j", async value => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
    const response = await createAdminProxy({ publishableKey: "public", fetcher })(request());
    expect(response.status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refuses cross-origin browser requests and unsupported methods before authentication", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createAdminProxy({ publishableKey: "public", fetcher });
    expect((await handler(request({}, { headers: { origin: "https://attacker.invalid" } }))).status).toBe(403);
    expect((await handler(new Request("https://example.invalid", { method: "GET" }))).status).toBe(405);
    expect((await handler(request({}, { headers: { "content-type": "application/json" } }))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("handles the approved browser preflight without a data request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await createAdminProxy({ publishableKey: "public", fetcher })(new Request("https://example.invalid", { method: "OPTIONS", headers: { origin } }));
    expect(response.status).toBe(204); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ operation: "delete" }, { operation: "overview", url: "https://attacker.invalid" }, { operation: "courses.list", limit: 100 }, { operation: "courses.list", offset: -1 }])("rejects unsupported operation %j", async operation => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(actor));
    expect((await createAdminProxy({ publishableKey: "public", fetcher })(request(operation))).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds request bodies before forwarding", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(actor));
    expect((await createAdminProxy({ publishableKey: "public", fetcher })(request({ operation: "overview", body: "x".repeat(10000) }))).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never turns an upstream failure or incomplete counts into zeroes", async () => {
    for (const upstream of [new Response("private failure", { status: 500 }), Response.json({ ...overview, data: { organizationCount: 1 } }), new Response("<html>app fallback</html>")]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockResolvedValueOnce(upstream);
      const response = await createAdminProxy({ publishableKey: "public", fetcher })(request());
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(await response.text()).not.toMatch(/organizationCount|private failure|app fallback/);
    }
  });
  it("preserves explicit unavailable/not-found distinctions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockResolvedValueOnce(Response.json({ error: { code: "notfound", details: "private" } }, { status: 404 }));
    const response = await createAdminProxy({ publishableKey: "public", fetcher })(request());
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: { code: "notfound" } });
  });
  it("projects course details and rejects a different course or pagination window", () => {
    const operation = parseAdminOperation({ operation: "courses.get", courseId: userId.toUpperCase() });
    const summary = { id: userId, title: "Course", description: null, category: null, status: "published", estimatedDurationMinutes: 10, updatedAt: "2026-09-11", privateMedia: "secret" };
    const result = parseAdminEnvelope({ ...overview, operation: "courses.get", data: { course: summary, lessons: [{ id: userId, title: "Lesson", type: "video", position: -1, url: "private" }], lessonsTruncated: false } }, operation);
    expect(JSON.stringify(result)).not.toMatch(/secret|privateMedia|"url"/);
    expect(() => parseAdminEnvelope({ ...overview, operation: "courses.get", data: { course: { ...summary, id: "different" }, lessons: [], lessonsTruncated: false } }, operation)).toThrow();
    expect(() => parseAdminEnvelope({ ...overview, operation: "courses.list", data: { items: [], total: 0, limit: 20, offset: 20 } }, { operation: "courses.list", limit: 20, offset: 0 })).toThrow();
  });
});
