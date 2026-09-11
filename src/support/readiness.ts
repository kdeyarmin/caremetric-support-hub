import { z } from 'zod';
import { appRequest } from '../lib/appSession';

const count = z.number().int().nonnegative();
export const readinessProduct = z.object({
  id: z.uuid(), slug: z.string(), name: z.string(), status: z.enum(['active','pilot','retired']),
  supportEnabled: z.boolean(), activeTenantCount: count, usableMemberCount: count,
  readyTenantCount: count, publishedItemCount: count,
});
export const intakeTenant = z.object({
  tenantId: z.uuid(), name: z.string(), tenantStatus: z.string(), accessStatus: z.string(),
  enabled: z.boolean(), updatedAt: z.string().nullable(), usableMemberCount: count, ready: z.boolean(),
});
const summary = z.object({ products: z.array(readinessProduct), loadedAt: z.string() });
const page = z.object({ rows: z.array(intakeTenant), total: count, offset: count, limit: count });
export type ReadinessProduct = z.infer<typeof readinessProduct>;
export type IntakeTenant = z.infer<typeof intakeTenant>;
export const readinessClient = {
  async summary(signal?: AbortSignal) { return summary.parse(await appRequest('rpc/get_support_readiness', {}, signal)); },
  async tenants(productId: string, offset: number, signal?: AbortSignal) {
    return page.parse(await appRequest('rpc/list_support_intake_tenants', {p_product_id:productId,p_offset:offset,p_limit:20}, signal));
  },
  async set(productId: string, tenant: IntakeTenant, enabled: boolean) {
    return appRequest('rpc/set_support_intake', {
      p_product_id:productId,p_tenant_id:tenant.tenantId,p_enabled:enabled,
      p_reviewed:true,p_expected_updated_at:tenant.updatedAt,
    });
  },
};
export type ReadinessClient = typeof readinessClient;
export function intakeBlocker(product: ReadinessProduct, tenant: IntakeTenant) {
  if (product.status==='retired' || !product.supportEnabled) return 'Support is disabled for this app.';
  if (tenant.tenantStatus!=='active' || tenant.accessStatus!=='active') return 'Customer access is inactive.';
  if (!tenant.usableMemberCount) return 'A customer member must finish SMS sign-in setup.';
  return null;
}
