import { describe, expect, it, vi } from 'vitest';
import { nativeConnectionOrigin, selfService } from './self-service.mjs';

describe('native customer connection links', () => {
  it.each(['carebase', 'breathe', 'caremetric-intel'])('keeps %s connections on the origin its native adapter trusts', async slug => {
    const query = vi.fn(async sql => ({ rows: sql.includes('billing_authenticate_app') ? [{ result: { slug, product_id: '96000000-0000-4000-8000-000000000001' } }] : [] }));
    const release = vi.fn();
    const service = selfService({ pool: { connect: async () => ({ query, release }) }, provider: {}, publicOrigin: 'https://help.caremetric.ai' });
    const result = await service.issue(`Bearer cmb_${'a'.repeat(43)}`, {
      account: 'synthetic-account', user: 'synthetic-user', account_name: 'Synthetic account', display_name: 'Synthetic user',
      role: 'member', facilities: [], capabilities: ['training.profile.v1'],
    });
    const link = new URL(result.url);
    expect(link.origin).toBe(nativeConnectionOrigin);
    expect(link.pathname).toBe('/connect');
    expect(link.search).toBe('');
    expect(link.hash).toMatch(/^#cmc_[A-Za-z0-9_-]{43}$/);
    expect(result.expires_in).toBe(300);
    expect(query.mock.calls.some(([sql]) => sql.includes('issue_self_service_connection'))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});
