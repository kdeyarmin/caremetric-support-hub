import { describe, expect, it } from "vitest";
import { billingCommandSchema, billingIntentSchema, billingPortalUrlSchema, billingResultMetadata, nativeBillingCommandSchema, projectBillingCommand, verifyBillingOutcome } from "../../supabase/functions/_shared/billingCommandProtocol";
import { billingApply, billingCreated, billingIntent, billingOrganization, billingPending, billingRequest, portalUrl } from "./fixtures/billingPortal";
const now = Date.parse("2026-09-11T19:30:00.000Z");
const envelope = (data: unknown, operation: "preview" | "apply" = "preview") => ({ contractVersion: 1, product: "carebase", operation, generatedAt: new Date(now).toISOString(), data });

describe("closed billing portal contract", () => {
  it("allows only native preview/apply and separate Hub resume/discard operations", () => {
    expect(nativeBillingCommandSchema.parse(billingRequest)).toEqual(billingRequest);
    expect(nativeBillingCommandSchema.parse(billingApply)).toEqual(billingApply);
    for (const input of [{ ...billingRequest, actor: billingOrganization }, { ...billingRequest, parameters: { returnUrl: portalUrl } },
      { ...billingRequest, action: "billing.checkout.create" }, { ...billingRequest, reason: "short" }, { ...billingRequest, reason: "Invalid\nreason" },
      { ...billingApply, expectedDigest: "A".repeat(64) }, { ...billingApply, targetId: billingOrganization },
      { operation: "resume", targetId: billingOrganization }]) expect(nativeBillingCommandSchema.safeParse(input).success).toBe(false);
    expect(billingCommandSchema.parse({ operation: "resume", targetId: billingOrganization })).toBeDefined();
    expect(billingCommandSchema.safeParse({ operation: "resume", targetId: billingOrganization, actorId: billingOrganization }).success).toBe(false);
  });
  it("binds previews to the exact target/reason and a bounded native lifetime", () => {
    const preview = billingIntent(now).preview!;
    expect(projectBillingCommand(envelope(preview), billingRequest)).toEqual(preview);
    for (const patch of [{ targetId: billingApply.commandId }, { reason: "A different administrative reason" }, { expiresAt: new Date(now).toISOString() },
      { expiresAt: new Date(now + 302000).toISOString() }, { extra: "unreviewed" }, { summary: { ...preview.summary, url: portalUrl } }])
      expect(() => projectBillingCommand(envelope({ ...preview, ...patch }), billingRequest)).toThrow();
    expect(() => projectBillingCommand({ ...envelope(preview), product: "breathe" }, billingRequest)).toThrow();
    expect(() => projectBillingCommand({ ...envelope(preview), providerSecret: "unreviewed" }, billingRequest)).toThrow();
  });
  it("preserves pending, terminal identity and URL-free durable metadata", () => {
    const created = billingCreated(now), preview = billingIntent(now).preview!;
    expect(projectBillingCommand(envelope(created, "apply"), billingApply)).toEqual(created);
    expect(projectBillingCommand(envelope(billingPending, "apply"), billingApply)).toEqual(billingPending);
    expect(verifyBillingOutcome(created, preview)).toEqual(created);
    expect(JSON.stringify(billingResultMetadata(created))).not.toContain(portalUrl);
    expect(() => billingIntentSchema.parse({ ...billingIntent(now), result: created })).toThrow();
    for (const patch of [{ targetId: billingApply.commandId }, { action: "billing.checkout.create" }, { commandId: billingOrganization }])
      expect(() => verifyBillingOutcome({ ...created, ...patch }, preview)).toThrow();
    for (const patch of [{ retryAfterSeconds: 1 }, { completedAt: new Date(now).toISOString() }, { session: created.session }])
      expect(() => projectBillingCommand(envelope({ ...billingPending, ...patch }, "apply"), billingApply)).toThrow();
  });
  it.each(["http://billing.stripe.com/p/session/x", "https://billing.stripe.com.evil.invalid/p/session/x", "https://user@billing.stripe.com/p/session/x",
    "https://billing.stripe.com/p/session/x#secret", "https://billing.stripe.com:443/p/session/x", "https://billing.stripe.com/p/session/../other",
    "https://billing.stripe.com/login/test", "https://billing.stripe.com/p/session/", "javascript:alert(1)", `https://billing.stripe.com/p/session/${"a".repeat(2049)}`,
    "https://billing.stripe.com/p/session/test/path", "https://billing.stripe.com/p/session/test?locale=en",
    "https://billing.stripe.com/p/session?secret=test&locale=en", "https://billing.stripe.com/p/session?secret=test&secret=other",
    "https://billing.stripe.com/p/session?secret=test%2Ffoo", "https://billing.stripe.com/p/session?secret=", "https://billing.stripe.com/p/session/test#"])("rejects an unsafe or noncanonical provider URL %s", url => {
    expect(billingPortalUrlSchema.safeParse(url).success).toBe(false);
  });
  it("accepts Stripe's documented secret query and the legacy single-token path", () => {
    expect(billingPortalUrlSchema.parse(portalUrl)).toBe(portalUrl);
    const legacy = "https://billing.stripe.com/p/session/test_fixture";
    expect(billingPortalUrlSchema.parse(legacy)).toBe(legacy);
  });
});
