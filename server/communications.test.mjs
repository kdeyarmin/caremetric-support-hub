import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { communications, htmlToText, inquiryImportItem, parseMailbox, phoneImportItem, productFromAddresses, replySubject, sendgridMail, sendgridSignatureValid, twilioMessaging, twilioSignature } from './communications.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
const request = (body, headers) => Object.assign(Readable.from([Buffer.from(body)]), { headers });
/** Records each server-role SQL call instead of touching a database. */
function fakePool(result = { id: 'x', reference: 1001, created: true, duplicate: false }) {
  const calls = [];
  const client = { query: vi.fn(async (sql, values) => { if (sql.startsWith('select private.')) calls.push({ sql, values }); return { rows: [{ result }] }; }), release: vi.fn() };
  return { calls, pool: { connect: async () => client } };
}
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
async function signedEmail(fields, timestamp = String(Math.floor(Date.now() / 1000))) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const encoded = new Request('https://hub.test/', { method: 'POST', body: form });
  const payload = Buffer.from(await encoded.arrayBuffer());
  const signature = sign('sha256', Buffer.concat([Buffer.from(timestamp), payload]), privateKey).toString('base64');
  return { payload, headers: { 'content-type': encoded.headers.get('content-type'), 'x-twilio-email-event-webhook-signature': signature, 'x-twilio-email-event-webhook-timestamp': timestamp } };
}

describe('provider signatures', () => {
  it('matches Twilio\'s documented request-validation example exactly', () => {
    const params = new URLSearchParams({ Digits: '1234', To: '+18005551212', From: '+14158675310', Caller: '+14158675310', CallSid: 'CA1234567890ABCDE' });
    expect(twilioSignature('12345', 'https://example.com/myapp.php?foo=1&bar=2', params)).toBe('L/OH5YylLD5NRKLltdqwSvS0BnU=');
  });
  it('verifies SendGrid ECDSA signatures over the timestamp and the exact raw body', () => {
    const payload = Buffer.from('raw multipart body');
    const signature = sign('sha256', Buffer.concat([Buffer.from('1760000000'), payload]), privateKey).toString('base64');
    expect(sendgridSignatureValid(publicKey, signature, '1760000000', payload)).toBe(true);
    expect(sendgridSignatureValid(publicKey, signature, '1760000001', payload)).toBe(false);
    expect(sendgridSignatureValid(publicKey, signature, '1760000000', Buffer.from('raw multipart body!'))).toBe(false);
    expect(sendgridSignatureValid(publicKey, 'not base64 der', '1760000000', payload)).toBe(false);
  });
});

describe('message parsing', () => {
  it('reads mailboxes and routes plus-addressed support mail to an application', () => {
    expect(parseMailbox('"Pat Smith" <Pat@Agency.Test>')).toEqual({ address: 'pat@agency.test', name: 'Pat Smith' });
    expect(parseMailbox('pat@agency.test')).toEqual({ address: 'pat@agency.test', name: null });
    expect(parseMailbox('not an address')).toBeNull();
    expect(productFromAddresses(['support@caremetric.ai', 'support+PennFit@caremetric.ai'])).toBe('pennfit');
    expect(productFromAddresses(['support@caremetric.ai'])).toBeNull();
  });
  it('keeps one Re: and only the current conversation reference in reply subjects', () => {
    expect(replySubject('Login help', 1007)).toBe('Re: Login help [CM-1007]');
    expect(replySubject('RE: re: Login help [CM-1001]', 1007)).toBe('Re: Login help [CM-1007]');
    expect(replySubject('[CM-1001] Login [CM-1002] help', 1007)).toBe('Re: Login help [CM-1007]');
    expect(replySubject('[CM-1001]', 1007)).toBe('Re: Your CareMetric support request [CM-1007]');
  });
  it('reduces HTML mail to readable text without markup or scripts', () => {
    expect(htmlToText('<p>Hello &amp; welcome</p><script>alert(1)</script><div>Line two<br>Line three</div>')).toBe('Hello & welcome\n Line two\nLine three');
  });
  it('maps Breathe phone messages and Advisors requests to import items with the reviewed eleven fields', () => {
    const phone = phoneImportItem({ id: '99000000-0000-4000-8000-000000000001', contactName: 'Caller', companyName: 'Agency', phone: '(202) 555-0111', email: null, message: 'Please call back.', status: 'new', createdAt: '2026-10-01T00:00:00.000Z', product: 'advisors', requestType: 'healthcare_advisors', sms: { status: 'delivered', resources: ['advisors'], errorCode: null } });
    expect(Object.keys(phone)).toHaveLength(11);
    expect(phone).toMatchObject({ status: 'new', productSlug: 'advisors', inquiryType: 'advisors', contactPhone: '+12025550111', subject: 'Advisors call from Caller' });
    expect(phone.body).toContain('Requested text: advisors (delivered)');
    expect(phoneImportItem({ id: 'x', contactName: null, companyName: null, phone: null, email: null, message: 'm', status: 'resolved', createdAt: null, product: 'software', requestType: 'other' }, new Date('2026-10-02T00:00:00Z')))
      .toMatchObject({ status: 'closed', inquiryType: 'unclassified', receivedAt: '2026-10-02T00:00:00.000Z', subject: 'Phone message from an unidentified caller' });
    const inquiry = inquiryImportItem({ id: 'CM-0A1B2C3D4E5F', createdAt: '2026-10-01T00:00:00.000Z', name: 'Requester', email: 'r@agency.test', organization: 'Agency', phone: null, sector: 'Hospice', service: 'Strategic Planning & Operations', message: 'Help.', status: 'in-progress', notes: 'internal' });
    expect(Object.keys(inquiry)).toHaveLength(11);
    expect(inquiry).toMatchObject({ status: 'open', productSlug: 'advisors', inquiryType: 'advisors', contactPhone: null });
    expect(inquiry.body).not.toContain('internal');
  });
});

describe('reply providers', () => {
  it('reports sent only for a provider acceptance and never resends an uncertain outcome', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ sid: 'SM' + 'a'.repeat(32) }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({}, { status: 400 })).mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(new Response('', { status: 503 }));
    const sms = twilioMessaging({ accountSid: 'AC' + '0'.repeat(32), authToken: 'token', messagingServiceSid: 'MG' + '0'.repeat(32), fetchImpl });
    expect(sms.configured).toBe(true);
    expect(await sms.send('+12025550111', 'Hi')).toEqual({ delivery: 'sent', id: 'SM' + 'a'.repeat(32) });
    expect(await sms.send('+12025550111', 'Hi')).toEqual({ delivery: 'failed', id: null });
    expect(await sms.send('+12025550111', 'Hi')).toEqual({ delivery: 'unknown', id: null });
    expect(await sms.send('+12025550111', 'Hi')).toEqual({ delivery: 'unknown', id: null });
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    expect(new URLSearchParams(fetchImpl.mock.calls[0][1].body).get('MessagingServiceSid')).toBe('MG' + '0'.repeat(32));
    expect(twilioMessaging({ accountSid: 'AC123', authToken: 'x', from: '+12025550100' }).configured).toBe(false);
  });
  it('sends plain-text email from the support address', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 202, headers: { 'x-message-id': 'abc.123' } }));
    const mail = sendgridMail({ apiKey: 'SG.fixture', fetchImpl });
    expect(await mail.send('pat@agency.test', 'Re: Help [CM-1001]', 'Body')).toEqual({ delivery: 'sent', id: 'abc.123' });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.from).toEqual({ email: 'support@caremetric.ai', name: 'CareMetric Support' });
    expect(body.content).toEqual([{ type: 'text/plain', value: 'Body' }]);
    expect(sendgridMail({ apiKey: 'not-a-key' }).configured).toBe(false);
  });
});

describe('inbound webhooks', () => {
  it('accepts a correctly signed Twilio text and records it once through the server role', async () => {
    const { pool, calls } = fakePool();
    const service = communications({ pool, delegations: {}, twilioAuthToken: 'twilio-token' });
    const body = new URLSearchParams({ From: '+12025550142', To: '+18775212890', Body: ' My login fails ', MessageSid: 'SM' + 'b'.repeat(32), NumMedia: '1' });
    const signature = twilioSignature('twilio-token', `${origin}/api/channels/sms/twilio`, body);
    const twiml = await service.smsWebhook(request(body.toString(), { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }));
    expect(twiml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(['sms', '+12025550142', 'SM' + 'b'.repeat(32), 'My login fails\n\n[1 picture or file attachment(s) were not stored. Ask the sender to describe them.]', '+12025550142']);
    await expect(service.smsWebhook(request(body.toString(), { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'forged' }))).rejects.toMatchObject({ status: 403 });
    body.set('Body', 'tampered');
    await expect(service.smsWebhook(request(body.toString(), { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }))).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
    await expect(communications({ pool, delegations: {} }).smsWebhook(request('', {}))).rejects.toMatchObject({ status: 503 });
  });
  it('accepts a signed SendGrid email, threads by reference, and never stores attachments', async () => {
    const { pool, calls } = fakePool();
    const service = communications({ pool, delegations: {}, sendgridInboundPublicKey: publicKeyBase64 });
    const { payload, headers } = await signedEmail({ from: 'Pat Smith <pat@agency.test>', to: 'support+breathe@caremetric.ai', subject: 'Re: Login help [CM-1007]',
      text: 'Still failing.', html: '<p>ignored</p>', headers: 'Message-ID: <abc@mail.test>\r\nDate: Mon, 19 Oct 2026', envelope: JSON.stringify({ to: ['support+breathe@caremetric.ai'], from: 'bounce@agency.test' }), attachments: '2' });
    expect(await service.emailWebhook(request(payload, headers))).toEqual({ received: true, reference: 1001 });
    expect(calls[0].values).toEqual(['email', '<abc@mail.test>', '<abc@mail.test>', '1007', 'breathe', 'Re: Login help [CM-1007]',
      'Still failing.\n\n[2 attachment(s) were not stored. Ask the sender to describe them without patient information.]', 'Pat Smith', 'pat@agency.test']);
    const tampered = Buffer.concat([payload, Buffer.from(' ')]);
    await expect(service.emailWebhook(request(tampered, headers))).rejects.toMatchObject({ status: 403 });
    const stale = await signedEmail({ from: 'pat@agency.test', text: 'x' }, String(Math.floor(Date.now() / 1000) - 3600));
    await expect(service.emailWebhook(request(stale.payload, stale.headers))).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
    expect(communications({ pool, delegations: {}, sendgridInboundPublicKey: '!!!' }).emailWebhook).toBeTypeOf('function');
  });
  it('threads email by the last reference in the subject, which is the one the Hub appended', async () => {
    const { pool, calls } = fakePool();
    const service = communications({ pool, delegations: {}, sendgridInboundPublicKey: publicKeyBase64 });
    const { payload, headers } = await signedEmail({ from: 'pat@agency.test', to: 'support@caremetric.ai', subject: 'Re: Fwd [CM-1001] question [CM-1007]', text: 'Thanks.', headers: 'Message-ID: <last@mail.test>' });
    await service.emailWebhook(request(payload, headers));
    expect(calls[0].values[3]).toBe('1007');
  });
});

describe('imports', () => {
  const source = total => Array.from({ length: total }, (_, index) => ({ id: `CM-${String(index).padStart(12, '0')}`, createdAt: '2026-10-01T00:00:00.000Z', name: 'Requester', email: 'r@agency.test', organization: 'Agency', phone: null, sector: 'Hospice', service: 'Strategic Planning & Operations', message: 'Help.', status: 'new', notes: '' }));
  function service(total) {
    const items = source(total), reads = [];
    const delegations = { admin: vi.fn(async (_token, input) => { reads.push(input.offset); return { data: { items: items.slice(input.offset, input.offset + input.limit), total, limit: input.limit, offset: input.offset } }; }) };
    return { reads, service: communications({ pool: fakePool({ created: 50, skipped: 0 }).pool, delegations }) };
  }
  it('reads at most 200 messages per import and returns where to resume', async () => {
    const first = service(260);
    expect(await first.service.sync('session', { source: 'advisors.web' })).toMatchObject({ read: 200, nextOffset: 200 });
    expect(first.reads).toEqual([0, 50, 100, 150]);
    const rest = service(260);
    expect(await rest.service.sync('session', { source: 'advisors.web', offset: 200 })).toMatchObject({ read: 60, nextOffset: null });
    expect(rest.reads).toEqual([200, 250]);
    const exact = service(200);
    expect(await exact.service.sync('session', { source: 'advisors.web' })).toMatchObject({ read: 200, nextOffset: null });
  });
  it('rejects a resume position outside the application contract before reading', async () => {
    const bad = service(10);
    for (const offset of [-1, 1.5, '50', 10001]) await expect(bad.service.sync('session', { source: 'advisors.web', offset })).rejects.toMatchObject({ status: 400 });
    expect(bad.reads).toEqual([]);
  });
});
