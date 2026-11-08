import { describe, expect, it, vi } from 'vitest';
import { socialExecutors } from './executor.mjs';

const now = () => new Date('2026-11-10T15:31:00Z');
const message = 'Annual training hours piling up? Keep each staff member\'s training in one place.\n\n#PersonalCareHome';
const metaOf = (over = {}) => ({
  configured: { pages: true, instagram: true, ads: true },
  publishPost: vi.fn(async () => ({ id: '1111_99' })), reply: vi.fn(async () => ({ id: 'r1' })), hide: vi.fn(async () => ({ success: true })),
  readItem: vi.fn(async () => ({ text: 'x', answered: false, fromPage: false, open: true, recipient: '7777', history: [] })),
  pauseAd: vi.fn(async () => ({ success: true })), createAd: vi.fn(async () => ({ id: '90', creativeId: '91' })),
  readAdset: vi.fn(async () => ({ id: '40', dailyBudget: 2000, active: true })), setDailyBudget: vi.fn(async () => ({ success: true })),
  ...over,
});
const run = (kind, input, { meta = metaOf(), settings = {}, autoApproved = false, notifier = null, targetId = '' } = {}) => {
  const executors = socialExecutors({ meta, settings, notifier, now, log: () => {} });
  return { meta, promise: executors[kind]({ id: 'a1', kind, input, autoApproved, targetId, agentKey: 'social_manager', taskId: 't1' }) };
};

describe('carrying out social actions', () => {
  it('publishes a post at its time slot, and hands back one that started early', async () => {
    const post = { platform: 'facebook', product: 'carebase', message, link: 'https://cmcarebase.com/pa-training-requirements', scheduledFor: '2026-11-10T15:30:00.000Z' };
    const { meta, promise } = run('social.post', post);
    expect(await promise).toEqual({ published: true, id: '1111_99' });
    expect(meta.publishPost).toHaveBeenCalledWith({ platform: 'facebook', message, link: 'https://cmcarebase.com/pa-training-requirements', imageUrl: null });
    const early = run('social.post', { ...post, scheduledFor: '2026-11-11T15:30:00.000Z' });
    await expect(early.promise).rejects.toMatchObject({ code: 'action_deferred' });
    expect(early.meta.publishPost).not.toHaveBeenCalled();
  });

  it('refuses a post whose words no longer pass the checks, or an Instagram post without an image', async () => {
    await expect(run('social.post', { platform: 'facebook', product: 'carebase', message: 'CareBase ensures compliance.', scheduledFor: '2026-11-10T15:00:00Z' }).promise).rejects.toMatchObject({ code: 'invalid_post' });
    await expect(run('social.post', { platform: 'instagram', product: 'carebase', message, scheduledFor: '2026-11-10T15:00:00Z' }).promise).rejects.toMatchObject({ code: 'image_missing' });
  });

  it('replies only to what is still unanswered, and to a message only inside its reply window', async () => {
    const reply = { platform: 'messenger', kind: 'message', id: 'm_1', parentId: 't_1', message: 'Thanks for asking. You can start a 30-day free trial: https://cmcarebase.com/signup', product: 'carebase' };
    const { meta, promise } = run('social.reply', reply);
    expect(await promise).toEqual({ replied: true, id: 'r1' });
    expect(meta.reply).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message', recipient: '7777' }));
    await expect(run('social.reply', reply, { meta: metaOf({ readItem: vi.fn(async () => ({ answered: true })) }) }).promise).rejects.toMatchObject({ code: 'already_answered' });
    await expect(run('social.reply', reply, { meta: metaOf({ readItem: vi.fn(async () => ({ answered: false, open: false })) }) }).promise).rejects.toMatchObject({ code: 'window_closed' });
    await expect(run('social.reply', reply, { meta: metaOf({ readItem: vi.fn(async () => ({ gone: true })) }) }).promise).rejects.toMatchObject({ code: 'item_gone' });
  });

  it('hides a comment, pauses an ad and starts a new ad', async () => {
    expect(await run('social.moderate', { operation: 'hide', platform: 'facebook', kind: 'comment', id: '1_10' }).promise).toEqual({ hidden: true });
    expect(await run('social.ad_pause', { adId: '51' }, { targetId: '51' }).promise).toEqual({ paused: true });
    await expect(run('social.ad_pause', { adId: '51' }, { targetId: '52' }).promise).rejects.toMatchObject({ code: 'invalid_ad' });
    const ad = { adsetId: '40', name: 'PA operators · survey · 2026-11-09', message: 'Getting ready for your next DHS inspection? CareBase keeps staff training, resident records and survey documentation in one place.',
      headline: 'Try CareBase free', description: '30-day free trial', link: 'https://cmcarebase.com/signup', imageHash: 'img1', callToAction: 'SIGN_UP', product: 'carebase' };
    const created = run('social.ad_create', ad);
    expect(await created.promise).toEqual({ created: true, id: '90' });
    await expect(run('social.ad_create', { ...ad, link: 'https://example.org/' }).promise).rejects.toMatchObject({ code: 'invalid_ad' });
    await expect(run('social.ad_create', { ...ad, headline: 'We guarantee results' }).promise).rejects.toMatchObject({ code: 'invalid_ad' });
  });

  it('changes a budget only on the owner\'s approval, under the cap, by a measured step and from the budget it was proposed from', async () => {
    const budget = { adsetId: '40', from: 2000, to: 2400 };
    const settings = { maxDailyBudgetCents: 3000 };
    const ok = run('social.ad_budget', budget, { settings });
    expect(await ok.promise).toEqual({ dailyBudget: 2400 });
    expect(ok.meta.setDailyBudget).toHaveBeenCalledWith('40', 2400);
    await expect(run('social.ad_budget', budget, { settings, autoApproved: true }).promise).rejects.toMatchObject({ code: 'auto_approved_refused' });
    await expect(run('social.ad_budget', budget, { settings: {} }).promise).rejects.toMatchObject({ code: 'over_budget_cap' });
    await expect(run('social.ad_budget', { ...budget, to: 2900 }, { settings }).promise).rejects.toMatchObject({ code: 'budget_step_too_large' });
    await expect(run('social.ad_budget', budget, { settings, meta: metaOf({ readAdset: vi.fn(async () => ({ dailyBudget: 2100 })) }) }).promise).rejects.toMatchObject({ code: 'budget_changed' });
  });

  it('never retries a request Meta may have received, and asks the owner to look', async () => {
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    const meta = metaOf({ publishPost: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'meta_unconfirmed' }); }) });
    await expect(run('social.post', { platform: 'facebook', product: 'carebase', message, scheduledFor: '2026-11-10T15:00:00Z' }, { meta, notifier }).promise).rejects.toMatchObject({ code: 'social_unconfirmed' });
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning', dedupeKey: 'social:unconfirmed:a1' }));
  });

  it('refuses everything while Meta is not connected', async () => {
    await expect(run('social.ad_pause', { adId: '51' }, { targetId: '51', meta: metaOf({ configured: { pages: true, instagram: false, ads: false } }) }).promise).rejects.toMatchObject({ code: 'meta_not_configured' });
  });
});
