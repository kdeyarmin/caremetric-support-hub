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
const linkedinPost = 'urn:li:share:7100000000000000001';
const linkedinComment = 'urn:li:comment:(urn:li:activity:7100000000000000009,7200000000000000002)';
const linkedinOf = (over = {}) => ({
  configured: { page: true, ads: true },
  publishPost: vi.fn(async () => ({ id: 'urn:li:share:7100000000000000099' })), reply: vi.fn(async () => ({ id: 'urn:li:comment:(urn:li:activity:1,2)' })),
  remove: vi.fn(async () => ({ deleted: true })), readItem: vi.fn(async () => ({ text: 'x', answered: false, fromPage: false, history: [] })),
  pauseAd: vi.fn(async () => ({ success: true })), createAd: vi.fn(async () => ({ id: '820009', postId: 'urn:li:share:7100000000000000020' })),
  readAdset: vi.fn(async () => ({ id: '610001', dailyBudget: 2000, currency: 'USD', active: true })), setDailyBudget: vi.fn(async () => ({ success: true })),
  ...over,
});
const run = (kind, input, { meta = metaOf(), linkedin = linkedinOf(), settings = {}, autoApproved = false, notifier = null, targetId = '' } = {}) => {
  const executors = socialExecutors({ meta, linkedin, settings, notifier, now, log: () => {} });
  return { meta, linkedin, promise: executors[kind]({ id: 'a1', kind, input, autoApproved, targetId, agentKey: 'social_manager', taskId: 't1' }) };
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
    expect(ok.meta.setDailyBudget).toHaveBeenCalledWith('40', 2400, { currency: 'USD' });
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

describe('carrying out social actions on LinkedIn', () => {
  it('publishes a LinkedIn post through LinkedIn, with its link as a card', async () => {
    const post = { platform: 'linkedin', product: 'carebase', message, link: 'https://cmcarebase.com/pa-training-requirements', linkLabel: 'PA training requirements', scheduledFor: '2026-11-10T13:45:00.000Z' };
    const { meta, linkedin, promise } = run('social.post', { ...post, scheduledFor: '2026-11-10T15:30:00.000Z' });
    expect(await promise).toEqual({ published: true, id: 'urn:li:share:7100000000000000099' });
    expect(linkedin.publishPost).toHaveBeenCalledWith({ message, link: 'https://cmcarebase.com/pa-training-requirements', linkTitle: 'PA training requirements', imageUrl: null });
    expect(meta.publishPost).not.toHaveBeenCalled();
    await expect(run('social.post', post, { linkedin: linkedinOf({ configured: { page: false, ads: false } }) }).promise).rejects.toMatchObject({ code: 'linkedin_not_configured' });
    // Meta being connected or not does not matter to a LinkedIn post.
    expect(await run('social.post', { ...post, scheduledFor: '2026-11-10T15:30:00.000Z' }, { meta: metaOf({ configured: { pages: false, instagram: false, ads: false } }) }).promise).toMatchObject({ published: true });
  });

  it('replies to a LinkedIn comment only while it is unanswered', async () => {
    const reply = { platform: 'linkedin', kind: 'comment', id: linkedinComment, parentId: linkedinPost, message: 'Thanks for asking. You can start a 30-day free trial: https://cmcarebase.com/signup', product: 'carebase' };
    const { linkedin, promise } = run('social.reply', reply);
    expect(await promise).toEqual({ replied: true, id: 'urn:li:comment:(urn:li:activity:1,2)' });
    expect(linkedin.reply).toHaveBeenCalledWith(expect.objectContaining({ platform: 'linkedin', id: linkedinComment, parentId: linkedinPost, message: reply.message }));
    await expect(run('social.reply', reply, { linkedin: linkedinOf({ readItem: vi.fn(async () => ({ answered: true })) }) }).promise).rejects.toMatchObject({ code: 'already_answered' });
  });

  it('deletes a LinkedIn comment only on the owner\'s own approval, since a deletion cannot be undone', async () => {
    const moderation = { operation: 'delete', platform: 'linkedin', kind: 'comment', id: linkedinComment, parentId: linkedinPost };
    const { linkedin, promise } = run('social.moderate', moderation);
    expect(await promise).toEqual({ deleted: true });
    expect(linkedin.remove).toHaveBeenCalledWith({ id: linkedinComment, parentId: linkedinPost });
    const automatic = run('social.moderate', moderation, { autoApproved: true });
    await expect(automatic.promise).rejects.toMatchObject({ code: 'auto_approved_refused' });
    expect(automatic.linkedin.remove).not.toHaveBeenCalled();
    await expect(run('social.moderate', { ...moderation, operation: 'hide' }).promise).rejects.toMatchObject({ code: 'invalid_moderation' });
    await expect(run('social.moderate', { ...moderation, id: '1_10' }).promise).rejects.toMatchObject({ code: 'invalid_moderation' });
  });

  it('pauses a LinkedIn creative, starts one, and changes a campaign budget in its own currency, under the same rules as Meta', async () => {
    const paused = run('social.ad_pause', { adId: '820002', platform: 'linkedin' }, { targetId: 'linkedin:820002' });
    expect(await paused.promise).toEqual({ paused: true });
    expect(paused.linkedin.pauseAd).toHaveBeenCalledWith('820002');
    expect(paused.meta.pauseAd).not.toHaveBeenCalled();
    await expect(run('social.ad_pause', { adId: '820002', platform: 'linkedin' }, { targetId: '820002' }).promise).rejects.toMatchObject({ code: 'invalid_ad' });
    const ad = { platform: 'linkedin', adsetId: '610001', name: 'PA operators · survey · 2026-11-09', message: 'Getting ready for your next DHS inspection? CareBase keeps staff training, resident records and survey documentation in one place.',
      headline: 'Try CareBase free', description: '30-day free trial', link: 'https://cmcarebase.com/signup', imageHash: null, callToAction: 'SIGN_UP', product: 'carebase' };
    const created = run('social.ad_create', ad);
    expect(await created.promise).toEqual({ created: true, id: '820009' });
    expect(created.linkedin.createAd).toHaveBeenCalledWith(expect.objectContaining({ adsetId: '610001', link: 'https://cmcarebase.com/signup', imageUrl: null }));
    const branded = run('social.ad_create', { ...ad, imageUrl: 'https://cdn.example.com/brand-1.jpg' });
    await branded.promise;
    expect(branded.linkedin.createAd).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: 'https://cdn.example.com/brand-1.jpg' }));
    await expect(run('social.ad_create', { ...ad, adsetId: 'act_1' }).promise).rejects.toMatchObject({ code: 'invalid_ad' });
    const settings = { maxDailyBudgetCents: 3000 };
    const budget = run('social.ad_budget', { platform: 'linkedin', adsetId: '610001', from: 2000, to: 2400 }, { settings, linkedin: linkedinOf({ readAdset: vi.fn(async () => ({ dailyBudget: 2000, currency: 'CAD' })) }) });
    expect(await budget.promise).toEqual({ dailyBudget: 2400 });
    expect(budget.linkedin.setDailyBudget).toHaveBeenCalledWith('610001', 2400, { currency: 'CAD' });
    await expect(run('social.ad_budget', { platform: 'linkedin', adsetId: '610001', from: 2000, to: 2400 }, { settings, autoApproved: true }).promise).rejects.toMatchObject({ code: 'auto_approved_refused' });
  });

  it('never retries a request LinkedIn may have received, and asks the owner to look', async () => {
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    const linkedin = linkedinOf({ publishPost: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'linkedin_unconfirmed' }); }) });
    await expect(run('social.post', { platform: 'linkedin', product: 'carebase', message, scheduledFor: '2026-11-10T15:00:00Z' }, { linkedin, notifier }).promise).rejects.toMatchObject({ code: 'social_unconfirmed' });
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning', dedupeKey: 'social:unconfirmed:a1' }));
  });
});

describe('approved creative', () => {
  const assetId = '22222222-2222-4222-8222-222222222222';
  const link = `https://www.caremetricintel.com/?utm_source=meta&utm_medium=paid&utm_campaign=creative-1&utm_content=${assetId}`;
  const image = `https://help.caremetric.ai/api/creative/a/${'f'.repeat(64)}.png`;

  it('starts a Meta ad with the approved image and tracked link, and marks the asset live', async () => {
    const meta = metaOf();
    const creative = { live: vi.fn(async () => true) };
    const executors = socialExecutors({ meta, settings: {}, now, log: () => {}, creative });
    const input = { adsetId: '120200000000001', name: 'Ad', message: 'CareMetric Intel brings targeted marketing and territory analysis into one place for your team.', headline: 'Territory plans',
      description: 'Free trial', link, imageHash: null, imageUrl: image, callToAction: 'SIGN_UP', product: 'caremetric-intel', creativeAssetId: assetId };
    expect(await executors['social.ad_create']({ id: 'a1', kind: 'social.ad_create', input, targetId: '', agentKey: 'social_manager' })).toEqual({ created: true, id: '90' });
    expect(meta.createAd).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: image, link }));
    expect(creative.live).toHaveBeenCalledWith(assetId, '90');
  });

  it('never fails a publish because the asset could not be marked live', async () => {
    const meta = metaOf();
    const creative = { live: vi.fn(async () => { throw new Error('down'); }) };
    const executors = socialExecutors({ meta, settings: {}, now, log: () => {}, creative });
    const input = { platform: 'instagram', product: 'caremetric-intel', message, link: null, imageUrl: image, scheduledFor: now().toISOString(), creativeAssetId: assetId };
    expect(await executors['social.post']({ id: 'a1', kind: 'social.post', input, agentKey: 'social_manager' })).toEqual({ published: true, id: '1111_99' });
    expect(creative.live).toHaveBeenCalled();
  });
});
