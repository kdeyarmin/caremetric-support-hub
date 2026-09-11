import { isUuid, parseAdminEnvelope, parseAdminOperation, type AdminOperation } from "./adminProtocol.ts";
import { billingReadOperations, parseBillingData, parseBillingOperation } from "./billingProtocol.ts";
import type { AdminInvoiceDetail, AdminInvoicePage, AdminSubscriptionVerification, BillingReadOperation } from "./billingProtocol.ts";

export const portfolioProducts = ["carebase", "breathe", "caremetric-emr", "pennsync", "intel", "caremetric-go"] as const;
export type PortfolioProduct = typeof portfolioProducts[number];
export const portfolioOperations = ["capabilities", "overview", "courses.list", "courses.get", "organizations.list", "users.list", "billing.overview", "billing.subscriptions.list", ...billingReadOperations, "commands.preview", "commands.apply"] as const;
export type PortfolioOperationName = typeof portfolioOperations[number];
export type DirectoryOperation = { operation: "organizations.list" | "users.list" | "billing.subscriptions.list"; search?: string; limit: number; offset: number };
export type PortfolioOperation = AdminOperation | DirectoryOperation | BillingReadOperation | { operation: "capabilities" | "billing.overview" };
export interface PortfolioRequest { product: PortfolioProduct; operation: PortfolioOperation; }
export interface PortfolioCapabilities { apiVersion: 1; operations: PortfolioOperationName[]; sourceRevision: string | null; }
export interface PortfolioOverview { organizationCount: number | null; activeUserCount: number | null; registeredUserCount?: number; globalCourseCount?: number; subscriptionCount?: number; }
export interface AdminOrganization { id: string; name: string | null; slug: string | null; status: string; createdAt: string | null; }
export interface AdminDirectoryUser { id: string; displayName: string | null; email: string | null; role: string; status: string; createdAt: string | null; }
export interface AdminSubscription {
  id: string; organizationId: string | null; organizationName: string | null; planCode: string | null; planName: string | null;
  status: string; providerStatus: string | null; providerCustomerId: string | null; providerSubscriptionId: string | null;
  currentPeriodEnd: string | null; updatedAt: string | null;
}
export interface AdminPage<T> { items: T[]; total: number; limit: number; offset: number; }
export type AdminSubscriptionPage = AdminPage<AdminSubscription> & { source: "application_database" };
export interface AdminBillingOverview { source: "application_database"; subscriptionCount: number; statusCounts: Array<{ status: string; count: number }>; }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid administration contract");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 1000): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid administration contract");
  return value;
}
function nullableString(value: unknown, max = 1000): string | null { return value === null ? null : string(value, max); }
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid administration contract");
  return value;
}
function id(value: unknown): string { if (!isUuid(value)) throw new Error("Invalid administration contract"); return value.toLowerCase(); }
function entityId(value: unknown, product: PortfolioProduct): string {
  if (product !== "pennsync" && product !== "intel") return id(value);
  if (typeof value !== "string" || !/^[0-9a-f]{24}$/.test(value)) throw new Error("Invalid native application identity");
  return value;
}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  const result = string(value, 100);
  if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid administration contract");
  return result;
}
function only(row: Record<string, unknown>, keys: string[]) {
  if (Object.keys(row).some(key => !keys.includes(key))) throw new Error("Unsupported administrator parameter");
}

/** Product is resolved only through the server registry, never a supplied URL. */
export function parsePortfolioRequest(input: unknown): PortfolioRequest {
  const row = object(input);
  const { product = "carebase", ...operation } = row;
  if (!portfolioProducts.includes(product as PortfolioProduct)) throw new Error("Unsupported application");
  let parsed: PortfolioOperation;
  if (billingReadOperations.includes(operation.operation as typeof billingReadOperations[number])) {
    if (product !== "carebase") throw new Error("Unsupported application billing read");
    parsed = parseBillingOperation(operation);
  } else if (operation.operation === "capabilities" || operation.operation === "billing.overview") {
    only(operation, ["operation"]);
    parsed = { operation: operation.operation };
  } else if (["organizations.list", "users.list", "billing.subscriptions.list"].includes(String(operation.operation))) {
    // Reuse the same bounded literal-search and pagination contract as courses.
    const page = parseAdminOperation({ ...operation, operation: "courses.list" });
    if (page.operation !== "courses.list") throw new Error("Invalid pagination");
    parsed = { ...page, operation: operation.operation as DirectoryOperation["operation"] };
  } else parsed = parseAdminOperation(operation);
  return { product: product as PortfolioProduct, operation: parsed };
}

function page<T>(row: Record<string, unknown>, operation: DirectoryOperation, project: (value: unknown) => T): AdminPage<T> {
  if (!Array.isArray(row.items) || row.items.length > operation.limit || row.limit !== operation.limit || row.offset !== operation.offset) throw new Error("Invalid administration page");
  return { items: row.items.map(project), total: count(row.total), limit: operation.limit, offset: operation.offset };
}
function organization(value: unknown, product: PortfolioProduct): AdminOrganization {
  const row = object(value);
  return { id: entityId(row.id, product), name: nullableString(row.name), slug: nullableString(row.slug, 255), status: string(row.status, 100), createdAt: timestamp(row.createdAt) };
}
function user(value: unknown, product: PortfolioProduct): AdminDirectoryUser {
  const row = object(value);
  if (product === "intel" && row.status !== "registered") throw new Error("Unverified Intel account activity");
  // Breathe's native identity column is TEXT; legacy IDs must retain their case.
  const userId = product === "breathe" ? string(row.id, 128) : entityId(row.id, product);
  if (product === "breathe" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(userId)) throw new Error("Invalid native identity");
  return { id: userId, displayName: nullableString(row.displayName), email: nullableString(row.email, 500), role: string(row.role, 100), status: string(row.status, 100), createdAt: timestamp(row.createdAt) };
}
function subscription(value: unknown, product: PortfolioProduct): AdminSubscription {
  const row = object(value);
  return {
    id: entityId(row.id, product), organizationId: product === "pennsync" && row.organizationId === null ? null : entityId(row.organizationId, product), organizationName: nullableString(row.organizationName),
    planCode: nullableString(row.planCode, 255), planName: nullableString(row.planName), status: string(row.status, 100),
    providerStatus: nullableString(row.providerStatus, 100), providerCustomerId: nullableString(row.providerCustomerId, 255),
    providerSubscriptionId: nullableString(row.providerSubscriptionId, 255), currentPeriodEnd: timestamp(row.currentPeriodEnd), updatedAt: timestamp(row.updatedAt),
  };
}

/** Enforce source identity, match the requested operation, and strip all unreviewed fields. */
export function parsePortfolioEnvelope(input: unknown, request: PortfolioRequest) {
  const envelope = object(input);
  const { product, operation } = request;
  if (envelope.contractVersion !== 1 || envelope.product !== product || envelope.operation !== operation.operation || timestamp(envelope.generatedAt) === null) throw new Error("Mismatched application response");
  if (product === "carebase" && ["overview", "courses.list", "courses.get"].includes(operation.operation)) {
    return parseAdminEnvelope(input, operation as AdminOperation);
  }
  const row = object(envelope.data);
  let data: PortfolioCapabilities | PortfolioOverview | AdminPage<AdminOrganization> | AdminPage<AdminDirectoryUser> | AdminSubscriptionPage | AdminBillingOverview | AdminInvoicePage | AdminInvoiceDetail | AdminSubscriptionVerification;
  if (billingReadOperations.includes(operation.operation as typeof billingReadOperations[number])) {
    if (product !== "carebase") throw new Error("Unsupported application billing read");
    data = parseBillingData(row, operation as BillingReadOperation, value => subscription(value, product));
  } else if (operation.operation === "capabilities") {
    if (row.apiVersion !== 1 || !Array.isArray(row.operations) || row.operations.length > 100 || row.operations.some(value => typeof value !== "string")) throw new Error("Invalid capabilities");
    const revision = nullableString(row.sourceRevision, 64);
    if (revision !== null && !/^[a-f0-9]{7,64}$/i.test(revision)) throw new Error("Invalid source revision");
    data = { apiVersion: 1, operations: [...new Set(row.operations.filter(value => portfolioOperations.includes(value as PortfolioOperationName)))] as PortfolioOperationName[], sourceRevision: revision };
  } else if (operation.operation === "overview" && product === "intel") {
    if (row.organizationCount !== null || row.activeUserCount !== null || row.subscriptionCount !== undefined) throw new Error("Unverified Intel totals");
    data = { organizationCount: null, activeUserCount: null, registeredUserCount: count(row.registeredUserCount) };
  } else if (operation.operation === "overview" && product === "breathe") {
    data = { organizationCount: count(row.organizationCount), activeUserCount: count(row.activeUserCount), subscriptionCount: count(row.subscriptionCount) };
  } else if (operation.operation === "overview" && (product === "caremetric-emr" || product === "caremetric-go" || product === "pennsync")) {
    if (row.activeUserCount !== null) throw new Error("Unverified account activity count");
    data = { organizationCount: count(row.organizationCount), activeUserCount: null, registeredUserCount: count(row.registeredUserCount), subscriptionCount: count(row.subscriptionCount) };
  } else if (operation.operation === "organizations.list") data = page(row, operation, value => organization(value, product));
  else if (operation.operation === "users.list") data = page(row, operation, value => user(value, product));
  else if (operation.operation === "billing.subscriptions.list") {
    if (row.source !== "application_database") throw new Error("Unrecognized billing source");
    data = { ...page(row, operation, value => subscription(value, product)), source: "application_database" };
  } else if (operation.operation === "billing.overview") {
    if (row.source !== "application_database" || !Array.isArray(row.statusCounts) || row.statusCounts.length > 100) throw new Error("Invalid billing overview");
    const statusCounts = row.statusCounts.map(value => { const status = object(value); return { status: string(status.status, 100), count: count(status.count) }; });
    const total = count(row.subscriptionCount);
    if (new Set(statusCounts.map(value => value.status)).size !== statusCounts.length || statusCounts.reduce((sum, value) => sum + value.count, 0) !== total) throw new Error("Incomplete billing overview");
    data = { source: "application_database", subscriptionCount: total, statusCounts };
  } else throw new Error("Unsupported application operation");
  return { contractVersion: 1 as const, product, operation: operation.operation, generatedAt: String(envelope.generatedAt), data };
}
