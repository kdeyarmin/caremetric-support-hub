import { describe, expect, it, vi } from 'vitest';
import { autonomyFeature, autonomyHandlers, autonomyWords } from './autonomy.mjs';

const task = { id: '11111111-1111-4111-8111-111111111111', agentKey: 'chief_of_staff', kind: 'autonomy.graduate', sourceKind: 'schedule' };
const step = (category, label, automaticAt, status = 'supervised') => ({ category, label, status, automaticAt, supervisedSince: '2026-11-04T22:00:00+00:00', changedAt: '2026-11-04T22:00:00+00:00', ready: true, agents: [] });
/**
 * A store whose steps behave like the database's: graduating a due step makes it automatic and pending announcement, and announcing it
 * clears that. `pending` are switches an earlier run could not announce.
 */
const fixture = ({ due = [], soon = [], pending = [], graduate = null, delivery = 'sent' } = {}) => {
  const state = { due: [...due], announce: [...pending] };
  const store = {
    autonomyDue: vi.fn(async () => ({ due: state.due, announce: state.announce, soon })),
    autonomyGraduate: vi.fn(graduate ?? (async category => {
      const switched = { ...state.due.find(item => item.category === category), status: 'automatic', automaticAt: '2026-11-11T22:00:00.123456+00:00' };
      state.due = state.due.filter(item => item.category !== category);
      state.announce.push(switched);
      return { graduated: true, step: switched };
    })),
    autonomyAnnounced: vi.fn(async category => { state.announce = state.announce.filter(item => item.category !== category); return true; }),
    startRun: vi.fn(async () => 'run1'), finishRun: vi.fn(async () => true),
  };
  const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: typeof delivery === 'function' ? delivery() : delivery }]) };
  const handlers = autonomyHandlers({ store, notifier, publicOrigin: 'https://help.example.test/', features: new Set([autonomyFeature]), log: () => {} });
  return { store, notifier, state, run: () => handlers['autonomy.graduate'](task) };
};

describe('autonomy.graduate', () => {
  it('registers only when the database declares autonomy steps', () => {
    const store = { autonomyDue: vi.fn() };
    expect(autonomyHandlers({ store, notifier: {}, publicOrigin: 'https://h.test', features: new Set() })).toEqual({});
    expect(autonomyHandlers({ store, notifier: {}, publicOrigin: 'https://h.test', features: null })).toEqual({});
    expect(Object.keys(autonomyHandlers({ store, notifier: {}, publicOrigin: 'https://h.test', features: [autonomyFeature] }))).toEqual(['autonomy.graduate']);
  });

  it('does nothing when no week has ended, nothing is pending and nothing ends within a day', async () => {
    const { store, notifier, run } = fixture();
    expect(await run()).toEqual({ result: { graduated: [], waiting: [], announced: [], reminded: [], delivery: [] } });
    expect(store.autonomyGraduate).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
    expect(store.startRun).not.toHaveBeenCalled();
  });

  it('switches each due step, tells the owner once under the switch time, records that, and records the run', async () => {
    const { store, notifier, state, run } = fixture({ due: [step('account_emails', 'Account emails', '2026-11-11T22:00:00+00:00')] });
    const outcome = await run();
    expect(outcome.result).toMatchObject({ graduated: ['account_emails'], waiting: [], announced: ['account_emails'], reminded: [], delivery: ['account_emails:email:sent'] });
    const message = notifier.send.mock.calls[0][0];
    expect(message).toMatchObject({ severity: 'info', subject: 'Account emails: now on their own', dedupeKey: 'autonomy:automatic:account_emails:2026-11-11T22:00:00.123456+00:00', agentKey: 'chief_of_staff', taskId: task.id });
    expect(message.body).toContain(autonomyWords.account_emails);
    expect(message.body).toContain('Keep approving');
    expect(message.body).toContain('https://help.example.test/admin/team');
    expect(store.autonomyAnnounced).toHaveBeenCalledWith('account_emails', '2026-11-11T22:00:00.123456+00:00');
    expect(state.announce).toEqual([]);
    expect(store.finishRun).toHaveBeenCalledWith('run1', 'completed', {}, 'Switched to automatic after the supervised week: account_emails.', null);
  });

  it('keeps a switch pending when its email is refused, fails the task so it is retried, and announces it on the next run', async () => {
    let refuse = true;
    const { store, notifier, state, run } = fixture({ due: [step('account_emails', 'Account emails', '2026-11-11T22:00:00+00:00')], delivery: () => (refuse ? 'failed' : 'sent') });
    await expect(run()).rejects.toMatchObject({ code: 'notification_failed', transient: true });
    expect(store.autonomyAnnounced).not.toHaveBeenCalled();
    expect(state.announce.map(item => item.category)).toEqual(['account_emails']);
    expect(store.finishRun.mock.calls[0][3]).toContain('was not confirmed');
    refuse = false;
    const retried = await run();
    expect(retried.result).toMatchObject({ graduated: [], announced: ['account_emails'] });
    expect(notifier.send.mock.calls.map(([call]) => call.dedupeKey)).toEqual(Array(2).fill('autonomy:automatic:account_emails:2026-11-11T22:00:00.123456+00:00'));
    expect(state.announce).toEqual([]);
  });

  it('announces a switch an earlier run left pending even when nothing is due now', async () => {
    const { store, notifier, run } = fixture({ pending: [step('articles', 'Article publishing', '2026-11-10T09:00:00+00:00', 'automatic')] });
    expect((await run()).result.announced).toEqual(['articles']);
    expect(notifier.send.mock.calls[0][0].dedupeKey).toBe('autonomy:automatic:articles:2026-11-10T09:00:00+00:00');
    expect(store.autonomyGraduate).not.toHaveBeenCalled();
    expect(store.startRun).not.toHaveBeenCalled();
  });

  it('counts a switched-off or unconfirmed email as told, so it is never sent twice', async () => {
    for (const delivery of ['suppressed', 'unknown', 'duplicate']) {
      const { store, run } = fixture({ due: [step('account_emails', 'Account emails', '2026-11-11T22:00:00+00:00')], delivery });
      await run();
      expect(store.autonomyAnnounced, delivery).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves a step whose code is missing or that is no longer due, says why, and emails nobody about it', async () => {
    const due = [step('support_answers', 'Support answers', '2026-11-11T22:00:00+00:00'), step('articles', 'Article publishing', '2026-11-11T22:00:00+00:00')];
    const { notifier, store, run } = fixture({ due, graduate: async category => ({ graduated: false, reason: category === 'articles' ? 'not_due' : 'code_missing' }) });
    expect((await run()).result).toMatchObject({ graduated: [], waiting: ['support_answers:code_missing', 'articles:not_due'], announced: [] });
    expect(notifier.send).not.toHaveBeenCalled();
    expect(store.startRun).not.toHaveBeenCalled();
  });

  it('tells the owner when a step stays supervised for too few decisions, or is held for too many turned down', async () => {
    const due = [step('cold_email', 'Cold email', '2026-11-11T22:00:00+00:00'), step('social_posts', 'Social posts', '2026-11-11T22:00:00+00:00')];
    const { notifier, run } = fixture({ due, graduate: async category => (category === 'cold_email'
      ? { graduated: false, reason: 'not_enough_reviews', evidence: { reviewed: 3, rejected: 0 }, step: { automaticAt: '2026-11-18T22:00:00+00:00' } }
      : { graduated: false, reason: 'too_many_rejections', evidence: { reviewed: 10, rejected: 4 } }) });
    expect((await run()).result.waiting).toEqual(['cold_email:not_enough_reviews', 'social_posts:too_many_rejections']);
    const sent = notifier.send.mock.calls.map(([input]) => input);
    expect(sent.map(input => [input.subject, input.severity, input.dedupeKey])).toEqual([
      ['Cold email: one more supervised week', 'info', 'autonomy:extended:cold_email:2026-11-18T22:00:00+00:00'],
      ['Social posts: kept under your review', 'warning', 'autonomy:held:social_posts:2026-11-11T22:00:00+00:00'],
    ]);
    expect(sent[0].body).toContain('Only 3 decisions on cold email came to you');
    expect(sent[1].body).toContain('You turned down 4 of 10 decisions on social posts');
  });

  it('reminds the owner the day before, keyed by the switch time so it goes once', async () => {
    const { notifier, run } = fixture({ soon: [step('offers', 'Offers', '2026-11-12T15:00:00+00:00')] });
    expect((await run()).result.reminded).toEqual(['offers']);
    const message = notifier.send.mock.calls[0][0];
    expect(message.subject).toBe('Offers: on their own from Nov 12, 10:00 AM Eastern');
    expect(message.dedupeKey).toBe('autonomy:soon:offers:2026-11-12T15:00:00+00:00');
    expect(message.body).toContain(autonomyWords.offers);
  });

  it('words the four steps the owner handed over on 2026-11-15 in plain sentences, with the safeguards that stay', () => {
    expect(autonomyWords.named_contacts).toMatch(/publishes it or its mail server confirms it.*Guesses nothing confirmed are never kept.*unsubscribes and opt-outs still win/);
    expect(autonomyWords.learning_memo).toContain('as if you had chosen "Use this memo"');
    expect(autonomyWords.ad_campaigns).toMatch(/first ad from creative you already approved.*within your monthly number and daily ad-set limit.*ending with its month/);
    expect(autonomyWords.founder_posts).toContain('pass the fact-sheet checks');
  });

  it('names the AI team page when the server has no public address', async () => {
    const store = { autonomyDue: vi.fn(async () => ({ due: [], announce: [], soon: [step('offers', 'Offers', '2026-11-12T15:00:00+00:00')] })), autonomyGraduate: vi.fn(), autonomyAnnounced: vi.fn() };
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    await autonomyHandlers({ store, notifier, publicOrigin: undefined, features: [autonomyFeature] })['autonomy.graduate'](task);
    expect(notifier.send.mock.calls[0][0].body).toMatch(/choose Keep approving next to it on the AI team page\.$/);
  });
});
