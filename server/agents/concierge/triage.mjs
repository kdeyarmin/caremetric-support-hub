/**
 * `concierge.communication`: one task per inbound message. It reads a minimal view of the
 * conversation (never contact details or internal notes), screens the message for personal
 * identifiers, categorizes it by word matching, and tells the owner: by text and email when it
 * looks urgent, by email otherwise. It calls no model and keeps no message text: the alert, the
 * run summary and the task result carry kinds, the channel, the product, the reference number and
 * how long ago the message arrived.
 *
 * Alerts are capped so that anyone who can write to the support address cannot flood the owner:
 * at most 20 individual emails a day for each level (after that, one rollup email for the day) and
 * at most three urgent texts an hour (after that, urgent alerts go by email only).
 */
import { minutesBetween, permanent, recordRun } from '../tasks/shared.mjs';
import { alertWords, categoryWord, channelWord, decide } from './policy.mjs';
import { categorize } from './rules.mjs';
import { screenIdentifiers } from './screen.mjs';
import { conciergeSettings } from './settings.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dailyEmailCap = 20;
const hourlyTextCap = 3;
const easternDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

function skipReason(snapshot, payload, settings) {
  if (!snapshot) return 'not_found';
  if (snapshot.status === 'closed') return 'closed';
  // A newer message arrived: it gets its own task once it has settled.
  if (snapshot.latestInboundId !== payload.messageId) return 'superseded';
  if (snapshot.answered) return 'answered';
  if (!settings.channels.includes(snapshot.channel)) return 'channel_off';
  return null;
}

export function triageHandler({ store, notifier, log = line => console.warn(line) }) {
  async function sendAlert({ task, snapshot, payload, words, severity, now }) {
    const day = easternDate.format(now());
    const dayStart = task.budget?.dayStart ? new Date(task.budget.dayStart) : new Date(now().getTime() - 24 * 3_600_000);
    const base = { subject: words.subject, body: words.body, agentKey: task.agentKey, taskId: task.id };
    const rollup = level => notifier.send({
      severity: 'warning', subject: 'Many new messages today',
      body: `More than ${dailyEmailCap} ${{ urgent: 'urgent', warning: 'flagged', info: 'new' }[level]} messages have reached the Hub today, so they are no longer emailed one at a time.\n\nOpen Communications to see all of them.`,
      dedupeKey: `concierge:rollup:${level}:${day}`, agentKey: task.agentKey, taskId: task.id,
    });
    if (severity === 'urgent') {
      const [texts, emails] = await Promise.all([
        store.notificationCount({ prefix: 'concierge:urgent:', channel: 'sms', since: new Date(now().getTime() - 3_600_000) }),
        store.notificationCount({ prefix: 'concierge:urgent:', channel: 'email', since: dayStart }),
      ]);
      if (emails >= dailyEmailCap) return rollup('urgent');
      // Past the hourly limit on texts, an urgent alert still goes by email.
      return notifier.send({ ...base, severity: texts >= hourlyTextCap ? 'warning' : 'urgent', dedupeKey: `concierge:urgent:${snapshot.id}:${day}` });
    }
    const prefix = severity === 'warning' ? 'concierge:warn:' : 'concierge:new:';
    if (await store.notificationCount({ prefix, channel: 'email', since: dayStart }) >= dailyEmailCap) return rollup(severity);
    return notifier.send({ ...base, severity, dedupeKey: `${prefix}${payload.messageId}` });
  }

  async function communication(task, { now = () => new Date() } = {}) {
    const payload = task.payload ?? {};
    if (!uuid.test(payload.communicationId ?? '') || !uuid.test(payload.messageId ?? '')) throw permanent('invalid_payload');
    const settings = conciergeSettings(task.agent?.config);
    const snapshot = await store.communicationSnapshot({ id: payload.communicationId, messages: 1, chars: 4000 });
    const skip = skipReason(snapshot, payload, settings);
    if (skip) return { result: { outcome: 'skipped', reason: skip, reference: snapshot?.reference ?? null } };
    const inbound = (snapshot.messages ?? []).find(message => message.id === snapshot.latestInboundId);
    if (!inbound) return { result: { outcome: 'skipped', reason: 'no_message', reference: snapshot.reference } };

    // Both checks read the original text; neither keeps any of it.
    const screen = screenIdentifiers(`${snapshot.subject ?? ''}\n${inbound.body}`);
    const { category, reasons } = categorize({ text: inbound.body, subject: snapshot.subject });
    const { severity } = decide({ category, phi: screen.flagged });
    if (severity === null) return { result: { outcome: 'skipped', reason: category, reference: snapshot.reference } };

    const words = alertWords({
      category, phi: screen.flagged, severity, channel: snapshot.channel, productSlug: snapshot.productSlug, reference: snapshot.reference,
      minutes: minutesBetween(inbound.at, now()),
    });
    const results = await sendAlert({ task, snapshot, payload, words, severity, now });
    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    await recordRun({ store, log }, task, {
      promptVersion: 'rules.1',
      summary: `Triaged CM-${snapshot.reference} (${channelWord(snapshot.channel)}): ${categoryWord(category)}${screen.flagged ? ', identifiers found' : ''}; ${severity} alert (${delivery.join(', ')}).`,
    });
    return {
      result: {
        outcome: 'alerted', reference: snapshot.reference, channel: snapshot.channel, product: snapshot.productSlug ?? null, category, phi: screen.flagged,
        severity, delivery, screen: screen.kinds, rules: reasons,
      },
    };
  }

  return communication;
}
