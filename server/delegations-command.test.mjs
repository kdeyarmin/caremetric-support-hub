import { describe, expect, it, vi } from 'vitest';
import { delegations } from './delegations.mjs';

const target = '99400000-0000-4000-8000-000000000002', commandId = '99400000-0000-4000-8000-000000000003';
const preview = { operation: 'preview', requestId: '99400000-0000-4000-8000-000000000001', action: 'users.setActive', targetId: target, parameters: { active: false }, reason: 'Deactivate departed fixture staff' };
const envelope = { contractVersion: 1, product: 'carebase', operation: 'preview', generatedAt: '2026-11-16T16:00:00.000Z',
  data: { commandId, action: 'users.setActive', targetId: target, reason: preview.reason, expiresAt: '2026-11-16T16:04:00.000Z', previewDigest: 'a'.repeat(64), changes: [{ field: 'active', before: 'true', after: 'false' }] } };

// A pool whose session lookups answer from `sessions` in turn: a row while signed in, none once the session is revoked.
function pool(sessions) {
  const lookups = [...sessions];
  return { connect: async () => ({
    release() {},
    query: async text => {
      if (/^select s\.id/.test(text)) return { rows: lookups.length ? lookups.shift() : [] };
      if (text.includes('hub.authorize_app_command()')) return { rows: [{ actor: { user_id: 'owner', role: 'platform_admin', method: 'sms' } }] };
      return { rows: [] };
    },
  }) };
}
const signedIn = [{ id: 'session', user_id: 'owner', auth_method: 'sms' }];

describe('an access change in CareBase', () => {
  it('returns the preview while the session stays signed in', async () => {
    const fetchImpl = vi.fn(async () => Response.json(envelope));
    const result = await delegations({ pool: pool([signedIn, signedIn]), storageUrl: 'https://storage.test', fetchImpl }).command('token', preview);
    expect(result.data).toEqual(envelope.data);
    expect(fetchImpl).toHaveBeenCalledWith('https://cmcarebase.com/api/platform-admin/command', expect.anything());
  });

  it('keeps the before-and-after values from a session revoked while CareBase answered', async () => {
    const fetchImpl = vi.fn(async () => Response.json(envelope));
    await expect(delegations({ pool: pool([signedIn, []]), storageUrl: 'https://storage.test', fetchImpl }).command('token', preview))
      .rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
