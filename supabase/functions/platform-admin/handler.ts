import { parsePortfolioEnvelope, parsePortfolioRequest } from "../_shared/portfolioProtocol.ts";
import { adminRegistry } from "../_shared/adminRegistry.ts";
import { createAdminGateway, type AdminProxyOptions } from "../_shared/adminGateway.ts";
export type { AdminProxyOptions } from "../_shared/adminGateway.ts";

export function createAdminProxy(options: AdminProxyOptions) {
  return createAdminGateway(options, {
    authorizationRpc: "authorize_platform_admin",
    parse: parsePortfolioRequest,
    // Intel's hosted bridge accepts only first-party one-use SMS capabilities.
    target: parsed => ({ endpoint: parsed.product === "intel" ? null : adminRegistry[parsed.product].endpoint, authorizationHeader: adminRegistry[parsed.product].authorizationHeader, body: parsed.operation }),
    project: parsePortfolioEnvelope,
  });
}
