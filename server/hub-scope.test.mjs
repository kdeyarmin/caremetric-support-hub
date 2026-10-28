import { describe, expect, it, vi } from 'vitest';
import { nativeSelfService, selfService } from './self-service.mjs';
import { adminRegistry } from '../supabase/functions/_shared/adminRegistry.ts';
import { centralHubApps } from '../src/hubScope.ts';
import { selfServiceApps, connectionSchema } from '../src/self-service/protocol.ts';
import { CAREMETRIC_PRODUCT_SLUGS, buildHelpUrl } from '../packages/help-sdk/src/index.ts';

describe('centralized Hub application boundary', () => {
  it('exposes only CareBase, Breathe and Intel across native and Help interfaces', () => {
    expect(Object.keys(nativeSelfService).sort()).toEqual([...centralHubApps].sort());
    expect([...CAREMETRIC_PRODUCT_SLUGS].sort()).toEqual([...centralHubApps].sort());
    expect(selfServiceApps).toEqual(centralHubApps);
    expect(Object.entries(adminRegistry).filter(([, entry]) => entry.endpoint).map(([slug]) => slug).sort()).toEqual(['breathe', 'carebase', 'intel']);
  });

  it.each(['pennsync', 'caremetric-emr', 'caremetric-go', 'advisors'])('refuses stale credentials for %s before issuing or redeeming authority', async slug => {
    const query = vi.fn(async sql => ({ rows: sql.includes('billing_authenticate_app') ? [{ result: { slug, product_id: '96000000-0000-4000-8000-000000000001' } }] : [] }));
    const service = selfService({ pool: { connect: async () => ({ query, release: vi.fn() }) }, provider: {} });
    await expect(service.issue(`Bearer cmb_${'a'.repeat(43)}`, { account: 'old-account', user: 'old-user', account_name: 'Old account', display_name: 'Old user', role: 'member', facilities: [], capabilities: [] })).rejects.toMatchObject({ status: 401 });
    expect(query.mock.calls.some(([sql]) => sql.includes('issue_self_service_connection'))).toBe(false);
    await expect(service.consume(`Bearer cms_${'a'.repeat(43)}`, slug)).rejects.toMatchObject({ status: 401 });
    expect(query.mock.calls.some(([sql]) => sql.includes('consume_self_service_operation'))).toBe(false);
    expect(() => buildHelpUrl({ context: { product: slug } })).toThrow();
    expect(connectionSchema.safeParse({ id: "96000000-0000-4000-8000-000000000001", tenant_id: "96000000-0000-4000-8000-000000000002", app: slug, name: "Old application", role: "member", facilities: [], capabilities: [], connected_at: "2026-10-28T00:00:00Z" }).success).toBe(false);
  });
});
