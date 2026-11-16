import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { communications, htmlToText, inquiryImportItem, parseMailbox, phoneImportItem, productFromAddresses, replySubject, senderAuthenticated, sendgridMail, sendgridSignatureValid, supportReplyEmail, twilioMessaging, twilioSignature } from './communications.mjs';

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
    expect(htmlToText('<html><head><title>Re: Login [CM-1]</title><style>p{color:red}</style></head><body><!--[if mso]><table><![endif]--><p>Thanks</p><header>Kept</header></body></html>')).toBe('Thanks\n Kept');
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
    expect(body.tracking_settings).toEqual({ click_tracking: { enable: false, enable_text: false } });
    expect(sendgridMail({ apiKey: 'not-a-key' }).configured).toBe(false);
    expect(body).not.toHaveProperty('reply_to');
  });
  it('asks customers to answer at the inbound address when one is set, and ignores one that is not an address', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 202 }));
    await sendgridMail({ apiKey: 'SG.fixture', replyTo: ' support@inbound.caremetric.ai ', fetchImpl }).send('pat@agency.test', 'Re: Help', 'Body');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).reply_to).toEqual({ email: 'support@inbound.caremetric.ai' });
    await sendgridMail({ apiKey: 'SG.fixture', replyTo: 'not an address', fetchImpl }).send('pat@agency.test', 'Re: Help', 'Body');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).not.toHaveProperty('reply_to');
  });
  it('sends the text part first and the HTML part second when both are given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 202 }));
    const mail = sendgridMail({ apiKey: 'SG.fixture', from: 'help@caremetric.test', fetchImpl });
    expect(await mail.send('pat@agency.test', 'Re: Help [CM-1001]', { text: 'Body', html: '<p>Body</p>' })).toEqual({ delivery: 'sent', id: null });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.personalizations).toEqual([{ to: [{ email: 'pat@agency.test' }] }]);
    expect(body.from).toEqual({ email: 'help@caremetric.test', name: 'CareMetric Support' });
    expect(body.subject).toBe('Re: Help [CM-1001]');
    expect(body.tracking_settings).toEqual({ click_tracking: { enable: false, enable_text: false } });
    expect(body.content).toEqual([{ type: 'text/plain', value: 'Body' }, { type: 'text/html', value: '<p>Body</p>' }]);
    expect(body).not.toHaveProperty('reply_to');
  });
  it('emails a staff reply once, with the reference subject, the agent text and an HTML part', async () => {
    const started = { messageId: 'm1', replay: false, delivery: 'pending', deliveryChannel: 'email', to: 'pat@agency.test', reference: 1042, subject: 'Login help [CM-1001]' };
    const { pool, calls } = fakePool(started);
    const send = vi.fn(async () => ({ delivery: 'sent', id: 'sg-1' }));
    const service = communications({ pool, delegations: {}, email: { configured: true, send }, sms: { configured: false } });
    const body = 'Hi Pat,\r\n\r\nWe reset your access. <b>Try again</b>.';
    expect(await service.reply('session', { id: '99000000-0000-4000-8000-000000000001', body, requestKey: '99000000-0000-4000-8000-000000000002' }))
      .toEqual({ delivery: 'sent', deliveryChannel: 'email', replay: false });
    expect(send).toHaveBeenCalledTimes(1);
    const [to, subject, message] = send.mock.calls[0];
    expect(to).toBe('pat@agency.test');
    expect(subject).toBe('Re: Login help [CM-1042]');
    expect(message).toEqual(supportReplyEmail({ subject: 'Login help [CM-1001]', reference: 1042, body: 'Hi Pat,\n\nWe reset your access. <b>Try again</b>.' }));
    expect(message.text.startsWith('Hi Pat,\n\nWe reset your access. <b>Try again</b>.\n\n— CareMetric Support\nReference CM-1042')).toBe(true);
    expect(message.html).toContain('We reset your access. &lt;b&gt;Try again&lt;/b&gt;.');
    expect(calls.at(-1).values).toEqual(['m1', 'sent', 'sg-1']);
    const replayed = communications({ pool: fakePool({ ...started, replay: true, delivery: 'sent' }).pool, delegations: {}, email: { configured: true, send } });
    expect((await replayed.reply('session', { id: '99000000-0000-4000-8000-000000000001', body, requestKey: '99000000-0000-4000-8000-000000000002' })).replay).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('can send an email under a fixed subject chosen by the server, never one the browser supplies', async () => {
    const started = { messageId: 'm3', replay: false, delivery: 'pending', deliveryChannel: 'email', to: 'pat@agency.test', reference: 1044, subject: 'Roster for Pat Example SSN 000-12-3456' };
    const send = vi.fn(async () => ({ delivery: 'sent', id: 'sg-3' }));
    const service = communications({ pool: fakePool(started).pool, delegations: {}, email: { configured: true, send }, sms: { configured: false } });
    const input = { id: '99000000-0000-4000-8000-000000000005', body: 'Hello.', requestKey: '99000000-0000-4000-8000-000000000006' };
    await service.reply('session', input, { subject: 'Your message to CareMetric support' });
    expect(send.mock.calls[0][1]).toBe('Re: Your message to CareMetric support [CM-1044]');
    expect(JSON.stringify(send.mock.calls[0])).not.toMatch(/Pat Example|000-12-3456/);
    // The conversation's own subject is used when no override is given, as before.
    await communications({ pool: fakePool(started).pool, delegations: {}, email: { configured: true, send }, sms: { configured: false } }).reply('session', input);
    expect(send.mock.calls[1][1]).toBe('Re: Roster for Pat Example SSN 000-12-3456 [CM-1044]');
    // A subject in the request itself is refused (the route passes the browser's body as the input and nothing else).
    await expect(service.reply('session', { ...input, subject: 'Anything' })).rejects.toMatchObject({ status: 400 });
    for (const subject of ['', 'Line\nbreak', 'x'.repeat(151), 7]) await expect(service.reply('session', input, { subject })).rejects.toMatchObject({ status: 400 });
  });
  it('lets a subject the server chose win over the phone-line title, which replaces only the stored subject', async () => {
    const started = { messageId: 'm5', replay: false, delivery: 'pending', deliveryChannel: 'email', to: 'jordan@example.com', reference: 1046,
      subject: 'Customer service call from Jordan Rivera', channel: 'phone' };
    const send = vi.fn(async () => ({ delivery: 'sent', id: 'sg-5' }));
    const service = communications({ pool: fakePool(started).pool, delegations: {}, email: { configured: true, send }, sms: { configured: false } });
    const input = { id: '99000000-0000-4000-8000-000000000009', body: 'Hello.', requestKey: '99000000-0000-4000-8000-00000000000a' };
    await service.reply('session', input, { subject: 'Your message to CareMetric support' });
    expect(send.mock.calls[0][1]).toBe('Re: Your message to CareMetric support [CM-1046]');
    expect(send.mock.calls[0][2].subject).toBe(send.mock.calls[0][1]);
    expect(send.mock.calls[0][2].html).not.toContain('Jordan Rivera');
    // Without one, a staff reply to the same conversation still carries the phone title.
    await communications({ pool: fakePool(started).pool, delegations: {}, email: { configured: true, send }, sms: { configured: false } }).reply('session', input);
    expect(send.mock.calls[1][1]).toBe('Re: Your phone message to CareMetric [CM-1046]');
    expect(supportReplyEmail({ subject: 'Anything', reference: 1046, body: 'Hi', channel: 'phone', override: 'Your message to CareMetric support' }).subject).toBe('Re: Your message to CareMetric support [CM-1046]');
    expect(supportReplyEmail({ subject: 'Anything', reference: 1046, body: 'Hi', channel: 'phone' }).subject).toBe('Re: Your phone message to CareMetric [CM-1046]');
  });
  it('says so, with a code, when the provider answered but the delivery could not be recorded', async () => {
    const started = { messageId: 'm4', replay: false, delivery: 'pending', deliveryChannel: 'email', to: 'pat@agency.test', reference: 1045, subject: 'Help' };
    const calls = [];
    const client = { query: vi.fn(async sql => {
      if (sql.startsWith('select private.finish_communication_delivery')) throw new Error('connection to the database was lost');
      calls.push(sql);
      return { rows: [{ result: started }] };
    }), release: vi.fn() };
    const send = vi.fn(async () => ({ delivery: 'sent', id: 'sg-4' }));
    const service = communications({ pool: { connect: async () => client }, delegations: {}, email: { configured: true, send }, sms: { configured: false } });
    const failure = await service.reply('session', { id: '99000000-0000-4000-8000-000000000007', body: 'Hello.', requestKey: '99000000-0000-4000-8000-000000000008' }).catch(error => error);
    expect(send).toHaveBeenCalledTimes(1);
    expect([failure.status, failure.code]).toEqual([502, 'delivery_unsettled']);
    expect(failure.message).not.toMatch(/connection to the database/);
    // Staff see the warning in the inbox: the code alone would reach the browser as a generic failure.
    expect(failure.publicMessage).toBe('The provider answered, but the delivery could not be recorded. Check the conversation before sending again.');
  });
  it('names an emailed reply to a phone-line message for the caller, not with the staff import title', async () => {
    const started = { messageId: 'm2', replay: false, delivery: 'pending', deliveryChannel: 'email', to: 'jordan@example.com', reference: 1043,
      subject: 'Customer service call from Jordan Rivera', channel: 'phone' };
    const send = vi.fn(async () => ({ delivery: 'sent', id: 'sg-2' }));
    const service = communications({ pool: fakePool(started).pool, delegations: {}, email: { configured: true, send }, sms: { configured: false } });
    await service.reply('session', { id: '99000000-0000-4000-8000-000000000003', body: 'Hi Jordan,\n\nThanks for calling.', requestKey: '99000000-0000-4000-8000-000000000004' });
    expect(send.mock.calls[0][1]).toBe('Re: Your phone message to CareMetric [CM-1043]');
    expect(send.mock.calls[0][2].subject).toBe(send.mock.calls[0][1]);
    expect(send.mock.calls[0][2].html).not.toContain('Jordan Rivera');
    // A database from before the channel field keeps the stored subject.
    const older = { ...started };
    delete older.channel;
    await communications({ pool: fakePool(older).pool, delegations: {}, email: { configured: true, send }, sms: { configured: false } })
      .reply('session', { id: '99000000-0000-4000-8000-000000000003', body: 'Hi Jordan,', requestKey: '99000000-0000-4000-8000-000000000005' });
    expect(send.mock.calls[1][1]).toBe('Re: Customer service call from Jordan Rivera [CM-1043]');
  });
  it('keeps the subject of a reply to an email or web-form conversation', () => {
    expect(supportReplyEmail({ subject: 'Login help', reference: 1007, body: 'Hi', channel: 'email' }).subject).toBe('Re: Login help [CM-1007]');
    expect(supportReplyEmail({ subject: 'Consultation request from Riverside Home Health', reference: 1044, body: 'Hi', channel: 'web_form' }).subject)
      .toBe('Re: Consultation request from Riverside Home Health [CM-1044]');
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
      text: 'Still failing.', html: '<p>ignored</p>', headers: 'Message-ID: <abc@mail.test>\r\nDate: Mon, 19 Oct 2026', envelope: JSON.stringify({ to: ['support+breathe@caremetric.ai'], from: 'bounce@agency.test' }), attachments: '2',
      SPF: 'pass', dkim: '{@agency.test : pass}' });
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
  it('receives an email with large attachments, up to what SendGrid posts, and still stores none of them', async () => {
    // SendGrid Inbound Parse posts messages up to 30 MB with their attachments; a 10 MB cap answered 413 and the message never arrived.
    const { pool, calls } = fakePool();
    const service = communications({ pool, delegations: {}, sendgridInboundPublicKey: publicKeyBase64 });
    const scan = new File([Buffer.alloc(12 * 1024 * 1024, 1)], 'scan.pdf', { type: 'application/pdf' });
    const { payload, headers } = await signedEmail({ from: 'pat@agency.test', to: 'support@caremetric.ai', subject: 'Invoice question', text: 'See the scan.', attachments: '1', attachment1: scan });
    expect(payload.length).toBeGreaterThan(10 * 1024 * 1024);
    expect(await service.emailWebhook(request(payload, headers))).toEqual({ received: true, reference: 1001 });
    expect(calls[0].values[6]).toBe('See the scan.\n\n[1 attachment(s) were not stored. Ask the sender to describe them without patient information.]');
  });
  it('refuses a post without a current SendGrid signature before reading its body', async () => {
    const service = communications({ pool: fakePool().pool, delegations: {}, sendgridInboundPublicKey: publicKeyBase64 });
    let read = false;
    const body = () => Object.assign(Readable.from((function* () { read = true; yield Buffer.from('x'); })()), {});
    const type = { 'content-type': 'multipart/form-data; boundary=x' };
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    for (const headers of [type, { ...type, 'x-twilio-email-event-webhook-signature': 'sig' }, { ...type, 'x-twilio-email-event-webhook-signature': 'sig', 'x-twilio-email-event-webhook-timestamp': stale }]) {
      await expect(service.emailWebhook(Object.assign(body(), { headers }))).rejects.toMatchObject({ status: 403 });
    }
    expect(read).toBe(false);
  });
  it('threads an HTML-only customer reply that quotes the Hub reply and stores only readable text', async () => {
    const { pool, calls } = fakePool();
    const service = communications({ pool, delegations: {}, sendgridInboundPublicKey: publicKeyBase64 });
    const sent = supportReplyEmail({ subject: 'Login help', reference: 1042, body: 'Hi Pat,\n\nWe reset your access.' });
    const html = `<html><head><style>p{margin:0}</style></head><body><p>That worked, thanks!</p><blockquote>${sent.html}</blockquote></body></html>`;
    const { payload, headers } = await signedEmail({ from: 'pat@agency.test', to: 'support@caremetric.ai', subject: `RE: ${sent.subject}`, html, headers: 'Message-ID: <html-only@mail.test>', dkim: '{@agency.test : pass}' });
    await service.emailWebhook(request(payload, headers));
    expect(calls[0].values[3]).toBe('1042');
    const stored = calls[0].values[6];
    expect(stored.startsWith('That worked, thanks!')).toBe(true);
    expect(stored).toContain('We reset your access.');
    expect(stored).not.toMatch(/<\/?(p|div|table|td|tr|br|html|head|body|style|title)\b|font-family|&[a-z#0-9]+;/i);
  });
  it('threads email by the last reference in the subject, which is the one the Hub appended', async () => {
    const { pool, calls } = fakePool();
    const service = communications({ pool, delegations: {}, sendgridInboundPublicKey: publicKeyBase64 });
    const { payload, headers } = await signedEmail({ from: 'pat@agency.test', to: 'support@caremetric.ai', subject: 'Re: Fwd [CM-1001] question [CM-1007]', text: 'Thanks.', headers: 'Message-ID: <last@mail.test>', dkim: '{@agency.test : pass}' });
    await service.emailWebhook(request(payload, headers));
    expect(calls[0].values[3]).toBe('1007');
  });
  it('keeps a reply from an unverified sender out of the conversation it names', async () => {
    // Anyone can write From: pat@agency.test. Without SendGrid's SPF or DKIM confirming that domain, the email starts its own conversation.
    for (const auth of [{}, { SPF: 'fail', dkim: '{@attacker.test : pass}' }, { SPF: 'pass', envelope: JSON.stringify({ from: 'bounce@attacker.test' }) }, { dkim: '{@agency.test : fail}' }]) {
      const { pool, calls } = fakePool();
      const service = communications({ pool, delegations: {}, sendgridInboundPublicKey: publicKeyBase64 });
      const { payload, headers } = await signedEmail({ from: 'Pat Smith <pat@agency.test>', to: 'support@caremetric.ai', subject: 'Re: Login help [CM-1007]', text: 'Send the invoice to my new address.',
        headers: 'Message-ID: <forged@mail.test>', ...auth });
      await service.emailWebhook(request(payload, headers));
      expect(calls[0].values[3], JSON.stringify(auth)).toBeNull();
      expect(calls[0].values[6]).toBe("[This email names conversation CM-1007, but its sender's address could not be verified, so it was kept separate. Check who sent it before replying.]\n\nSend the invoice to my new address.");
    }
  });
  it('recognizes an authenticated sender only for the From domain', () => {
    expect(senderAuthenticated({ spf: 'pass', envelopeFrom: 'bounce@agency.test', from: 'pat@agency.test' })).toBe(true);
    expect(senderAuthenticated({ spf: 'pass', envelopeFrom: 'bounce@mail.agency.test', from: 'pat@agency.test' })).toBe(true);
    expect(senderAuthenticated({ dkim: '{@sendgrid.net : pass, @agency.test : pass}', from: 'pat@agency.test' })).toBe(true);
    expect(senderAuthenticated({ spf: 'softfail', envelopeFrom: 'bounce@agency.test', from: 'pat@agency.test' })).toBe(false);
    expect(senderAuthenticated({ spf: 'pass', envelopeFrom: 'bounce@notagency.test', from: 'pat@agency.test' })).toBe(false);
    expect(senderAuthenticated({ dkim: '{@sendgrid.net : pass}', from: 'pat@agency.test' })).toBe(false);
    expect(senderAuthenticated({ dkim: '{@agency.test : fail}', from: 'pat@agency.test' })).toBe(false);
    expect(senderAuthenticated({ spf: 'pass', envelopeFrom: '', from: 'pat@agency.test' })).toBe(false);
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
    expect(await first.service.sync('session', { source: 'breathe.phone' })).toMatchObject({ read: 200, nextOffset: 200 });
    expect(first.reads).toEqual([0, 50, 100, 150]);
    const rest = service(260);
    expect(await rest.service.sync('session', { source: 'breathe.phone', offset: 200 })).toMatchObject({ read: 60, nextOffset: null });
    expect(rest.reads).toEqual([200, 250]);
    const exact = service(200);
    expect(await exact.service.sync('session', { source: 'breathe.phone' })).toMatchObject({ read: 200, nextOffset: null });
  });
  it('rejects a resume position outside the application contract before reading', async () => {
    const bad = service(10);
    for (const offset of [-1, 1.5, '50', 10001]) await expect(bad.service.sync('session', { source: 'breathe.phone', offset })).rejects.toMatchObject({ status: 400 });
    expect(bad.reads).toEqual([]);
  });
});
