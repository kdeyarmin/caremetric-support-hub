import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connectionFields, connectionValue, openConnection, sealConnection, socialConnections, socialConnectionsFeature } from './social-connections.mjs';
import { appServer } from './http.mjs';
import { HttpError } from './sms-auth.mjs';

const key = randomBytes(32).toString('hex');
const token = 'fake-social-token-for-testing-only';
const version = '2026-11-11T05:00:00.000001+00:00';
const rows = () => ['meta','linkedin'].map(provider => ({ provider, ciphertext: null, revision: randomUUID() }));
const fields = provider => Object.fromEntries(Object.keys(connectionFields[provider]).map(name => [name, { value: name === 'pageId' || name === 'organizationId' ? '123' : '', changedAt: version }]));

it('authenticates ciphertext, isolates providers and never uses deterministic encryption', () => {
  const value = { token };
  const sealed = sealConnection('meta', value, key);
  expect(sealed).not.toContain(token);
  expect(sealConnection('meta', value, key)).not.toBe(sealed);
  expect(openConnection('meta', sealed, key)).toEqual(value);
  const parts = sealed.split('.');
  const damaged = Buffer.from(parts[3], 'base64url'); damaged[0] ^= 1; parts[3] = damaged.toString('base64url');
  for (const [provider, ciphertext, secret] of [
    ['linkedin', sealed, key], ['meta', sealed, randomBytes(32).toString('hex')],
    ['meta', parts.join('.'), key], ['meta', 'not-ciphertext', key],
  ]) expect(() => openConnection(provider, ciphertext, secret)).toThrow('Social connection storage is unavailable');
  expect(() => sealConnection('meta', value, 'short')).toThrow('Social connection storage is unavailable');
});

it('accepts only useful Page links and normalizes them without a network lookup', () => {
  expect(connectionValue('meta', 'pageId', ' https://www.facebook.com/profile.php?id=123 ')).toBe('123');
  expect(connectionValue('linkedin', 'organizationId', 'https://www.linkedin.com/company/456/admin/dashboard/')).toBe('456');
  expect(connectionValue('linkedin', 'organizationId', 'urn:li:organization:456')).toBe('456');
  expect(connectionValue('meta', 'adAccountId', 'act_123')).toBe('act_123');
  expect(connectionValue('meta', 'instagramId', '')).toBeNull();
  for (const value of ['https://linkedin.com.evil.test/company/456/admin/', 'https://www.linkedin.com/company/a-name/', 'https://user@linkedin.com/company/456/', 'https://127.0.0.1/company/456/', 'hello']) {
    expect(() => connectionValue('linkedin', 'organizationId', value)).toThrow();
  }
});

function harness({ environment = {}, denied = false } = {}) {
  const state = { rows: rows(), fail: false, denied, queries: [] };
  const values = Object.values(connectionFields).flatMap(Object.entries).map(([name, key]) => ({ key, value: name === 'pageId' || name === 'organizationId' ? '123' : null, changedAt: version }));
  state.values = values;
  const read = vi.fn(async () => { if (state.fail) throw new Error(token); return { connections: state.rows, settings: Object.fromEntries(state.values.map(row => [row.key, row.value])) }; });
  const session = vi.fn(async (_session, work) => work({ query: async (sql, args) => {
    state.queries.push(sql);
    if (sql.includes('authorize_app_') && state.denied) throw new HttpError(403, 'Owner access required.');
    if (sql.includes('get_hub_settings')) return { rows: [{ result: values }] };
    if (sql.includes('social_connection_values')) return { rows: [{ result: state.rows }] };
    if (sql.includes('save_social_connection')) {
      const row = state.rows.find(row => row.provider === args[0]);
      if (row.revision !== args[1]) throw Object.assign(new Error('stale'), { code: '40001' });
      row.ciphertext = args[2]; row.revision = randomUUID();
    }
    return { rows: [] };
  } }));
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [], elements: [] }), { status: 200 }));
  const env = { HUB_SOCIAL_CREDENTIALS_KEY: key, ...environment };
  const service = socialConnections({ features: new Set([socialConnectionsFeature]), settings: { get: () => 'older-general-cache', refresh: vi.fn(async () => {}) }, env, read, session, fetchImpl });
  return { state, service, read, fetchImpl };
}

it('writes encrypted bundles, preserves blank secrets, clears explicitly and never echoes secrets', async () => {
  const { service, state } = harness({ environment: { HUB_META_ACCESS_TOKEN: token } });
  await service.refresh();
  let view = await service.list('owner');
  expect(JSON.stringify(view)).not.toContain(token);
  const save = async secrets => {
    const revision = state.rows.find(row => row.provider === 'meta').revision;
    await service.admin('owner', { action: 'save', provider: 'meta', revision, fields: fields('meta'), secrets });
  };
  await save({ token: ' ' });
  expect(service.resolvedEnv().HUB_META_ACCESS_TOKEN).toBe(token);
  expect(JSON.stringify(state.rows)).not.toContain(token);
  expect(openConnection('meta', state.rows.find(row => row.provider === 'meta').ciphertext, key)).toEqual({ token });
  await save({ token: null });
  expect(service.resolvedEnv().HUB_META_ACCESS_TOKEN).toBe('');
  view = await service.list('owner');
  expect(view.connections.find(row => row.provider === 'meta').secrets.token).toBe(false);
  await save({ token: 'replacement-token-testing-only' });
  expect(service.resolvedEnv().HUB_META_ACCESS_TOKEN).toBe('replacement-token-testing-only');
});

it('fails closed while storage is unavailable, including after a previously successful read', async () => {
  const { service, state } = harness({ environment: { HUB_META_ACCESS_TOKEN: token } });
  expect(service.resolvedEnv().HUB_META_ACCESS_TOKEN).toBe('');
  await service.refresh();
  expect(service.resolvedEnv().HUB_META_ACCESS_TOKEN).toBe(token);
  state.fail = true;
  await expect(service.refresh()).rejects.toThrow('Social connection storage is unavailable');
  expect(service.resolvedEnv().HUB_META_ACCESS_TOKEN).toBe('');
  state.fail = false;
  state.rows[0].ciphertext = sealConnection('meta', { token }, randomBytes(32).toString('hex'));
  await expect(service.refresh()).rejects.toThrow('Social connection storage is unavailable');
  expect(service.resolvedEnv().HUB_META_ACCESS_TOKEN).toBe('');
});

it('keeps tokens and account IDs paired when the general settings cache is older or a refresh fails', async () => {
  const { service, state } = harness({ environment: { HUB_META_ACCESS_TOKEN: token } });
  await service.refresh();
  expect(service.getSetting('social.meta_page_id')).toBe('123');
  state.values.find(row => row.key === 'social.meta_page_id').value = '456';
  state.rows[0].ciphertext = sealConnection('meta', { token: 'replacement-token-for-page-456' }, key);
  expect([service.resolvedEnv().HUB_META_ACCESS_TOKEN, service.getSetting('social.meta_page_id')]).toEqual([token, '123']);
  await service.refresh();
  expect([service.resolvedEnv().HUB_META_ACCESS_TOKEN, service.getSetting('social.meta_page_id')]).toEqual(['replacement-token-for-page-456', '456']);
  expect(service.getSetting('social.max_daily_budget_cents')).toBe('older-general-cache');
  state.fail = true; await expect(service.refresh()).rejects.toThrow();
  expect([service.resolvedEnv().HUB_META_ACCESS_TOKEN, service.getSetting('social.meta_page_id')]).toEqual(['', null]);
});

it('keeps legacy configuration working before the deployment gate', async () => {
  const service = socialConnections({ features: new Set(), env: { HUB_META_ACCESS_TOKEN: token }, session: async (_token, work) => work({ query: async () => ({}) }) });
  await service.start();
  expect(service.resolvedEnv().HUB_META_ACCESS_TOKEN).toBe(token);
  expect(await service.list('owner')).toMatchObject({ editable: false, connections: [] });
});

it('authorizes before reading credentials, saving or contacting providers', async () => {
  const { service, state, fetchImpl } = harness({ denied: true });
  await expect(service.list('other')).rejects.toMatchObject({ status: 403 });
  await expect(service.save('other', { action: 'save', provider: 'meta', revision: state.rows[0].revision, fields: fields('meta'), secrets: { token } })).rejects.toMatchObject({ status: 403 });
  await expect(service.check('other', 'meta')).rejects.toMatchObject({ status: 403 });
  expect(state.queries.every(sql => sql.includes('authorize_app_'))).toBe(true);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('rejects unknown fields and malformed credentials before saving', async () => {
  const { service, state } = harness();
  const input = { action: 'save', provider: 'meta', revision: state.rows[0].revision, fields: fields('meta'), secrets: { token } };
  for (const changes of [{ secrets: { unknown: token } }, { secrets: { token: 'short' } }, { secrets: { token: `${token}\nextra` } }, { fields: { ...input.fields, budget: { value: '999', changedAt: version } } }, { provider: '__proto__' }, { revision: null }, { extra: token }]) {
    await expect(service.admin('owner', { ...input, ...changes })).rejects.toMatchObject({ status: 400 });
  }
  expect(state.rows.every(row => row.ciphertext === null)).toBe(true);
});

it('checks with read-only API calls and returns reviewed, credential-free failures', async () => {
  const { service, fetchImpl } = harness({ environment: { HUB_META_ACCESS_TOKEN: token, HUB_LINKEDIN_ACCESS_TOKEN: token } });
  expect(await service.check('owner', 'meta')).toMatchObject({ ok: true });
  expect(await service.check('owner', 'linkedin')).toMatchObject({ ok: true });
  expect(fetchImpl.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  expect(fetchImpl.mock.calls.every(([url]) => ['graph.facebook.com','api.linkedin.com'].includes(new URL(url).hostname))).toBe(true);
  fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 190, message: token } }), { status: 400 }));
  const failure = await service.check('owner', 'meta');
  expect(failure).toMatchObject({ ok: false, message: expect.stringContaining('expired') });
  expect(JSON.stringify(failure)).not.toContain(token);
});

describe('the social connection HTTP boundary', () => {
  const origin = 'https://help.caremetric.ai';
  const cookie = 's'.repeat(43);
  const admin = vi.fn(async () => ({ editable: true, message: null, connections: [] }));
  let server, base;
  beforeAll(async () => {
    server = appServer({ auth: {}, gateway: {}, delegations: {}, socialConnections: { admin }, origins: [origin] });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}/api/admin/social-connections`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  it('requires same-origin JSON, refuses queries and bounds request size', async () => {
    const post = (body, headers = {}, suffix = '') => fetch(base + suffix, { method: 'POST', headers: { Origin: origin, Cookie: `__Host-caremetric_session=${cookie}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const response = await post({ action: 'list' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(admin).toHaveBeenLastCalledWith(cookie, { action: 'list' });
    expect((await post({ action: 'list' }, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await post({ action: 'list' }, {}, '?token=x')).status).toBe(400);
    expect((await post({ token: 'x'.repeat(66000) })).status).toBe(413);
    expect((await fetch(base)).status).toBe(400);
  });
});
