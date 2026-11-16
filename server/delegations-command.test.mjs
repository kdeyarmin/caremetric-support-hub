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
      if (text.includes('hub.authorize_app_command()') || text.includes('hub.authorize_app_admin()')) return { rows: [{ actor: { user_id: 'owner', role: 'platform_admin', method: 'sms' } }] };
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

describe('an account change in CareMetric Intel', () => {
  const account = '00000000000000000000002a';
  const intelPreview = { product: 'intel', ...preview, targetId: account };
  const intelEnvelope = { ...envelope, product: 'intel', data: { ...envelope.data, targetId: account, changes: [{ field: 'status', before: 'active', after: 'disabled' }] } };

  it('is not offered until the database declares the feature', async () => {
    const fetchImpl = vi.fn();
    await expect(delegations({ pool: pool([signedIn]), storageUrl: 'https://storage.test', fetchImpl }).command('token', intelPreview))
      .rejects.toMatchObject({ status: 503, code: 'unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("goes to Intel's own command endpoint with an intel.command capability in Intel's header", async () => {
    const issued = [];
    const fetchImpl = vi.fn(async () => Response.json(intelEnvelope));
    const base = pool([signedIn, signedIn]);
    const recording = { connect: async () => { const client = await base.connect(); return { ...client, query: async (text, values) => { if (text.startsWith('insert into private.app_delegations')) issued.push(values[2]); return client.query(text, values); } }; } };
    const result = await delegations({ pool: recording, storageUrl: 'https://storage.test', fetchImpl, appCommands: true }).command('token', intelPreview);
    expect(result.data.changes).toEqual([{ field: 'status', before: 'active', after: 'disabled' }]);
    expect(issued).toEqual(['intel.command']);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://www.caremetricintel.com/functions/centralAdminCommand');
    expect(Object.keys(options.headers).sort()).toEqual(['Content-Type', 'X-CareMetric-Hub-Authorization']);
    expect(JSON.parse(options.body)).toEqual({ ...preview, targetId: account });
  });

  it("refuses a UUID id for Intel before anything is issued", async () => {
    const fetchImpl = vi.fn();
    const service = delegations({ pool: pool([signedIn]), storageUrl: 'https://storage.test', fetchImpl, appCommands: true });
    await expect(service.command('token', { ...intelPreview, targetId: target })).rejects.toMatchObject({ status: 400 });
    await expect(service.command('token', { ...intelPreview, action: 'organizations.setSuspension', parameters: { suspended: true }, targetId: target })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends an Intel organization's suspension to Intel's own command endpoint, as reviewed", async () => {
    const suspension = { ...intelPreview, action: 'organizations.setSuspension', parameters: { suspended: true } };
    const fetchImpl = vi.fn(async () => Response.json({ ...intelEnvelope, data: { ...intelEnvelope.data, action: 'organizations.setSuspension' } }));
    const result = await delegations({ pool: pool([signedIn, signedIn]), storageUrl: 'https://storage.test', fetchImpl, appCommands: true }).command('token', suspension);
    expect(result.data).toMatchObject({ action: 'organizations.setSuspension', targetId: account, changes: [{ field: 'status', before: 'active', after: 'disabled' }] });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://www.caremetricintel.com/functions/centralAdminCommand');
    expect(JSON.parse(options.body)).toEqual({ ...preview, action: 'organizations.setSuspension', parameters: { suspended: true }, targetId: account });
  });

  it("shows the application's reason for a refusal in the Hub's own words, never its text", async () => {
    const answer = body => vi.fn(async () => Response.json(body, { status: 422 }));
    const service = fetchImpl => delegations({ pool: pool([signedIn]), storageUrl: 'https://storage.test', fetchImpl, appCommands: true });
    await expect(service(answer({ error: { code: 'refused', reason: 'last_administrator' } })).command('token', intelPreview))
      .rejects.toMatchObject({ status: 422, code: 'refused', publicMessage: 'This is the last active administrator. Make someone else an administrator first.' });
    await expect(service(answer({ error: { code: 'refused', reason: 'Please email ceo@example.test' } })).command('token', intelPreview))
      .rejects.toMatchObject({ status: 422, code: 'refused', publicMessage: 'The application refused this change. Check the account in the application itself.' });
  });
});

describe('capabilities offered to the browser', () => {
  const lifecycle = ['organizations.lifecycle.context', 'organizations.lifecycle.preview', 'organizations.lifecycle.apply', 'organizations.lifecycle.resume'];
  const read = (product, operations, appCommands) => {
    const fetchImpl = vi.fn(async () => Response.json({ contractVersion: 1, product, operation: 'capabilities', generatedAt: '2026-11-16T16:00:00.000Z', data: { apiVersion: 1, operations, sourceRevision: null } }));
    return delegations({ pool: pool([signedIn, signedIn]), storageUrl: 'https://storage.test', fetchImpl, appCommands }).admin('token', { product, operation: 'capabilities' }).then(result => result.data.operations);
  };
  it("keep Breathe's and Intel's change operations hidden until the database declares them", async () => {
    expect(await read('breathe', ['organizations.list', ...lifecycle], false)).toEqual(['organizations.list']);
    expect(await read('breathe', ['organizations.list', ...lifecycle, 'commands.preview'], true)).toEqual(['organizations.list', ...lifecycle]);
    expect(await read('intel', ['users.list', 'commands.preview', 'commands.apply'], false)).toEqual(['users.list']);
    expect(await read('intel', ['users.list', 'commands.preview', 'commands.apply', ...lifecycle], true)).toEqual(['users.list', 'commands.preview', 'commands.apply']);
    expect(await read('carebase', ['users.list', 'commands.preview', 'commands.apply'], false)).toEqual(['users.list', 'commands.preview', 'commands.apply']);
  });
  it("offer Breathe's staff sign-in changes only from Breathe, and only once declared", async () => {
    const staff = ['staff.access.context', 'staff.access.preview', 'staff.access.apply', 'staff.access.resume'];
    expect(await read('breathe', ['users.list', ...staff], false)).toEqual(['users.list']);
    expect(await read('breathe', ['users.list', ...staff, ...lifecycle], true)).toEqual(['users.list', ...staff, ...lifecycle]);
    expect(await read('intel', ['users.list', ...staff], true)).toEqual(['users.list']);
    expect(await read('carebase', ['users.list', ...staff], true)).toEqual(['users.list']);
  });
});
