import { isUuid, parseAdminEnvelope, parseAdminOperation, type AdminOperation } from "./adminProtocol.ts";
import { billingReadOperations, parseBillingData, parseBillingOperation } from "./billingProtocol.ts";
import type { AdminInvoiceDetail, AdminInvoicePage, AdminSubscriptionVerification, BillingReadOperation } from "./billingProtocol.ts";
import { parseCheckoutCatalog, type BillingCatalogOperation, type BillingPackagePage } from "./checkoutCatalogProtocol.ts";
import { isOperationalRead, operationalReadOperations, parseOperationalRead, parseOperationalPage, type OperationalPage, type OperationalRow, type OperationalReadOperation } from "./operationsProtocol.ts";

export const portfolioProducts = ["carebase", "breathe", "caremetric-emr", "pennsync", "intel", "caremetric-go", "advisors"] as const;
export type PortfolioProduct = typeof portfolioProducts[number];
export const learningPackageCapabilities = ["learning.packages.context", "learning.packages.status", "learning.packages.upload", "learning.packages.accept", "learning.packages.finish"] as const;
export const portfolioOperations = ["phone.messages.list", "inquiries.list", "capabilities", "overview", "courses.list", "courses.get", "organizations.list", "users.list", "billing.overview", "billing.subscriptions.list", ...billingReadOperations, ...operationalReadOperations, ...learningPackageCapabilities, "learning.distribution.context", "billing.packages.list", "commands.preview", "commands.apply", "billing.commands.preview", "billing.commands.apply", "billing.checkout.preview", "billing.checkout.apply", "billing.checkout.check", "billing.checkout.recover", "support.identity.resolve", "learning.media.v1", "operations.config.v1", "training.v1"] as const;
export type PortfolioOperationName = typeof portfolioOperations[number];
export type DirectoryOperation = { operation: "organizations.list" | "users.list" | "billing.subscriptions.list" | "phone.messages.list" | "inquiries.list"; search?: string; limit: number; offset: number };
/** Healthcare Advisors is a consulting practice: it exposes only its consultation inbox. */
export const advisorsOperations: readonly PortfolioOperationName[] = ["capabilities", "overview", "inquiries.list"];
export type PortfolioOperation = AdminOperation | DirectoryOperation | BillingReadOperation | BillingCatalogOperation | OperationalReadOperation | { operation: "capabilities" | "billing.overview" };
export interface PortfolioRequest { product: PortfolioProduct; operation: PortfolioOperation; }
export interface PortfolioCapabilities { apiVersion: 1; operations: PortfolioOperationName[]; sourceRevision: string | null; }
export interface PortfolioOverview { organizationCount: number | null; activeUserCount: number | null; registeredUserCount?: number; globalCourseCount?: number; subscriptionCount?: number; inquiryCount?: number; openInquiryCount?: number; }
export interface PhoneMessage {
  id: string; contactName: string | null; companyName: string | null; phone: string | null;
  email: string | null; message: string; status: string; createdAt: string | null; product: string; requestType: string;
  sms?: { status: string; resources: string[]; errorCode: string | null } | null;
}
/** A consultation request submitted through caremetricadvisors.com. Contact details are self-reported. */
export interface AdvisorInquiry {
  id: string; createdAt: string; name: string; email: string; organization: string; phone: string | null;
  sector: string; service: string; message: string; status: "new" | "in-progress" | "closed"; notes: string;
}
export const advisorInquiryStatuses = ["new", "in-progress", "closed"] as const;
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
  if (product === "advisors" ? !advisorsOperations.includes(operation.operation as PortfolioOperationName) : operation.operation === "inquiries.list") throw new Error("Unsupported application operation");
  let parsed: PortfolioOperation;
  if (isOperationalRead(operation.operation)) {
    if (product !== "carebase") throw new Error("Unsupported application operational read");
    parsed = parseOperationalRead(operation);
  } else if (operation.operation === "billing.packages.list") {
    if (product !== "carebase") throw new Error("Unsupported application checkout catalog");
    const page = parseAdminOperation({ ...operation, operation: "courses.list" });
    if (page.operation !== "courses.list") throw new Error("Invalid checkout pagination");
    parsed = { ...page, operation: "billing.packages.list" };
  } else if (billingReadOperations.includes(operation.operation as typeof billingReadOperations[number])) {
    if (product !== "carebase") throw new Error("Unsupported application billing read");
    parsed = parseBillingOperation(operation);
  } else if (operation.operation === "capabilities" || operation.operation === "billing.overview") {
    only(operation, ["operation"]);
    parsed = { operation: operation.operation };
  } else if (["organizations.list", "users.list", "billing.subscriptions.list", "phone.messages.list", "inquiries.list"].includes(String(operation.operation))) {
    if (operation.operation === "phone.messages.list" && product !== "breathe") throw new Error("Unsupported phone inbox source");
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

function inquiry(value: unknown): AdvisorInquiry {
  const row = object(value);
  const id = string(row.id, 15);
  if (!/^CM-[A-F0-9]{12}$/.test(id)) throw new Error("Invalid consultation reference");
  const createdAt = timestamp(row.createdAt);
  const status = string(row.status, 20);
  if (createdAt === null || !advisorInquiryStatuses.includes(status as AdvisorInquiry["status"])) throw new Error("Invalid consultation request");
  const phone = string(row.phone, 40);
  return { id, createdAt, name: string(row.name, 100), email: string(row.email, 200), organization: string(row.organization, 160), phone: phone.trim() ? phone : null,
    sector: string(row.sector, 80), service: string(row.service, 80), message: string(row.message, 1800), status: status as AdvisorInquiry["status"], notes: string(row.notes, 3000) };
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
  let data: AdminPage<PhoneMessage> | AdminPage<AdvisorInquiry> | PortfolioCapabilities | PortfolioOverview | AdminPage<AdminOrganization> | AdminPage<AdminDirectoryUser> | AdminSubscriptionPage | AdminBillingOverview | AdminInvoicePage | AdminInvoiceDetail | AdminSubscriptionVerification | BillingPackagePage | OperationalPage<OperationalRow>;
  if (isOperationalRead(operation.operation)) {
    if (product !== "carebase" || Object.keys(envelope).length !== 5 || typeof envelope.generatedAt !== "string" || !/^\d{4}-\d\d-\d\dT/.test(envelope.generatedAt)) throw new Error("Invalid operational read envelope");
    data = parseOperationalPage(row, operation as OperationalReadOperation);
  } else if (operation.operation === "billing.packages.list") {
    if (product !== "carebase" || Object.keys(envelope).length !== 5) throw new Error("Invalid checkout catalog envelope");
    data = parseCheckoutCatalog(row, operation);
  } else if (billingReadOperations.includes(operation.operation as typeof billingReadOperations[number])) {
    if (product !== "carebase") throw new Error("Unsupported application billing read");
    data = parseBillingData(row, operation as BillingReadOperation, value => subscription(value, product));
  } else if (operation.operation === "capabilities") {
    if (row.apiVersion !== 1 || !Array.isArray(row.operations) || row.operations.length > 100 || row.operations.some(value => typeof value !== "string")) throw new Error("Invalid capabilities");
    const revision = nullableString(row.sourceRevision, 64);
    if (revision !== null && !/^[a-f0-9]{7,64}$/i.test(revision)) throw new Error("Invalid source revision");
    data = { apiVersion: 1, operations: [...new Set(row.operations.filter(value => portfolioOperations.includes(value as PortfolioOperationName) && (product === "advisors" ? advisorsOperations.includes(value as PortfolioOperationName) : value !== "inquiries.list") && (product === "carebase" || !isOperationalRead(value) && value !== "learning.distribution.context" && value !== "learning.media.v1" && value !== "operations.config.v1" && value !== "training.v1" && !learningPackageCapabilities.includes(value as typeof learningPackageCapabilities[number]))))] as PortfolioOperationName[], sourceRevision: revision };
  } else if (operation.operation === "phone.messages.list") {
    if (product !== "breathe") throw new Error("Unsupported phone inbox source");
    data = page(row, operation, value => {
      const item = object(value);
      let sms: PhoneMessage["sms"];
      if (item.sms !== undefined) {
        if (item.sms === null) sms = null;
        else {
          const text = object(item.sms);
          const status = string(text.status, 20);
          if (!["submitting", "accepted", "delivered", "failed", "undelivered", "unknown"].includes(status) || !Array.isArray(text.resources) || text.resources.length > 3) throw new Error("Invalid text delivery record");
          sms = { status, resources: text.resources.map(value => string(value, 80)), errorCode: nullableString(text.errorCode, 20) };
        }
      }
      return { id: id(item.id), contactName: nullableString(item.contactName, 160), companyName: nullableString(item.companyName, 200),
        phone: nullableString(item.phone, 40), email: nullableString(item.email, 500), message: string(item.message, 2000),
        status: string(item.status, 100), createdAt: timestamp(item.createdAt), product: string(item.product, 80), requestType: string(item.requestType, 80), ...(sms !== undefined ? { sms } : {}) };
    });
  } else if (operation.operation === "inquiries.list") {
    if (product !== "advisors") throw new Error("Unsupported consultation inbox source");
    data = page(row, operation, value => inquiry(value));
  } else if (operation.operation === "overview" && product === "advisors") {
    if (row.organizationCount !== null || row.activeUserCount !== null || row.subscriptionCount !== undefined) throw new Error("Advisors reports no organizations, accounts or subscriptions");
    const inquiryCount = count(row.inquiryCount), openInquiryCount = count(row.openInquiryCount);
    if (openInquiryCount > inquiryCount) throw new Error("Inconsistent consultation totals");
    data = { organizationCount: null, activeUserCount: null, inquiryCount, openInquiryCount };
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
