import { describe, expect, it, vi } from 'vitest';
import { attention, composeReview, salesReviewHandler } from './review.mjs';
import { salesHandlers } from './index.mjs';

const now = new Date('2026-11-09T12:45:00Z');
const ago = days => new Date(now.getTime() - days * 86_400_000).toISOString();
const ahead = days => new Date(now.getTime() + days * 86_400_000).toISOString();
const deal = over => ({ product: 'carebase', stage: 'qualified', name: 'Maple Grove Personal Care Home', internal: false, contact_id: 'c', eligibility: 'permitted', next_at: ahead(1), updated_at: ago(1), events: [], ...over });

describe('which deals need the owner', () => {
  it('ranks trials, warm prospects, overdue and stalled conversations and blocked prospects', () => {
    expect(attention(deal({ stage: 'trial', trial_end: ago(2) }), now)).toMatchObject({ key: 'trial_expired', words: 'Trial ended 2 days ago with no decision recorded' });
    expect(attention(deal({ stage: 'trial', trial_end: ahead(3) }), now)).toMatchObject({ key: 'trial_ending', words: 'Trial ends in 3 days and has not reached first value' });
    expect(attention(deal({ stage: 'trial', trial_end: ahead(3), activated_at: ago(5) }), now)).toBeNull();
    expect(attention(deal({ stage: 'engaged', events: [{ kind: 'positive_reply', occurred_at: ago(2) }] }), now)).toMatchObject({ key: 'warm' });
    expect(attention(deal({ stage: 'trial', trial_end: ahead(20), events: [{ kind: 'positive_reply', occurred_at: ago(2) }] }), now)).toBeNull();
    expect(attention(deal({ stage: 'engaged', next_at: ago(3) }), now)).toMatchObject({ key: 'reply_waiting', words: 'Next step overdue by 3 days' });
    expect(attention(deal({ stage: 'demo', updated_at: ago(20) }), now)).toMatchObject({ key: 'stalled' });
    expect(attention(deal({ eligibility: 'review' }), now)).toMatchObject({ key: 'blocked' });
    expect(attention(deal({ contact_id: null }), now)).toMatchObject({ key: 'blocked' });
    expect(attention(deal({}), now)).toBeNull();
  });
});

describe('the weekly pipeline review', () => {
  const items = [
    deal({ stage: 'trial', trial_end: ahead(2), events: [{ kind: 'trial_started', occurred_at: ago(12) }] }),
    deal({ name: 'Cedar Hospice', product: 'caremetric-intel', stage: 'engaged', events: [{ kind: 'positive_reply', occurred_at: ago(1) }] }),
    deal({ name: 'Internal test home', internal: true, stage: 'trial', trial_end: ago(1) }),
    deal({ name: 'Oak Home', stage: 'paying', events: [{ kind: 'paid', occurred_at: ago(3) }] }),
    deal({ name: 'Birch Home', stage: 'identified' }),
  ];

  it('counts each product\'s pipeline, lists who needs the owner by name in the email only, and leaves out internal organizations', () => {
    const report = composeReview({ items, now, publicOrigin: 'https://help.caremetric.ai' });
    expect(report.subject).toBe('Weekly pipeline: 2 deals need you');
    expect(report.result).toMatchObject({ prospects: 1, conversations: 1, trials: 1, customers: 1, needsYou: 2, warm: 1, trialsAtRisk: 1 });
    expect(report.body).toBe('1 prospect, 1 in conversation, 1 trial, 1 customer. 2 deals need you (1 warm, 1 trials at risk).');
    expect(report.body).not.toMatch(/Maple|Cedar|Internal/);
    const text = JSON.stringify(report.blocks);
    expect(text).toContain('Maple Grove Personal Care Home (CareBase)');
    expect(text).toContain('Cedar Hospice (Intel)');
    expect(text).not.toContain('Internal test home');
    expect(report.blocks.at(-1)).toEqual({ type: 'button', label: 'Open Growth', url: 'https://help.caremetric.ai/admin/growth' });
    const carebase = report.blocks.find((block, index) => block.type === 'details' && report.blocks[index - 1]?.text === 'CareBase');
    expect(carebase.rows).toContainEqual(['This week: became paying', '1']);
  });

  it('says so when the pipeline is empty', () => {
    const report = composeReview({ items: [], now });
    expect(report.subject).toBe('Weekly pipeline: nothing needs you');
    expect(report.blocks[0].text).toBe('The pipeline is empty: no prospects, conversations or trials yet.');
  });

  it('reads every page, sends once a week under one key, and always reports when the owner asks', async () => {
    const pages = [{ total: 3, items: items.slice(0, 2) }, { total: 3, items: items.slice(2, 3) }];
    const growth = { store: { snapshot: vi.fn(async offset => pages[offset === 0 ? 0 : 1]) } };
    const store = { startRun: vi.fn(async () => 'r'), finishRun: vi.fn(async () => undefined) };
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    const review = salesReviewHandler({ store, growth, notifier, publicOrigin: 'https://help.caremetric.ai', log: () => {} });
    const outcome = await review({ id: 't', agentKey: 'sales_executive', sourceKind: 'schedule' }, { now: () => now });
    expect(growth.store.snapshot.mock.calls.map(call => call[0])).toEqual([0, 2]);
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'sales:review:2026-11-09', agentKey: 'sales_executive', taskId: 't' }));
    expect(outcome.result).toMatchObject({ week: '2026-11-09', delivery: ['email:sent'], needsYou: 2 });
    expect(store.startRun).toHaveBeenCalledWith('t', 'none', 'sales-review.1');
    notifier.send.mockResolvedValue([{ channel: 'email', delivery: 'duplicate', original: 'sent' }]);
    expect((await review({ id: 't2', agentKey: 'sales_executive', sourceKind: 'schedule' }, { now: () => now })).result).toEqual({ skipped: 'already_sent', week: '2026-11-09' });
    notifier.send.mockResolvedValue([{ channel: 'email', delivery: 'sent' }]);
    await review({ id: 't3', agentKey: 'sales_executive', sourceKind: 'owner' }, { now: () => now });
    expect(notifier.send).toHaveBeenLastCalledWith(expect.objectContaining({ dedupeKey: 'sales:review:run:t3' }));
  });
});

describe('the Sales Executive\'s handlers', () => {
  const growth = { store: { snapshot: vi.fn() } };
  it('register only when the database declares the feature, and the review only with the growth records', () => {
    expect(salesHandlers({ store: {}, notifier: {}, growth, features: new Set() })).toEqual({});
    expect(Object.keys(salesHandlers({ store: {}, notifier: {}, growth, features: new Set(['platform.agents.sales-executive.v1']) }))).toEqual(['sales.reply', 'sales.review']);
    expect(Object.keys(salesHandlers({ store: {}, notifier: {}, growth: null, features: ['platform.agents.sales-executive.v1'] }))).toEqual(['sales.reply']);
  });
});
