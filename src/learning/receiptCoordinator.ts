import { z } from "zod";
import { GatewayError } from "../../supabase/functions/_shared/adminGateway.ts";
import { learningReceiptSchema, receiptUuid, sourceReceiptBatchSchema, type LearningReceiptOperation } from "./receiptProtocol.ts";
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const preparedSchema = z.object({ mappingId: receiptUuid, organizationId: receiptUuid, employeeId: receiptUuid,
  hubTenantId: receiptUuid, hubUserId: receiptUuid, courseId: receiptUuid, versionId: receiptUuid, sourceRevision: digest });
const identitySchema = z.object({ organizationId: receiptUuid, employeeId: receiptUuid, profileId: receiptUuid });
const activeSchema = z.object({ mappingId: receiptUuid, sourceRevision: digest, active: z.literal(true) });

export async function coordinateLearningReceipt(op: LearningReceiptOperation, ctx: {signal: AbortSignal; hub(name: string, args?: Record<string,unknown>): Promise<unknown>; native(operation: unknown): Promise<unknown>}) {
      if (op.operation === "status") return ctx.hub("get_learning_receipt_status");
      if (op.operation === "provision_access") {
        const identity = identitySchema.parse(await ctx.native({ operation: "resolve_identity", organizationId: op.nativeOrganizationId, employeeId: op.nativeEmployeeId }));
        if (identity.organizationId.toLowerCase() !== op.nativeOrganizationId.toLowerCase() || identity.employeeId.toLowerCase() !== op.nativeEmployeeId.toLowerCase()) throw new GatewayError("upstream");
        return ctx.hub("provision_learning_receipt_access", { p_native_organization_id: identity.organizationId, p_native_employee_id: identity.employeeId,
          p_native_profile_id: identity.profileId, p_hub_tenant_id: op.hubTenantId, p_tenant_name: op.tenantName, p_hub_user_id: op.hubUserId });
      }
      if (op.operation === "provision") {
        const prepared = preparedSchema.parse(await ctx.hub("prepare_learning_receipt_mapping", { p_mapping_id: op.mappingId,
          p_source_snapshot_id: op.sourceSnapshotId, p_native_organization_id: op.nativeOrganizationId, p_native_employee_id: op.nativeEmployeeId,
          p_hub_tenant_id: op.hubTenantId, p_hub_user_id: op.hubUserId }));
        const active = activeSchema.parse(await ctx.native({ operation: "provision", ...prepared }));
        if (active.mappingId !== prepared.mappingId || active.sourceRevision !== prepared.sourceRevision) throw new GatewayError("upstream");
        await ctx.hub("set_learning_receipt_mapping_state", { p_mapping_id: op.mappingId, p_state: "active" });
      } else if (op.operation === "revoke") {
        // Stop Hub acceptance first. A lost native response is safe to retry.
        await ctx.hub("set_learning_receipt_mapping_state", { p_mapping_id: op.mappingId, p_state: "revoked" });
        await ctx.native({ operation: "revoke", mappingId: op.mappingId });
      } else if (op.operation === "retract") {
        await ctx.native(op);
      } else {
        const batch = sourceReceiptBatchSchema.parse(await ctx.native({ operation: "list", limit: op.limit }));
        const counts = { accepted: 0, quarantined: 0, failed: 0 };
        for (const entry of batch) {
          ctx.signal.throwIfAborted();
          if (entry.state === "quarantined") { counts.quarantined++; continue; }
          try {
            const receipt = learningReceiptSchema.parse(JSON.parse(entry.payload));
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entry.payload))), b => b.toString(16).padStart(2, "0")).join("");
            if (receipt.eventId !== entry.eventId || hash !== entry.sourceDigest) throw new GatewayError("upstream");
            const accepted = z.object({ eventId: receiptUuid, accepted: z.literal(true), replayed: z.boolean() }).parse(await ctx.hub("ingest_learning_receipt", { p_payload: entry.payload, p_source_digest: entry.sourceDigest }));
            if (accepted.eventId !== entry.eventId) throw new GatewayError("upstream");
            await ctx.native({ operation: "acknowledge", eventId: entry.eventId, sourceDigest: entry.sourceDigest });
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
}
