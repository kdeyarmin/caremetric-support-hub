import { requestAdmin } from "./transport";
import { tenantLifecycleContext, tenantLifecycleOperation, tenantLifecyclePreview } from "./tenantLifecycleProtocol";
import type { TenantLifecycleContext, TenantLifecycleOperation, TenantLifecyclePreview } from "./tenantLifecycleProtocol";

type Operation<K extends TenantLifecycleOperation["operation"]> = Extract<TenantLifecycleOperation, { operation: K }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export interface TenantLifecycleClient {
  request(operation: DistributiveOmit<Operation<"context">, "domain">, signal: AbortSignal): Promise<TenantLifecycleContext>;
  request(operation: DistributiveOmit<Operation<"preview" | "apply" | "resume">, "domain">, signal: AbortSignal): Promise<TenantLifecyclePreview>;
}

/** Breathe organization suspend and restore through the Hub server's /api/admin/tenant-lifecycle; every answer is checked again here. */
export const tenantLifecycleClient: TenantLifecycleClient = {
  async request(operation: DistributiveOmit<TenantLifecycleOperation, "domain">, signal: AbortSignal) {
    const parsed = tenantLifecycleOperation.parse({ domain: "tenant.lifecycle.v1", ...operation });
    const answer = await requestAdmin("tenant-lifecycle", parsed, signal);
    return (parsed.operation === "context" ? tenantLifecycleContext.parse(answer) : tenantLifecyclePreview.parse(answer)) as never;
  },
} as TenantLifecycleClient;
