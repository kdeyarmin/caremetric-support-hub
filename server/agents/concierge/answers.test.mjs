import { describe, expect, it, vi } from 'vitest';
import { answerExecutor } from './answers.mjs';
import { replySubject } from './executor.mjs';
import { conciergeExecutors } from './index.mjs';

const ids = { action: '11111111-1111-4111-8111-111111111111', communication: '22222222-2222-4222-8222-222222222222', message: '33333333-3333-4333-8333-333333333333' };
const execution = (input = {}) => ({
  id: ids.action, agentKey: 'support_concierge', taskId: 't1', kind: 'communication.answer', execution: 1, autoApproved: true,
  input: { communicationId: ids.communication, basedOnMessageId: ids.message, reference: 1042, body: 'Hello,\n\nOpen Reports and select Export.', route: 'email', ...input },
});
const fixture = (answer = async () => ({ delivery: 'sent', deliveryChannel: 'email', replay: false })) => {
  const communications = { answer: vi.fn(answer) };
  const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
  return { communications, notifier, run: (item = execution()) => answerExecutor({ communications, notifier, log: () => {} })(item) };
};

describe('sending a support answer', () => {
  it('sends without the owner\'s session, under the fixed subject, and says the AI assistant wrote it', async () => {
    const { communications, run } = fixture();
    expect(await run()).toEqual({ delivery: 'sent', channel: 'email', replay: false, author: 'ai_assistant' });
    expect(communications.answer).toHaveBeenCalledWith({ actionId: ids.action, execution: 1, subject: replySubject });
  });

  it('passes on every refusal the database gives, coded, and never retries', async () => {
    for (const code of ['answers_off', 'conversation_closed', 'conversation_missing', 'thread_changed', 'reply_refused']) {
      const { run } = fixture(async () => ({ refused: code }));
      await expect(run()).rejects.toMatchObject({ code });
    }
    const { run } = fixture(async () => ({ refused: 'something_new' }));
    await expect(run()).rejects.toMatchObject({ code: 'reply_refused' });
  });

  it('refuses an answer it cannot read before asking the database', async () => {
    const { communications, run } = fixture();
    for (const input of [{ communicationId: 'x' }, { basedOnMessageId: null }, { body: '' }, { body: 'x'.repeat(5001) }]) {
      await expect(run(execution(input))).rejects.toMatchObject({ code: 'invalid_reply' });
    }
    expect(communications.answer).not.toHaveBeenCalled();
  });

  it('warns the owner when delivery was not confirmed, and fails a refused delivery without a warning', async () => {
    const unknown = fixture(async () => ({ delivery: 'unknown', deliveryChannel: 'email', replay: false }));
    await expect(unknown.run()).rejects.toMatchObject({ code: 'delivery_unknown' });
    expect(unknown.notifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning', subject: 'Check CM-1042 before sending again', dedupeKey: `concierge:answer-check:${ids.action}` }));
    const pending = fixture(async () => ({ delivery: 'pending', deliveryChannel: 'email', replay: true }));
    await expect(pending.run()).rejects.toMatchObject({ code: 'delivery_unconfirmed' });
    const unsettled = fixture(async () => { throw Object.assign(new Error('x'), { code: 'delivery_unsettled' }); });
    await expect(unsettled.run()).rejects.toMatchObject({ code: 'delivery_unconfirmed' });
    expect(unsettled.notifier.send).toHaveBeenCalledTimes(1);
    const failed = fixture(async () => ({ delivery: 'failed', deliveryChannel: 'email', replay: false }));
    await expect(failed.run()).rejects.toMatchObject({ code: 'delivery_failed' });
    expect(failed.notifier.send).not.toHaveBeenCalled();
  });

  it('settles a replay that was sent as sent', async () => {
    const { run } = fixture(async () => ({ delivery: 'sent', deliveryChannel: 'chat', replay: true }));
    expect(await run()).toMatchObject({ delivery: 'sent', channel: 'chat', replay: true });
  });

  it('is registered, as a non-session executor, only when the database has answers and the inbox can send them', () => {
    const communications = { reply: vi.fn(), answer: vi.fn() };
    const both = conciergeExecutors({ communications, store: {}, notifier: {}, features: new Set(['platform.agents.concierge.v1', 'platform.agents.concierge-autosend.v1']) });
    expect(Object.keys(both).sort()).toEqual(['communication.answer', 'communication.reply']);
    expect(both['communication.answer'].requiresSession).toBeUndefined();
    expect(both['communication.reply'].requiresSession).toBe(true);
    expect(Object.keys(conciergeExecutors({ communications, store: {}, notifier: {}, features: new Set(['platform.agents.concierge.v1']) }))).toEqual(['communication.reply']);
    expect(Object.keys(conciergeExecutors({ communications: { reply: vi.fn() }, store: {}, notifier: {}, features: ['platform.agents.concierge.v1', 'platform.agents.concierge-autosend.v1'] }))).toEqual(['communication.reply']);
  });
});
