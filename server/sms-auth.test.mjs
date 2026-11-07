import { describe, expect, it, vi } from 'vitest';
import { smsAuth } from './sms-auth.mjs';

const owner = '+12025550101', stranger = '+12025550199';
// A database that holds one registered number and records what is written to it.
function fakePool() {
  const writes = [];
  const query = vi.fn(async (sql, values = []) => {
    if (/^(begin|commit|rollback)/.test(sql)) return { rows: [] };
    if (sql.includes('count(*) filter')) return { rows: [{ total: 0, phone_count: 0, client_count: 0, recent: 0 }] };
    if (sql.includes('usable_sms_identity')) return { rows: values[0] === owner ? [{ user_id: 'u1', identity_version: 1 }] : [] };
    if (sql.includes('from private.sms_challenges c')) return { rows: [] };
    writes.push(sql);
    return { rows: [] };
  });
  return { writes, query, connect: async () => ({ query, release() {} }) };
}

describe('SMS sign-in code requests', () => {
  it('answers a registered and an unregistered number the same way, without waiting for the provider', async () => {
    let release;
    const provider = { send: vi.fn(() => new Promise(resolve => { release = resolve; })), verify: vi.fn(async () => false) };
    const auth = smsAuth({ pool: fakePool(), provider, log: { warn() {} } });
    // The provider has not answered, yet both requests are already answered, with the same fields.
    const [known, unknown] = await Promise.all([auth.start(owner, '203.0.113.9'), auth.start(stranger, '203.0.113.9')]);
    expect(Object.keys(known).sort()).toEqual(['browserToken', 'id']);
    expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort());
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.send).toHaveBeenCalledWith(owner);
    release('provider-id');
  });

  it('does not tell the requester when the provider fails', async () => {
    const warn = vi.fn();
    const auth = smsAuth({ pool: fakePool(), provider: { send: vi.fn(async () => { throw new Error('upstream'); }), verify: vi.fn() }, log: { warn } });
    const answer = await auth.start(owner, '203.0.113.9');
    expect(Object.keys(answer).sort()).toEqual(['browserToken', 'id']);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  });

  it('checks a code only once its text has been recorded', async () => {
    const pool = fakePool();
    let release;
    const provider = { send: vi.fn(() => new Promise(resolve => { release = resolve; })), verify: vi.fn(async () => false) };
    const auth = smsAuth({ pool, provider, log: { warn() {} } });
    const { id, browserToken } = await auth.start(owner, '203.0.113.9');
    let checked = false;
    const verifying = auth.verify(id, browserToken, '123456', null).catch(() => { checked = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(checked).toBe(false);
    release('provider-id');
    await verifying;
    expect(checked).toBe(true);
    expect(pool.writes.some(sql => sql.includes('set provider_id'))).toBe(true);
  });
});
