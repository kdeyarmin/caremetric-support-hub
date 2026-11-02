import { describe, expect, it, vi } from 'vitest';
import { replyExecutor, replySubject } from './executor.mjs';
import { HttpError } from '../../sms-auth.mjs';

const ids = { communication: '11111111-1111-4111-8111-111111111111', message: '22222222-2222-4222-8222-222222222222', other: '33333333-3333-4333-8333-333333333333' };
const sessionToken = 'S'.repeat(43);
const body = 'Hello,\n\nThank you for contacting CareMetric Support. We have your message and a member of our team will review it and reply here.';
const execution = (overrides = {}) => ({
  id: 'action-1', agentKey: 'support_concierge', taskId: 'task-1', kind: 'communication.reply', targetKind: 'communication', targetId: 'CM-1042',
  requestKey: '44444444-4444-4444-8444-444444444444', autoApproved: false,
  input: { communicationId: ids.communication, reference: 1042, channel: 'email', route: 'email', basedOnMessageId: ids.message, body, classification: { category: 'general', phi: false }, template: 'standard' },
  ...overrides,
});
const fixture = ({ snapshot = { id: ids.communication, status: 'new', headMessageId: ids.message }, reply = { messageId: 'm1', replay: false, delivery: 'sent', deliveryChannel: 'email' } } = {}) => {
  const logs = [];
  const store = { communicationSnapshot: vi.fn(async () => snapshot) };
  const communications = { reply: vi.fn(async () => reply) };
  const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
  return { store, communications, notifier, logs, executor: replyExecutor({ store, communications, notifier, log: line => logs.push(line) }) };
};
const refusal = async (promise, code) => { await expect(promise).rejects.toMatchObject({ code }); };

describe('sending an approved reply', () => {
  it('is a session executor, so the background drain leaves it alone', () => {
    expect(fixture().executor.requiresSession).toBe(true);
  });

  it('checks the thread, then sends the exact approved text under the action\'s own key, as the owner', async () => {
    const { executor, store, communications } = fixture();
    expect(await executor(execution(), { sessionToken })).toEqual({ delivery: 'sent', channel: 'email', replay: false });
    expect(store.communicationSnapshot).toHaveBeenCalledWith({ id: ids.communication, requestKey: '44444444-4444-4444-8444-444444444444', messages: 0, chars: 100 });
    expect(communications.reply).toHaveBeenCalledWith(sessionToken, { id: ids.communication, body, requestKey: '44444444-4444-4444-8444-444444444444' }, { subject: 'Your message to CareMetric support' });
  });

  it('titles every email with a fixed subject, never the customer\'s, so an identifier in theirs is not echoed back', async () => {
    expect(replySubject).toBe('Your message to CareMetric support');
    const { executor, communications } = fixture({ snapshot: { id: ids.communication, status: 'new', headMessageId: ids.message, subject: 'Roster for Pat Example, SSN 000-12-3456' } });
    await executor(execution(), { sessionToken });
    const [, input, options] = communications.reply.mock.calls[0];
    expect(options).toEqual({ subject: replySubject });
    expect(JSON.stringify([input, options])).not.toMatch(/Pat Example|000-12-3456/);
  });

  it('settles a reply already recorded under its key without judging a thread that has moved on since', async () => {
    for (const delivery of ['sent', 'pending', 'failed', 'unknown']) {
      // The customer wrote again and the conversation was then closed, but the reply had been recorded first.
      const { executor, communications } = fixture({ snapshot: { id: ids.communication, status: 'closed', headMessageId: ids.other, ownReplyDelivery: delivery },
        reply: { messageId: 'm1', replay: true, delivery, deliveryChannel: 'email' } });
      const settled = executor(execution(), { sessionToken });
      if (delivery === 'sent') expect(await settled).toEqual({ delivery: 'sent', channel: 'email', replay: true });
      else await refusal(settled, { failed: 'delivery_failed', pending: 'delivery_unconfirmed', unknown: 'delivery_unknown' }[delivery]);
      expect(communications.reply, delivery).toHaveBeenCalledTimes(1);
    }
  });

  it('still judges the thread for a reply that was never recorded, even when the snapshot has the field', async () => {
    for (const [snapshot, code] of [
      [{ status: 'open', headMessageId: ids.other, ownReplyDelivery: null }, 'thread_changed'], [{ status: 'closed', headMessageId: ids.message, ownReplyDelivery: null }, 'conversation_closed'],
    ]) {
      const { executor, communications } = fixture({ snapshot });
      await refusal(executor(execution(), { sessionToken }), code);
      expect(communications.reply).not.toHaveBeenCalled();
    }
  });

  it('warns the owner, rather than reporting nothing happened, when the provider answered but the delivery could not be recorded', async () => {
    const { executor, communications, notifier } = fixture();
    communications.reply.mockRejectedValue(new HttpError(502, 'The provider answered, but the delivery could not be recorded.', 'delivery_unsettled'));
    await refusal(executor(execution(), { sessionToken }), 'delivery_unconfirmed');
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning', subject: 'Check CM-1042 before sending again', dedupeKey: 'concierge:reply-check:action-1' }));
  });

  it('treats a replay of a reply that was already sent as done, sending nothing new', async () => {
    const { executor } = fixture({ reply: { messageId: 'm1', replay: true, delivery: 'sent', deliveryChannel: 'chat' } });
    expect(await executor(execution(), { sessionToken })).toEqual({ delivery: 'sent', channel: 'chat', replay: true });
  });

  it('refuses a reply nobody approved, and one with no session, before looking at anything', async () => {
    const { executor, store, communications } = fixture();
    await refusal(executor(execution({ autoApproved: true }), { sessionToken }), 'auto_approved_refused');
    await refusal(executor(execution(), {}), 'session_required');
    await refusal(executor(execution(), { sessionToken: null }), 'session_required');
    await refusal(executor(execution()), 'session_required');
    expect(store.communicationSnapshot).not.toHaveBeenCalled();
    expect(communications.reply).not.toHaveBeenCalled();
  });

  it('refuses an action whose input is not a reply to a conversation', async () => {
    const { executor, communications } = fixture();
    for (const input of [undefined, {}, { communicationId: 'nope', basedOnMessageId: ids.message, body }, { communicationId: ids.communication, basedOnMessageId: 'nope', body },
      { communicationId: ids.communication, basedOnMessageId: ids.message, body: '' }, { communicationId: ids.communication, basedOnMessageId: ids.message, body: 'x'.repeat(5001) },
      { communicationId: ids.communication, basedOnMessageId: ids.message, body: 7 }]) {
      await refusal(executor(execution({ input }), { sessionToken }), 'invalid_reply');
    }
    expect(communications.reply).not.toHaveBeenCalled();
  });

  it('sends nothing into a conversation that moved on, that was closed, or that is gone', async () => {
    for (const [snapshot, code] of [
      [{ status: 'open', headMessageId: ids.other }, 'thread_changed'], [{ status: 'closed', headMessageId: ids.message }, 'conversation_closed'],
      [{ status: 'new', headMessageId: null }, 'thread_changed'], [null, 'conversation_missing'],
    ]) {
      const { executor, communications } = fixture({ snapshot });
      await refusal(executor(execution(), { sessionToken }), code);
      expect(communications.reply).not.toHaveBeenCalled();
    }
  });

  it('turns the inbox\'s refusals into codes the owner\'s screen explains', async () => {
    for (const [status, code] of [[401, 'session_required'], [403, 'not_permitted'], [409, 'reply_refused'], [400, 'invalid_reply']]) {
      const { executor, communications } = fixture();
      communications.reply.mockRejectedValue(new HttpError(status, `Message for ${sessionToken}`));
      await refusal(executor(execution(), { sessionToken }), code);
    }
    const { executor, communications } = fixture();
    const boom = new Error('connection reset');
    communications.reply.mockRejectedValue(boom);
    await expect(executor(execution(), { sessionToken })).rejects.toBe(boom);
  });

  it('never reports an unconfirmed send as sent, and warns the owner to look at the thread first', async () => {
    for (const [delivery, replay, code] of [['unknown', false, 'delivery_unknown'], ['unknown', true, 'delivery_unknown'], ['pending', true, 'delivery_unconfirmed'], ['pending', false, 'delivery_unconfirmed']]) {
      const { executor, notifier } = fixture({ reply: { messageId: 'm1', replay, delivery, deliveryChannel: 'sms' } });
      await refusal(executor(execution(), { sessionToken }), code);
      expect(notifier.send).toHaveBeenCalledTimes(1);
      expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning', subject: 'Check CM-1042 before sending again', dedupeKey: 'concierge:reply-check:action-1', agentKey: 'support_concierge', taskId: 'task-1' }));
    }
  });

  it('says plainly when the provider refused it, without a warning, since nothing reached the customer', async () => {
    const { executor, notifier } = fixture({ reply: { messageId: 'm1', replay: false, delivery: 'failed', deliveryChannel: 'email' } });
    await refusal(executor(execution(), { sessionToken }), 'delivery_failed');
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('still reports the failure when the warning itself cannot be sent, and logs only that it happened', async () => {
    const { executor, notifier, logs } = fixture({ reply: { messageId: 'm1', replay: false, delivery: 'unknown', deliveryChannel: 'email' } });
    notifier.send.mockRejectedValue(new Error(`database said ${sessionToken}`));
    await refusal(executor(execution(), { sessionToken }), 'delivery_unknown');
    expect(logs.map(line => JSON.parse(line))).toEqual([{ event: 'hub_agent_reply_warning_unsent', action_id: 'action-1' }]);
    expect(logs.join()).not.toContain(sessionToken);
  });

  it('puts neither the session nor the reply in a result or a message', async () => {
    const { executor, notifier, communications } = fixture({ reply: { messageId: 'm1', replay: false, delivery: 'unknown', deliveryChannel: 'email' } });
    const failure = await executor(execution(), { sessionToken }).catch(error => error);
    expect(JSON.stringify([failure.message, failure.code, notifier.send.mock.calls])).not.toMatch(new RegExp(`${sessionToken}|Thank you for contacting`));
    expect(communications.reply).toHaveBeenCalledTimes(1);
  });
});
