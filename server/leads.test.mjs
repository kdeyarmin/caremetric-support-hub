import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { appServer } from './http.mjs';
import { leadAdmin, leadBodyLimit, leadIntake, leadSecrets, leadSignature } from './leads.mjs';

const secret = 'carebase-lead-secret-'.repeat(2);
const otherSecret = 'intel-lead-secret-for-tests-0123456789';
const id = '11111111-1111-4111-8111-111111111111';
const nowMs = Date.parse('2026-11-03T12:00:00.000Z');
const seconds = Math.floor(nowMs / 1000);
const canary = 'LEAD-UNIT-CANARY';
const lead = {
  version: 1, source: 'carebase', kind: 'demo_request', externalId: 'cb-1', occurredAt: '2026-11-03T11:59:59.000Z',
  contact: { name: 'Jordan Rivera', email: 'jordan@sunrise.example' }, message: `${canary} please call`,
};

function request({ body = JSON.stringify(lead), source = 'carebase', timestamp = String(seconds), key = secret, signature, headers = {}, method = 'POST', url = '/api/leads' } = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const all = {
    'content-type': 'application/json', 'content-length': String(raw.length),
    ...(source === null ? {} : { 'x-caremetric-source': source }),
    ...(timestamp === null ? {} : { 'x-caremetric-timestamp': timestamp }),
    'x-caremetric-signature': signature ?? leadSignature(key, timestamp, raw),
    ...headers,
  };
  for (const [name, value] of Object.entries(all)) if (value === undefined) delete all[name];
  return Object.assign(Readable.from([raw]), { headers: all, method, url });
}
function harness(options = {}) {
  const logs = [];
  const store = { record: vi.fn(async () => ({ id, duplicate: false, conversation: 'CM-1042' })) };
  const intake = leadIntake({ store, secrets: { carebase: secret, intel: otherSecret }, enabled: true, now: () => nowMs, log: line => logs.push(line), ...options });
  return { intake, store, logs };
}

describe('lead intake secrets and signatures', () => {
  it('counts a secret shorter than 32 characters as not configured', () => {
    expect(leadSecrets({ HUB_LEAD_SECRET_CAREBASE: 'x'.repeat(31), HUB_LEAD_SECRET_INTEL: 'y'.repeat(32) })).toEqual({ carebase: null, intel: 'y'.repeat(32), advisors: null });
  });
  it('signs the timestamp, a dot and the exact raw bytes with HMAC-SHA256', () => {
    const body = Buffer.from('{"a":"é"}');
    expect(leadSignature(secret, '1762171200', body)).toBe('v1=' + createHmac('sha256', secret).update(Buffer.concat([Buffer.from('1762171200.'), body])).digest('hex'));
    expect(leadSignature(secret, '1762171200', body)).toMatch(/^v1=[0-9a-f]{64}$/);
  });
});

describe('POST /api/leads handler', () => {
  it('stores a website phone as a number the Hub can text', async () => {
    const { intake, store } = harness();
    const phoned = { ...lead, externalId: 'cb-phone', contact: { ...lead.contact, phone: '(202) 555-0144' } };
    expect((await intake.handle(request({ body: JSON.stringify(phoned) }))).status).toBe(202);
    expect(store.record).toHaveBeenCalledWith('carebase', { ...phoned, contact: { ...phoned.contact, phone: '+12025550144' } });
    store.record.mockClear();
    const odd = { ...lead, externalId: 'cb-odd', contact: { ...lead.contact, phone: 'extension 4' } };
    expect((await intake.handle(request({ body: JSON.stringify(odd) }))).status).toBe(202);
    expect(store.record).toHaveBeenCalledWith('carebase', odd);
  });

  it('records a signed lead and answers 202 with exactly the contract body', async () => {
    const { intake, store, logs } = harness();
    expect(await intake.handle(request())).toEqual({ status: 202, body: { id, duplicate: false, conversation: 'CM-1042' }, headers: {} });
    expect(store.record).toHaveBeenCalledWith('carebase', lead);
    expect(logs).toEqual(['Lead intake: source=carebase outcome=accepted status=202']);
  });

  it('answers a repeat 200 as a duplicate', async () => {
    const { intake, store } = harness();
    store.record.mockResolvedValueOnce({ id, duplicate: true, conversation: null });
    expect(await intake.handle(request())).toMatchObject({ status: 200, body: { id, duplicate: true, conversation: null } });
  });

  it('answers 401 unauthorized, with no detail, for every authentication failure', async () => {
    const { intake, store } = harness();
    const body = Buffer.from(JSON.stringify(lead));
    const cases = {
      'no source': request({ source: null }),
      'an unknown source': request({ source: 'breathe' }),
      'a source the secret does not belong to': request({ source: 'intel' }),
      'no timestamp': request({ timestamp: null, signature: leadSignature(secret, '', body) }),
      'a timestamp that is not whole seconds': request({ timestamp: `${seconds}.5` }),
      'a timestamp 301 seconds old': request({ timestamp: String(seconds - 301) }),
      'a timestamp 301 seconds ahead': request({ timestamp: String(seconds + 301) }),
      'no signature': request({ headers: { 'x-caremetric-signature': undefined } }),
      'the wrong secret': request({ key: otherSecret }),
      'a signature in uppercase hex': request({ signature: leadSignature(secret, String(seconds), body).toUpperCase().replace('V1=', 'v1=') }),
      'a signature without its version': request({ signature: leadSignature(secret, String(seconds), body).slice(3) }),
      'a signature over another body': request({ signature: leadSignature(secret, String(seconds), Buffer.from('{}')) }),
      'a signature over another timestamp': request({ signature: leadSignature(secret, String(seconds - 1), body) }),
      'a browser origin': request({ headers: { origin: 'https://cmcarebase.com' } }),
      'a cookie': request({ headers: { cookie: '__Host-caremetric_session=x' } }),
      'a query string': request({ url: '/api/leads?debug=1' }),
    };
    for (const [name, req] of Object.entries(cases)) expect(await intake.handle(req), name).toEqual({ status: 401, body: { error: 'unauthorized' }, headers: {} });
    expect(store.record).not.toHaveBeenCalled();
  });

  it('accepts a timestamp exactly 300 seconds from its clock', async () => {
    const { intake } = harness();
    expect((await intake.handle(request({ timestamp: String(seconds - 300) }))).status).toBe(202);
    expect((await intake.handle(request({ timestamp: String(seconds + 300) }))).status).toBe(202);
  });

  it('answers 503 not_configured for a product without a usable secret, before reading anything', async () => {
    const { intake } = harness({ secrets: { carebase: 'short' } });
    expect(await intake.handle(request())).toEqual({ status: 503, body: { error: 'not_configured' }, headers: {} });
    expect((await intake.handle(request({ source: 'advisors' }))).body).toEqual({ error: 'not_configured' });
  });

  it('answers 413 too_large for a body over 16,384 bytes, declared or streamed', async () => {
    const { intake, store } = harness();
    const big = JSON.stringify({ ...lead, message: 'x'.repeat(leadBodyLimit) });
    expect(await intake.handle(request({ body: big }))).toEqual({ status: 413, body: { error: 'too_large' }, headers: {} });
    expect(await intake.handle(request({ body: big, headers: { 'content-length': undefined } }))).toMatchObject({ status: 413 });
    const exact = Buffer.alloc(leadBodyLimit, 0x20);
    expect((await intake.handle(request({ body: exact }))).status, 'exactly the limit is read (and is not a lead)').toBe(400);
    expect(store.record).not.toHaveBeenCalled();
  });

  it('answers 400 invalid_lead for a signed body that is not one JSON object', async () => {
    const { intake, store } = harness();
    const bodies = {
      'plain text': ['not json', {}], 'an array': ['[1,2]', {}], 'null': ['null', {}], 'a number': ['42', {}],
      'a NUL character': [JSON.stringify({ ...lead, message: 'a\u0000b' }), {}],
      'a lone surrogate': ['{"version":1,"message":"\\ud800"}', {}],
      'deep nesting': [`{"a":${'['.repeat(40)}${']'.repeat(40)}}`, {}],
      'another content type': [JSON.stringify(lead), { 'content-type': 'text/plain' }],
    };
    for (const [name, [body, headers]] of Object.entries(bodies)) expect(await intake.handle(request({ body, headers })), name).toEqual({ status: 400, body: { error: 'invalid_lead' }, headers: {} });
    expect(await intake.handle(request({ body: Buffer.from([0x7b, 0xff, 0x7d]) })), 'invalid UTF-8').toMatchObject({ status: 400 });
    expect((await intake.handle(request({ headers: { 'content-type': 'application/json; charset=utf-8' } }))).status).toBe(202);
    expect(store.record).toHaveBeenCalledTimes(1);
  });

  it('passes the database\'s refusal on as 400, and anything else as 503 unavailable', async () => {
    const { intake, store, logs } = harness();
    store.record.mockRejectedValueOnce(Object.assign(new Error('Invalid lead.'), { code: '22023' }));
    expect(await intake.handle(request())).toEqual({ status: 400, body: { error: 'invalid_lead' }, headers: {} });
    store.record.mockRejectedValueOnce(Object.assign(new Error(`new row violates check constraint, Failing row contains (${canary})`), { code: '23514' }));
    expect(await intake.handle(request())).toEqual({ status: 503, body: { error: 'unavailable' }, headers: {} });
    store.record.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    expect((await intake.handle(request())).body).toEqual({ error: 'unavailable' });
    for (const odd of [null, { id: 'not-a-uuid', duplicate: false, conversation: null }, { id, duplicate: 'no', conversation: null }, { id, duplicate: false, conversation: 'CM-x' }]) {
      store.record.mockResolvedValueOnce(odd);
      expect((await intake.handle(request())).status).toBe(503);
    }
    expect(logs.join('\n')).not.toContain(canary);
  });

  it('answers 503 unavailable when the database does not declare support.leads.v1, after authenticating', async () => {
    const { intake, store } = harness({ enabled: false });
    expect(await intake.handle(request())).toEqual({ status: 503, body: { error: 'unavailable' }, headers: {} });
    expect((await intake.handle(request({ key: otherSecret }))).status).toBe(401);
    expect(store.record).not.toHaveBeenCalled();
  });

  it('limits each product to its own budget of signed requests per minute', async () => {
    let clock = nowMs;
    const { intake } = harness({ limit: 2, now: () => clock });
    expect((await intake.handle(request())).status).toBe(202);
    expect((await intake.handle(request())).status).toBe(202);
    expect(await intake.handle(request())).toEqual({ status: 429, body: { error: 'rate_limited' }, headers: {} });
    expect((await intake.handle(request({ key: otherSecret }))).status, 'unsigned requests never use up the budget').toBe(401);
    expect((await intake.handle(request({ source: 'intel', key: otherSecret, body: JSON.stringify({ ...lead, source: 'intel' }) }))).status, 'another product has its own').toBe(202);
    clock += 60_000;
    expect((await intake.handle(request({ timestamp: String(seconds + 60) }))).status).toBe(202);
  });

  it('answers 405 to anything but POST', async () => {
    const { intake } = harness();
    expect(await intake.handle(request({ method: 'GET' }))).toEqual({ status: 405, body: { error: 'method_not_allowed' }, headers: { Allow: 'POST' } });
  });

  it('logs only the product, the outcome and the status, never the body, contact or secret', async () => {
    const { intake, logs } = harness();
    await intake.handle(request());
    await intake.handle(request({ key: otherSecret }));
    await intake.handle(request({ source: `carebase ${canary}` }));
    expect(logs).toEqual([
      'Lead intake: source=carebase outcome=accepted status=202',
      'Lead intake: source=carebase outcome=unauthorized status=401',
      'Lead intake: source=unknown outcome=unauthorized status=401',
    ]);
    for (const line of logs) for (const secretText of [canary, 'jordan', secret, otherSecret]) expect(line).not.toContain(secretText);
  });

  it('never throws, even when the request stream fails', async () => {
    const { intake } = harness();
    const broken = Object.assign(new Readable({ read() { this.destroy(new Error('socket hang up')); } }), { method: 'POST', url: '/api/leads', headers: { 'x-caremetric-source': 'carebase' } });
    expect(await intake.handle(broken)).toEqual({ status: 503, body: { error: 'unavailable' }, headers: {} });
  });

  it('reports which products are configured without their values', () => {
    const { intake } = harness();
    expect(intake.configured()).toEqual(['carebase', 'intel']);
    expect(intake.enabled()).toBe(true);
  });
});

describe('the owner\'s lead status change', () => {
  const version = '2026-11-03T12:00:01.123456+00:00';
  function admin(result = async () => ({ id, status: 'contacted' })) {
    const calls = [];
    const session = vi.fn(async (token, work) => work({ query: async (sql, values) => { calls.push({ token, sql, values }); return { rows: [{ result: await result() }] }; } }));
    return { desk: leadAdmin({ session }), calls };
  }
  it('runs hub.update_lead_status in the owner\'s session with the version the lead was read at', async () => {
    const { desk, calls } = admin();
    expect(await desk.status('owner-token', { id, status: 'contacted', expectedUpdatedAt: version })).toEqual({ id, status: 'contacted' });
    expect(calls).toEqual([{ token: 'owner-token', sql: 'select hub.update_lead_status($1, $2, $3) as result', values: [id, 'contacted', version] }]);
  });
  it('refuses a malformed change before the database', async () => {
    const { desk, calls } = admin();
    for (const input of [{}, { id, status: 'won' }, { id, status: 'won', expectedUpdatedAt: version, note: 'x' }, { id: 'x', status: 'won', expectedUpdatedAt: version },
      { id, status: 'archived', expectedUpdatedAt: version }, { id, status: 'won', expectedUpdatedAt: 'yesterday' }, null]) {
      await expect(desk.status('owner-token', input)).rejects.toMatchObject({ status: 400 });
    }
    expect(calls).toEqual([]);
    await expect(leadAdmin({ enabled: false, session: vi.fn() }).status('owner-token', { id, status: 'won', expectedUpdatedAt: version })).rejects.toMatchObject({ status: 503 });
  });
  it('passes on the database\'s reviewed refusals with their own status', async () => {
    for (const [code, status] of [['40001', 409], ['28000', 401], ['42501', 403], ['P0002', 404], ['22023', 400]]) {
      const { desk } = admin(async () => { throw Object.assign(new Error(`reviewed ${code}`), { code }); });
      await expect(desk.status('owner-token', { id, status: 'won', expectedUpdatedAt: version })).rejects.toMatchObject({ status, message: `reviewed ${code}` });
    }
    const { desk } = admin(async () => { throw Object.assign(new Error('internal detail'), { code: 'XX000' }); });
    await expect(desk.status('owner-token', { id, status: 'won', expectedUpdatedAt: version })).rejects.not.toHaveProperty('status');
  });
});

describe('lead routes', () => {
  const origin = 'https://support-hub-web-production.up.railway.app';
  const leads = { handle: vi.fn(async () => ({ status: 202, body: { id, duplicate: false, conversation: null }, headers: {} })) };
  const desk = { status: vi.fn(async () => ({ id, status: 'won' })) };
  let server, base;
  beforeAll(async () => {
    server = appServer({ leads, leadAdmin: desk, origins: [origin], gateway: {}, delegations: {}, auth: {} });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));

  it('hands POST /api/leads to the intake handler, server to server, and returns its answer as JSON', async () => {
    const response = await fetch(base + '/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id, duplicate: false, conversation: null });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    leads.handle.mockResolvedValueOnce({ status: 405, body: { error: 'method_not_allowed' }, headers: { Allow: 'POST' } });
    const wrong = await fetch(base + '/api/leads', { method: 'PUT', body: '{}' });
    expect([wrong.status, wrong.headers.get('allow')]).toEqual([405, 'POST']);
    expect((await fetch(base + '/api/leads/')).status).toBe(404);
  });

  it('answers not_configured when the server has no intake handler', async () => {
    const bare = appServer({ origins: [origin], gateway: {}, delegations: {}, auth: {} });
    bare.listen(0, '127.0.0.1'); await once(bare, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${bare.address().port}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect([response.status, await response.json()]).toEqual([503, { error: 'not_configured' }]);
      const owner = await fetch(`http://127.0.0.1:${bare.address().port}/api/admin/leads/status`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
      expect(owner.status).toBe(503);
    } finally { await new Promise(resolve => bare.close(resolve)); }
  });

  it('serves the owner\'s status change only from the Hub origin, with the session cookie, and nothing else', async () => {
    const post = (path, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify({ id, status: 'won', expectedUpdatedAt: '2026-11-03T12:00:00+00:00' }) });
    const token = 'a'.repeat(43);
    const response = await post('/api/admin/leads/status', { Cookie: `__Host-caremetric_session=${token}` });
    expect(response.status).toBe(200);
    expect(desk.status).toHaveBeenCalledWith(token, { id, status: 'won', expectedUpdatedAt: '2026-11-03T12:00:00+00:00' });
    expect((await post('/api/admin/leads/status', { Origin: 'https://attacker.test' })).status).toBe(403);
    expect((await post('/api/admin/leads/status?all=1')).status).toBe(400);
    expect((await post('/api/admin/leads/delete')).status).toBe(404);
    expect((await fetch(base + '/api/admin/leads/status')).status).toBe(404);
    expect(desk.status).toHaveBeenCalledTimes(1);
  });
});
