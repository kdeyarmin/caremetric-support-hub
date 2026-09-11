import { describe, expect, it } from "vitest";
import { nativeCheckoutCommandSchema, checkoutResultSchema, checkoutResultMetadata, checkoutResultMetadataSchema, projectCheckoutCommand, parseCheckoutUrl, verifyCheckoutOutcome } from "../../supabase/functions/_shared/checkoutCommandProtocol";
import { parseCheckoutCatalog } from "../../supabase/functions/_shared/checkoutCatalogProtocol";
import { parsePortfolioEnvelope, parsePortfolioRequest } from "../../supabase/functions/_shared/portfolioProtocol";
import { checkoutApply, checkoutCatalog, checkoutClosed, checkoutOpen, checkoutPending, checkoutPreview, checkoutRequest, checkoutSessionId, checkoutUrl } from "./fixtures/checkout";
const envelope = (operation: string, data: unknown) => ({ contractVersion: 1, product: "carebase", operation, generatedAt: new Date().toISOString(), data });
describe("closed subscription checkout protocol", () => {
  it("requires the exact native package, cadence and separate apply/check action", () => {
    expect(nativeCheckoutCommandSchema.parse(checkoutRequest)).toEqual(checkoutRequest);
    expect(nativeCheckoutCommandSchema.parse({ ...checkoutApply, operation: "check" }).operation).toBe("check");
    for (const input of [{ ...checkoutRequest, actorId: checkoutRequest.targetId },
      { ...checkoutRequest, parameters: { ...checkoutRequest.parameters, providerPriceId: "price_Arbitrary" } },
      { ...checkoutRequest, parameters: { ...checkoutRequest.parameters, billingInterval: "week" } },
      { ...checkoutRequest, parameters: { ...checkoutRequest.parameters, unitAmount: 10 } },
      { operation: "apply", commandId: checkoutApply.commandId, expectedDigest: checkoutApply.expectedDigest }]) {
      expect(nativeCheckoutCommandSchema.safeParse(input).success).toBe(false);
    }
  });
  it("binds preview source fields and bounded lifetime to the requested plan", () => {
    const preview = checkoutPreview();
    expect(projectCheckoutCommand(envelope("preview", preview), checkoutRequest)).toEqual(preview);
    for (const altered of [{ ...preview, targetId: checkoutRequest.requestId },
      { ...preview, summary: { ...preview.summary, packageId: checkoutRequest.requestId } },
      { ...preview, summary: { ...preview.summary, billingInterval: "year" } },
      { ...preview, summary: { ...preview.summary, intervalCount: 0 } },
      { ...preview, summary: { ...preview.summary, currency: "USD" } },
      { ...preview, summary: { ...preview.summary, amount: 100 } },
      { ...preview, expiresAt: new Date(Date.now() + 360000).toISOString() }]) {
      expect(() => projectCheckoutCommand(envelope("preview", altered), checkoutRequest)).toThrow();
    }
  });
  it("accepts both documented encoded fragments and fragment-free session URLs bound to the exact ID", () => {
    expect(parseCheckoutUrl(checkoutUrl, checkoutSessionId)).toBe(checkoutUrl);
    const plain = `https://checkout.stripe.com/c/pay/${checkoutSessionId}`;
    expect(parseCheckoutUrl(plain, checkoutSessionId)).toBe(plain);
    expect(checkoutResultSchema.parse(checkoutOpen()).outcome).toBe("open");
  });
  it.each([
    checkoutUrl.replace("checkout.stripe.com", "checkout.stripe.com.evil.test"),
    checkoutUrl.replace("checkout.stripe.com", "checkout.stripe.com:443"),
    checkoutUrl.replace("checkout.stripe.com", "user@checkout.stripe.com"),
    checkoutUrl.replace("/c/pay/", "/c%2Fpay/"),
    `https://checkout.stripe.com/c/pay/${checkoutSessionId}?redirect=https://evil.test`,
    `https://checkout.stripe.com/c/pay/${checkoutSessionId}/extra`,
    `https://checkout.stripe.com/c/pay/${checkoutSessionId}#invalid%QQ`,
    `https://checkout.stripe.com/c/pay/${checkoutSessionId}#literal space`,
    `https://checkout.stripe.com/c/pay/${checkoutSessionId}Extra`,
  ])("rejects unsafe or unbound checkout URL %s", url => {
    expect(() => parseCheckoutUrl(url, checkoutSessionId)).toThrow();
  });
  it("requires closed lifecycle state combinations and never exposes a URL for pending/complete", () => {
    expect(checkoutResultSchema.parse(checkoutPending()).canStartNewCheckout).toBe(false);
    expect(checkoutResultSchema.parse(checkoutClosed("failed", true)).providerStatus).toBeNull();
    expect(checkoutResultSchema.parse(checkoutClosed("complete", false)).canStartNewCheckout).toBe(false);
    const open = checkoutOpen();
    for (const input of [{ ...checkoutPending(), canStartNewCheckout: true }, { ...open, canStartNewCheckout: true },
      { ...checkoutClosed("complete"), session: open.session }, { ...checkoutClosed("complete"), providerStatus: "expired" },
      { ...checkoutClosed("failed"), providerStatus: "open" }, { ...open, session: { ...open.session, livemode: true } },
      { ...open, extraProviderData: {} }, { ...checkoutPending(), retryAfterSeconds: null }]) {
      expect(checkoutResultSchema.safeParse(input).success).toBe(false);
    }
  });
  it("rejects response substitution and keeps every provider URL out of durable metadata", () => {
    const open = checkoutOpen(), metadata = checkoutResultMetadata(open);
    expect(JSON.stringify(metadata)).not.toContain(checkoutUrl);
    expect(checkoutResultMetadataSchema.safeParse(open).success).toBe(false);
    expect(() => verifyCheckoutOutcome({ ...open, targetId: checkoutRequest.requestId }, checkoutPreview())).toThrow();
    expect(() => projectCheckoutCommand({ ...envelope("apply", open), privateActor: "forged" }, checkoutApply)).toThrow();
    expect(() => projectCheckoutCommand(envelope("check", open), checkoutApply)).toThrow();
  });
  it("reads only bounded CareBase catalog records with exact int64 strings and explicit source", () => {
    const operation = { operation: "billing.packages.list" as const, offset: 0, limit: 20 };
    const page = checkoutCatalog();
    expect(parseCheckoutCatalog(page, operation).items[0].baseAmountMinor).toBe("9223372036854775807");
    expect(parsePortfolioEnvelope(envelope(operation.operation, page), { product: "carebase", operation }).data).toEqual(page);
    for (const amount of [Number("9223372036854775807"), "9223372036854775808", "1e3", "01", "-1", "1.50"]) {
      expect(() => parseCheckoutCatalog({ ...page, items: [{ ...page.items[0], baseAmountMinor: amount }] }, operation)).toThrow();
    }
    expect(() => parseCheckoutCatalog({ ...page, providerAvailability: "available" }, operation)).toThrow();
    expect(() => parseCheckoutCatalog({ ...page, items: [{ ...page.items[0], privateCustomer: {} }] }, operation)).toThrow();
    expect(() => parsePortfolioRequest({ product: "breathe", ...operation })).toThrow();
    expect(() => parsePortfolioRequest({ product: "carebase", ...operation, limit: 51 })).toThrow();
    expect(() => parsePortfolioRequest({ product: "carebase", operation: "billing.checkout.apply" })).toThrow();
  });
});
