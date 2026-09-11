import { isUuid, parseAdminOperation } from "./adminProtocol.ts";
import type { AdminPage, AdminSubscription } from "./portfolioProtocol.ts";

export const billingReadOperations = ["billing.invoices.list", "billing.invoices.get", "billing.subscriptions.verify"] as const;
export type BillingReadOperation = { operation: "billing.invoices.list"; limit: number; offset: number; search?: string }
  | { operation: "billing.invoices.get" | "billing.subscriptions.verify"; id: string };
export interface AdminInvoice {
  id: string; organizationId: string; organizationName: string | null; subscriptionId: string | null;
  providerInvoiceId: string; providerSubscriptionId: string | null; status: string; currency: string;
  amountDueMinor: string; amountPaidMinor: string; amountRemainingMinor: string;
  issuedAt: string | null; dueAt: string | null; paidAt: string | null; updatedAt: string | null;
}
export type AdminInvoicePage = AdminPage<AdminInvoice> & { source: "application_database" };
export interface ProviderInvoice {
  id: string; customerId: string; subscriptionId: string | null; status: string; currency: string;
  amountDueMinor: string; amountPaidMinor: string; amountRemainingMinor: string;
  createdAt: string; dueAt: string | null; paidAt: string | null; livemode: boolean;
}
export interface ProviderSubscription {
  id: string; customerId: string; status: string; cancelAtPeriodEnd: boolean; canceledAt: string | null; livemode: boolean;
}
export type ProviderAvailability = "available" | "unconfigured" | "unavailable" | "notfound" | "identity_mismatch";
export type ProviderRead<T> = { source: "stripe"; apiVersion: "2026-02-25.clover"; checkedAt: string } & (
  { availability: "available"; data: T } | { availability: Exclude<ProviderAvailability, "available">; data: null }
);
export type InvoiceComparisonField = "status" | "currency" | "amountDueMinor" | "amountPaidMinor" | "amountRemainingMinor";
export interface BillingComparison<T extends string> { status: "matches" | "differences" | "not_checked"; fields: T[]; }
export interface AdminInvoiceDetail { recorded: AdminInvoice; provider: ProviderRead<ProviderInvoice>; comparison: BillingComparison<InvoiceComparisonField>; }
export interface AdminSubscriptionVerification {
  recorded: AdminSubscription;
  applicationAccess: { billingState: string; stateSource: string; compedUntil: string | null; graceEndsAt: string | null; updatedAt: string | null };
  provider: ProviderRead<ProviderSubscription>; comparison: BillingComparison<"providerStatus">;
}

const invalid = (): never => { throw new Error("Invalid billing contract"); };
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function closed(value: unknown, keys: readonly string[]) {
  const row = object(value);
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function text(value: unknown, max: number): string { return typeof value === "string" && value.length <= max ? value : invalid(); }
function nullableText(value: unknown, max: number) { return value === null ? null : text(value, max); }
function id(value: unknown): string { return isUuid(value) ? value.toLowerCase() : invalid(); }
function nullableId(value: unknown) { return value === null ? null : id(value); }
function providerId(value: unknown, prefix: "in" | "sub" | "cus"): string {
  const result = text(value, 255);
  return new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(result) ? result : invalid();
}
function nullableProviderId(value: unknown, prefix: "sub") { return value === null ? null : providerId(value, prefix); }
function timestamp(value: unknown): string {
  const result = text(value, 30);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid();
  return result;
}
function nullableTime(value: unknown) { return value === null ? null : timestamp(value); }
function count(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid(); }
function boolean(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function status(value: unknown) { const result = text(value, 80); return /^[a-z_]{1,80}$/.test(result) ? result : invalid(); }
function currency(value: unknown) { const result = text(value, 3); return /^[a-z]{3}$/.test(result) ? result : invalid(); }
/** Decimal integer strings preserve every PostgreSQL bigint without Number coercion. */
export function parseMinorAmount(value: unknown): string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n ? value : invalid();
}

export function parseBillingOperation(input: unknown): BillingReadOperation {
  const row = object(input);
  if (row.operation === "billing.invoices.list") {
    const parsed = parseAdminOperation({ ...row, operation: "courses.list", limit: row.limit ?? 25 });
    if (parsed.operation !== "courses.list") return invalid();
    const search = parsed.search?.trim();
    return { operation: "billing.invoices.list", limit: parsed.limit, offset: parsed.offset, ...(search ? { search } : {}) };
  }
  closed(row, ["operation", "id"]);
  if (row.operation !== "billing.invoices.get" && row.operation !== "billing.subscriptions.verify") return invalid();
  return { operation: row.operation, id: id(row.id) };
}

const invoiceKeys = ["id", "organizationId", "organizationName", "subscriptionId", "providerInvoiceId", "providerSubscriptionId", "status", "currency", "amountDueMinor", "amountPaidMinor", "amountRemainingMinor", "issuedAt", "dueAt", "paidAt", "updatedAt"];
function invoice(input: unknown): AdminInvoice {
  const row = closed(input, invoiceKeys);
  return {
    id: id(row.id), organizationId: id(row.organizationId), organizationName: nullableText(row.organizationName, 500), subscriptionId: nullableId(row.subscriptionId),
    providerInvoiceId: providerId(row.providerInvoiceId, "in"), providerSubscriptionId: nullableProviderId(row.providerSubscriptionId, "sub"),
    status: text(row.status, 80), currency: currency(row.currency), amountDueMinor: parseMinorAmount(row.amountDueMinor), amountPaidMinor: parseMinorAmount(row.amountPaidMinor), amountRemainingMinor: parseMinorAmount(row.amountRemainingMinor),
    issuedAt: nullableTime(row.issuedAt), dueAt: nullableTime(row.dueAt), paidAt: nullableTime(row.paidAt), updatedAt: nullableTime(row.updatedAt),
  };
}
function providerInvoice(input: unknown): ProviderInvoice {
  const row = closed(input, ["id", "customerId", "subscriptionId", "status", "currency", "amountDueMinor", "amountPaidMinor", "amountRemainingMinor", "createdAt", "dueAt", "paidAt", "livemode"]);
  return {
    id: providerId(row.id, "in"), customerId: providerId(row.customerId, "cus"), subscriptionId: nullableProviderId(row.subscriptionId, "sub"), status: status(row.status), currency: currency(row.currency),
    amountDueMinor: parseMinorAmount(row.amountDueMinor), amountPaidMinor: parseMinorAmount(row.amountPaidMinor), amountRemainingMinor: parseMinorAmount(row.amountRemainingMinor),
    createdAt: timestamp(row.createdAt), dueAt: nullableTime(row.dueAt), paidAt: nullableTime(row.paidAt), livemode: boolean(row.livemode),
  };
}
function providerSubscription(input: unknown): ProviderSubscription {
  const row = closed(input, ["id", "customerId", "status", "cancelAtPeriodEnd", "canceledAt", "livemode"]);
  return { id: providerId(row.id, "sub"), customerId: providerId(row.customerId, "cus"), status: status(row.status), cancelAtPeriodEnd: boolean(row.cancelAtPeriodEnd), canceledAt: nullableTime(row.canceledAt), livemode: boolean(row.livemode) };
}
function provider<T>(input: unknown, project: (value: unknown) => T): ProviderRead<T> {
  const row = closed(input, ["source", "apiVersion", "availability", "checkedAt", "data"]);
  if (row.source !== "stripe" || row.apiVersion !== "2026-02-25.clover") invalid();
  const base = { source: "stripe" as const, apiVersion: "2026-02-25.clover" as const, checkedAt: timestamp(row.checkedAt) };
  if (row.availability === "available") return { ...base, availability: "available", data: project(row.data) };
  if (!["unconfigured", "unavailable", "notfound", "identity_mismatch"].includes(String(row.availability)) || row.data !== null) invalid();
  return { ...base, availability: row.availability as Exclude<ProviderAvailability, "available">, data: null };
}
function comparison<T extends string>(input: unknown, available: boolean, differences: T[]): BillingComparison<T> {
  const row = closed(input, ["status", "fields"]);
  const expected = available ? differences.length ? "differences" : "matches" : "not_checked";
  if (row.status !== expected || !Array.isArray(row.fields) || row.fields.length !== differences.length || new Set(row.fields).size !== row.fields.length || differences.some(field => !(row.fields as unknown[]).includes(field))) invalid();
  return { status: expected, fields: differences };
}

export function parseBillingData(input: unknown, operation: BillingReadOperation, projectSubscription: (value: unknown) => AdminSubscription): AdminInvoicePage | AdminInvoiceDetail | AdminSubscriptionVerification {
  if (operation.operation === "billing.invoices.list") {
    const row = closed(input, ["source", "items", "total", "limit", "offset"]);
    if (row.source !== "application_database" || row.limit !== operation.limit || row.offset !== operation.offset || !Array.isArray(row.items) || row.items.length > operation.limit) invalid();
    const items = (row.items as unknown[]).map(invoice), total = count(row.total);
    if (new Set(items.map(item => item.id)).size !== items.length || items.length > Math.max(0, total - operation.offset)) invalid();
    return { source: "application_database", items, total, limit: operation.limit, offset: operation.offset };
  }
  const row = closed(input, operation.operation === "billing.invoices.get" ? ["recorded", "provider", "comparison"] : ["recorded", "applicationAccess", "provider", "comparison"]);
  if (operation.operation === "billing.invoices.get") {
    const recorded = invoice(row.recorded), checked = provider(row.provider, providerInvoice);
    if (recorded.id !== operation.id) invalid();
    const fields: InvoiceComparisonField[] = ["status", "currency", "amountDueMinor", "amountPaidMinor", "amountRemainingMinor"];
    if (checked.availability === "available" && (checked.data.id !== recorded.providerInvoiceId || (recorded.providerSubscriptionId !== null && checked.data.subscriptionId !== recorded.providerSubscriptionId))) invalid();
    const differences = checked.availability === "available" ? fields.filter(field => recorded[field] !== checked.data[field]) : [];
    return { recorded, provider: checked, comparison: comparison(row.comparison, checked.availability === "available", differences) };
  }
  closed(row.recorded, ["id", "organizationId", "organizationName", "planCode", "planName", "status", "providerStatus", "providerCustomerId", "providerSubscriptionId", "currentPeriodEnd", "updatedAt"]);
  const recorded = projectSubscription(row.recorded), checked = provider(row.provider, providerSubscription);
  if (recorded.id !== operation.id) invalid();
  if (checked.availability === "available" && (checked.data.id !== recorded.providerSubscriptionId || checked.data.customerId !== recorded.providerCustomerId)) invalid();
  const access = closed(row.applicationAccess, ["billingState", "stateSource", "compedUntil", "graceEndsAt", "updatedAt"]);
  if (!["trial", "active", "grace", "past_due", "canceled", "comped", "suspended"].includes(String(access.billingState)) || !["legacy", "stripe", "manual_comp", "manual_suspension"].includes(String(access.stateSource))) invalid();
  const differences: "providerStatus"[] = checked.availability === "available" && recorded.providerStatus !== checked.data.status ? ["providerStatus"] : [];
  return { recorded, provider: checked, comparison: comparison(row.comparison, checked.availability === "available", differences), applicationAccess: {
    billingState: String(access.billingState), stateSource: String(access.stateSource), compedUntil: nullableTime(access.compedUntil), graceEndsAt: nullableTime(access.graceEndsAt), updatedAt: nullableTime(access.updatedAt),
  } };
}
