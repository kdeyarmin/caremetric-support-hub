import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer } from './http.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
const chatToken = 'c'.repeat(43);
const service = {
  smsWebhook: vi.fn(async () => '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'),
  emailWebhook: vi.fn(async () => ({ received: true, reference: 1001 })),
  startChat: vi.fn(async () => ({ reference: 1002, token: chatToken })),
  readChat: vi.fn(async chat => ({ reference: 1002, status: 'new', messages: [], chat })),
  postChat: vi.fn(async () => ({ reference: 1002, status: 'new', messages: [] })),
  channels: vi.fn(async () => ({ chat: { enabled: true } })),
  availability: vi.fn(() => ({ chat: false })),
  list: vi.fn(async () => ({ items: [], total: 0 })),
};
let server, base;
beforeAll(async () => {
  server = appServer({ communications: service, origins: [origin], gateway: {}, delegations: {}, auth: {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('communication routes', () => {
  it('accepts provider webhooks only as server-to-server POSTs', async () => {
    const sms = await post('/api/channels/sms/twilio', 'From=%2B12025550142', { 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(sms.status).toBe(200);
    expect(sms.headers.get('content-type')).toBe('text/xml');
    expect(sms.headers.get('cache-control')).toBe('no-store');
    expect((await post('/api/channels/email/inbound', {})).status).toBe(200);
    for (const [path, init] of [
      ['/api/channels/sms/twilio', { method: 'POST', headers: { Origin: origin } }],
      ['/api/channels/sms/twilio', { method: 'POST', headers: { Cookie: '__Host-caremetric_session=x' } }],
      ['/api/channels/sms/twilio?debug=1', { method: 'POST' }],
      ['/api/channels/sms/twilio', { method: 'GET' }],
    ]) expect((await fetch(base + path, init)).status, path).toBe(403);
    expect((await post('/api/channels/voice', {})).status).toBe(404);
    expect(service.smsWebhook).toHaveBeenCalledTimes(1);
  });
  it('starts chats only from the Hub origin and keeps the token in an HttpOnly cookie', async () => {
    expect((await post('/api/chat/start', { name: 'V' }, { Origin: 'https://attacker.test' })).status).toBe(403);
    const started = await post('/api/chat/start', { name: 'V' }, { Origin: origin });
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ reference: 1002 });
    const setCookie = started.headers.get('set-cookie');
    expect(setCookie).toContain(`__Host-caremetric_chat=${chatToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
    const thread = await fetch(base + '/api/chat/thread', { headers: { Cookie: `__Host-caremetric_chat=${chatToken}` } });
    expect((await thread.json()).chat).toBe(chatToken);
    expect(await (await fetch(base + '/api/chat/availability')).json()).toEqual({ chat: false });
    const ended = await post('/api/chat/end', {}, { Origin: origin });
    expect(ended.headers.get('set-cookie')).toContain('__Host-caremetric_chat=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  });
  it('allowlists staff actions and rejects query strings', async () => {
    expect((await post('/api/communications/list', {}, { Origin: origin })).status).toBe(200);
    expect((await post('/api/communications/delete', {}, { Origin: origin })).status).toBe(404);
    expect((await post('/api/communications/list?all=1', {}, { Origin: origin })).status).toBe(400);
    expect((await post('/api/communications/list', {}, { Origin: 'https://attacker.test' })).status).toBe(403);
    expect((await fetch(base + '/api/communications/channels')).status).toBe(200);
  });
});
