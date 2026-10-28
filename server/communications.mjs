import { resolveProductSlug } from '../src/domain.ts';
import { isCentralHubApp } from '../src/hubScope.ts';
import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { HttpError, digest, token, transaction, withSession } from './sms-auth.mjs';
import { normalizePhone } from './sms-provider.mjs';
import { SUPPORT_PHONE_DISPLAY, SUPPORT_TEAM_NAME, renderEmail } from './email-layout.mjs';

/* Unified communications: inbound SMS and email webhooks, website chat, staff
   replies, and imports from the Breathe phone line and the Advisors consultation
   form. Message text never reaches logs, errors or audit metadata. */
export const chatCookie = '__Host-caremetric_chat';
export const defaultPublicOrigin = 'https://support-hub-web-production.up.railway.app';
const e164 = /^\+[1-9][0-9]{7,14}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const emailAddress = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const clean = value => value.replace(/\r\n/g, '\n').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
// The application administration contracts accept page offsets up to 10,000.
const maxImportOffset = 10000;
const reviewedErrors = { '22023': 400, '22007': 400, P0001: 409, '40001': 409, '42501': 403, '53400': 429, '28000': 401 };

/** Database messages for these codes are authored in the reviewed migrations; anything else stays generic. */
function reviewed(error) {
  if (error instanceof HttpError) return error;
  const status = reviewedErrors[error?.code];
  return status ? new HttpError(status, error.message) : error;
}
async function rawBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new HttpError(413, 'Request is too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const equal = (a, b) => { const left = Buffer.from(String(a)), right = Buffer.from(String(b)); return left.length === right.length && timingSafeEqual(left, right); };

/** Twilio request validation: HMAC-SHA1 over the exact public URL plus the sorted POST parameters. */
export function twilioSignature(authToken, url, params) {
  const data = url + [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => key + value).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}
/** SendGrid signed webhooks: ECDSA P-256 / SHA-256 over the timestamp followed by the raw body. */
export function sendgridSignatureValid(publicKey, signature, timestamp, payload) {
  try { return verify('sha256', Buffer.concat([Buffer.from(timestamp, 'utf8'), payload]), publicKey, Buffer.from(signature, 'base64')); }
  catch { return false; }
}

/** Parse "Name <address>" or a bare address. */
export function parseMailbox(value) {
  const text = String(value || '').trim();
  const angle = /^(.*)<([^<>]+)>\s*$/.exec(text);
  const address = (angle ? angle[2] : text).trim().toLowerCase();
  const name = angle ? angle[1].trim().replace(/^"(.*)"$/, '$1').trim() : '';
  return emailAddress.test(address) && address.length <= 320 ? { address, name: name.slice(0, 160) || null } : null;
}
/** support+breathe@… routes to an application; any other address leaves the conversation for triage. */
export function productFromAddresses(addresses) {
  for (const value of addresses) {
    const tag = /^[^+@\s]+\+([a-z0-9-]{2,40})@/i.exec(String(value).trim())?.[1];
    if (tag) return tag.toLowerCase();
  }
  return null;
}
/** One "Re:" and only this conversation's reference, even when the customer's subject carried another. */
export function replySubject(subject, reference) {
  const base = String(subject || '').replace(/\s*\[CM-\d+\]/g, '').replace(/^(\s*re\s*:\s*)+/i, '').trim();
  return `Re: ${base || 'Your CareMetric support request'} [CM-${reference}]`;
}
/** Imported phone-line conversations are titled for staff ("Billing call from Jordan
    Rivera"), so the caller's emailed reply is named for what they did instead. */
export const PHONE_REPLY_SUBJECT = 'Your phone message to CareMetric';
/** The email a staff reply sends: the agent's words exactly as written, signed by
    CareMetric Support, in the shared person-to-person layout with a matching text part.
    `channel` is where the conversation started; a database without it keeps the stored subject. */
export function supportReplyEmail({ subject, reference, body, channel }) {
  const title = replySubject(channel === 'phone' ? PHONE_REPLY_SUBJECT : subject, reference);
  const { html, text } = renderEmail({
    layout: 'personal',
    title,
    blocks: [{ type: 'message', text: body }],
    signature: [`— ${SUPPORT_TEAM_NAME}`, `Reference CM-${reference}`],
    footer: [
      "You're receiving this because you contacted CareMetric.",
      `Reply to this email to continue the conversation, or call ${SUPPORT_PHONE_DISPLAY}.`,
      "Please don't include patient information in your reply.",
    ],
  });
  return { subject: title, text, html };
}
/** Reduces an HTML-only email to text. Head, title, style, script and comment content
    (including a quoted copy of a Hub reply's own markup) never reach the stored message. */
export function htmlToText(html) {
  return String(html || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

const inquiryTypes = { healthcare_advisors: 'advisors', tech_support: 'technical_support', customer_service: 'customer_service', sales: 'sales', billing: 'billing' };
const requestLabels = { healthcare_advisors: 'Advisors call', tech_support: 'Technical support call', customer_service: 'Customer service call', sales: 'Software inquiry call', billing: 'Billing call' };
/** A Breathe phone-line message (already parsed by the portfolio contract) as a Hub import item. */
export function phoneImportItem(message, now = new Date()) {
  const status = message.status === 'new' ? 'new' : /closed|resolved|complete|done|archived/i.test(message.status) ? 'closed' : 'open';
  const sms = message.sms ? `\n\nRequested text: ${message.sms.resources.join(', ') || 'none'} (${message.sms.status})` : '';
  return {
    sourceKey: message.id, receivedAt: message.createdAt ?? now.toISOString(), status, productSlug: message.product || null,
    inquiryType: inquiryTypes[message.requestType] ?? 'unclassified',
    subject: `${requestLabels[message.requestType] ?? 'Phone message'} from ${message.contactName || message.phone || 'an unidentified caller'}`,
    body: (message.message + sms).slice(0, 4000), contactName: message.contactName, contactEmail: message.email,
    contactPhone: normalizePhone(message.phone ?? '') ?? message.phone, organization: message.companyName,
  };
}
/** An Advisors consultation request (already parsed by the portfolio contract) as a Hub import item. */
export function inquiryImportItem(inquiry) {
  return {
    sourceKey: inquiry.id, receivedAt: inquiry.createdAt, status: inquiry.status === 'in-progress' ? 'open' : inquiry.status,
    productSlug: 'advisors', inquiryType: 'advisors', subject: `Consultation request from ${inquiry.organization}`,
    body: `${inquiry.message}\n\nInterest: ${inquiry.service}\nSector: ${inquiry.sector}`.slice(0, 4000),
    contactName: inquiry.name, contactEmail: inquiry.email, contactPhone: inquiry.phone ? normalizePhone(inquiry.phone) ?? inquiry.phone : null,
    organization: inquiry.organization,
  };
}

/** Twilio Programmable Messaging for staff replies by text. */
export function twilioMessaging({ accountSid, authToken, messagingServiceSid, from, fetchImpl = fetch }) {
  const configured = /^AC[0-9a-f]{32}$/.test(accountSid || '') && !!authToken && (/^MG[0-9a-f]{32}$/.test(messagingServiceSid || '') || e164.test(from || ''));
  return {
    configured,
    async send(to, body) {
      const form = new URLSearchParams({ To: to, Body: body, ...(messagingServiceSid ? { MessagingServiceSid: messagingServiceSid } : { From: from }) });
      let response;
      try {
        response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
          method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(), redirect: 'error', signal: AbortSignal.timeout(15000),
        });
      } catch { return { delivery: 'unknown', id: null }; }
      if (response.status >= 400 && response.status < 500) return { delivery: 'failed', id: null };
      if (!response.ok) return { delivery: 'unknown', id: null };
      const sid = (await response.json().catch(() => ({}))).sid;
      return { delivery: 'sent', id: typeof sid === 'string' && /^(SM|MM)[0-9a-f]{32}$/.test(sid) ? sid : null };
    },
  };
}
/** SendGrid Mail Send for staff replies by email. `content` is the text body, or
    { text, html } to send both parts (text/plain first, as SendGrid requires). */
export function sendgridMail({ apiKey, from = 'support@caremetric.ai', fetchImpl = fetch }) {
  const configured = typeof apiKey === 'string' && apiKey.startsWith('SG.') && emailAddress.test(from);
  return {
    configured,
    async send(to, subject, content) {
      const { text, html } = typeof content === 'string' ? { text: content, html: null } : content;
      let response;
      try {
        response = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from, name: 'CareMetric Support' }, subject,
            content: [{ type: 'text/plain', value: text }, ...(html ? [{ type: 'text/html', value: html }] : [])] }),
        });
      } catch { return { delivery: 'unknown', id: null }; }
      if (response.status >= 400 && response.status < 500) return { delivery: 'failed', id: null };
      if (response.status !== 202) return { delivery: 'unknown', id: null };
      const id = response.headers.get('x-message-id');
      return { delivery: 'sent', id: id && /^[A-Za-z0-9._-]{1,200}$/.test(id) ? id : null };
    },
  };
}

export function communications({ pool, delegations, publicOrigin = defaultPublicOrigin, twilioAuthToken, sendgridInboundPublicKey, sms, email, chatEnabled = false, now = () => new Date() }) {
  let inboundKey = null;
  // A malformed key disables inbound email rather than stopping the whole Hub.
  try { if (sendgridInboundPublicKey) inboundKey = createPublicKey({ key: Buffer.from(sendgridInboundPublicKey, 'base64'), format: 'der', type: 'spki' }); }
  catch { console.warn('Inbound email is disabled: the SendGrid verification key could not be read.'); }
  const available = () => [...(sms?.configured ? ['sms'] : []), ...(email?.configured ? ['email'] : [])];
  const server = (sql, values) => transaction(pool, async db => (await db.query(sql, values)).rows[0].result).catch(error => { throw reviewed(error); });
  const staff = (sessionToken, sql, values) => withSession(pool, sessionToken, async db => (await db.query(sql, values)).rows[0].result).catch(error => { throw reviewed(error); });
  const id = value => { if (typeof value !== 'string' || !uuid.test(value)) throw new HttpError(400, 'Choose a conversation.'); return value; };
  const requestKey = value => { if (typeof value !== 'string' || !uuid.test(value)) throw new HttpError(400, 'Reload the conversation and try again.'); return value; };
  const only = (input, keys) => { if (!input || Object.keys(input).some(key => !keys.includes(key))) throw new HttpError(400, 'Unsupported request.'); };

  async function deliver(started, body) {
    if (started.replay || started.deliveryChannel === 'chat') return { delivery: started.delivery, deliveryChannel: started.deliveryChannel, replay: started.replay };
    let outcome;
    if (started.deliveryChannel === 'sms') outcome = await sms.send(started.to, body);
    else {
      const message = supportReplyEmail({ subject: started.subject, reference: started.reference, body, channel: started.channel });
      outcome = await email.send(started.to, message.subject, message);
    }
    await server('select private.finish_communication_delivery($1,$2,$3) as result', [started.messageId, outcome.delivery, outcome.id]);
    return { delivery: outcome.delivery, deliveryChannel: started.deliveryChannel, replay: false };
  }

  return {
    /** Inbound SMS from Twilio. Returns an empty TwiML response; staff reply from the Hub. */
    async smsWebhook(req) {
      if (!twilioAuthToken) throw new HttpError(503, 'Text messaging is not configured.');
      if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Unsupported message format.');
      const params = new URLSearchParams((await rawBody(req, 16384)).toString('utf8'));
      const signature = req.headers['x-twilio-signature'];
      if (typeof signature !== 'string' || !equal(signature, twilioSignature(twilioAuthToken, `${publicOrigin}/api/channels/sms/twilio`, params))) throw new HttpError(403, 'Invalid signature.');
      const from = params.get('From') ?? '', sid = params.get('MessageSid') ?? '', media = Number(params.get('NumMedia') ?? '0');
      if (!e164.test(from) || !/^(SM|MM)[0-9a-f]{32}$/.test(sid)) throw new HttpError(400, 'Unsupported message.');
      const text = [(params.get('Body') ?? '').trim(), media > 0 ? `[${media} picture or file attachment(s) were not stored. Ask the sender to describe them.]` : ''].filter(Boolean).join('\n\n');
      await server('select private.ingest_inbound_communication($1,$2,$3,null,null,null,$4,null,null,$5) as result', ['sms', from, sid, text || '[Empty text message]', from]);
      return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
    },
    /** Inbound email from SendGrid Inbound Parse (signed webhook, parsed mode). Attachments are never stored. */
    async emailWebhook(req) {
      if (!inboundKey) throw new HttpError(503, 'Inbound email is not configured.');
      if (req.headers['content-type']?.split(';')[0] !== 'multipart/form-data') throw new HttpError(415, 'Unsupported message format.');
      const payload = await rawBody(req, 10485760);
      const signature = req.headers['x-twilio-email-event-webhook-signature'], timestamp = req.headers['x-twilio-email-event-webhook-timestamp'];
      if (typeof signature !== 'string' || typeof timestamp !== 'string' || !/^\d{9,11}$/.test(timestamp)
        || Math.abs(now().getTime() / 1000 - Number(timestamp)) > 600 || !sendgridSignatureValid(inboundKey, signature, timestamp, payload)) {
        throw new HttpError(403, 'Invalid signature.');
      }
      let form;
      try { form = await new Response(payload, { headers: { 'content-type': req.headers['content-type'] } }).formData(); }
      catch { throw new HttpError(400, 'Unsupported message.'); }
      const field = name => { const value = form.get(name); return typeof value === 'string' ? value : ''; };
      let envelope = {};
      try { envelope = JSON.parse(field('envelope') || '{}'); } catch { /* The From header remains authoritative. */ }
      const sender = parseMailbox(field('from')) ?? parseMailbox(envelope.from);
      if (!sender) throw new HttpError(400, 'Unsupported sender.');
      const headers = field('headers');
      const messageId = /^Message-ID:\s*(<[^>\r\n]{1,290}>)/im.exec(headers)?.[1] ?? digest([sender.address, field('subject'), field('text'), /^Date:.*$/im.exec(headers)?.[0] ?? ''].join('\n'));
      const subject = field('subject').trim();
      // Outbound subjects end with the conversation's reference, so the last one is ours.
      const reference = [...subject.matchAll(/\[CM-(\d{4,12})\]/g)].at(-1)?.[1] ?? null;
      const attachments = Number(field('attachments') || '0');
      const text = [(field('text') || htmlToText(field('html'))).trim(), attachments > 0 ? `[${attachments} attachment(s) were not stored. Ask the sender to describe them without patient information.]` : ''].filter(Boolean).join('\n\n');
      const product = productFromAddresses([...(Array.isArray(envelope.to) ? envelope.to : []), ...field('to').split(',')]);
      const result = await server('select private.ingest_inbound_communication($1,$2,$3,$4,$5,$6,$7,$8,$9,null) as result',
        ['email', messageId, messageId, reference, product, subject || null, text || '[Empty email]', sender.name, sender.address]);
      return { received: true, reference: result.reference };
    },
    /** Public: whether website chat accepts new conversations. Off until the owner enables it. */
    availability() { return { chat: chatEnabled }; },
    async startChat(input, clientAddress) {
      if (!chatEnabled) throw new HttpError(503, 'Chat is not available yet. Call (877) 521-2890 or email support@caremetric.ai.');
      only(input, ['name', 'email', 'product', 'message', 'noPhi']);
      if (input.noPhi !== true) throw new HttpError(400, 'Confirm that your message contains no patient information.');
      for (const key of ['name', 'email', 'message']) if (typeof input[key] !== 'string') throw new HttpError(400, 'Enter your name, email address and question.');
      if (input.product !== undefined && input.product !== null && (typeof input.product !== 'string' || !/^[a-z0-9-]{2,40}$/.test(input.product))) throw new HttpError(400, 'Choose an application.');
      if (input.product && !isCentralHubApp(resolveProductSlug(input.product))) throw new HttpError(400, 'Use the application’s own support.');
      const chat = token();
      const result = await server('select private.start_chat($1,$2,$3,$4,$5,$6) as result', [digest(chat), digest('chat:' + clientAddress), input.name, input.email, input.product ?? null, input.message]);
      return { reference: result.reference, token: chat };
    },
    async readChat(chat) {
      if (!chat) throw new HttpError(404, 'No chat is open in this browser.');
      return server('select private.read_chat($1) as result', [digest(chat)]);
    },
    async postChat(chat, input, clientAddress) {
      if (!chatEnabled) throw new HttpError(503, 'Chat is not available yet. Call (877) 521-2890 or email support@caremetric.ai.');
      if (!chat) throw new HttpError(404, 'No chat is open in this browser.');
      only(input, ['message']);
      if (typeof input.message !== 'string') throw new HttpError(400, 'Write a message.');
      return server('select private.post_chat_message($1,$2,$3) as result', [digest(chat), digest('chat:' + clientAddress), input.message]);
    },
    async channels(sessionToken) {
      await staff(sessionToken, 'select hub.list_communications(null,null,null,null,0,1) as result', []);
      return { sms: { inbound: !!twilioAuthToken, replies: !!sms?.configured }, email: { inbound: !!inboundKey, replies: !!email?.configured }, chat: { enabled: chatEnabled }, phone: { sync: true }, webForm: { sync: true } };
    },
    async list(sessionToken, input) {
      only(input, ['status', 'channel', 'productId', 'search', 'offset', 'limit']);
      if (input.productId != null && (typeof input.productId !== 'string' || !uuid.test(input.productId))) throw new HttpError(400, 'Choose an application.');
      return staff(sessionToken, 'select hub.list_communications($1,$2,$3,$4,$5,$6) as result',
        [input.status ?? null, input.channel ?? null, input.productId ?? null, input.search ?? null, input.offset ?? 0, input.limit ?? 25]);
    },
    async get(sessionToken, input) {
      only(input, ['id']);
      return staff(sessionToken, 'select hub.get_communication($1) as result', [id(input.id)]);
    },
    async update(sessionToken, input) {
      only(input, ['id', 'status', 'inquiryType', 'productId', 'changeProduct', 'assignedTo', 'changeAssignment', 'expectedUpdatedAt']);
      for (const key of ['productId', 'assignedTo']) if (input[key] != null && (typeof input[key] !== 'string' || !uuid.test(input[key]))) throw new HttpError(400, 'Invalid conversation update.');
      return staff(sessionToken, 'select hub.update_communication($1,$2,$3,$4,$5,$6,$7,$8) as result',
        [id(input.id), input.status ?? null, input.inquiryType ?? null, input.productId ?? null, input.changeProduct === true, input.assignedTo ?? null, input.changeAssignment === true, input.expectedUpdatedAt]);
    },
    async note(sessionToken, input) {
      only(input, ['id', 'body', 'requestKey']);
      return staff(sessionToken, 'select hub.add_communication_note($1,$2,$3) as result', [id(input.id), input.body, requestKey(input.requestKey)]);
    },
    async reply(sessionToken, input) {
      only(input, ['id', 'body', 'requestKey']);
      if (typeof input.body !== 'string') throw new HttpError(400, 'Write a reply.');
      const started = await staff(sessionToken, 'select hub.begin_communication_reply($1,$2,$3,$4) as result', [id(input.id), input.body, requestKey(input.requestKey), available()]);
      return deliver(started, clean(input.body));
    },
    /** Copy up to 200 messages another application received into the Hub, resuming at offset. Requires the platform administrator session. */
    async sync(sessionToken, input) {
      only(input, ['source', 'offset']);
      if (input.source === 'advisors.web') throw new HttpError(410, 'Advisors uses its own consultation inbox.');
      const source = { 'breathe.phone': { product: 'breathe', operation: 'phone.messages.list', item: phoneImportItem },
        'advisors.web': { product: 'advisors', operation: 'inquiries.list', item: inquiryImportItem } }[input.source];
      if (!source) throw new HttpError(400, 'Choose a message source.');
      const start = input.offset ?? 0;
      if (!Number.isSafeInteger(start) || start < 0 || start > maxImportOffset) throw new HttpError(400, 'Choose where to resume the import.');
      // Fail before any application read when the caller is not the platform administrator.
      await staff(sessionToken, 'select hub.authorize_app_admin() as result', []);
      let read = 0, created = 0, skipped = 0, nextOffset = null;
      for (let offset = start; ; offset += 50) {
        const page = (await delegations.admin(sessionToken, { product: source.product, operation: source.operation, limit: 50, offset })).data;
        read += page.items.length;
        if (page.items.length) {
          const result = await staff(sessionToken, 'select hub.import_communications($1,$2::jsonb) as result', [input.source, JSON.stringify(page.items.map(item => source.item(item)))]);
          created += result.created; skipped += result.skipped;
        }
        if (offset + 50 >= page.total || page.items.length < 50 || offset + 50 > maxImportOffset) break;
        // Each request stays bounded; the administrator resumes from nextOffset.
        if (offset + 50 >= start + 200) { nextOffset = offset + 50; break; }
      }
      return { source: input.source, read, created, skipped, nextOffset };
    },
  };
}
