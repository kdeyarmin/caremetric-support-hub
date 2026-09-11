import { createAdminGateway, GatewayError, type AdminProxyOptions, type GatewayExecution } from "../_shared/adminGateway.ts";
import { learningReceiptOperationSchema, projectReceiptResult, receiptUuid } from "../../../src/learning/receiptProtocol.ts";

import { coordinateLearningReceipt } from "../../../src/learning/receiptCoordinator.ts";

const hubOrigin = "https://xgauehtwksmnoqhgqegm.supabase.co";
const nativeEndpoint = "https://cmcarebase.com/api/learning-admin/receipt";

export function createLearningReceiptProxy(options: AdminProxyOptions & { serviceKey: string }) {
  const native = (ctx: GatewayExecution, operation: unknown) => ctx.fetchJson(nativeEndpoint, {
    method: "POST", headers: { Authorization: ctx.authorization, "Content-Type": "application/json" }, body: JSON.stringify(operation),
  });
  const hub = (ctx: GatewayExecution, name: string, args: Record<string, unknown> = {}) => {
    if (!options.serviceKey || options.serviceKey.startsWith("sb_publishable_")) throw new GatewayError("unconfigured");
    return ctx.fetchJson(`${hubOrigin}/rest/v1/rpc/${name}`, { method: "POST", headers: {
      apikey: options.serviceKey, Authorization: `Bearer ${options.serviceKey}`, "Content-Type": "application/json", "Content-Profile": "hub",
    }, body: JSON.stringify({ ...args, p_actor_id: ctx.actor.user_id, p_session_id: ctx.actor.session_id }) });
  };
  return createAdminGateway(options, {
    authorizationRpc: "authorize_platform_command", commandErrors: true,
    validateAuthority: actor => {
      const start = Date.parse(String(actor.session_started_at)); const end = Date.parse(String(actor.assurance_expires_at)); const now = Date.now();
      return receiptUuid.safeParse(actor.session_id).success && start <= now && start > now - 480 * 60000 && end > now && end <= start + 480 * 60000;
    },
    parse: value => learningReceiptOperationSchema.parse(value),
    project: projectReceiptResult,
    execute: (op, ctx) => coordinateLearningReceipt(op, { signal: ctx.signal, hub: (name,args) => hub(ctx,name,args), native: operation => native(ctx,operation) }),
  });
}
