import { renderEmail } from '../email-layout.mjs';

/**
 * Messages from the AI team to the owner. Each one is recorded in the database before it is
 * sent, under a dedupe key, so a retried task never texts or emails twice; the outcome is
 * recorded after. Urgent items go by text and email, everything else by email. A channel
 * that is not configured, or has nobody to send to, is recorded as suppressed rather than
 * failing the task that raised the alert.
 *
 * Bodies carry counts, names and references the team produced. They must never quote
 * inbound customer text: that is possible PHI and does not belong in a text or an inbox.
 */
const severities = new Set(['info', 'warning', 'urgent']);
const emailAddress = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const smsLimit = 320;
const tones = { warning: 'warning', urgent: 'danger' };
const signature = ['— Your CareMetric AI team'];

const clip = (value, limit) => {
  const text = String(value ?? '').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
};
const paragraphs = body => String(body).split(/\n{2,}/).map(part => part.trim()).filter(Boolean);

/** The owner email for a notification: a callout for anything that needs attention, then the body. */
export function renderOwnerEmail({ subject, body, severity = 'info', publicOrigin }) {
  const [first = '', ...rest] = paragraphs(body);
  const tone = tones[severity];
  const link = /^https:\/\//i.test(publicOrigin ?? '') ? { label: 'Open the AI team', url: `${publicOrigin.replace(/\/+$/, '')}/admin/team` } : null;
  return renderEmail({
    layout: 'branded',
    title: subject,
    preheader: clip(first || subject, 110),
    heading: subject,
    blocks: [
      tone ? { type: 'callout', tone, title: severity === 'urgent' ? 'Needs your attention' : 'Worth a look', text: first } : { type: 'paragraph', text: first },
      ...rest.map(text => ({ type: 'paragraph', text })),
    ].filter(block => block.text),
    signature,
    footer: ['You are receiving this because you own this CareMetric Support Hub.', ...(link ? [link] : [])],
  });
}

export function ownerNotifier({ store, sms, email, ownerEmail, publicOrigin, log = line => console.warn(line) }) {
  const channelsFor = severity => (severity === 'urgent' ? ['sms', 'email'] : ['email']);

  async function transport(channel, { subject, body, severity }) {
    if (channel === 'sms') {
      const contact = await store.ownerContact();
      if (!sms?.configured || !contact?.phone) return { delivery: 'suppressed', id: null };
      return sms.send(contact.phone, clip(`CareMetric: ${subject}. ${paragraphs(body)[0] ?? ''}`, smsLimit));
    }
    if (!email?.configured || !emailAddress.test(ownerEmail ?? '')) return { delivery: 'suppressed', id: null };
    const { html, text } = renderOwnerEmail({ subject, body, severity, publicOrigin });
    return email.send(ownerEmail, subject, { text, html });
  }

  async function deliver(channel, input) {
    const begun = await store.notifyBegin({ ...input, channel });
    if (begun.duplicate) return { channel, delivery: 'duplicate' };
    let outcome;
    try {
      outcome = await transport(channel, input);
    } catch {
      outcome = { delivery: 'unknown', id: null };
    }
    try {
      await store.notifyFinish(begun.id, outcome.delivery, outcome.id ?? null);
    } catch {
      // The row stays pending and is settled by housekeeping; the send itself already happened.
      log(JSON.stringify({ event: 'hub_agent_notification_unsettled', channel }));
    }
    return { channel, delivery: outcome.delivery };
  }

  return {
    channelsFor,
    /** Returns one { channel, delivery } per channel; delivery is sent, failed, unknown, suppressed or duplicate. */
    async send({ severity = 'info', subject, body, dedupeKey, agentKey = null, taskId = null }) {
      if (!severities.has(severity)) throw new TypeError('Unsupported notification severity.');
      if (!subject || !body || !dedupeKey) throw new TypeError('A notification needs a subject, a body and a dedupe key.');
      const input = { severity, subject: clip(subject, 200), body: clip(body, 4000), dedupeKey, agentKey, taskId };
      const results = [];
      for (const channel of channelsFor(severity)) results.push(await deliver(channel, input));
      return results;
    },
  };
}
