import { parsePortfolioEnvelope, parsePortfolioRequest } from "../_shared/portfolioProtocol.ts";
import { adminRegistry } from "../_shared/adminRegistry.ts";
import { createAdminGateway, type AdminProxyOptions } from "../_shared/adminGateway.ts";
export type { AdminProxyOptions } from "../_shared/adminGateway.ts";

export function createAdminProxy(options: AdminProxyOptions) {
  return createAdminGateway(options, {
    authorizationRpc: "authorize_platform_admin",
    parse: parsePortfolioRequest,
    // Intel's and Advisors' bridges accept only first-party one-use SMS capabilities.
    target: parsed => ({ endpoint: parsed.product === "intel" || parsed.product === "advisors" ? null : adminRegistry[parsed.product].endpoint, authorizationHeader: adminRegistry[parsed.product].authorizationHeader, body: parsed.operation }),
    project: parsePortfolioEnvelope,
  });
}
