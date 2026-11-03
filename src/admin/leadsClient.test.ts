// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ demoMode: false }));
vi.mock("../lib/config", () => ({ config: settings }));
import { LeadsApiError, leadsClient } from "./leadsClient";

const lead = {
  id: "11111111-1111-4111-8111-111111111111", source: "advisors", kind: "consultation", externalId: "CM-0A1B2C3D4E5F", test: false,
  occurredAt: "2026-11-03T12:00:00+00:00", receivedAt: "2026-11-03T12:00:01.5+00:00",
  contact: { name: "Robin Park", email: "robin@lakeside.example", phone: null, organization: "Lakeside Hospice", role: null },
  details: { service: "strategy", sector: "Hospice" },
  attribution: { utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null, referrerHost: null, landingPath: "/services", firstSeenAt: "2026-11-02T09:00:00+00:00" },
  productId: "00000000-0000-4000-8000-000000000007", conversation: { id: "22222222-2222-4222-8222-222222222222", reference: "CM-1001", status: "open" },
  status: "contacted", createdAt: "2026-11-03T12:00:01.5+00:00", updatedAt: "2026-11-03T12:10:00.123456+00:00",
};
const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

beforeEach(() => { settings.demoMode = false; });
afterEach(() => vi.unstubAllGlobals());

describe("Leads client", () => {
  it("reads a page through the RPC allowlist with the database's parameter names", async () => {
    const fetcher = respond({ items: [lead], total: 1, offset: 0, limit: 25 });
    vi.stubGlobal("fetch", fetcher);
    const result = await leadsClient.list({ kind: "consultation", source: null, includeTest: false, offset: 0, limit: 25 }, { signal: new AbortController().signal });
    expect(result.items[0].conversation?.reference).toBe("CM-1001");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/rpc/list_leads");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(init.body))).toEqual({ p_kind: "consultation", p_source: null, p_include_test: false, p_offset: 0, p_limit: 25 });
  });

  it("changes a status through the owner route with the version the lead was read at", async () => {
    const fetcher = respond(lead);
    vi.stubGlobal("fetch", fetcher);
    expect((await leadsClient.setStatus({ id: lead.id, status: "contacted", expectedUpdatedAt: "2026-11-03T12:00:01.5+00:00" })).status).toBe("contacted");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/leads/status");
    expect(JSON.parse(String(init.body))).toEqual({ id: lead.id, status: "contacted", expectedUpdatedAt: "2026-11-03T12:00:01.5+00:00" });
  });

  it("keeps the server's reviewed message and status, and tells the shell when the session lapsed", async () => {
    vi.stubGlobal("fetch", respond({ error: "This lead changed. Refresh and try again." }, 409));
    await expect(leadsClient.setStatus({ id: lead.id, status: "won", expectedUpdatedAt: lead.updatedAt }))
      .rejects.toMatchObject({ status: 409, code: "upstream", message: "This lead changed. Refresh and try again." });
    const lapsed = vi.fn();
    window.addEventListener("caremetric:session", lapsed);
    vi.stubGlobal("fetch", respond({ error: "Current administrator session required." }, 401));
    await expect(leadsClient.setStatus({ id: lead.id, status: "won", expectedUpdatedAt: lead.updatedAt })).rejects.toMatchObject({ status: 401, code: "401" });
    expect(lapsed).toHaveBeenCalledTimes(1);
    window.removeEventListener("caremetric:session", lapsed);
    vi.stubGlobal("fetch", respond({ error: "x" }, 403));
    await expect(leadsClient.list({ kind: null, source: null, includeTest: true, offset: 0, limit: 25 }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "403" });
    vi.stubGlobal("fetch", respond({ error: "Leads are not configured." }, 503));
    await expect(leadsClient.setStatus({ id: lead.id, status: "won", expectedUpdatedAt: lead.updatedAt })).rejects.toMatchObject({ code: "unconfigured" });
  });

  it("does not trust an answer that is not the shape it expects", async () => {
    vi.stubGlobal("fetch", respond({ ...lead, status: "maybe" }));
    await expect(leadsClient.setStatus({ id: lead.id, status: "won", expectedUpdatedAt: lead.updatedAt })).rejects.toThrow();
    vi.stubGlobal("fetch", respond({ items: [{ ...lead, message: undefined, details: { nested: { no: true } } }], total: 1, offset: 0, limit: 25 }));
    await expect(leadsClient.list({ kind: null, source: null, includeTest: false, offset: 0, limit: 25 }, { signal: new AbortController().signal })).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    await expect(leadsClient.setStatus({ id: lead.id, status: "won", expectedUpdatedAt: lead.updatedAt })).rejects.toMatchObject({ message: "The request could not be completed." });
  });

  it("does not call the server in the preview", async () => {
    settings.demoMode = true;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(leadsClient.list({ kind: null, source: null, includeTest: false, offset: 0, limit: 25 }, { signal: new AbortController().signal })).rejects.toBeInstanceOf(LeadsApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
