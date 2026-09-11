import type { CheckoutIntent, CheckoutPreview, CheckoutPreviewRequest, CheckoutResult } from "../../../supabase/functions/_shared/checkoutCommandProtocol";
import type { BillingPackageChoice, BillingPackagePage } from "../../../supabase/functions/_shared/checkoutCatalogProtocol";

export const checkoutOrganization = "11111111-1111-4111-8111-111111111111";
export const checkoutPackageId = "22222222-2222-4222-8222-222222222222";
export const checkoutCommandId = "33333333-3333-4333-8333-333333333333";
export const checkoutSessionId = "cs_test_a11YYufWQzNY63zpQ6QSNRQhkUpVph4WRmzW0zWJO2znZKdVujZ0N0S22u";
// Public example, https://docs.stripe.com/api/checkout/sessions/object (2026-09-11).
export const checkoutUrl = `https://checkout.stripe.com/c/pay/${checkoutSessionId}#fidkdWxOYHwnPyd1blpxYHZxWjA0SDdPUW5JbmFMck1wMmx9N2BLZjFEfGRUNWhqTmJ%2FM2F8bUA2SDRySkFdUV81T1BSV0YxcWJcTUJcYW5rSzN3dzBLPUE0TzRKTTxzNFBjPWZEX1NKSkxpNTVjRjN8VHE0YicpJ2N3amhWYHdzYHcnP3F3cGApJ2lkfGpwcVF8dWAnPyd2bGtiaWBabHFgaCcpJ2BrZGdpYFVpZGZgbWppYWB3dic%2FcXdwYHgl`;
export const checkoutRequest: CheckoutPreviewRequest = {
  operation: "preview", action: "billing.checkout.create", requestId: "44444444-4444-4444-8444-444444444444",
  targetId: checkoutOrganization, parameters: { packageId: checkoutPackageId, billingInterval: "month" }, reason: "Review the native subscription checkout",
};
export const checkoutApply = { operation: "apply" as const, action: "billing.checkout.create" as const, commandId: checkoutCommandId, expectedDigest: "a".repeat(64) };
export const checkoutCheck = { ...checkoutApply, operation: "check" as const };
export const checkoutChoice: BillingPackageChoice = {
  id: "55555555-5555-4555-8555-555555555555", packageId: checkoutPackageId, name: "Example plan",
  description: "Recorded native plan", status: "active", availability: "mapped", providerPriceId: "price_Example",
  billingInterval: "month", intervalCount: 3, billingMetric: "flat", pricingModel: "flat", currency: "usd",
  baseAmountMinor: "9223372036854775807", unitAmountMinor: null, includedQuantity: 0, minimumQuantity: 1, maximumQuantity: null, trialDays: 14,
};
export function checkoutCatalog(): BillingPackagePage {
  return { source: "application_database", providerAvailability: "not_checked", items: [{ ...checkoutChoice }], total: 1, limit: 20, offset: 0 };
}
export function checkoutPreview(): CheckoutPreview {
  return { commandId: checkoutCommandId, action: checkoutRequest.action, targetId: checkoutOrganization, reason: checkoutRequest.reason,
    expiresAt: new Date(Date.now() + 240000).toISOString(), previewDigest: checkoutApply.expectedDigest,
    summary: { kind: "checkout", organizationName: "Example organization", packageId: checkoutPackageId, billingInterval: "month", intervalCount: 3,
      currency: "usd", billingMetric: "flat", quantity: 1, providerPriceId: "price_Example", providerCustomerId: null, trialDays: 14 } };
}
export function checkoutOpen(): CheckoutResult {
  return { commandId: checkoutCommandId, action: checkoutRequest.action, targetId: checkoutOrganization, outcome: "open", replayed: false,
    checkedAt: new Date().toISOString(), providerStatus: "open", availability: "available", canStartNewCheckout: false, retryAfterSeconds: null,
    session: { kind: "checkout", id: checkoutSessionId, url: checkoutUrl, expiresAt: new Date(Date.now() + 3600000).toISOString(), livemode: false } };
}
export function checkoutPending(): CheckoutResult {
  return { commandId: checkoutCommandId, action: checkoutRequest.action, targetId: checkoutOrganization, outcome: "pending", replayed: true,
    checkedAt: null, providerStatus: null, availability: "unavailable", canStartNewCheckout: false, retryAfterSeconds: 30, session: null };
}
export function checkoutClosed(outcome: "complete" | "expired" | "failed", canStartNewCheckout = false): CheckoutResult {
  return { commandId: checkoutCommandId, action: checkoutRequest.action, targetId: checkoutOrganization, outcome, replayed: true,
    checkedAt: new Date().toISOString(), providerStatus: outcome === "failed" ? null : outcome, availability: "available",
    canStartNewCheckout, retryAfterSeconds: null, session: null };
}
export function checkoutIntent(): CheckoutIntent {
  return { request: checkoutRequest, preview: checkoutPreview(), result: null, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 28800000).toISOString(), previewDispatchedAt: new Date().toISOString(), dispatchedAt: null, retryAt: null };
}
