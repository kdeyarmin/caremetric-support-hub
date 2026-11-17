/**
 * `concierge.sweep`, every five minutes: find the conversations whose newest inbound message has
 * settled and nobody has answered, and give each message its own task (`concierge.communication`).
 * The sweep itself looks at no message text and calls no model. Each task's request key is the
 * message's id, so a message is triaged once however often the sweep sees it, and a customer's
 * next message gets a task of its own.
 */
import { conciergeSettings } from './settings.mjs';

const batch = 10;

export function sweepHandler({ store, alertTexts = false }) {
  return async function sweep(task, { signal } = {}) {
    const settings = conciergeSettings(task.agent?.config);
    const pending = await store.conciergePending({
      // An inbound text is alerted even while texts are not triaged (platform.agents.support-truth.v1): nothing is sent back for it.
      limit: batch, settleSeconds: settings.settleSeconds, windowHours: settings.windowHours,
      channels: alertTexts && !settings.channels.includes('sms') ? [...settings.channels, 'sms'] : settings.channels,
    });
    let enqueued = 0;
    for (const item of pending) {
      if (signal?.aborted) throw Object.assign(new Error('The sweep was stopped.'), { code: 'task_timeout', transient: true });
      const id = await store.enqueue(task.agentKey, 'concierge.communication', `concierge:${item.messageId}`, {
        payload: { communicationId: item.id, messageId: item.messageId }, priority: 5, sourceKind: 'communication', sourceRef: `CM-${item.reference}`,
      });
      if (id) enqueued += 1;
    }
    return { result: { pending: pending.length, enqueued } };
  };
}
