import { createAdminGateway, type AdminProxyOptions } from "../_shared/adminGateway.ts";
import { parseCommandEnvelope, parsePortfolioCommand } from "../_shared/adminCommandProtocol.ts";
import { isUuid } from "../_shared/adminProtocol.ts";

export function createCommandProxy(options: AdminProxyOptions) {
  return createAdminGateway(options, {
    authorizationRpc: "authorize_platform_command",
    commandErrors: true,
    validateAuthority: actor => {
      const started = typeof actor.session_started_at === "string" ? Date.parse(actor.session_started_at) : NaN;
      const expires = typeof actor.assurance_expires_at === "string" ? Date.parse(actor.assurance_expires_at) : NaN;
      const now = Date.now();
      return isUuid(actor.session_id) && Number.isFinite(started) && Number.isFinite(expires)
        && started >= now - 480 * 60000 && started <= now + 5 * 60000 && expires > now && expires <= started + 480 * 60000;
    },
    parse: parsePortfolioCommand,
    target: parsed => ({ endpoint: "https://cmcarebase.com/api/platform-admin/command", body: parsed.command }),
    project: parseCommandEnvelope,
  });
}
