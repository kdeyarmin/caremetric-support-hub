/**
 * Sends a support answer: a reply the Concierge drafted from the owner's published guides, citing them, for a message in which no
 * identifier was found (the database admits nothing else as `communication.answer`). Unlike a plain reply it needs no owner session:
 * the owner approves it during the supervised week, and once they hand support answers over it is approved automatically. The inbox
 * records it as written by the CareMetric AI Assistant before sending, checks again that it may go (the Concierge is still trusted
 * with answers, the conversation is open, the customer has not written again) and delivers it like any staff reply.
 *
 * Every failure is coded and never retried. A send the provider did not confirm, or one recorded but never settled, also warns the
 * owner to look at the thread before anything else is sent.
 */
import { replySubject } from './executor.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure = code => Object.assign(new Error('The answer could not be sent.'), { code });
const refusals = new Set(['answers_off', 'conversation_closed', 'conversation_missing', 'thread_changed', 'reply_refused']);

export function answerExecutor({ communications, notifier, log = line => console.warn(line) }) {
  async function warn(execution, reference) {
    try {
      await notifier.send({
        severity: 'warning', subject: `Check CM-${reference} before sending again`,
        body: `An answer to CM-${reference} may or may not have reached the customer: the provider did not confirm it.\n\nOpen the conversation in Communications and look at the thread before you send anything else.`,
        dedupeKey: `concierge:answer-check:${execution.id}`, agentKey: execution.agentKey, taskId: execution.taskId,
      });
    } catch {
      log(JSON.stringify({ event: 'hub_agent_answer_warning_unsent', action_id: execution.id }));
    }
  }

  return async execution => {
    const input = execution.input ?? {};
    if (!uuid.test(input.communicationId ?? '') || !uuid.test(input.basedOnMessageId ?? '') || typeof input.body !== 'string' || input.body.length === 0 || input.body.length > 5000) throw failure('invalid_reply');
    const reference = Number.isSafeInteger(input.reference) ? input.reference : 0;
    let outcome;
    try {
      outcome = await communications.answer({ actionId: execution.id, execution: execution.execution ?? null, subject: replySubject });
    } catch (error) {
      if (error?.code === 'delivery_unsettled') { await warn(execution, reference); throw failure('delivery_unconfirmed'); }
      throw error;
    }
    if (outcome?.refused) throw failure(refusals.has(outcome.refused) ? outcome.refused : 'reply_refused');
    if (outcome?.delivery === 'sent') return { delivery: 'sent', channel: outcome.deliveryChannel ?? null, replay: Boolean(outcome.replay), author: 'ai_assistant' };
    if (outcome?.delivery === 'failed') throw failure('delivery_failed');
    // Unknown: the provider did not say. Pending on a replay: recorded, but a restart came before the send was settled.
    await warn(execution, reference);
    throw failure(outcome?.delivery === 'unknown' ? 'delivery_unknown' : 'delivery_unconfirmed');
  };
}
