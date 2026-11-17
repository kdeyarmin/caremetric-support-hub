import { HttpError, digest, transaction, withSession } from './sms-auth.mjs';
import { live } from './live.mjs';
import { renderEmail } from './email-layout.mjs';
import { validGrowthFromName } from './growth/sender.mjs';

/* Bulk email from the platform administrator to the users of each application,
   narrowed by role and account status. Audiences are read from each
   application's users.list through the administrator's own session; delivery
   runs on the Hub server through SendGrid, one message per address, each with a
   one-click unsubscribe link. The database decides who may do what and records
   every outcome; this module only moves pages and messages. */

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const emailAddress = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const reviewedErrors = { '22023': 400, P0001: 409, '40001': 409, '42501': 403, '28000': 401 };
const actions = new Set(['list', 'get', 'create', 'load', 'save', 'test', 'send', 'cancel']);
export const bulkEmailActions = actions;
// Each load request reads at most this many pages of 50 users; the page resumes until every directory is read.
const pagesPerRequest = 10;
const batchSize = 25, concurrency = 5, tickBudgetMs = 45000;

function reviewed(error) {
  if (error instanceof HttpError) return error;
  const status = reviewedErrors[error?.code];
  return status ? new HttpError(status, error.message) : error;
}

const unsubscribeLabel = 'Unsubscribe from CareMetric announcements';
/** The applications as a reader would list them: "A", "A or B", "A, B or C". The database
    joins each recipient's application names with ", " (product names hold no comma). */
export function applicationList(applications) {
  const names = String(applications ?? '').split(', ').map(name => name.trim()).filter(Boolean);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}
/** Why they received it, how to stop and the mailing address. The unsubscribe line is a link wherever the layout can link it (https). */
function footerLines({ applications, unsubscribeUrl, postalAddress }) {
  return [
    applicationList(applications)
      ? `You are receiving this email because you have an account in ${applicationList(applications)}.`
      : 'You are receiving this email because you have a CareMetric account.',
    !unsubscribeUrl ? 'Unsubscribe link: included in each real message.'
      : /^https:\/\//i.test(unsubscribeUrl) ? { label: unsubscribeLabel, url: unsubscribeUrl } : `${unsubscribeLabel}: ${unsubscribeUrl}`,
    ...(postalAddress ? [postalAddress] : []),
  ];
}
const announcementText = body => body.replace(/\r\n/g, '\n').trimEnd();

/** The plain-text message every recipient receives: the administrator's text, then why they received it and how to stop. */
export function composeBulkEmail({ body, applications, unsubscribeUrl, postalAddress }) {
  const footer = ['--', ...footerLines({ applications, unsubscribeUrl, postalAddress }).map(line => (typeof line === 'string' ? line : `${line.label}: ${line.url}`))];
  return `${announcementText(body)}\n\n${footer.join('\n')}\n`;
}

/** The same message as HTML in the shared CareMetric email layout: the administrator's words exactly as written (personal layout, no product header), then the same footer. */
export function bulkEmailHtml({ subject, body, applications, unsubscribeUrl, postalAddress }) {
  return renderEmail({
    layout: 'personal', title: subject, signature: [],
    blocks: [{ type: 'message', text: announcementText(body) }],
    footer: footerLines({ applications, unsubscribeUrl, postalAddress }),
  }).html;
}

/**
 * SendGrid Mail Send for bulk email: one recipient per request, text then HTML, one-click unsubscribe headers, no tracking. The
 * Account Manager's customer emails use the same sender under their own SendGrid category.
 */
export function sendgridBulkMail({ apiKey, from = 'support@caremetric.ai', fromName = 'CareMetric', fromNameLocked = false, replyTo = from, category = 'hub-bulk-email', fetchImpl = fetch }) {
  // The sender, its display name and Reply-To are Hub settings (Settings → Email); each may be a function, read on each send.
  const sender = () => ({ from: String(live(from) ?? ''), fromName: String(live(fromName) ?? ''), replyTo: String(live(replyTo) ?? '') });
  return {
    get configured() { const now = sender(); return typeof apiKey === 'string' && apiKey.startsWith('SG.') && emailAddress.test(now.from) && emailAddress.test(now.replyTo) && /^[a-z0-9-]{1,40}$/.test(category); },
    // `messageFromName`: one message's own display name (a founder-signed growth email), used unless the owner saved a display name
    // (`fromNameLocked`) or it is not one a mail service accepts.
    async send({ to, subject, text, html, unsubscribeUrl, messageId, fromName: messageFromName = null }) {
      const { from, fromName: senderName, replyTo } = sender();
      const fromName = messageFromName && live(fromNameLocked) !== true && validGrowthFromName(messageFromName) ? messageFromName.trim() : senderName;
      const personalization = { to: [{ email: to }], ...(unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}) };
      let response;
      try {
        response = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            personalizations: [personalization], ...(messageId ? { custom_args: { growth_message_id: messageId } } : {}), from: { email: from, name: fromName }, reply_to: { email: replyTo }, subject,
            content: [{ type: 'text/plain', value: text }, ...(html ? [{ type: 'text/html', value: html }] : [])], categories: [category],
            tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false } },
          }),
        });
      } catch { return { delivery: 'unknown', id: null }; }
      if (response.status >= 400 && response.status < 500) return { delivery: 'failed', id: null };
      if (response.status !== 202) return { delivery: 'unknown', id: null };
      const id = response.headers.get('x-message-id');
      return { delivery: 'sent', id: id && /^[A-Za-z0-9._-]{1,200}$/.test(id) ? id : null };
    },
  };
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function page(title, message, form) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title>
<style>body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f8fb;color:#172b3a}main{max-width:32rem;margin:12vh auto;padding:2rem;background:#fff;border:1px solid #d9e2ed;border-radius:14px}h1{font-size:1.4rem;margin:0 0 .75rem}button{font:inherit;font-weight:600;padding:.7rem 1.2rem;border:0;border-radius:8px;background:#264491;color:#fff;cursor:pointer}@media(max-width:560px){main{margin:1rem;padding:1.25rem}}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p>${form ? '<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>' : ''}</main></body></html>`;
}

export function bulkEmail({ pool, delegations, mail, publicOrigin, postalAddress = '' }) {
  // The footer's postal address is a Hub setting (Settings → Email); it may be a function, read on each message.
  const postal = () => String(live(postalAddress) ?? '').trim();
  const admin = (sessionToken, sql, values = []) => withSession(pool, sessionToken, async db => (await db.query(sql, values)).rows[0].result).catch(error => { throw reviewed(error); });
  const server = (sql, values) => transaction(pool, async db => (await db.query(sql, values)).rows[0].result).catch(error => { throw reviewed(error); });
  const only = (input, keys) => { if (!input || Object.keys(input).some(key => !keys.includes(key))) throw new HttpError(400, 'Unsupported request.'); };
  const id = value => { if (typeof value !== 'string' || !uuid.test(value)) throw new HttpError(400, 'Choose an email.'); return value; };
  const version = value => { if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, 'Refresh the email and try again.'); return value; };
  const requireMail = () => { if (!mail?.configured) throw new HttpError(503, 'Email sending is not configured. Set up the email service in Settings → Email (its key stays in Railway).'); };
  // CAN-SPAM: every bulk email carries the sender's postal address. Settings says bulk email is not sent without it, so it is not.
  const requirePostal = () => { if (!postal()) throw new HttpError(503, 'Add the mailing address first: Settings → Email → Mailing address in email footers. Every bulk email must carry it.'); };
  const unsubscribeUrl = token => `${publicOrigin}/api/email/unsubscribe/${token}`;
  let sending = null;

  async function deliver(item) {
    const url = unsubscribeUrl(item.token);
    const message = { subject: item.subject, body: item.body, applications: item.applications, unsubscribeUrl: url, postalAddress: postal() };
    const outcome = await mail.send({ to: item.to, subject: item.subject, text: composeBulkEmail(message), html: bulkEmailHtml(message), unsubscribeUrl: url });
    await server('select private.finish_email_delivery($1,$2,$3) as result', [item.id, outcome.delivery, outcome.id]);
  }

  const service = {
    async list(sessionToken, input) { only(input, []); return admin(sessionToken, 'select hub.list_email_campaigns() as result'); },
    async get(sessionToken, input) { only(input, ['id']); return admin(sessionToken, 'select hub.get_email_campaign($1) as result', [id(input.id)]); },
    async create(sessionToken, input) {
      only(input, ['productIds']);
      if (!Array.isArray(input.productIds) || !input.productIds.length || input.productIds.length > 6 || input.productIds.some(value => typeof value !== 'string' || !uuid.test(value))) throw new HttpError(400, 'Choose at least one application.');
      return admin(sessionToken, 'select hub.create_email_campaign($1::uuid[]) as result', [input.productIds]);
    },
    /** Reads up to ten directory pages and records them; call again until the campaign is no longer loading. */
    async load(sessionToken, input) {
      only(input, ['id']);
      const campaign = id(input.id);
      for (let pages = 0; pages < pagesPerRequest; pages++) {
        const next = await admin(sessionToken, 'select hub.next_email_audience_page($1) as result', [campaign]);
        if (!next) break;
        const result = (await delegations.admin(sessionToken, { product: next.directory, operation: 'users.list', limit: 50, offset: next.offset })).data;
        const items = result.items.map(user => ({ id: user.id, email: user.email, role: user.role, status: user.status }));
        const added = await admin(sessionToken, 'select hub.add_email_audience_page($1,$2,$3,$4,$5::jsonb) as result', [campaign, next.productId, next.offset, result.total, JSON.stringify(items)]);
        if (added.loaded) break;
      }
      return admin(sessionToken, 'select hub.get_email_campaign($1) as result', [campaign]);
    },
    async save(sessionToken, input) {
      only(input, ['id', 'subject', 'body', 'selection', 'version']);
      if (typeof input.subject !== 'string' || typeof input.body !== 'string' || !input.selection || typeof input.selection !== 'object' || Array.isArray(input.selection)) throw new HttpError(400, 'Write the email and choose its audience.');
      return admin(sessionToken, 'select hub.save_email_campaign($1,$2,$3,$4::jsonb,$5) as result', [id(input.id), input.subject, input.body, JSON.stringify(input.selection), version(input.version)]);
    },
    /** Sends the saved message once to the address the administrator typed. No recipient is recorded. */
    async test(sessionToken, input) {
      only(input, ['id', 'to']);
      requireMail();
      const to = typeof input.to === 'string' ? input.to.trim() : '';
      if (!emailAddress.test(to) || to.length > 320) throw new HttpError(400, 'Enter the email address for the test.');
      const message = await admin(sessionToken, 'select hub.authorize_email_test($1) as result', [id(input.id)]);
      const test = { subject: `[Test] ${message.subject}`, body: message.body, applications: message.applications, unsubscribeUrl: null, postalAddress: postal() };
      const outcome = await mail.send({ to, subject: test.subject, text: composeBulkEmail(test), html: bulkEmailHtml(test), unsubscribeUrl: null });
      return { delivery: outcome.delivery };
    },
    async send(sessionToken, input) {
      only(input, ['id', 'version', 'recipients']);
      requireMail();
      requirePostal();
      if (!Number.isSafeInteger(input.recipients) || input.recipients < 1) throw new HttpError(400, 'Review the recipient count before sending.');
      const result = await admin(sessionToken, 'select hub.queue_email_campaign($1,$2,$3) as result', [id(input.id), version(input.version), input.recipients]);
      // Start delivering now; the timer retries anything this misses.
      service.tick().catch(() => console.warn('Bulk email delivery could not complete; it will retry.'));
      return result;
    },
    async cancel(sessionToken, input) { only(input, ['id']); return admin(sessionToken, 'select hub.cancel_email_campaign($1) as result', [id(input.id)]); },
    /** Housekeeping, then delivery of queued messages for up to 45 seconds, five at a time. Runs on a timer and right after a send is queued. */
    tick() {
      sending ??= (async () => {
        const deadline = Date.now() + tickBudgetMs;
        try {
          await server('select private.email_housekeeping() as result', []);
          // Nothing is claimed while the mailing address is blank: queued messages wait for it, and housekeeping still runs.
          while (mail?.configured && postal() && Date.now() < deadline) {
            const batch = await server('select private.claim_email_batch($1) as result', [batchSize]);
            if (!batch.length) break;
            const queue = [...batch];
            await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => { for (let item = queue.shift(); item; item = queue.shift()) await deliver(item); }));
          }
        } finally { sending = null; }
      })();
      return sending;
    },
    /**
     * The unsubscribe page, for bulk announcements and for the Account Manager's check-in emails alike: one suppression list stops
     * both, and the page says so. GET only shows it; POST (the button, or a mail client's one-click request) confirms.
     */
    async unsubscribePage(token, confirm) {
      const result = await server('select private.email_unsubscribe($1,$2) as result', [digest(token), confirm]);
      if (!result.valid) return page('Link not recognized', 'This unsubscribe link is not valid. If you keep receiving CareMetric emails you did not ask for, reply to one and ask us to stop.', false);
      if (result.unsubscribed) return page('You are unsubscribed', 'You will no longer receive announcements or check-in emails from CareMetric. Messages about your own support requests, and receipts and billing notices, are not affected.', false);
      return page(result.purpose === 'lifecycle' ? 'Unsubscribe from CareMetric check-in emails' : 'Unsubscribe from CareMetric announcements',
        'Select Unsubscribe to stop receiving announcements and check-in emails from CareMetric.', true);
    },
  };
  return service;
}
