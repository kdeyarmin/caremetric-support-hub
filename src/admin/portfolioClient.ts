import { AdminApiError, requestAdmin } from "./transport";
export { AdminApiError } from "./transport";
import { parsePortfolioEnvelope, parsePortfolioRequest } from "../../supabase/functions/_shared/portfolioProtocol";
import type { AdminBillingOverview, AdminDirectoryUser, AdminOrganization, AdminPage, AdminSubscriptionPage, PortfolioCapabilities, PortfolioOperation, PortfolioOverview, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";

export interface PortfolioReadOptions { product: PortfolioProduct; signal: AbortSignal; }
export interface PortfolioPageOptions extends PortfolioReadOptions { search?: string; limit: number; offset: number; }
export interface PortfolioClient {
  capabilities(options: PortfolioReadOptions): Promise<PortfolioCapabilities>;
  overview(options: PortfolioReadOptions): Promise<PortfolioOverview>;
  organizations(options: PortfolioPageOptions): Promise<AdminPage<AdminOrganization>>;
  users(options: PortfolioPageOptions): Promise<AdminPage<AdminDirectoryUser>>;
  subscriptions(options: PortfolioPageOptions): Promise<AdminSubscriptionPage>;
  billing(options: PortfolioReadOptions): Promise<AdminBillingOverview>;
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
};
