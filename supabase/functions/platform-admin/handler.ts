import { parsePortfolioEnvelope, parsePortfolioRequest } from "../_shared/portfolioProtocol.ts";
import { adminRegistry } from "../_shared/adminRegistry.ts";
import { createAdminGateway, type AdminProxyOptions } from "../_shared/adminGateway.ts";
export type { AdminProxyOptions } from "../_shared/adminGateway.ts";

export function createAdminProxy(options: AdminProxyOptions) {
  return createAdminGateway(options, {
    authorizationRpc: "authorize_platform_admin",
    parse: parsePortfolioRequest,
    target: parsed => ({ endpoint: adminRegistry[parsed.product].endpoint, body: parsed.operation }),
    project: parsePortfolioEnvelope,
  });
}
