import { describe, expect, it, vi } from "vitest";
import { parsePortfolioEnvelope, parsePortfolioRequest } from "../../supabase/functions/_shared/portfolioProtocol";
import { parseMinorAmount } from "../../supabase/functions/_shared/billingProtocol";
import { createAdminProxy } from "../../supabase/functions/platform-admin/handler";
import { billingFixtureTime, invoiceDetailFixture, invoiceFixture, subscriptionVerificationFixture } from "./billingFixtures";

const envelope = (operation: string, data: unknown) => ({ contractVersion: 1, product: "carebase", operation, generatedAt: billingFixtureTime, data });
const page = { source: "application_database", items: [invoiceFixture], total: 1, limit: 25, offset: 0 };
const parse = (operation: string, data: unknown) => parsePortfolioEnvelope(envelope(operation, data), parsePortfolioRequest({ operation, ...(operation === "billing.invoices.get" ? { id: invoiceFixture.id } : operation === "billing.subscriptions.verify" ? { id: subscriptionVerificationFixture.recorded.id } : {}) })).data;

describe("closed billing reads", () => {
  it("normalizes literal search and binds pagination for SMS delegation", () => {
    expect(parsePortfolioRequest({ operation: "billing.invoices.list", search: "  in_100%  " })).toEqual({ product: "carebase", operation: { operation: "billing.invoices.list", limit: 25, offset: 0, search: "in_100%" } });
    expect(parsePortfolioRequest({ operation: "billing.invoices.list", search: " " }).operation).not.toHaveProperty("search");
  });
  it.each([
    { operation: "billing.invoices.list", product: "breathe" }, { operation: "billing.invoices.get", id: invoiceFixture.id, product: "pennsync" },
    { operation: "billing.invoices.get", id: "in_fixture" }, { operation: "billing.invoices.get", id: invoiceFixture.id, providerId: "in_other" },
    { operation: "billing.subscriptions.verify", id: invoiceFixture.id, url: "https://attacker.invalid" },
    { operation: "billing.invoices.list", search: "*" }, { operation: "billing.invoices.list", search: "a\nb" }, { operation: "billing.invoices.list", search: "a".repeat(101) },
    { operation: "billing.invoices.list", limit: 51 }, { operation: "billing.invoices.list", offset: 10001 }, { operation: "billing.invoices.list", sort: "anything" },
  ])("rejects unreviewed request %j", request => expect(() => parsePortfolioRequest(request)).toThrow());
  it("accepts all three exact native payloads and nullable legacy invoice links", () => {
    expect(parse("billing.invoices.list", page)).toEqual(page);
    expect(parse("billing.invoices.get", invoiceDetailFixture)).toEqual(invoiceDetailFixture);
    expect(parse("billing.subscriptions.verify", subscriptionVerificationFixture)).toEqual(subscriptionVerificationFixture);
    const legacy = { ...invoiceDetailFixture, recorded: { ...invoiceFixture, subscriptionId: null, providerSubscriptionId: null, issuedAt: null } };
    expect(parse("billing.invoices.get", legacy)).toEqual(legacy);
  });
  it.each([0, 1.5, "-1", "+1", "01", "1.0", "1e3", " 1", "9223372036854775808", "123456789012345678901"])("rejects unsafe or noncanonical money %j", value => expect(() => parseMinorAmount(value)).toThrow());
  it("preserves every minor unit above Number.MAX_SAFE_INTEGER", () => {
    expect(parseMinorAmount("9223372036854775807")).toBe("9223372036854775807");
    expect(parseMinorAmount("9007199254740993")).toBe("9007199254740993");
  });
  it.each([{ total: 0 }, { total: -1 }, { offset: 1 }, { limit: 20 }, { items: [invoiceFixture, invoiceFixture], total: 2 }, { source: "stripe" }, { paymentUrl: "https://private.invalid" }])("rejects inconsistent or expanded invoice page %j", patch => expect(() => parse("billing.invoices.list", { ...page, ...patch })).toThrow());
  it.each([{ hostedInvoiceUrl: "https://private.invalid" }, { currency: "USD" }, { currency: "us" }, { amountDueMinor: 1 }, { paidAt: undefined }, { issuedAt: "2026-02-30T17:00:00.000Z" }, { providerInvoiceId: "../in_fixture" }])("rejects unsafe invoice fields %j", patch => expect(() => parse("billing.invoices.list", { ...page, items: [{ ...invoiceFixture, ...patch }] })).toThrow());
  it("rejects another native record or another Stripe invoice identity", () => {
    expect(() => parse("billing.invoices.get", { ...invoiceDetailFixture, recorded: { ...invoiceFixture, id: invoiceFixture.organizationId } })).toThrow();
    for (const patch of [{ id: "in_other" }, { subscriptionId: "sub_other" }, { customerId: "bad" }, { livemode: "true" }, { paymentUrl: "https://private.invalid" }, { createdAt: null }]) {
      expect(() => parse("billing.invoices.get", { ...invoiceDetailFixture, provider: { ...invoiceDetailFixture.provider, data: { ...invoiceDetailFixture.provider.data, ...patch } } })).toThrow();
    }
  });
  it.each(["unconfigured", "unavailable", "notfound", "identity_mismatch"])("keeps unavailable %s provider separate from the stored record", availability => {
    const data = { ...invoiceDetailFixture, provider: { ...invoiceDetailFixture.provider, availability, data: null }, comparison: { status: "not_checked", fields: [] } };
    expect(parse("billing.invoices.get", data)).toEqual(data);
    expect(() => parse("billing.invoices.get", { ...data, provider: { ...data.provider, data: invoiceDetailFixture.provider.data } })).toThrow();
    expect(() => parse("billing.invoices.get", { ...data, comparison: { status: "matches", fields: [] } })).toThrow();
  });
  it.each([{ apiVersion: "future" }, { source: "application_database" }, { availability: "cached" }, { checkedAt: null }, { privateMetadata: "secret" }])("rejects unsupported provider provenance %j", patch => expect(() => parse("billing.invoices.get", { ...invoiceDetailFixture, provider: { ...invoiceDetailFixture.provider, ...patch } })).toThrow());
  it("recomputes invoice differences instead of trusting a matches assertion", () => {
    const data = { ...invoiceDetailFixture, provider: { ...invoiceDetailFixture.provider, data: { ...invoiceDetailFixture.provider.data, status: "open", amountRemainingMinor: "7" } } };
    expect(() => parse("billing.invoices.get", data)).toThrow();
    expect(parse("billing.invoices.get", { ...data, comparison: { status: "differences", fields: ["amountRemainingMinor", "status"] } })).toMatchObject({ comparison: { status: "differences", fields: ["status", "amountRemainingMinor"] } });
    for (const fields of [["status"], ["status", "status"], ["status", "customerId"]]) expect(() => parse("billing.invoices.get", { ...data, comparison: { status: "differences", fields } })).toThrow();
  });
  it("checks subscription identity and provider-status differences while preserving manual access", () => {
    const data = subscriptionVerificationFixture;
    for (const patch of [{ id: "sub_other" }, { customerId: "cus_other" }, { status: "canceled" }]) expect(() => parse("billing.subscriptions.verify", { ...data, provider: { ...data.provider, data: { ...data.provider.data, ...patch } } })).toThrow();
    expect(() => parse("billing.subscriptions.verify", { ...data, applicationAccess: { ...data.applicationAccess, stateSource: "provider_guess" } })).toThrow();
    expect(() => parse("billing.subscriptions.verify", { ...data, recorded: { ...data.recorded, creditCard: "private" } })).toThrow();
    const changed = { ...data, provider: { ...data.provider, data: { ...data.provider.data, status: "canceled" } }, comparison: { status: "differences", fields: ["providerStatus"] } };
    expect(parse("billing.subscriptions.verify", changed)).toMatchObject({ applicationAccess: { billingState: "comped", stateSource: "manual_comp" }, comparison: changed.comparison });
  });
  it("routes an authorized exact invoice read through the existing fixed native proxy", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ user_id: invoiceFixture.id, role: "platform_admin", aal: "aal2" })).mockResolvedValueOnce(Response.json(envelope("billing.invoices.get", invoiceDetailFixture)));
    const request = new Request("https://example.invalid/platform-admin", { method: "POST", headers: { authorization: "Bearer header.payload.signature", "content-type": "application/json" }, body: JSON.stringify({ operation: "billing.invoices.get", id: invoiceFixture.id }) });
    const result = await createAdminProxy({ publishableKey: "sb_publishable_fixture", fetcher })(request);
    expect(result.status).toBe(200);
    expect(fetcher.mock.calls[1][0]).toBe("https://cmcarebase.com/api/platform-admin/read");
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify({ operation: "billing.invoices.get", id: invoiceFixture.id }));
    expect((await result.json()).data).toEqual(invoiceDetailFixture);
  });
});
