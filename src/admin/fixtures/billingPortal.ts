import type { BillingIntent, BillingPreviewRequest, BillingResult } from "../../../supabase/functions/_shared/billingCommandProtocol";
export const billingOrganization = "aaaaaaaa-0000-4000-8000-000000000001";
export const billingCommandId = "aaaaaaaa-0000-4000-8000-000000000002";
export const billingRequest: BillingPreviewRequest = { operation: "preview", requestId: "aaaaaaaa-0000-4000-8000-000000000003",
  action: "billing.portal.create", targetId: billingOrganization, parameters: {}, reason: "Review the organization billing options" };
export const billingApply = { operation: "apply" as const, commandId: billingCommandId, expectedDigest: "a".repeat(64) };
// Public example from https://docs.stripe.com/api/customer_portal/sessions/create
export const portalUrl = "https://billing.stripe.com/p/session?secret=test_YWNjdF8xTTJKVGtMa2RJd0h1N2l4LF9OY2lBYjJXcHY4a2NPck96UjBEbFVYRnU5bjlwVUF50100BUtQs3bl";
export function billingIntent(now = Date.now()): BillingIntent {
  return { request: billingRequest, preview: { commandId: billingCommandId, action: billingRequest.action, targetId: billingOrganization,
    reason: billingRequest.reason, expiresAt: new Date(now + 240000).toISOString(), previewDigest: billingApply.expectedDigest,
    summary: { kind: "portal", organizationName: "Example organization", providerCustomerId: "cus_Example", providerConfigurationId: "bpc_Example", returnPath: "/admin/enterprise" } },
  result: null, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 28800000).toISOString(), previewDispatchedAt: new Date(now).toISOString(), dispatchedAt: null, retryAt: null };
}
export function billingCreated(now = Date.now()): BillingResult {
  return { commandId: billingCommandId, action: billingRequest.action, targetId: billingOrganization, outcome: "created", replayed: false,
    completedAt: new Date(now).toISOString(), retryAfterSeconds: null, session: { kind: "portal", id: "bps_Example", url: portalUrl, expiresAt: null, livemode: false } };
}
export const billingPending: BillingResult = { commandId: billingCommandId, action: billingRequest.action, targetId: billingOrganization,
  outcome: "pending", replayed: true, completedAt: null, retryAfterSeconds: 30, session: null };
