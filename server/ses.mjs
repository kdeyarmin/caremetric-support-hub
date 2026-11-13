import { createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { live } from './live.mjs';

/**
 * Amazon SES for the Hub's email (docs/AMAZON_SES.md). Two senders with the same interface as the SendGrid ones in
 * communications.mjs and bulk-email.mjs, so a switch (Settings → Email → Email service) moves every send from one to the other:
 *
 * - sesMail: staff replies, the AI team's alerts and the Support Concierge's answers (`send(to, subject, content)`).
 * - sesBulkMail: bulk, growth and customer lifecycle email (`send({ to, subject, text, html, unsubscribeUrl, messageId })`), with
 *   one-click unsubscribe headers and the growth message id as an SES message tag, so delivery events find their message.
 *
 * Both call the SES v2 SendEmail API with a raw MIME message, signed with AWS Signature Version 4. No AWS SDK: the request is one
 * signed POST, and the signer is checked against AWS's published test vector and a live request (ses.test.mjs).
 *
 * Delivery, bounce and complaint events reach the Hub as Amazon SNS notifications (snsMessage below): the signature is checked against
 * the certificate SNS signs with, the certificate must come from SNS in the configured region, and only the configured topic is
 * accepted, so nobody can subscribe the Hub to a topic of their own.
 */

const emailAddress = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const accessKeyPattern = /^(AKIA|ASIA)[A-Z0-9]{12,124}$/;
const regionPattern = /^[a-z]{2}(-[a-z]+)+-\d$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const amzDate = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * AWS Signature Version 4 for one request. `headers` are the headers to sign (lower-case names); host and x-amz-date are added.
 * Returns every header to send, Authorization included.
 */
export function signV4({ method, url, region, service, accessKeyId, secretAccessKey, sessionToken = null, headers = {}, body = '', now = new Date() }) {
  const target = new URL(url);
  const stamp = amzDate(now), day = stamp.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim()])),
    host: target.host, 'x-amz-date': stamp, ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}) };
  const names = Object.keys(all).sort();
  const query = [...target.searchParams].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, target.pathname || '/', query, ...names.map(name => `${name}:${all[name]}`), '', names.join(';'), sha256(body)].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

// Strip caller-supplied line breaks before folding header text.
const oneLine = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
// Keep "Subject: " plus the first encoded word within 76 columns. Each
// UTF-8 code point belongs to exactly one independently decodable word.
function encodedWords(value) {
  const words = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 39) {
      words.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  words.push(chunk);
  return words.map(word => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}
function displayMailbox(name, address) {
  if (!name) return `<${address}>`;
  const label = ascii(name) && name.length <= 60 ? `"${name}"` : encodedWords(name);
  const lastLine = label.slice(label.lastIndexOf("\n") + 1);
  const prefix = label.includes("\r\n") ? 0 : "From: ".length;
  const separator = prefix + lastLine.length + address.length + 3 <= 76 ? " " : "\r\n ";
  return `${label}${separator}<${address}>`;
}
function subjectHeader(value) {
  return ascii(value) && value.length <= 69 ? value : encodedWords(value);
}
const ascii = value => /^[\x20-\x7e]*$/.test(value);
const mailbox = (address, name) => {
  const display = oneLine(name).replace(/["\\]/g, '');
  return displayMailbox(display, address);
};
const base64Lines = text => Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, line => `${line}\r\n`);
const part = (type, text) => `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(text)}`;

/** One RFC 5322 message: text first, then HTML when given (multipart/alternative), every part base64 so any text is safe. */
export function mimeMessage({ from, fromName = '', to, replyTo = null, subject, text, html = null, headers = {}, date = new Date(), boundary = `cm-${randomBytes(12).toString('hex')}` }) {
  const lines = [
    `From: ${mailbox(from, fromName)}`, `To: <${to}>`, ...(replyTo ? [`Reply-To: <${replyTo}>`] : []),
    `Subject: ${subjectHeader(oneLine(subject))}`, `Date: ${date.toUTCString().replace('GMT', '+0000')}`, 'MIME-Version: 1.0',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${oneLine(value)}`),
  ];
  if (!html) return `${lines.join('\r\n')}\r\n${part('text/plain', text ?? '')}`;
  return `${lines.join('\r\n')}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`
    + `--${boundary}\r\n${part('text/plain', text ?? '')}--${boundary}\r\n${part('text/html', html)}--${boundary}--\r\n`;
}

/**
 * The SES v2 SendEmail call shared by both senders. Answers like the SendGrid senders: `sent` with SES's message id, `failed` when
 * SES refused the message (a 4xx: it was not sent), `unknown` when the outcome cannot be known (a timeout or a server error).
 */
function sesClient({ accessKeyId, secretAccessKey, sessionToken = null, region, configurationSet, fetchImpl, now }) {
  const regionNow = () => { const value = live(region); return typeof value === 'string' && regionPattern.test(value) ? value : 'us-east-2'; };
  const setNow = () => { const value = live(configurationSet); return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null; };
  return {
    get configured() { return typeof accessKeyId === 'string' && accessKeyPattern.test(accessKeyId) && typeof secretAccessKey === 'string' && secretAccessKey.length >= 20; },
    async send({ to, raw, tags = [] }) {
      const host = `email.${regionNow()}.amazonaws.com`, url = `https://${host}/v2/email/outbound-emails`;
      const set = setNow();
      const body = JSON.stringify({ Destination: { ToAddresses: [to] }, Content: { Raw: { Data: Buffer.from(raw, 'utf8').toString('base64') } },
        ConfigurationOverrides: { Tracking: { ClickTrackingEnabled: "DISABLED", OpenTrackingEnabled: "DISABLED" } },
        ...(tags.length ? { EmailTags: tags } : {}), ...(set ? { ConfigurationSetName: set } : {}) });
      let response;
      try {
        const headers = signV4({ method: 'POST', url, region: regionNow(), service: 'ses', accessKeyId, secretAccessKey, sessionToken,
          headers: { 'content-type': 'application/json' }, body, now: now() });
        delete headers.host;
        response = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(15000) });
      } catch { return { delivery: 'unknown', id: null }; }
      if (response.status >= 400 && response.status < 500) return { delivery: 'failed', id: null };
      if (response.status !== 200) return { delivery: 'unknown', id: null };
      const id = (await response.json().catch(() => ({}))).MessageId;
      return { delivery: 'sent', id: typeof id === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(id) ? id : null };
    },
  };
}

/** SES for staff replies and alerts: the same interface as sendgridMail (communications.mjs). `from` and `replyTo` may be functions. */
export function sesMail({ accessKeyId, secretAccessKey, sessionToken = null, region = 'us-east-2', configurationSet = null, from = 'support@caremetric.ai', replyTo = null, fromName = 'CareMetric Support', fetchImpl = fetch, now = () => new Date() }) {
  const client = sesClient({ accessKeyId, secretAccessKey, sessionToken, region, configurationSet, fetchImpl, now });
  const sender = () => { const value = live(from); return typeof value === 'string' ? value.trim() : ''; };
  const reply = () => { const value = live(replyTo); return typeof value === 'string' && emailAddress.test(value.trim()) ? value.trim() : null; };
  return {
    get configured() { return client.configured && emailAddress.test(sender()); },
    async send(to, subject, content) {
      const { text, html } = typeof content === 'string' ? { text: content, html: null } : content;
      const raw = mimeMessage({ from: sender(), fromName, to, replyTo: reply(), subject, text, html, date: now() });
      return client.send({ to, raw, tags: [{ Name: 'category', Value: 'hub-support' }] });
    },
  };
}

/** SES for bulk, growth and customer email: the same interface as sendgridBulkMail (bulk-email.mjs). Settings may be functions. */
export function sesBulkMail({ accessKeyId, secretAccessKey, sessionToken = null, region = 'us-east-2', configurationSet = null, from = 'support@caremetric.ai', fromName = 'CareMetric', replyTo = from, category = 'hub-bulk-email', fetchImpl = fetch, now = () => new Date() }) {
  const client = sesClient({ accessKeyId, secretAccessKey, sessionToken, region, configurationSet, fetchImpl, now });
  const sender = () => ({ from: String(live(from) ?? '').trim(), fromName: String(live(fromName) ?? ''), replyTo: String(live(replyTo) ?? '').trim() });
  return {
    get configured() { const value = sender(); return client.configured && emailAddress.test(value.from) && emailAddress.test(value.replyTo) && /^[a-z0-9-]{1,40}$/.test(category); },
    async send({ to, subject, text, html, unsubscribeUrl, messageId }) {
      const { from, fromName, replyTo } = sender();
      const headers = unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {};
      const raw = mimeMessage({ from, fromName, to, replyTo, subject, text, html, headers, date: now() });
      const tags = [{ Name: 'category', Value: category }, ...(typeof messageId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(messageId) ? [{ Name: 'growth_message_id', Value: messageId }] : [])];
      return client.send({ to, raw, tags });
    },
  };
}

/**
 * The sender the owner chose (Settings → Email → Email service), read on each send, so switching between SendGrid and Amazon SES
 * takes effect within a minute without a restart. SES can fall back to configured SendGrid before a request.
 * Sending through SES always requires an explicit selection.
 */
export function chosenMail(choice, providers) {
  const current = () => {
    const wanted = live(choice) === 'ses' ? 'ses' : 'sendgrid';
    if (wanted === 'ses' && !providers.ses?.configured && providers.sendgrid?.configured) return providers.sendgrid;
    return providers[wanted];
  };
  return {
    get configured() { return current()?.configured === true; },
    get provider() { const value = current(); return value === providers.ses ? 'ses' : 'sendgrid'; },
    async send(...args) {
      const sender = current();
      if (!sender?.configured) return { delivery: 'failed', id: null };
      return sender.send(...args);
    },
  };
}

const snsFields = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};
export const snsTopicPattern = /^arn:aws:sns:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):([A-Za-z0-9_-]{1,256})$/;

/** The text SNS signs: each present field's name and value on their own lines, in the order SNS documents. */
export function snsStringToSign(message) {
  return (snsFields[message?.Type] ?? []).filter(name => typeof message[name] === 'string').map(name => `${name}\n${message[name]}\n`).join('');
}

/**
 * Checks one SNS message (the parsed JSON body SNS posts) and returns it, or throws. `topicArn` is the only topic accepted (it may be a
 * function). The signing certificate must be an https .pem file on sns.<topic's region>.amazonaws.com; it is fetched once and cached.
 * Messages older than six hours are refused. A SubscriptionConfirmation is confirmed here by visiting its SubscribeURL, which must also
 * be on SNS in that region; the caller gets `{ confirmed: true }` and does nothing else.
 */
export function snsReceiver({ topicArn, fetchImpl = fetch, now = () => Date.now(), certificates = new Map() }) {
  const fail = message => Object.assign(new Error(message), { status: 403 });
  return async function receive(raw) {
    const expected = live(topicArn);
    const topic = typeof expected === 'string' ? snsTopicPattern.exec(expected) : null;
    if (!topic) throw Object.assign(new Error('Amazon SES events are not configured.'), { status: 503 });
    let message;
    try { message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch { throw Object.assign(new Error('Invalid notification.'), { status: 400 }); }
    if (!message || typeof message !== 'object' || !snsFields[message.Type] || message.TopicArn !== expected) throw fail('Unknown topic.');
    const snsHost = `sns.${topic[1]}.amazonaws.com`;
    const onSns = value => { try { const url = new URL(value); return url.protocol === 'https:' && url.host === snsHost && !url.username && !url.password; } catch { return false; } };
    if (!onSns(message.SigningCertURL) || !new URL(message.SigningCertURL).pathname.endsWith('.pem')) throw fail('Untrusted signing certificate.');
    const sent = Date.parse(message.Timestamp ?? '');
    if (!Number.isFinite(sent) || Math.abs(now() - sent) > 6 * 3600_000) throw fail('Stale notification.');
    const algorithm = message.SignatureVersion === '2' ? 'sha256' : message.SignatureVersion === '1' ? 'sha1' : null;
    if (!algorithm || typeof message.Signature !== 'string') throw fail('Invalid signature.');
    let key = certificates.get(message.SigningCertURL);
    if (!key) {
      let pem;
      try {
        const response = await fetchImpl(message.SigningCertURL, { redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (response.status !== 200) throw new Error('certificate');
        pem = await response.text();
        key = createPublicKey(pem);
      } catch { throw Object.assign(new Error('The signing certificate could not be read.'), { status: 503 }); }
      certificates.set(message.SigningCertURL, key);
    }
    let valid = false;
    try { valid = verify(algorithm, Buffer.from(snsStringToSign(message), 'utf8'), key, Buffer.from(message.Signature, 'base64')); } catch { valid = false; }
    if (!valid) throw fail('Invalid signature.');
    if (message.Type === 'SubscriptionConfirmation') {
      if (!onSns(message.SubscribeURL)) throw fail('Untrusted subscription address.');
      let response;
      try { response = await fetchImpl(message.SubscribeURL, { redirect: 'error', signal: AbortSignal.timeout(10000) }); } catch { response = null; }
      if (response?.status !== 200) throw Object.assign(new Error('The subscription could not be confirmed. SNS will retry.'), { status: 502 });
      return { confirmed: true };
    }
    if (message.Type === 'UnsubscribeConfirmation') return { unsubscribed: true };
    return { notification: message };
  };
}

/**
 * The growth delivery events in one SES event notification (the configuration set's SNS event destination publishes one event per
 * notification). Only messages the Hub tagged with a growth message id count. Delivery → delivered; all bounces and rejects count as terminal failures.
 * Only a permanent bounce or complaint suppresses the contact. A DeliveryDelay is still in progress. Each event's id is the SNS message
 * id, so a notification SNS delivers twice is recorded once.
 */
export function sesGrowthEvents(notification) {
  let event;
  try { event = JSON.parse(notification.Message); } catch { return []; }
  const type = event?.eventType ?? event?.notificationType;
  const tag = event?.mail?.tags?.growth_message_id;
  const messageId = Array.isArray(tag) ? tag[0] : null;
  if (typeof messageId !== 'string') return [];
  const kind = type === 'Delivery' ? 'delivered'
    : type === 'Bounce' ? (event.bounce?.bounceType === 'Permanent' ? 'bounced' : 'unsuppressed_bounce')
      : type === 'Reject' ? 'unsuppressed_bounce' : type === 'Complaint' ? 'complaint' : null;
  if (!kind) return [];
  const at = Date.parse(event.delivery?.timestamp ?? event.bounce?.timestamp ?? event.complaint?.timestamp ?? event.mail?.timestamp ?? notification.Timestamp);
  return [{ id: `ses:${notification.MessageId}`, messageId, kind, at: Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString() }];
}
