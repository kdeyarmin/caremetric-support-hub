import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer } from './http.mjs';
import { composeBulkEmail, sendgridBulkMail } from './bulk-email.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
const token = 'a'.repeat(64);
const service = {
  list: vi.fn(async () => ({ campaigns: [] })),
  send: vi.fn(async (session, input) => ({ id: input.id, status: 'sending' })),
  tick: vi.fn(), unsubscribePage: vi.fn(async (value, confirm) => `<p>${confirm ? 'done' : 'confirm'} ${value.length}</p>`),
};
let server, base;
beforeAll(async () => {
  server = appServer({ bulkEmail: service, origins: [origin], gateway: {}, delegations: {}, auth: {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });

describe('bulk email routes', () => {
  it('serves allowlisted administrator actions to same-origin POSTs only', async () => {
    const sent = await post('/api/admin/bulk-email/send', { id: 'x', version: 2, recipients: 3 });
    expect(sent.status).toBe(200);
    // The session cookie (absent here) is passed through; the database decides who may send.
    expect(service.send).toHaveBeenCalledWith(null, { id: 'x', version: 2, recipients: 3 });
    expect((await post('/api/admin/bulk-email/send', {}, { Origin: 'https://evil.example' })).status).toBe(403);
    for (const action of ['tick', 'unsubscribePage', 'constructor', 'delete']) expect((await post('/api/admin/bulk-email/' + action, {})).status, action).toBe(404);
    expect((await post('/api/admin/bulk-email/list?x=1', {})).status).toBe(400);
    expect((await fetch(base + '/api/admin/bulk-email/list')).status).toBe(404);
  });
  it('lets an unsubscribe link work from any mail client with only its token', async () => {
    const view = await fetch(`${base}/api/email/unsubscribe/${token}`);
    expect(view.status).toBe(200);
    expect(view.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(view.headers.get('cache-control')).toBe('no-store');
    expect(await view.text()).toBe('<p>confirm 64</p>');
    // RFC 8058 one-click: a cross-site form POST with no session.
    const oneClick = await fetch(`${base}/api/email/unsubscribe/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://mail.example' }, body: 'List-Unsubscribe=One-Click' });
    expect(await oneClick.text()).toBe('<p>done 64</p>');
    expect(service.unsubscribePage).toHaveBeenLastCalledWith(token, true);
    expect((await fetch(`${base}/api/email/unsubscribe/${token}`, { method: 'POST', body: 'x'.repeat(5000) })).status).toBe(413);
    expect((await fetch(`${base}/api/email/unsubscribe/${token}`, { method: 'DELETE' })).status).toBe(405);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) expect((await fetch(`${base}/api/email/unsubscribe/${bad}`)).status).toBe(404);
  });
});

describe('bulk email messages', () => {
  it('ends every message with why it was sent, the unsubscribe link and the mailing address', () => {
    const text = composeBulkEmail({ body: 'Hello\r\nAll users  \n\n', applications: 'CareMetric CareBase, CareMetric Go', unsubscribeUrl: 'https://hub.example/api/email/unsubscribe/' + token, postalAddress: '1 Main St, Altoona, PA' });
    expect(text).toBe(`Hello\nAll users\n\n--\nYou are receiving this email because you have a CareMetric CareBase, CareMetric Go account with CareMetric.\nUnsubscribe from CareMetric announcements: https://hub.example/api/email/unsubscribe/${token}\n1 Main St, Altoona, PA\n`);
    expect(composeBulkEmail({ body: 'Hi', applications: 'PennSync', unsubscribeUrl: null, postalAddress: '' })).toContain('Unsubscribe link: included in each real message.');
  });
  it('sends one recipient per request with one-click unsubscribe headers and no tracking', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202, headers: { 'x-message-id': 'abc.123' } }));
    const mail = sendgridBulkMail({ apiKey: 'SG.key', from: 'news@caremetric.ai', replyTo: 'support@caremetric.ai', fetchImpl });
    expect(mail.configured).toBe(true);
    expect(await mail.send({ to: 'a@agency.test', subject: 'Update', text: 'Body', unsubscribeUrl: 'https://hub.example/u' })).toEqual({ delivery: 'sent', id: 'abc.123' });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.personalizations).toEqual([{ to: [{ email: 'a@agency.test' }], headers: { 'List-Unsubscribe': '<https://hub.example/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }]);
    expect(body.from).toEqual({ email: 'news@caremetric.ai', name: 'CareMetric' });
    expect(body.reply_to).toEqual({ email: 'support@caremetric.ai' });
    expect(body.tracking_settings).toEqual({ click_tracking: { enable: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false } });
    expect(body.content).toEqual([{ type: 'text/plain', value: 'Body' }]);
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 400 }));
    expect((await mail.send({ to: 'b@agency.test', subject: 'S', text: 'T', unsubscribeUrl: null })).delivery).toBe('failed');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).personalizations[0].headers).toBeUndefined();
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await mail.send({ to: 'c@agency.test', subject: 'S', text: 'T', unsubscribeUrl: null })).delivery).toBe('unknown');
    fetchImpl.mockRejectedValueOnce(new Error('network'));
    expect((await mail.send({ to: 'd@agency.test', subject: 'S', text: 'T', unsubscribeUrl: null })).delivery).toBe('unknown');
    expect(sendgridBulkMail({ apiKey: 'not-a-key' }).configured).toBe(false);
    expect(sendgridBulkMail({ apiKey: 'SG.key', from: 'not an address' }).configured).toBe(false);
  });
});
