import { describe, expect, it, vi } from "vitest";
import { parsePortfolioEnvelope, parsePortfolioRequest } from "../../supabase/functions/_shared/portfolioProtocol";
import { createAdminProxy } from "../../supabase/functions/platform-admin/handler";

const uuid = "99000000-0000-4000-8000-000000000001";
const now = "2026-09-11T15:00:00.000Z";
const actor = { user_id: uuid, role: "platform_admin", aal: "aal2" };
const page = { limit: 20, offset: 0, total: 1 };
const staff = { id: "Legacy_Staff-42", displayName: null, email: "staff@example.invalid", role: "agent", status: "active", createdAt: now };
const organization = { id: uuid, name: "Fixture organization", slug: null, status: "active", createdAt: null };
const subscription = { id: uuid, organizationId: uuid, organizationName: null, planCode: null, planName: null, status: "active", providerStatus: null, providerCustomerId: null, providerSubscriptionId: null, currentPeriodEnd: null, updatedAt: null };
const envelope = (operation: string, data: unknown, product = "breathe") => ({ contractVersion: 1, product, operation, generatedAt: now, data });
const parse = (operation: string, data: unknown, product = "breathe") => parsePortfolioEnvelope(envelope(operation, data, product), parsePortfolioRequest({ product, operation }));
const request = (body: unknown) => new Request("https://example.invalid/platform-admin", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer header.payload.signature" }, body: JSON.stringify(body) });

describe("portfolio contracts", () => {
  it("preserves the deployed CareBase default and normalizes directory pages", () => {
    expect(parsePortfolioRequest({ operation: "overview" })).toEqual({ product: "carebase", operation: { operation: "overview" } });
    expect(parsePortfolioRequest({ product: "breathe", operation: "users.list", search: "é 100%_" })).toEqual({ product: "breathe", operation: { operation: "users.list", search: "é 100%_", limit: 20, offset: 0 } });
  });
  it.each([
    { product: "https://attacker.invalid", operation: "overview" },
    { product: "breathe", operation: "capabilities", url: "https://attacker.invalid" },
    { operation: "users.list", actorId: uuid }, { operation: "users.list", limit: 0 },
    { operation: "users.list", limit: 51 }, { operation: "users.list", offset: 10001 },
    { operation: "users.list", search: "*" }, { operation: "users.list", search: "a\nb" },
    { operation: "billing.overview", organizationId: uuid }, { operation: "users.delete", userId: uuid },
  ])("rejects unreviewed parameters and destinations: %j", value => expect(() => parsePortfolioRequest(value)).toThrow());
  it("projects known capabilities and ignores future operation names", () => {
    const result = parse("capabilities", { apiVersion: 1, operations: ["users.list", "users.list", "future.write"], sourceRevision: "abcdef1234567", secret: "private" });
    expect(result.data).toEqual({ apiVersion: 1, operations: ["users.list"], sourceRevision: "abcdef1234567" });
  });
  it("keeps CareBase-only capabilities out of other product projections", () => {
    const result = parse("capabilities", { apiVersion: 1, operations: ["users.list", "learning.media.v1", "operations.config.v1"], sourceRevision: null });
    expect(result.data).toEqual({ apiVersion: 1, operations: ["users.list"], sourceRevision: null });
  });
  it.each([{ apiVersion: 2, operations: [], sourceRevision: null }, { apiVersion: 1, operations: [42], sourceRevision: null }, { apiVersion: 1, operations: [], sourceRevision: "unverified branch" }])("rejects invalid capability metadata %j", data => expect(() => parse("capabilities", data)).toThrow());
  it("preserves opaque Breathe staff identities and strips unreviewed identity fields", () => {
    const result = parse("users.list", { ...page, items: [{ ...staff, passwordHash: "private", patient: { medicalRecord: "private" } }] });
    expect(result.data).toEqual({ ...page, items: [staff] });
    expect(() => parse("users.list", { ...page, items: [staff] }, "carebase")).toThrow();
  });
  it.each(["", "../user", "a.b", "a:b", "x".repeat(129), "with space"])("rejects invalid opaque native identity %s", id => expect(() => parse("users.list", { ...page, items: [{ ...staff, id }] })).toThrow());
  it("retains UUID requirements for Breathe organizations and subscriptions", () => {
    expect(() => parse("organizations.list", { ...page, items: [{ ...organization, id: staff.id }] })).toThrow();
    expect(() => parse("billing.subscriptions.list", { ...page, source: "application_database", items: [{ ...subscription, organizationId: staff.id }] })).toThrow();
  });
  it("retains a native organization with no recorded display name", () => {
    const unnamed = { ...organization, name: null };
    expect(parse("organizations.list", { ...page, items: [unnamed] }).data).toEqual({ ...page, items: [unnamed] });
    expect(() => parse("organizations.list", { ...page, items: [{ ...organization, name: undefined }] })).toThrow();
  });
  it("requires nullable values explicitly and keeps incomplete provider snapshots honest", () => {
    expect(parse("billing.subscriptions.list", { ...page, source: "application_database", items: [subscription] }).data).toEqual({ ...page, source: "application_database", items: [subscription] });
    expect(() => parse("billing.subscriptions.list", { ...page, source: "stripe_live", items: [subscription] })).toThrow();
    expect(() => parse("billing.subscriptions.list", { ...page, source: "application_database", items: [{ ...subscription, providerStatus: undefined }] })).toThrow();
  });
  it.each([{ offset: 20 }, { limit: 50 }, { total: -1 }, { items: Array(21).fill(organization) }])("rejects inconsistent page windows %j", changes => expect(() => parse("organizations.list", { ...page, items: [organization], ...changes })).toThrow());
  it("rejects stale source identity, a different operation and missing timestamps", () => {
    const requested = parsePortfolioRequest({ product: "breathe", operation: "users.list" });
    for (const changed of [{ product: "carebase" }, { operation: "organizations.list" }, { generatedAt: null }, { contractVersion: 2 }]) {
      expect(() => parsePortfolioEnvelope({ ...envelope("users.list", { ...page, items: [staff] }), ...changed }, requested)).toThrow();
    }
  });
  it("requires complete unique billing state counts without deriving monetary totals", () => {
    const data = { source: "application_database", subscriptionCount: 3, statusCounts: [{ status: "active", count: 2 }, { status: "canceled", count: 1 }] };
    expect(parse("billing.overview", { ...data, revenue: 10000 }).data).toEqual(data);
    expect(() => parse("billing.overview", { ...data, subscriptionCount: 4 })).toThrow();
    expect(() => parse("billing.overview", { ...data, statusCounts: [{ status: "active", count: 2 }, { status: "active", count: 1 }] })).toThrow();
    expect(() => parse("billing.overview", { ...data, statusCounts: [{ status: "active", count: -1 }] })).toThrow();
  });
  it("keeps registered EMR profiles distinct from unavailable account activity", () => {
    const data = { organizationCount: 2, activeUserCount: null, registeredUserCount: 8, subscriptionCount: 3 };
    expect(parse("overview", data, "caremetric-emr").data).toEqual(data);
    expect(() => parse("overview", { ...data, activeUserCount: 0 }, "caremetric-emr")).toThrow();
    expect(() => parse("overview", { ...data, registeredUserCount: undefined }, "caremetric-emr")).toThrow();
  });
});

describe("portfolio proxy routing", () => {
  it("routes EMR to the verified native Supabase function and retains explicit unavailable activity", async () => {
    const data = { organizationCount: 2, activeUserCount: null, registeredUserCount: 8, subscriptionCount: 3 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockResolvedValueOnce(Response.json(envelope("overview", data, "caremetric-emr")));
    const response = await createAdminProxy({ publishableKey: "sb_publishable_fixture", fetcher })(request({ product: "caremetric-emr", operation: "overview" }));
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[1][0]).toBe("https://ubbtgcaosuebrlwcvihw.supabase.co/functions/v1/central-admin-read");
    expect(await response.json()).toEqual(envelope("overview", data, "caremetric-emr"));
  });
  it("forwards an authorized staff read only to Breathe's fixed native route", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockResolvedValueOnce(Response.json(envelope("users.list", { ...page, items: [staff] })));
    const response = await createAdminProxy({ publishableKey: "sb_publishable_fixture", fetcher })(request({ product: "breathe", operation: "users.list" }));
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(fetcher.mock.calls[1]).toMatchObject(["https://cmbreathe.com/resupply-api/central-admin/read", { body: '{"operation":"users.list","limit":20,"offset":0}', redirect: "manual", headers: { Authorization: "Bearer header.payload.signature", "Content-Type": "application/json" } }]);
    expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty("apikey");
    expect(await response.json()).toEqual(envelope("users.list", { ...page, items: [staff] }));
  });
  it("never follows an upstream redirect or projects its body", async () => {
    // Both gateway fetches run with redirect "manual": a 3xx returns as a
    // response and fails the ordinary ok check, so the caller's JWT is
    // never re-sent to a redirect target and the redirect body is never
    // projected as product data.
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope("users.list", { ...page, items: [staff] })), { status: 302, headers: { "content-type": "application/json", location: "https://attacker.invalid/read" } }));
    const response = await createAdminProxy({ publishableKey: "sb_publishable_fixture", fetcher })(request({ product: "breathe", operation: "users.list" }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(staff.email);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("treats an authorization redirect as unconfigured and never calls the product", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://attacker.invalid/" } }));
    const response = await createAdminProxy({ publishableKey: "sb_publishable_fixture", fetcher })(request({ product: "breathe", operation: "users.list" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "unconfigured" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["intel", "advisors"])("never sends a legacy JWT to the SMS-only %s connection", async product => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(actor));
    const response = await createAdminProxy({ publishableKey: "sb_publishable_fixture", fetcher })(request({ product, operation: "capabilities" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "unconfigured" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("routes Go to its independent adapter while preserving shared EMR data semantics", async () => {
    const data = { organizationCount: 2, activeUserCount: null, registeredUserCount: 8, subscriptionCount: 3 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockResolvedValueOnce(Response.json(envelope("overview", data, "caremetric-go")));
    const response = await createAdminProxy({ publishableKey: "sb_publishable_fixture", fetcher })(request({ product: "caremetric-go", operation: "overview" }));
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[1][0]).toBe("https://ubbtgcaosuebrlwcvihw.supabase.co/functions/v1/central-go-admin-read");
    expect((await response.json()).data).toEqual(data);
    expect(() => parse("overview", { ...data, activeUserCount: 8 }, "caremetric-go")).toThrow();
  });
  it("does not accept EMR's response as Go even though both use the same database", async () => {
    const data = { organizationCount: 2, activeUserCount: null, registeredUserCount: 8, subscriptionCount: 3 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockResolvedValueOnce(Response.json(envelope("overview", data, "caremetric-emr")));
    const response = await createAdminProxy({ publishableKey: "sb_publishable_fixture", fetcher })(request({ product: "caremetric-go", operation: "overview" }));
    expect(response.status).toBe(503);
  });
  it("does not accept a valid response from the wrong application", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockResolvedValueOnce(Response.json(envelope("organizations.list", { ...page, items: [organization] }, "carebase")));
    const response = await createAdminProxy({ publishableKey: "sb_publishable_fixture", fetcher })(request({ product: "breathe", operation: "organizations.list" }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(organization.name);
  });
  it("rechecks authorization for every selected-product operation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("revoked", { status: 403 }));
    const handler = createAdminProxy({ publishableKey: "sb_publishable_fixture", fetcher });
    for (const product of ["carebase", "breathe"]) expect((await handler(request({ product, operation: "users.list" }))).status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith("/rpc/authorize_platform_admin"))).toBe(true);
  });
  it("uses only PennSync's reviewed custom header and preserves its exact native identities", async () => {
    const data = { ...page, items: [{ ...staff, id: "694ec16f72e01b60d22f7cc0", role: "admin", status: "registered" }] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(actor)).mockResolvedValueOnce(Response.json(envelope("users.list", data, "pennsync")));
    const response = await createAdminProxy({ publishableKey: "sb_publishable_fixture", fetcher })(request({ product: "pennsync", operation: "users.list" }));
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[1]).toMatchObject(["https://caremetricai.base44.app/functions/centralAdminRead", { headers: { "X-CareMetric-Hub-Authorization": "Bearer header.payload.signature" } }]);
    expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty("Authorization");
    expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty("apikey");
    expect((await response.json()).data).toEqual(data);
  });
});

describe("Intel registered-user boundaries", () => {
  it("does not invent organization, active-account or subscription totals", () => {
    const data={organizationCount:null,activeUserCount:null,registeredUserCount:2};
    expect(parse("overview",data,"intel").data).toEqual(data);
    expect(()=>parse("overview",{...data,organizationCount:0},"intel")).toThrow();
    expect(()=>parse("overview",{...data,activeUserCount:2},"intel")).toThrow();
    expect(()=>parse("overview",{...data,subscriptionCount:0},"intel")).toThrow();
  });
  it("preserves Intel's native IDs and strips fields outside the directory contract", () => {
    const row={...staff,id:"6993c62145573ca8a97ad4aa",status:"registered"};
    expect(parse("users.list",{...page,items:[{...row,password:"private"}]},"intel").data).toEqual({...page,items:[row]});
    expect(()=>parse("users.list",{...page,items:[{...row,id:uuid}]},"intel")).toThrow();
    expect(()=>parse("users.list",{...page,items:[{...row,status:"active"}]},"intel")).toThrow();
    expect(()=>parsePortfolioEnvelope(envelope("users.list",{...page,items:[row]},"pennsync"),parsePortfolioRequest({product:"intel",operation:"users.list"}))).toThrow();
  });
});

describe("PennSync native billing boundaries", () => {
  it("allows its individual subscriptions without inventing an organization", () => {
    const row = { ...subscription, id: "694ec16f72e01b60d22f7cc0", organizationId: null };
    const data = { ...page, source: "application_database", items: [row] };
    expect(parse("billing.subscriptions.list", data, "pennsync").data).toEqual(data);
    expect(() => parse("billing.subscriptions.list", { ...data, items: [{ ...subscription, organizationId: null }] }, "carebase")).toThrow();
  });
  it.each([uuid, "694EC16F72E01B60D22F7CC0", "../694ec16f72e01b60d22f7cc0"])("rejects mismatched native IDs %s", id => {
    expect(() => parse("organizations.list", { ...page, items: [{ ...organization, id }] }, "pennsync")).toThrow();
  });
});

describe("shared phone message contract", () => {
  const message = { id: uuid, contactName: "Caller", companyName: "Organization", phone: "+12025550111", email: null, message: "Callback requested.", status: "new", createdAt: now, product: "advisors", requestType: "healthcare_advisors" };
  it("keeps bounded text delivery details without internal provider identifiers", () => {
    const sms = { status: "delivered", resources: ["advisors"], errorCode: null };
    expect(parse("phone.messages.list", { ...page, items: [{ ...message, sms: { ...sms, twilioMessageSid: "private" } }] }).data).toEqual({ ...page, items: [{ ...message, sms }] });
    expect(() => parse("phone.messages.list", { ...page, items: [{ ...message, sms: { ...sms, status: "invented" } }] })).toThrow();
  });
  it("accepts bounded messages and strips internal metadata", () => {
    expect(parse("phone.messages.list", { ...page, items: [{ ...message, transcript: "private", twilioCallSid: "private" }] }).data).toEqual({ ...page, items: [message] });
  });
  it("rejects alternate sources, oversized summaries, and mismatched pages", () => {
    expect(() => parsePortfolioRequest({ product: "intel", operation: "phone.messages.list" })).toThrow();
    expect(() => parse("phone.messages.list", { ...page, items: [{ ...message, message: "x".repeat(2001) }] })).toThrow();
    expect(() => parse("phone.messages.list", { ...page, offset: 20, items: [message] })).toThrow();
  });
});

describe("Healthcare Advisors consultation boundaries", () => {
  const inquiry = { id: "CM-0A1B2C3D4E5F", createdAt: now, name: "Requester", email: "requester@example.invalid", organization: "Fixture agency", phone: "", sector: "Home Health", service: "strategy", message: "Please contact us about an operations review.", status: "new", notes: "" };
  it("exposes only the consultation inbox, overview and capabilities", () => {
    expect(parsePortfolioRequest({ product: "advisors", operation: "inquiries.list", search: "agency" })).toEqual({ product: "advisors", operation: { operation: "inquiries.list", search: "agency", limit: 20, offset: 0 } });
    for (const operation of ["users.list", "organizations.list", "billing.overview", "billing.subscriptions.list", "phone.messages.list", "courses.list"]) {
      expect(() => parsePortfolioRequest({ product: "advisors", operation })).toThrow();
    }
    expect(() => parsePortfolioRequest({ product: "breathe", operation: "inquiries.list" })).toThrow();
    expect(parse("capabilities", { apiVersion: 1, operations: ["overview", "inquiries.list", "users.list", "billing.overview"], sourceRevision: null }, "advisors").data)
      .toEqual({ apiVersion: 1, operations: ["overview", "inquiries.list"], sourceRevision: null });
    expect(parse("capabilities", { apiVersion: 1, operations: ["overview", "inquiries.list"], sourceRevision: null }, "breathe").data)
      .toEqual({ apiVersion: 1, operations: ["overview"], sourceRevision: null });
  });
  it("reports consultation totals without inventing organizations, accounts or subscriptions", () => {
    const data = { organizationCount: null, activeUserCount: null, inquiryCount: 4, openInquiryCount: 2 };
    expect(parse("overview", data, "advisors").data).toEqual(data);
    expect(() => parse("overview", { ...data, organizationCount: 0 }, "advisors")).toThrow();
    expect(() => parse("overview", { ...data, subscriptionCount: 0 }, "advisors")).toThrow();
    expect(() => parse("overview", { ...data, openInquiryCount: 5 }, "advisors")).toThrow();
  });
  it("keeps bounded request fields and strips anything else", () => {
    expect(parse("inquiries.list", { ...page, items: [{ ...inquiry, form_digest: "private", consent: 1 }] }, "advisors").data)
      .toEqual({ ...page, items: [{ ...inquiry, phone: null }] });
    for (const changed of [{ id: "CM-0a1b2c3d4e5f" }, { id: "../CM-0A1B2C3D4E5F" }, { status: "deleted" }, { message: "x".repeat(1801) }, { createdAt: null }, { notes: null }]) {
      expect(() => parse("inquiries.list", { ...page, items: [{ ...inquiry, ...changed }] }, "advisors")).toThrow();
    }
    expect(() => parsePortfolioEnvelope(envelope("inquiries.list", { ...page, items: [inquiry] }, "breathe"), parsePortfolioRequest({ product: "advisors", operation: "inquiries.list" }))).toThrow();
  });
});
