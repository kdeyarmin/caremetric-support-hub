/**
 * Sends an approved reply. It is the only thing the Concierge's `communication.reply` action does, and it
 * does it the way the owner would: through the inbox's own reply (`communications.reply`), which authorizes
 * the owner's live session, records the message before sending it and never sends the same request key twice.
 * It therefore needs that session, so it is a session executor: it runs straight after the owner approves, or
 * when they press "Run what's waiting".
 *
 * It refuses, before anything is recorded, to send into a conversation that moved on since the reply was
 * proposed (the customer wrote again, or the conversation was closed): the owner would be answering a
 * message the reply was never written for. It also refuses a reply nobody approved. That judgement is for a
 * NEW message only: when the reply was already recorded under this action's key (a restart came after it was
 * sent), the replay settles that delivery whatever the thread has done since, instead of reporting a sent
 * reply as never sent.
 *
 * The email carries a fixed subject, never the customer's: a message that named a person or carried an
 * identifier in its subject would otherwise have it echoed back by an automated reply.
 *
 * Every failure is coded, never retried and never recorded as sent. A send the provider did not confirm, a
 * replay of one that was recorded but whose delivery was never settled, and a send the provider answered whose
 * delivery could not be recorded also warn the owner to look at the thread before sending again, because the
 * customer may or may not have received it. A session that lapsed before anything was sent is `session_required`.
 */
import { sessionExecutor } from '../actions.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What every Concierge email is titled: the subject line becomes "Re: <this> [CM-n]". It is never taken from the conversation. */
export const replySubject = 'Your message to CareMetric support';
const failure = code => Object.assign(new Error('The reply could not be sent.'), { code });
const httpCode = { 400: 'invalid_reply', 401: 'session_required', 403: 'not_permitted', 409: 'reply_refused' };

export function replyExecutor({ communications, store, notifier, log = line => console.warn(line) }) {
  async function warn(execution, reference) {
    try {
      await notifier.send({
        severity: 'warning', subject: `Check CM-${reference} before sending again`,
        body: `A reply to CM-${reference} may or may not have reached the customer: the provider did not confirm it.\n\nOpen the conversation in Communications and look at the thread before you send anything else.`,
        dedupeKey: `concierge:reply-check:${execution.id}`, agentKey: execution.agentKey, taskId: execution.taskId,
      });
    } catch {
      log(JSON.stringify({ event: 'hub_agent_reply_warning_unsent', action_id: execution.id }));
    }
  }

  return sessionExecutor(async (execution, { sessionToken = null } = {}) => {
    if (execution.autoApproved) throw failure('auto_approved_refused');
    if (!sessionToken) throw failure('session_required');
    const input = execution.input ?? {};
    if (!uuid.test(input.communicationId ?? '') || !uuid.test(input.basedOnMessageId ?? '') || typeof input.body !== 'string' || input.body.length === 0 || input.body.length > 5000) throw failure('invalid_reply');
    const reference = Number.isSafeInteger(input.reference) ? input.reference : 0;

    // The head asked about ignores the reply sent under this action's own key, so a replay after a crash still matches.
    const snapshot = await store.communicationSnapshot({ id: input.communicationId, requestKey: execution.requestKey, messages: 0, chars: 100 });
    if (!snapshot) throw failure('conversation_missing');
    // A reply already recorded under this key is settled by the replay below, not judged: it was written for the thread as it was.
    // (A database from before the field reports nothing and gets the guards for every execution, as it always did.)
    const recorded = typeof snapshot.ownReplyDelivery === 'string';
    if (!recorded) {
      if (snapshot.status === 'closed') throw failure('conversation_closed');
      if (snapshot.headMessageId !== input.basedOnMessageId) throw failure('thread_changed');
    }

    let outcome;
    try {
      outcome = await communications.reply(sessionToken, { id: input.communicationId, body: input.body, requestKey: execution.requestKey }, { subject: replySubject });
    } catch (error) {
      if (error?.code === 'delivery_unsettled') {
        // The provider answered but the record was not settled: the customer may have the reply, so this is not a plain failure.
        await warn(execution, reference);
        throw failure('delivery_unconfirmed');
      }
      const code = httpCode[error?.status];
      throw code ? failure(code) : error;
    }
    if (outcome?.delivery === 'sent') return { delivery: 'sent', channel: outcome.deliveryChannel ?? null, replay: Boolean(outcome.replay) };
    if (outcome?.delivery === 'failed') throw failure('delivery_failed');
    // Unknown: the provider did not say. Pending on a replay: recorded, but a restart came before the send was settled.
    await warn(execution, reference);
    throw failure(outcome?.delivery === 'unknown' ? 'delivery_unknown' : 'delivery_unconfirmed');
  });
}
