import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { chosenMail, mimeMessage, sesBulkMail, sesGrowthEvents, sesMail, signV4, snsReceiver, snsStringToSign } from './ses.mjs';
import { growthService } from './growth/service.mjs';

const at = new Date('2026-11-12T17:00:00Z');
const access = { accessKeyId: 'AKIAEXAMPLEEXAMPLE12', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: () => at };
const ok = (body = { MessageId: '0100019a-example-message-id-000000' }) => ({ status: 200, json: async () => body });
const sentRequest = fetchImpl => { const [url, request] = fetchImpl.mock.calls.at(-1); const body = JSON.parse(request.body); return { url, request, body, raw: Buffer.from(body.Content.Raw.Data, 'base64').toString('utf8') }; };
const partText = (raw, type) => {
  const match = new RegExp(`Content-Type: ${type}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`).exec(raw);
  return match ? Buffer.from(match[1].replace(/\r\n/g, ''), 'base64').toString('utf8') : null;
};

describe('Signature Version 4', () => {
  it('matches AWS\'s published get-vanilla test vector', () => {
    const headers = signV4({ method: 'GET', url: 'https://example.amazonaws.com/', region: 'us-east-1', service: 'service',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2015-08-30T12:36:00Z') });
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, '
      + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  it('signs a session token when there is one', () => {
    const headers = signV4({ method: 'POST', url: 'https://email.us-east-2.amazonaws.com/v2/email/outbound-emails', region: 'us-east-2', service: 'ses',
      ...access, sessionToken: 'token-123', headers: { 'Content-Type': 'application/json' }, body: '{}', now: at });
    expect(headers['x-amz-security-token']).toBe('token-123');
    expect(headers.authorization).toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-security-token');
  });
});

describe('the MIME message', () => {
  it('writes text and HTML parts, encodes non-ASCII text and never lets a value add a header', () => {
    const raw = mimeMessage({ from: 'support@caremetric.ai', fromName: 'CareMetric Support', to: 'pat@example.org', replyTo: 'support@caremetric.ai',
      subject: 'Your café question\r\nBcc: attacker@example.org', text: 'Hello — thanks', html: '<p>Hello — thanks</p>', date: at, boundary: 'b1' });
    expect(raw).toContain('From: "CareMetric Support" <support@caremetric.ai>\r\nTo: <pat@example.org>\r\nReply-To: <support@caremetric.ai>\r\n');
    expect(raw).not.toMatch(/^Bcc:/m);
    const subject = /^Subject: =\?UTF-8\?B\?([^?]+)\?=$/m.exec(raw);
    expect(Buffer.from(subject[1], 'base64').toString('utf8')).toBe('Your café question Bcc: attacker@example.org');
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="b1"');
    expect(partText(raw, 'text/plain')).toBe('Hello — thanks');
    expect(partText(raw, 'text/html')).toBe('<p>Hello — thanks</p>');
    expect(raw.endsWith('--b1--\r\n')).toBe(true);
  });

  it('sends a plain text message as one part', () => {
    const raw = mimeMessage({ from: 'a@caremetric.ai', to: 'b@example.org', subject: 'Hi', text: 'Only text', date: at });
    expect(raw).not.toContain('multipart');
    expect(partText(raw, 'text/plain')).toBe('Only text');
  });
});

describe('sending through SES', () => {
  it('sends a support reply as a signed raw message and reports the message id', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const mail = sesMail({ ...access, region: () => 'us-east-2', configurationSet: () => 'caremetric-hub', from: () => 'support@caremetric.ai', replyTo: () => 'support@caremetric.ai', fetchImpl });
    expect(mail.configured).toBe(true);
    await expect(mail.send('pat@example.org', 'Re: your question [CM-1234]', { text: 'Answer', html: '<p>Answer</p>' })).resolves.toEqual({ delivery: 'sent', id: '0100019a-example-message-id-000000' });
    const { url, request, body, raw } = sentRequest(fetchImpl);
    expect(url).toBe('https://email.us-east-2.amazonaws.com/v2/email/outbound-emails');
    expect(request.redirect).toBe('error');
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEEXAMPLE12\/20261112\/us-east-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(request.headers.host).toBeUndefined();
    expect(body.Destination).toEqual({ ToAddresses: ['pat@example.org'] });
    expect(body.ConfigurationSetName).toBe('caremetric-hub');
    expect(body.EmailTags).toEqual([{ Name: 'category', Value: 'hub-support' }]);
    expect(raw).toContain('Reply-To: <support@caremetric.ai>');
    expect(partText(raw, 'text/html')).toBe('<p>Answer</p>');
  });

  it('says failed when SES refuses the message and unknown when the outcome cannot be known', async () => {
    const send = async response => sesMail({ ...access, fetchImpl: vi.fn(response) }).send('pat@example.org', 'Hi', 'Text');
    await expect(send(async () => ({ status: 400, json: async () => ({}) }))).resolves.toEqual({ delivery: 'failed', id: null });
    await expect(send(async () => ({ status: 503, json: async () => ({}) }))).resolves.toEqual({ delivery: 'unknown', id: null });
    await expect(send(async () => { throw new Error('timeout'); })).resolves.toEqual({ delivery: 'unknown', id: null });
    await expect(send(async () => ok({ MessageId: 'bad id with spaces' }))).resolves.toEqual({ delivery: 'sent', id: null });
  });

  it('is not configured without a usable key or sender', () => {
    expect(sesMail({ ...access, accessKeyId: '' }).configured).toBe(false);
    expect(sesMail({ ...access, secretAccessKey: 'short' }).configured).toBe(false);
    expect(sesMail({ ...access, from: () => 'not an address' }).configured).toBe(false);
  });

  it('sends bulk and growth email with one-click unsubscribe headers and the growth message id as a tag', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const mail = sesBulkMail({ ...access, from: () => 'hello@go.caremetric.ai', fromName: () => 'Kevin at CareMetric', replyTo: () => 'support@caremetric.ai', fetchImpl });
    expect(mail.configured).toBe(true);
    await mail.send({ to: 'office@agency.example', subject: 'Referral sources', text: 'Text', html: '<p>Text</p>',
      unsubscribeUrl: 'https://help.caremetric.ai/api/growth/preferences/abc', messageId: '11111111-1111-4111-8111-111111111111' });
    const { body, raw } = sentRequest(fetchImpl);
    expect(raw).toContain('From: "Kevin at CareMetric" <hello@go.caremetric.ai>');
    expect(raw).toContain('List-Unsubscribe: <https://help.caremetric.ai/api/growth/preferences/abc>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(body.EmailTags).toEqual([{ Name: 'category', Value: 'hub-bulk-email' }, { Name: 'growth_message_id', Value: '11111111-1111-4111-8111-111111111111' }]);
    expect(body.ConfigurationSetName).toBeUndefined();
  });
});

describe('choosing the email service', () => {
  const provider = configured => ({ configured, send: vi.fn(async () => ({ delivery: 'sent', id: null })) });

  it('sends through the service the owner chose and follows a change at once', async () => {
    let choice = 'sendgrid';
    const sendgrid = provider(true), ses = provider(true);
    const mail = chosenMail(() => choice, { sendgrid, ses });
    await mail.send('a@example.org', 'Hi', 'Text');
    choice = 'ses';
    await mail.send('b@example.org', 'Hi', 'Text');
    expect(sendgrid.send).toHaveBeenCalledWith('a@example.org', 'Hi', 'Text');
    expect(ses.send).toHaveBeenCalledWith('b@example.org', 'Hi', 'Text');
    expect(mail.provider).toBe('ses');
  });

  it('keeps sending through the other service while the chosen one is not set up', async () => {
    const sendgrid = provider(true), ses = provider(false);
    const mail = chosenMail(() => 'ses', { sendgrid, ses });
    expect(mail.configured).toBe(true);
    expect(mail.provider).toBe('sendgrid');
    expect(chosenMail(() => 'ses', { sendgrid: provider(false), ses: provider(false) }).configured).toBe(false);
  });
});

describe('Amazon SNS notifications', () => {
  const topic = 'arn:aws:sns:us-east-2:575467220558:caremetric-hub-email-events';
  const certUrl = 'https://sns.us-east-2.amazonaws.com/SimpleNotificationService-abc.pem';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const signed = (fields, version = '2') => {
    const message = { SignatureVersion: version, SigningCertURL: certUrl, TopicArn: topic, Timestamp: at.toISOString(), MessageId: 'sns-1', ...fields };
    return { ...message, Signature: sign(version === '2' ? 'sha256' : 'sha1', Buffer.from(snsStringToSign(message)), privateKey).toString('base64') };
  };
  const event = { eventType: 'Delivery', mail: { timestamp: at.toISOString(), tags: { growth_message_id: ['11111111-1111-4111-8111-111111111111'] } }, delivery: { timestamp: at.toISOString() } };
  const notification = (fields = {}, version) => signed({ Type: 'Notification', Message: JSON.stringify(event), ...fields }, version);
  const receiver = (fetchImpl = vi.fn(async () => ({ status: 200, text: async () => pem }))) => ({ fetchImpl, receive: snsReceiver({ topicArn: () => topic, fetchImpl, now: () => at.getTime() }) });
  const body = message => Buffer.from(JSON.stringify(message));

  it('accepts a signed notification from the configured topic and caches the certificate', async () => {
    const { fetchImpl, receive } = receiver();
    await expect(receive(body(notification()))).resolves.toMatchObject({ notification: { MessageId: 'sns-1' } });
    await expect(receive(body(notification({ MessageId: 'sns-2' }, '1')))).resolves.toMatchObject({ notification: { MessageId: 'sns-2' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(certUrl, expect.objectContaining({ redirect: 'error' }));
  });

  it('refuses another topic, a certificate off SNS, a changed message and an old one', async () => {
    const { receive } = receiver();
    await expect(receive(body(notification({ TopicArn: 'arn:aws:sns:us-east-2:111111111111:someone-else' })))).rejects.toMatchObject({ status: 403 });
    await expect(receive(body(notification({ SigningCertURL: 'https://attacker.example/sns.pem' })))).rejects.toMatchObject({ status: 403 });
    await expect(receive(body(notification({ SigningCertURL: 'https://sns.us-west-2.amazonaws.com/cert.pem' })))).rejects.toMatchObject({ status: 403 });
    await expect(receive(body({ ...notification(), Message: '{"eventType":"Complaint"}' }))).rejects.toMatchObject({ status: 403 });
    await expect(receive(body(notification({ Timestamp: '2026-11-11T00:00:00Z' })))).rejects.toMatchObject({ status: 403 });
    await expect(receive(Buffer.from('not json'))).rejects.toMatchObject({ status: 400 });
  });

  it('is unavailable until the events topic is set', async () => {
    await expect(snsReceiver({ topicArn: () => null })(body(notification()))).rejects.toMatchObject({ status: 503 });
  });

  it('confirms a subscription only on SNS in the topic\'s region', async () => {
    const { fetchImpl, receive } = receiver();
    const subscribe = 'https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=t';
    await expect(receive(body(signed({ Type: 'SubscriptionConfirmation', Message: 'confirm', SubscribeURL: subscribe, Token: 't' })))).resolves.toEqual({ confirmed: true });
    expect(fetchImpl).toHaveBeenLastCalledWith(subscribe, expect.objectContaining({ redirect: 'error' }));
    await expect(receive(body(signed({ Type: 'SubscriptionConfirmation', Message: 'confirm', SubscribeURL: 'https://attacker.example/confirm', Token: 't' }))))
      .rejects.toMatchObject({ status: 403 });
  });

  it('turns SES events into growth delivery events', () => {
    const of = (value, id = 'n1') => sesGrowthEvents({ MessageId: id, Timestamp: at.toISOString(), Message: JSON.stringify(value) });
    const tags = { growth_message_id: ['11111111-1111-4111-8111-111111111111'] };
    expect(of(event)).toEqual([{ id: 'ses:n1', messageId: '11111111-1111-4111-8111-111111111111', kind: 'delivered', at: at.toISOString() }]);
    expect(of({ eventType: 'Bounce', mail: { tags }, bounce: { bounceType: 'Permanent', timestamp: at.toISOString() } })[0].kind).toBe('bounced');
    expect(of({ eventType: 'Bounce', mail: { tags }, bounce: { bounceType: 'Transient' } })).toEqual([]);
    expect(of({ eventType: 'Complaint', mail: { tags }, complaint: {} })[0].kind).toBe('complaint');
    expect(of({ eventType: 'Reject', mail: { tags } })[0].kind).toBe('bounced');
    expect(of({ eventType: 'Delivery', mail: { tags: {} } })).toEqual([]);
    expect(sesGrowthEvents({ MessageId: 'n2', Message: 'not json' })).toEqual([]);
  });

  it('records verified SES events on the growth record once per notification', async () => {
    const store = { delivery: vi.fn(async () => true) };
    const { receive } = receiver();
    const service = growthService({ store, features: new Set(['platform.agents.customer-growth.v1']), sesEvents: receive, sesEventsReady: () => true });
    await expect(service.sesDelivery(body(notification()))).resolves.toEqual({ accepted: 1 });
    expect(store.delivery).toHaveBeenCalledWith('ses:sns-1', '11111111-1111-4111-8111-111111111111', 'delivered', at.toISOString());
    await expect(service.sesDelivery(body(notification({ TopicArn: 'arn:aws:sns:us-east-2:111111111111:other' })))).rejects.toMatchObject({ status: 403 });
    expect(service.readiness().deliveryFeedback).toBe(true);
    await expect(growthService({ store, features: new Set(['platform.agents.customer-growth.v1']) }).sesDelivery(body(notification()))).rejects.toMatchObject({ status: 503 });
  });
});
