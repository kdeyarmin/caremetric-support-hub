import { describe, expect, it, vi } from 'vitest';
import { accountsFeature, accountsHandlers } from '../tasks/accounts.mjs';
import { growthFeature, growthHandlers } from '../tasks/growth.mjs';
import { seoHandlers } from '../tasks/seo.mjs';
import { salesReviewHandler } from '../sales/review.mjs';
import { socialHandlers } from '../social/tasks.mjs';
import { heldForScorecard } from '../tasks/shared.mjs';

// Monday 2 November 2026, 08:00 Eastern.
const monday = new Date('2026-11-02T13:00:00Z');
const proceeded = () => Object.assign(new Error('The report went on to read its figures.'), { code: 'proceeded', transient: true });
const fail = () => vi.fn(async () => { throw proceeded(); });

// Each weekly report with stubs that stop it at its first read, so "held" and "went on" are told apart without a full fixture.
const reports = {
  'accounts.weekly': (store, notifier) => accountsHandlers({ store: { ...store, accountsSnapshot: fail() }, notifier, features: [accountsFeature], log: () => {} })['accounts.weekly'],
  'growth.weekly': (store, notifier) => growthHandlers({ store: { ...store, growthFacts: fail() }, notifier, features: [growthFeature], log: () => {} })['growth.weekly'],
  'seo.weekly': (store, notifier) => seoHandlers({ store, notifier: { send: fail() }, sites: [], searchConsole: null, env: {}, log: () => {} })['seo.weekly'],
  'sales.review': (store, notifier) => salesReviewHandler({ store, notifier, growth: { store: { snapshot: fail() } }, log: () => {} }),
  'social.report': (store, notifier) => socialHandlers({
    store, notifier, meta: { configured: { pages: true, instagram: false, ads: false }, recentPosts: fail() }, log: () => {},
  })['social.report'],
};
const task = (kind, over = {}) => ({ id: 't1', agentKey: 'agent', kind, sourceKind: 'schedule', attempts: 1, ...over });

describe('the five weekly reports while the Monday scorecard carries them', () => {
  for (const [kind, build] of Object.entries(reports)) {
    it(`${kind}: a scheduled run is held while the owner's setting is off, and sends nothing`, async () => {
      const store = { individualReports: vi.fn(async () => false), startRun: vi.fn(), finishRun: vi.fn() };
      const notifier = { send: vi.fn() };
      const outcome = await build(store, notifier)(task(kind), { now: () => monday });
      expect(outcome).toEqual({ result: { skipped: 'in_scorecard', week: '2026-11-02' } });
      expect(notifier.send).not.toHaveBeenCalled();
      expect(store.startRun).not.toHaveBeenCalled();
    });

    it(`${kind}: runs as before when the setting is on, on Run now, and without the scorecard`, async () => {
      for (const [store, over] of [
        [{ individualReports: vi.fn(async () => true) }, {}],
        [{ individualReports: vi.fn(async () => false) }, { sourceKind: 'owner' }],
        [{}, {}],
      ]) {
        const notifier = { send: fail() };
        await expect(build({ ...store, startRun: vi.fn(), finishRun: vi.fn() }, notifier)(task(kind, over), { now: () => monday })).rejects.toMatchObject({ code: 'proceeded' });
        if (over.sourceKind === 'owner') expect(store.individualReports).not.toHaveBeenCalled();
      }
    });
  }

  it('sends when the setting cannot be read: a second email is better than a missing one', async () => {
    const logs = [];
    const store = { individualReports: vi.fn(async () => { throw new Error('database down'); }) };
    expect(await heldForScorecard({ store, log: line => logs.push(line) }, task('accounts.weekly', { agentKey: 'account_manager' }))).toBe(false);
    expect(logs).toEqual([JSON.stringify({ event: 'hub_agent_report_setting_unread', agent: 'account_manager', kind: 'accounts.weekly' })]);
  });
});
