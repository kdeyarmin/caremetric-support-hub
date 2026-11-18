import { renderEmail } from '../email-layout.mjs';
import { live } from '../live.mjs';

/**
 * Messages from the AI team to the owner. Each one is recorded in the database before it is
 * sent, under a dedupe key, so a retried task never texts or emails twice; the outcome is
 * recorded after. Urgent items go by text and email, everything else by email. A channel
 * that is not configured, or has nobody to send to, is recorded as suppressed rather than
 * failing the task that raised the alert.
 *
 * Every message says how much of the owner's attention it asks for (owner decision 2026-11-18: "I only want emails when something
 * needs my decision or for me to do something", with one summary at the end of the day):
 * - `now`: something only the owner can fix, or a person (a customer, a prospect) waiting on the owner. Always sent at once.
 * - `decision`: a routine batch waiting for approval (the week's posts, new creative, ad changes, prospect emails).
 * - `update`: news and reports: nothing to do.
 * While Settings → AI team → "One end-of-day summary" is on, `update` messages (and `decision` messages too, unless "Email approval
 * requests right away" is on) are not emailed one at a time: each is recorded as held (`hold`, below) and the Chief of Staff's
 * end-of-day summary (tasks/summary.mjs) lists them. An urgent message is never held. A held message counts as delivered: the task
 * that raised it is done, and it is not tried again.
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
export function renderOwnerEmail({ subject, body, severity = 'info', publicOrigin, blocks: custom = null, communicationReference = null }) {
  const [first = '', ...rest] = paragraphs(body);
  const tone = tones[severity];
  const link = /^https:\/\//i.test(publicOrigin ?? '') ? { label: 'Open the AI team', url: `${publicOrigin.replace(/\/+$/, '')}/admin/team` } : null;
  const referenceLink = link && /^[1-9]\d*$/.test(String(communicationReference)) ? {
    label: `CM-${communicationReference}`,
    url: `${publicOrigin.replace(/\/+$/, '')}/communications?status=all&search=CM-${communicationReference}`,
  } : null;
  return renderEmail({
    layout: 'branded',
    title: subject,
    preheader: clip(first || subject, 110),
    heading: subject,
    referenceLink,
    blocks: [...(custom ?? [
      tone ? { type: 'callout', tone, title: severity === 'urgent' ? 'Needs your attention' : 'Worth a look', text: first } : { type: 'paragraph', text: first },
      ...rest.map(text => ({ type: 'paragraph', text })),
    ].filter(block => block.text)),
    ...(referenceLink ? [{
      type: 'button',
      label: `Open CM-${communicationReference} in Communications`,
      url: referenceLink.url,
    }] : [])],
    signature,
    footer: ['You are receiving this because you own this CareMetric Support Hub.', ...(link ? [link] : [])],
  });
}

/** True when the owner has the message, or will in the end-of-day summary: it was sent or held now, or an earlier attempt under the same key was. */
export const delivered = item => item.delivery === 'sent' || item.delivery === 'held' || (item.delivery === 'duplicate' && (item.original === 'sent' || item.original === 'held'));

const attentions = new Set(['now', 'decision', 'update']);
/** A message that does not say: a warning is something to look at now, anything else is news. */
const attentionFor = (severity, attention) => (severity === 'urgent' ? 'now' : attentions.has(attention) ? attention : severity === 'warning' ? 'now' : 'update');

/**
 * `hold(attention)` says whether a message of that attention waits for the end-of-day summary instead of being emailed now; it is read
 * for each message (the owner's settings apply within a minute). Without it, or when the store cannot record a held message (the
 * database does not declare the summary yet), every message is sent as before.
 */
export function ownerNotifier({ store, sms, email, ownerEmail, publicOrigin, hold = null, log = line => console.warn(line) }) {
  const channelsFor = severity => (severity === 'urgent' ? ['sms', 'email'] : ['email']);
  const held = attention => {
    if (attention === 'now' || typeof hold !== 'function' || typeof store?.notifyHold !== 'function') return false;
    try { return hold(attention) === true; } catch { return false; }
  };

  async function transport(channel, { subject, body, severity, blocks, communicationReference }) {
    if (channel === 'sms') {
      // Looking up where to text the owner happens before anything is sent. If that fails, nothing went out: that is a definite failure,
      // which a retry can put right, not an unknown outcome (which is never retried because the message may have gone).
      let contact;
      try { contact = await store.ownerContact(); } catch { return { delivery: 'failed', id: null }; }
      if (!sms?.configured || !contact?.phone) return { delivery: 'suppressed', id: null };
      return sms.send(contact.phone, clip(`CareMetric: ${subject}. ${paragraphs(body)[0] ?? ''}`, smsLimit));
    }
    // The owner's address is a Hub setting (Settings → AI team) and may be a function, read on each alert.
    const to = live(ownerEmail);
    if (!email?.configured || !emailAddress.test(to ?? '')) return { delivery: 'suppressed', id: null };
    const { html, text } = renderOwnerEmail({ subject, body, severity, publicOrigin, blocks, communicationReference });
    return email.send(to, subject, { text, html });
  }

  async function deliver(channel, input) {
    const begun = await store.notifyBegin({ ...input, channel });
    // A duplicate says what became of the original: a handler that is run again must not take "already recorded" for "already sent".
    if (begun.duplicate) return { channel, delivery: 'duplicate', original: begun.status ?? null };
    // Held for the end-of-day summary: recorded, not sent. A failure to record it leaves the row pending, which housekeeping settles as
    // unknown, so the task does not try again and send it twice; nothing went out.
    if (input.hold) {
      try {
        await store.notifyHold(begun.id, input.attention);
        return { channel, delivery: 'held' };
      } catch {
        log(JSON.stringify({ event: 'hub_agent_notification_unheld', channel }));
        return { channel, delivery: 'unknown' };
      }
    }
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
    /**
     * Returns one { channel, delivery } per channel; delivery is sent, held (for the end-of-day summary), failed, unknown, suppressed or
     * duplicate (with `original`, the status of the earlier attempt). `attention` is now, decision or update (see above).
     */
    async send({ severity = 'info', subject, body, dedupeKey, agentKey = null, taskId = null, blocks = null, communicationReference = null, attention = null }) {
      if (!severities.has(severity)) throw new TypeError('Unsupported notification severity.');
      if (!subject || !body || !dedupeKey) throw new TypeError('A notification needs a subject, a body and a dedupe key.');
      if (blocks !== null && (!Array.isArray(blocks) || blocks.length === 0)) throw new TypeError('Email blocks must be a non-empty list.');
      if (attention !== null && !attentions.has(attention)) throw new TypeError('Unsupported notification attention.');
      const level = attentionFor(severity, attention);
      const input = { severity, subject: clip(subject, 200), body: clip(body, 4000), dedupeKey, agentKey, taskId, blocks, communicationReference, attention: level, hold: held(level) };
      const results = [];
      for (const channel of channelsFor(severity)) results.push(await deliver(channel, input));
      return results;
    },
  };
}
