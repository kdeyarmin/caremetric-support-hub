import { describe, expect, it, vi } from 'vitest';
import { autonomyFeature, autonomyHandlers, autonomyWords } from './autonomy.mjs';

const task = { id: '11111111-1111-4111-8111-111111111111', agentKey: 'chief_of_staff', kind: 'autonomy.graduate', sourceKind: 'schedule' };
const step = (category, label, automaticAt, status = 'supervised') => ({ category, label, status, automaticAt, supervisedSince: '2026-11-04T22:00:00+00:00', changedAt: '2026-11-04T22:00:00+00:00', ready: true, agents: [] });
const fixture = ({ due = [], soon = [], graduate = async category => ({ graduated: true, step: { ...due.find(item => item.category === category), status: 'automatic' } }), delivery = 'sent' } = {}) => {
  const store = {
    autonomyDue: vi.fn(async () => ({ due, soon })), autonomyGraduate: vi.fn(graduate),
    startRun: vi.fn(async () => 'run1'), finishRun: vi.fn(async () => true),
  };
  const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery }]) };
  const handlers = autonomyHandlers({ store, notifier, publicOrigin: 'https://help.example.test/', features: new Set([autonomyFeature]), log: () => {} });
  return { store, notifier, run: () => handlers['autonomy.graduate'](task) };
};

describe('autonomy.graduate', () => {
  it('registers only when the database declares autonomy steps', () => {
    const store = { autonomyDue: vi.fn() };
    expect(autonomyHandlers({ store, notifier: {}, publicOrigin: 'https://h.test', features: new Set() })).toEqual({});
    expect(autonomyHandlers({ store, notifier: {}, publicOrigin: 'https://h.test', features: null })).toEqual({});
    expect(Object.keys(autonomyHandlers({ store, notifier: {}, publicOrigin: 'https://h.test', features: [autonomyFeature] }))).toEqual(['autonomy.graduate']);
  });

  it('does nothing when no supervised week has ended or ends within a day', async () => {
    const { store, notifier, run } = fixture();
    expect(await run()).toEqual({ result: { graduated: [], waiting: [], reminded: [], delivery: [] } });
    expect(store.autonomyGraduate).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
    expect(store.startRun).not.toHaveBeenCalled();
  });

  it('switches each due step, emails the owner once per switch, and records the run', async () => {
    const due = [step('account_emails', 'Account emails', '2026-11-11T22:00:00+00:00')];
    const { store, notifier, run } = fixture({ due });
    const outcome = await run();
    expect(outcome.result).toMatchObject({ graduated: ['account_emails'], waiting: [], reminded: [], delivery: ['account_emails:email:sent'] });
    expect(store.autonomyGraduate).toHaveBeenCalledWith('account_emails');
    const message = notifier.send.mock.calls[0][0];
    expect(message).toMatchObject({ severity: 'info', subject: 'Account emails: now on their own', dedupeKey: 'autonomy:automatic:account_emails:2026-11-11T22:00:00+00:00', agentKey: 'chief_of_staff', taskId: task.id });
    expect(message.body).toContain(autonomyWords.account_emails);
    expect(message.body).toContain('Keep approving');
    expect(message.body).toContain('https://help.example.test/admin/team');
    expect(store.finishRun).toHaveBeenCalledWith('run1', 'completed', {}, 'Switched to automatic after the supervised week: account_emails.', null);
  });

  it('leaves a step whose code is missing or that is no longer due, says why, and emails nobody about it', async () => {
    const due = [step('support_answers', 'Support answers', '2026-11-11T22:00:00+00:00'), step('articles', 'Article publishing', '2026-11-11T22:00:00+00:00')];
    const { notifier, store, run } = fixture({ due, graduate: async category => ({ graduated: false, reason: category === 'articles' ? 'not_due' : 'code_missing' }) });
    expect((await run()).result).toMatchObject({ graduated: [], waiting: ['support_answers:code_missing', 'articles:not_due'] });
    expect(notifier.send).not.toHaveBeenCalled();
    expect(store.startRun).not.toHaveBeenCalled();
  });

  it('reminds the owner the day before, keyed by the switch time so it goes once', async () => {
    const soon = [step('offers', 'Offers', '2026-11-12T15:00:00+00:00')];
    const { notifier, run } = fixture({ soon });
    expect((await run()).result.reminded).toEqual(['offers']);
    const message = notifier.send.mock.calls[0][0];
    expect(message.subject).toBe('Offers: on their own from Nov 12, 10:00 AM Eastern');
    expect(message.dedupeKey).toBe('autonomy:soon:offers:2026-11-12T15:00:00+00:00');
    expect(message.body).toContain(autonomyWords.offers);
  });

  it('names the AI team page when the server has no public address', async () => {
    const store = { autonomyDue: vi.fn(async () => ({ due: [], soon: [step('offers', 'Offers', '2026-11-12T15:00:00+00:00')] })), autonomyGraduate: vi.fn() };
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    await autonomyHandlers({ store, notifier, publicOrigin: undefined, features: [autonomyFeature] })['autonomy.graduate'](task);
    expect(notifier.send.mock.calls[0][0].body).toMatch(/choose Keep approving next to it on the AI team page\.$/);
  });

  it('says so in the run when the email about a switch was not confirmed', async () => {
    const due = [step('account_emails', 'Account emails', '2026-11-11T22:00:00+00:00')];
    const { store, run } = fixture({ due, delivery: 'failed' });
    await run();
    expect(store.finishRun.mock.calls[0][3]).toContain('was not confirmed');
  });
});
