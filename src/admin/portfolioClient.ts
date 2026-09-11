import { AdminApiError, requestAdmin } from "./transport";
export { AdminApiError } from "./transport";
import { parsePortfolioEnvelope, parsePortfolioRequest } from "../../supabase/functions/_shared/portfolioProtocol";
import type { AdminBillingOverview, AdminDirectoryUser, AdminOrganization, AdminPage, AdminSubscriptionPage, PortfolioCapabilities, PortfolioOperation, PortfolioOverview, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import type { AdminInvoiceDetail, AdminInvoicePage, AdminSubscriptionVerification } from "../../supabase/functions/_shared/billingProtocol";

export interface PortfolioReadOptions { product: PortfolioProduct; signal: AbortSignal; }
export interface PortfolioPageOptions extends PortfolioReadOptions { search?: string; limit: number; offset: number; }
export interface PortfolioClient {
  capabilities(options: PortfolioReadOptions): Promise<PortfolioCapabilities>;
  overview(options: PortfolioReadOptions): Promise<PortfolioOverview>;
  organizations(options: PortfolioPageOptions): Promise<AdminPage<AdminOrganization>>;
  users(options: PortfolioPageOptions): Promise<AdminPage<AdminDirectoryUser>>;
  subscriptions(options: PortfolioPageOptions): Promise<AdminSubscriptionPage>;
  billing(options: PortfolioReadOptions): Promise<AdminBillingOverview>;
  invoices(options: Omit<PortfolioPageOptions, "product">): Promise<AdminInvoicePage>;
  invoice(options: { id: string; signal: AbortSignal }): Promise<AdminInvoiceDetail>;
  verifySubscription(options: { id: string; signal: AbortSignal }): Promise<AdminSubscriptionVerification>;
}

export async function readPortfolio(product: PortfolioProduct, operation: PortfolioOperation, signal: AbortSignal) {
  let parsed;
  try { parsed = parsePortfolioRequest({ product, ...operation }); } catch { throw new AdminApiError("invalid_request"); }
  const response = await requestAdmin("platform-admin", { product: parsed.product, ...parsed.operation }, signal);
  return parsePortfolioEnvelope(response, parsed).data;
}

export const portfolioClient: PortfolioClient = {
  capabilities: async ({ product, signal }) => await readPortfolio(product, { operation: "capabilities" }, signal) as PortfolioCapabilities,
  overview: async ({ product, signal }) => await readPortfolio(product, { operation: "overview" }, signal) as PortfolioOverview,
  organizations: async ({ product, signal, ...page }) => await readPortfolio(product, { ...page, operation: "organizations.list" }, signal) as AdminPage<AdminOrganization>,
  users: async ({ product, signal, ...page }) => await readPortfolio(product, { ...page, operation: "users.list" }, signal) as AdminPage<AdminDirectoryUser>,
  subscriptions: async ({ product, signal, ...page }) => await readPortfolio(product, { ...page, operation: "billing.subscriptions.list" }, signal) as AdminSubscriptionPage,
  billing: async ({ product, signal }) => await readPortfolio(product, { operation: "billing.overview" }, signal) as AdminBillingOverview,
  invoices: async ({ signal, ...page }) => await readPortfolio("carebase", { ...page, operation: "billing.invoices.list" }, signal) as AdminInvoicePage,
  invoice: async ({ id, signal }) => await readPortfolio("carebase", { operation: "billing.invoices.get", id }, signal) as AdminInvoiceDetail,
  verifySubscription: async ({ id, signal }) => await readPortfolio("carebase", { operation: "billing.subscriptions.verify", id }, signal) as AdminSubscriptionVerification,
};
