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

/**
 * The owner email for a notification: a callout for anything that needs attention, then the body.
 * A caller that wants richer layout (the morning brief) passes its own `blocks`; the body is still
 * what is stored, shown on the Team screen and used for the preview.
 */
export function renderOwnerEmail({ subject, body, severity = 'info', publicOrigin, blocks: custom = null }) {
  const [first = '', ...rest] = paragraphs(body);
  const tone = tones[severity];
  const link = /^https:\/\//i.test(publicOrigin ?? '') ? { label: 'Open the AI team', url: `${publicOrigin.replace(/\/+$/, '')}/admin/team` } : null;
  return renderEmail({
    layout: 'branded',
    title: subject,
    preheader: clip(first || subject, 110),
    heading: subject,
    blocks: custom ?? [
      tone ? { type: 'callout', tone, title: severity === 'urgent' ? 'Needs your attention' : 'Worth a look', text: first } : { type: 'paragraph', text: first },
      ...rest.map(text => ({ type: 'paragraph', text })),
    ].filter(block => block.text),
    signature,
    footer: ['You are receiving this because you own this CareMetric Support Hub.', ...(link ? [link] : [])],
  });
}

/** True when the owner has the message: it was sent now, or an earlier attempt under the same key was sent. */
export const delivered = item => item.delivery === 'sent' || (item.delivery === 'duplicate' && item.original === 'sent');

export function ownerNotifier({ store, sms, email, ownerEmail, publicOrigin, log = line => console.warn(line) }) {
  const channelsFor = severity => (severity === 'urgent' ? ['sms', 'email'] : ['email']);

  async function transport(channel, { subject, body, severity, blocks }) {
    if (channel === 'sms') {
      // Looking up where to text the owner happens before anything is sent. If that fails, nothing went out: that is a definite failure,
      // which a retry can put right, not an unknown outcome (which is never retried because the message may have gone).
      let contact;
      try { contact = await store.ownerContact(); } catch { return { delivery: 'failed', id: null }; }
      if (!sms?.configured || !contact?.phone) return { delivery: 'suppressed', id: null };
      return sms.send(contact.phone, clip(`CareMetric: ${subject}. ${paragraphs(body)[0] ?? ''}`, smsLimit));
    }
    if (!email?.configured || !emailAddress.test(ownerEmail ?? '')) return { delivery: 'suppressed', id: null };
    const { html, text } = renderOwnerEmail({ subject, body, severity, publicOrigin, blocks });
    return email.send(ownerEmail, subject, { text, html });
  }

  async function deliver(channel, input) {
    const begun = await store.notifyBegin({ ...input, channel });
    // A duplicate says what became of the original: a handler that is run again must not take "already recorded" for "already sent".
    if (begun.duplicate) return { channel, delivery: 'duplicate', original: begun.status ?? null };
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
    /** Returns one { channel, delivery } per channel; delivery is sent, failed, unknown, suppressed or duplicate (with `original`, the status of the earlier attempt). */
    async send({ severity = 'info', subject, body, dedupeKey, agentKey = null, taskId = null, blocks = null }) {
      if (!severities.has(severity)) throw new TypeError('Unsupported notification severity.');
      if (!subject || !body || !dedupeKey) throw new TypeError('A notification needs a subject, a body and a dedupe key.');
      if (blocks !== null && (!Array.isArray(blocks) || blocks.length === 0)) throw new TypeError('Email blocks must be a non-empty list.');
      const input = { severity, subject: clip(subject, 200), body: clip(body, 4000), dedupeKey, agentKey, taskId, blocks };
      const results = [];
      for (const channel of channelsFor(severity)) results.push(await deliver(channel, input));
      return results;
    },
  };
}
