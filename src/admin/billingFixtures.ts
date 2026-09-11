import type { AdminInvoice, AdminInvoiceDetail, AdminSubscriptionVerification } from "../../supabase/functions/_shared/billingProtocol";
import type { AdminSubscription } from "../../supabase/functions/_shared/portfolioProtocol";

export const billingFixtureTime = "2026-09-11T17:00:00.000Z";
export const invoiceFixture: AdminInvoice = {
  id: "91000000-0000-4000-8000-000000000001", organizationId: "92000000-0000-4000-8000-000000000001", organizationName: "Fixture organization", subscriptionId: "93000000-0000-4000-8000-000000000001",
  providerInvoiceId: "in_fixture", providerSubscriptionId: "sub_fixture", status: "paid", currency: "usd", amountDueMinor: "9223372036854775807", amountPaidMinor: "9223372036854775807", amountRemainingMinor: "0",
  issuedAt: billingFixtureTime, dueAt: null, paidAt: billingFixtureTime, updatedAt: billingFixtureTime,
};
export const subscriptionFixture: AdminSubscription = {
  id: "93000000-0000-4000-8000-000000000001", organizationId: invoiceFixture.organizationId, organizationName: "Fixture organization", planCode: null, planName: "Fixture plan", status: "active", providerStatus: "active",
  providerCustomerId: "cus_fixture", providerSubscriptionId: "sub_fixture", currentPeriodEnd: null, updatedAt: billingFixtureTime,
};
export const invoiceDetailFixture: AdminInvoiceDetail = {
  recorded: invoiceFixture,
  provider: { source: "stripe", apiVersion: "2026-02-25.clover", availability: "available", checkedAt: billingFixtureTime, data: {
    id: "in_fixture", customerId: "cus_fixture", subscriptionId: "sub_fixture", status: "paid", currency: "usd", amountDueMinor: invoiceFixture.amountDueMinor, amountPaidMinor: invoiceFixture.amountPaidMinor, amountRemainingMinor: "0",
    createdAt: billingFixtureTime, dueAt: null, paidAt: billingFixtureTime, livemode: false,
  } }, comparison: { status: "matches", fields: [] },
};
export const subscriptionVerificationFixture: AdminSubscriptionVerification = {
  recorded: subscriptionFixture,
  applicationAccess: { billingState: "comped", stateSource: "manual_comp", compedUntil: null, graceEndsAt: null, updatedAt: billingFixtureTime },
  provider: { source: "stripe", apiVersion: "2026-02-25.clover", availability: "available", checkedAt: billingFixtureTime, data: {
    id: "sub_fixture", customerId: "cus_fixture", status: "active", cancelAtPeriodEnd: false, canceledAt: null, livemode: false,
  } }, comparison: { status: "matches", fields: [] },
};
