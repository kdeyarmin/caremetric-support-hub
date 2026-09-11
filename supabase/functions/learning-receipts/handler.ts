import { z } from "zod";
import { createAdminGateway, GatewayError, type AdminProxyOptions, type GatewayExecution } from "../_shared/adminGateway.ts";
import { learningReceiptOperationSchema, learningReceiptSchema, projectReceiptResult, receiptUuid, sourceReceiptBatchSchema } from "../../../src/learning/receiptProtocol.ts";

const hubOrigin = "https://xgauehtwksmnoqhgqegm.supabase.co";
const nativeEndpoint = "https://cmcarebase.com/api/learning-admin/receipt";
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const preparedSchema = z.object({ mappingId: receiptUuid, organizationId: receiptUuid, employeeId: receiptUuid,
  hubTenantId: receiptUuid, hubUserId: receiptUuid, courseId: receiptUuid, versionId: receiptUuid, sourceRevision: digest });
const identitySchema = z.object({ organizationId: receiptUuid, employeeId: receiptUuid, profileId: receiptUuid });
const activeSchema = z.object({ mappingId: receiptUuid, sourceRevision: digest, active: z.literal(true) });

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
    execute: async (op, ctx) => {
      if (op.operation === "status") return hub(ctx, "get_learning_receipt_status");
      if (op.operation === "provision_access") {
        const identity = identitySchema.parse(await native(ctx, { operation: "resolve_identity", organizationId: op.nativeOrganizationId, employeeId: op.nativeEmployeeId }));
        if (identity.organizationId.toLowerCase() !== op.nativeOrganizationId.toLowerCase() || identity.employeeId.toLowerCase() !== op.nativeEmployeeId.toLowerCase()) throw new GatewayError("upstream");
        return hub(ctx, "provision_learning_receipt_access", { p_native_organization_id: identity.organizationId, p_native_employee_id: identity.employeeId,
          p_native_profile_id: identity.profileId, p_hub_tenant_id: op.hubTenantId, p_tenant_name: op.tenantName, p_hub_user_id: op.hubUserId });
      }
      if (op.operation === "provision") {
        const prepared = preparedSchema.parse(await hub(ctx, "prepare_learning_receipt_mapping", { p_mapping_id: op.mappingId,
          p_source_snapshot_id: op.sourceSnapshotId, p_native_organization_id: op.nativeOrganizationId, p_native_employee_id: op.nativeEmployeeId,
          p_hub_tenant_id: op.hubTenantId, p_hub_user_id: op.hubUserId }));
        const active = activeSchema.parse(await native(ctx, { operation: "provision", ...prepared }));
        if (active.mappingId !== prepared.mappingId || active.sourceRevision !== prepared.sourceRevision) throw new GatewayError("upstream");
        await hub(ctx, "set_learning_receipt_mapping_state", { p_mapping_id: op.mappingId, p_state: "active" });
      } else if (op.operation === "revoke") {
        // Stop Hub acceptance first. A lost native response is safe to retry.
        await hub(ctx, "set_learning_receipt_mapping_state", { p_mapping_id: op.mappingId, p_state: "revoked" });
        await native(ctx, { operation: "revoke", mappingId: op.mappingId });
      } else if (op.operation === "retract") {
        await native(ctx, op);
      } else {
        const batch = sourceReceiptBatchSchema.parse(await native(ctx, { operation: "list", limit: op.limit }));
        const counts = { accepted: 0, quarantined: 0, failed: 0 };
        for (const entry of batch) {
          ctx.signal.throwIfAborted();
          if (entry.state === "quarantined") { counts.quarantined++; continue; }
          try {
            const receipt = learningReceiptSchema.parse(JSON.parse(entry.payload));
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entry.payload))), b => b.toString(16).padStart(2, "0")).join("");
            if (receipt.eventId !== entry.eventId || hash !== entry.sourceDigest) throw new GatewayError("upstream");
            const accepted = z.object({ eventId: receiptUuid, accepted: z.literal(true), replayed: z.boolean() }).parse(await hub(ctx, "ingest_learning_receipt", { p_payload: entry.payload, p_source_digest: entry.sourceDigest }));
            if (accepted.eventId !== entry.eventId) throw new GatewayError("upstream");
            await native(ctx, { operation: "acknowledge", eventId: entry.eventId, sourceDigest: entry.sourceDigest });
            counts.accepted++;
          } catch (error) {
            ctx.signal.throwIfAborted();
            if (error instanceof GatewayError && ["unauthenticated", "forbidden", "expired"].includes(error.code)) throw error;
            counts.failed++;
          }
        }
        return counts;
      }
      return { success: true };
    },
  });
}
