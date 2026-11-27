import { describe, expect, it, vi } from 'vitest';
import { socialExecutors } from './executor.mjs';
import { renderOwnerEmail } from '../notify.mjs';

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
    // The code names the check that refused it, so the owner's screen can say why (src/admin/teamProtocol.ts).
    await expect(run('social.post', { platform: 'facebook', product: 'carebase', message: 'CareBase ensures compliance.', scheduledFor: '2026-11-10T15:00:00Z' }).promise).rejects.toMatchObject({ code: 'post_check_compliance_assurance' });
    await expect(run('social.post', { platform: 'instagram', product: 'carebase', message, scheduledFor: '2026-11-10T15:00:00Z' }).promise).rejects.toMatchObject({ code: 'image_missing' });
  });

  it('publishes a post whose link is a product page with campaign tags, and refuses a link to anything else', async () => {
    const tagged = 'https://cmcarebase.com/pa-training-requirements?utm_source=facebook&utm_medium=social&utm_campaign=social-carebase&utm_content=post';
    const post = { platform: 'facebook', product: 'carebase', message, link: tagged, scheduledFor: '2026-11-10T15:30:00.000Z' };
    const { meta, promise } = run('social.post', post);
    expect(await promise).toMatchObject({ published: true });
    expect(meta.publishPost).toHaveBeenCalledWith(expect.objectContaining({ link: tagged }));
    for (const link of [
      'https://evil.example/',
      'https://cmcarebase.com/somewhere-else',
      `${tagged}&next=https://evil.example`,
      'https://www.caremetricintel.com/?utm_source=facebook&utm_medium=social&utm_campaign=social-intel',
    ]) {
      const refused = run('social.post', { ...post, link });
      await expect(refused.promise, link).rejects.toMatchObject({ code: 'post_check_link' });
      expect(refused.meta.publishPost).not.toHaveBeenCalled();
    }
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
    // A headline at LinkedIn's length starts on LinkedIn and is still refused on Meta, whose feed cuts it off at 40 characters.
    const longHeadline = 'Keep staff training and survey records in one place';
    expect(await run('social.ad_create', { ...ad, headline: longHeadline }).promise).toEqual({ created: true, id: '820009' });
    await expect(run('social.ad_create', { ...ad, platform: undefined, adsetId: '120200000000001', headline: longHeadline }).promise).rejects.toMatchObject({ code: 'invalid_ad' });
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
    const asset = { id: assetId, token: 'f'.repeat(64), status: 'approved', product: 'caremetric-intel', platform: 'meta', kind: 'static', placement: 'meta.feed_square',
      primaryText: 'CareMetric Intel brings targeted marketing and territory analysis into one place for your team.', headline: 'Territory plans', description: 'Free trial', landingUrl: link, cta: 'Start free trial', overlay: {} };
    const store = { creativeLiveAssets: vi.fn(async () => [asset]) };
    const executors = socialExecutors({ meta, settings: {}, now, log: () => {}, creative, store, publicOrigin: 'https://help.caremetric.ai' });
    const input = { adsetId: '120200000000001', name: 'Ad', message: 'CareMetric Intel brings targeted marketing and territory analysis into one place for your team.', headline: 'Territory plans',
      description: 'Free trial', link, imageHash: null, imageUrl: image, callToAction: 'SIGN_UP', product: 'caremetric-intel', creativeAssetId: assetId };
    expect(await executors['social.ad_create']({ id: 'a1', kind: 'social.ad_create', input, targetId: '', agentKey: 'social_manager' })).toEqual({ created: true, id: '90' });
    expect(meta.createAd).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: image, link }));
    expect(creative.live).toHaveBeenCalledWith(assetId, '90');
    for (const patch of [{ status: 'retired' }, { primaryText: 'Changed after approval' }, { token: 'e'.repeat(64) }, { landingUrl: 'https://www.caremetricintel.com/county-report' }, { cta: 'Learn more' }, { platform: 'linkedin' }]) {
      meta.createAd.mockClear();
      store.creativeLiveAssets.mockResolvedValue([{ ...asset, ...patch }]);
      await expect(executors['social.ad_create']({ id: 'a2', input })).rejects.toMatchObject({ code: 'ad_creative_changed' });
      expect(meta.createAd).not.toHaveBeenCalled();
    }
    store.creativeLiveAssets.mockResolvedValue([{ id: assetId, status: 'approved' }]);
    await expect(executors['social.ad_create']({ id: 'a3', input })).rejects.toMatchObject({ code: 'ad_creative_changed' });

  });

  it('never fails a publish because the asset could not be marked live', async () => {
    const meta = metaOf();
    const creative = { live: vi.fn(async () => { throw new Error('down'); }) };
    const executors = socialExecutors({ meta, settings: {}, now, log: () => {}, creative });
    const input = { platform: 'instagram', product: 'caremetric-intel', message, link: null, imageUrl: image, scheduledFor: now().toISOString(), creativeAssetId: assetId };
    expect(await executors['social.post']({ id: 'a1', kind: 'social.post', input, agentKey: 'social_manager' })).toEqual({ published: true, id: '1111_99' });
    expect(creative.live).toHaveBeenCalled();
  });

  it('publishes nothing from creative whose price, offer or trial wording changed after it was approved', async () => {
    const meta = metaOf({ publishStory: vi.fn(async () => ({ id: '1790000' })) });
    const asset = { id: assetId, token: 'f'.repeat(64), status: 'approved', product: 'caremetric-intel', platform: 'meta', kind: 'static', placement: 'meta.feed_square',
      primaryText: 'CareMetric Intel brings targeted marketing and territory analysis into one place for your team.', headline: 'Territory plans', description: 'Free trial', landingUrl: link,
      cta: 'Start free trial', overlay: { beats: ['Try Intel free for 14 days'] } };
    const store = { creativeLiveAssets: vi.fn(async () => [asset]) };
    const executors = socialExecutors({ meta, settings: {}, now, log: () => {}, creative: { live: vi.fn(async () => true) }, store, publicOrigin: 'https://help.caremetric.ai' });
    const post = { platform: 'instagram', product: 'caremetric-intel', message, link: null, imageUrl: image, scheduledFor: now().toISOString(), creativeAssetId: assetId };
    await expect(executors['social.post']({ id: 'p1', kind: 'social.post', input: post, agentKey: 'social_manager' })).rejects.toMatchObject({ code: 'post_creative_outdated' });
    const story = { ...post, pillar: 'story', format: 'story', message: '' };
    await expect(executors['social.post']({ id: 'p2', kind: 'social.post', input: story, agentKey: 'social_manager' })).rejects.toMatchObject({ code: 'post_creative_outdated' });
    expect(store.creativeLiveAssets).toHaveBeenCalledWith(['caremetric-intel']);
    expect(meta.publishPost).not.toHaveBeenCalled();
    expect(meta.publishStory).not.toHaveBeenCalled();
    const ad = { adsetId: '120200000000001', name: 'Ad', message: asset.primaryText, headline: 'Territory plans', description: 'Free trial', link, imageHash: null, imageUrl: image,
      callToAction: 'SIGN_UP', product: 'caremetric-intel', creativeAssetId: assetId };
    await expect(executors['social.ad_create']({ id: 'a1', kind: 'social.ad_create', input: ad, targetId: '' })).rejects.toMatchObject({ code: 'ad_creative_outdated' });
    expect(meta.createAd).not.toHaveBeenCalled();
    // The same creative with the current terms goes out.
    store.creativeLiveAssets.mockResolvedValue([{ ...asset, overlay: { beats: ['Start your 30-day free trial.'] } }]);
    expect(await executors['social.post']({ id: 'p3', kind: 'social.post', input: post, agentKey: 'social_manager' })).toEqual({ published: true, id: '1111_99' });
  });
});

describe('stories and article links', () => {
  const image = `https://help.caremetric.ai/api/creative/a/${'e'.repeat(64)}.png`;
  const story = (over = {}) => ({ platform: 'instagram', product: 'caremetric-intel', pillar: 'story', format: 'story', message: '', link: null, imageUrl: image,
    scheduledFor: now().toISOString(), creativeAssetId: '22222222-2222-4222-8222-222222222222', ...over });

  it('publishes an approved story image on Instagram or the Facebook Page, with no text or link', async () => {
    const meta = metaOf({ publishStory: vi.fn(async () => ({ id: '1790000' })) });
    const creative = { live: vi.fn(async () => true) };
    const executors = socialExecutors({ meta, settings: {}, now, log: () => {}, creative });
    expect(await executors['social.post']({ id: 'a1', kind: 'social.post', input: story(), agentKey: 'social_manager' })).toEqual({ published: true, id: '1790000', story: true });
    expect(meta.publishStory).toHaveBeenCalledWith({ platform: 'instagram', imageUrl: image });
    expect(meta.publishPost).not.toHaveBeenCalled();
    expect(creative.live).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', '1790000');
    for (const bad of [story({ message: 'Text' }), story({ link: 'https://www.caremetricintel.com/' }), story({ imageUrl: 'http://x.test/a.png' })]) {
      await expect(executors['social.post']({ id: 'a2', kind: 'social.post', input: bad, agentKey: 'social_manager' })).rejects.toMatchObject({ code: 'invalid_post' });
    }
    // LinkedIn has no stories.
    await expect(socialExecutors({ meta, linkedin: { configured: { page: true } }, settings: {}, now, log: () => {} })['social.post']({ id: 'a3', kind: 'social.post', input: story({ platform: 'linkedin' }),
      agentKey: 'social_manager' })).rejects.toMatchObject({ code: 'invalid_post' });
    expect(meta.publishStory).toHaveBeenCalledTimes(1);
  });

  it('lets a post link to the product\'s own published article, and nothing else outside its pages', async () => {
    const article = 'https://www.caremetricintel.com/resources/county-market-basics';
    const input = { platform: 'facebook', product: 'caremetric-intel', message: 'A short guide to reading your county\'s market.', link: article, imageUrl: null, scheduledFor: now().toISOString() };
    const { meta, promise } = run('social.post', input);
    expect(await promise).toEqual({ published: true, id: '1111_99' });
    expect(meta.publishPost).toHaveBeenCalledWith(expect.objectContaining({ link: article }));
    await expect(run('social.post', { ...input, link: 'https://www.caremetricintel.com/elsewhere/county-market-basics' }).promise).rejects.toMatchObject({ code: 'post_check_link' });
    await expect(run('social.post', { ...input, product: 'carebase' }).promise).rejects.toMatchObject({ code: 'post_check_link' });
  });
});

describe('the founder\'s own posts', () => {
  const message = 'Most agencies I talk to plan visits from memory. Writing down which referral sources you saw last month changes the week.';
  const input = { product: 'caremetric-intel', pillar: 'tip', message, scheduledFor: now().toISOString() };
  it('publishes on the founder\'s profile only when the owner approved it, with the exact checked words', async () => {
    const linkedin = linkedinOf({ configured: { page: true, ads: true, member: true }, publishMemberPost: vi.fn(async () => ({ id: 'urn:li:share:7300000000000000001' })) });
    const executors = socialExecutors({ meta: metaOf(), linkedin, settings: {}, now, log: () => {} });
    const action = over => ({ id: 'a1', kind: 'social.founder_post', input, agentKey: 'social_manager', targetId: 'founder:2026-11-09:1', ...over });
    expect(await executors['social.founder_post'](action())).toEqual({ published: true, id: 'urn:li:share:7300000000000000001', founder: true });
    expect(linkedin.publishMemberPost).toHaveBeenCalledWith({ message });
    await expect(executors['social.founder_post'](action({ autoApproved: true }))).rejects.toMatchObject({ code: 'approval_required' });
    await expect(executors['social.founder_post'](action({ input: { ...input, message: 'Book a call with me today.' } }))).rejects.toMatchObject({ code: 'post_check_meeting_offer' });
    const unconnected = socialExecutors({ meta: metaOf(), linkedin: linkedinOf(), settings: {}, now, log: () => {} });
    await expect(unconnected['social.founder_post'](action())).rejects.toMatchObject({ code: 'linkedin_not_configured' });
  });

  it('publishes one approved automatically only while the owner has handed founder posts over, checked just before it goes', async () => {
    const linkedin = linkedinOf({ configured: { page: true, ads: true, member: true }, publishMemberPost: vi.fn(async () => ({ id: 'urn:li:share:7300000000000000002' })) });
    const action = over => ({ id: 'a2', kind: 'social.founder_post', input, agentKey: 'social_manager', targetId: 'founder:2026-11-09:2', autoApproved: true, execution: 4, ...over });
    // The database has the hand-over and still trusts the Social Media Manager with founder posts: it publishes, at its slot, the checked words.
    const trusted = { actionTrusted: vi.fn(async () => true) };
    const handedOver = socialExecutors({ meta: metaOf(), linkedin, settings: {}, now, log: () => {}, store: trusted, handover: true });
    expect(await handedOver['social.founder_post'](action())).toEqual({ published: true, id: 'urn:li:share:7300000000000000002', founder: true });
    expect(trusted.actionTrusted).toHaveBeenCalledWith('a2', 4);
    await expect(handedOver['social.founder_post'](action({ input: { ...input, scheduledFor: '2026-11-11T12:50:00Z' } }))).rejects.toMatchObject({ code: 'action_deferred' });
    await expect(handedOver['social.founder_post'](action({ input: { ...input, message: 'Book a call with me today.' } }))).rejects.toMatchObject({ code: 'post_check_meeting_offer' });
    // Held again (or paused, or off Act) since it was approved: it waits for the owner instead of publishing.
    const held = socialExecutors({ meta: metaOf(), linkedin, settings: {}, now, log: () => {}, store: { actionTrusted: vi.fn(async () => false) }, handover: true });
    await expect(held['social.founder_post'](action())).rejects.toMatchObject({ code: 'approval_required' });
    // Without the hand-over in the database, or without a way to check it, nothing approved automatically is published.
    await expect(socialExecutors({ meta: metaOf(), linkedin, settings: {}, now, log: () => {}, store: trusted })['social.founder_post'](action())).rejects.toMatchObject({ code: 'approval_required' });
    await expect(socialExecutors({ meta: metaOf(), linkedin, settings: {}, now, log: () => {}, handover: true })['social.founder_post'](action())).rejects.toMatchObject({ code: 'approval_required' });
    expect(linkedin.publishMemberPost).toHaveBeenCalledTimes(1);
    // Without the founder's personal token it is not published at all (the weekly plan emails such posts to copy instead).
    const unconnected = socialExecutors({ meta: metaOf(), linkedin: linkedinOf(), settings: {}, now, log: () => {}, store: trusted, handover: true });
    await expect(unconnected['social.founder_post'](action())).rejects.toMatchObject({ code: 'linkedin_not_configured' });
  });
});

describe('why a post or reply was refused just before it went out', () => {
  it('says which check refused it, and that the words changed when they pass but would change', async () => {
    const sentence = Array.from({ length: 31 }, (_, index) => `word${index}`).join(' ');
    await expect(run('social.post', { platform: 'facebook', product: 'carebase', message: `${sentence}.`, scheduledFor: '2026-11-10T15:00:00Z' }).promise)
      .rejects.toMatchObject({ code: 'post_check_long_sentence' });
    // Approved with two spaces: the check would publish it with one, which is not the text that was approved.
    await expect(run('social.post', { platform: 'facebook', product: 'carebase', message: message.replace(' ', '  '), scheduledFor: '2026-11-10T15:00:00Z' }).promise)
      .rejects.toMatchObject({ code: 'post_check_changed' });
    const reply = { platform: 'messenger', kind: 'message', id: 'm_1', parentId: 't_1', message: 'Thanks for asking! 🎉🎉🎉🎉', product: 'carebase' };
    await expect(run('social.reply', reply).promise).rejects.toMatchObject({ code: 'reply_check_emoji' });
  });

  it('has words on the owner\'s screen for every reason the checks can give', async () => {
    const { readFile } = await import('node:fs/promises');
    const { writingCheckReasons, errorLabel } = await import('../../../src/admin/teamProtocol.ts');
    const { longestSentence } = await import('../content/validate.mjs');
    const source = async path => readFile(new URL(path, import.meta.url), 'utf8');
    const social = await source('./content.mjs');
    // The checks checkSocialText runs: the claim rules, textProblems and unclearCopy (not the Markdown checks that follow them).
    const validateAll = await source('../content/validate.mjs');
    const validate = validateAll.slice(0, validateAll.indexOf('// ---- Links and markup'));
    const reasons = new Set([
      ...[...social.matchAll(/reason: '([a-z_]+)'/g)].map(match => match[1]),
      ...[...validate.matchAll(/reasons\.add\('([a-z_]+)'\)/g)].map(match => match[1]),
      ...[...validate.slice(validate.indexOf('const claimRules = ['), validate.indexOf('];', validate.indexOf('const claimRules = [')))
        .matchAll(/^\s*\['([a-z_]+)',/gm)].map(match => match[1]),
    ]);
    expect(reasons.size).toBeGreaterThan(25);
    for (const reason of reasons) expect(writingCheckReasons[reason], reason).toBeTruthy();
    expect(writingCheckReasons.long_sentence).toContain(`over ${longestSentence} words`);
    expect(errorLabel('post_check_trial_terms')).toMatch(/^The post no longer passes the writing check .* so it was not published: it says the Intel trial needs a credit card to start/);
    expect(errorLabel('reply_check_link')).toMatch(/^The reply no longer passes the writing check, so it was not sent: it links somewhere other/);
    expect(errorLabel('post_check_some_new_rule')).toContain('some new rule');
    expect(errorLabel('invalid_post')).not.toBe('invalid_post');
  });
});

describe('reach outside cold email (team review 2026-11-17, stage 6)', () => {
  const post = { platform: 'linkedin', product: 'carebase', message, link: 'https://cmcarebase.com/pa-training-requirements?utm_source=linkedin&utm_medium=social&utm_campaign=social-carebase&utm_content=post-20261109-linkedin-1', linkLabel: 'PA training requirements', scheduledFor: '2026-11-10T15:30:00.000Z' };
  const refusing = code => linkedinOf({ publishPost: vi.fn(async () => { throw Object.assign(new Error('refused'), { code }); }) });

  it('emails a LinkedIn post LinkedIn refused at publishing to paste, its link included, and still fails it', async () => {
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    const { promise } = run('social.post', post, { linkedin: refusing('linkedin_permission'), settings: { reach: true }, notifier });
    await expect(promise).rejects.toMatchObject({ code: 'linkedin_permission' });
    const sent = notifier.send.mock.calls[0][0];
    expect(sent).toMatchObject({ severity: 'warning', subject: 'A LinkedIn post to paste: LinkedIn refused the team', dedupeKey: 'social:linkedin:paste:a1' });
    expect(sent.blocks[2]).toEqual({ type: 'message', text: `${message}\n\n${post.link}` });
    // Codex review 2026-11-20: custom blocks replace the body in the email, so the email itself must say how to reconnect.
    const email = renderOwnerEmail({ ...sent, publicOrigin: 'https://help.caremetric.ai' });
    expect(email.html).toContain('Reconnect LinkedIn (Settings → Social media)');
    expect(email.html).toContain('Paste this on the LinkedIn Page:');
  });

  // Review 2026-11-20: the founder posts of November 17 and 19 failed with linkedin_token_invalid, and nobody was told.
  it('emails a post for the founder\'s profile LinkedIn refused to paste, says how to renew the personal token, and still fails it', async () => {
    const founderMessage = 'Most agencies I talk to plan visits from memory. Writing down which referral sources you saw last month changes the week.';
    const action = { id: 'f1', kind: 'social.founder_post', agentKey: 'social_manager', taskId: 't9', targetId: 'founder:2026-11-19:1',
      input: { product: 'caremetric-intel', pillar: 'tip', message: founderMessage, scheduledFor: now().toISOString() } };
    const memberRefusing = code => linkedinOf({ configured: { page: true, ads: true, member: true }, publishMemberPost: vi.fn(async () => { throw Object.assign(new Error('refused'), { code }); }) });
    for (const code of ['linkedin_token_invalid', 'linkedin_permission']) {
      const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
      const executors = socialExecutors({ meta: metaOf(), linkedin: memberRefusing(code), settings: { reach: true }, notifier, now, log: () => {} });
      await expect(executors['social.founder_post'](action)).rejects.toMatchObject({ code });
      const sent = notifier.send.mock.calls[0][0];
      expect(sent).toMatchObject({ severity: 'warning', attention: 'now', dedupeKey: 'social:linkedin:founder-paste:f1', taskId: 't9' });
      expect(sent.blocks.slice(1)).toEqual([{ type: 'paragraph', text: 'Paste this on your LinkedIn profile:' }, { type: 'message', text: founderMessage }]);
      // The email itself, not only the notice's body, says the token lasts 60 days and where to save a new one.
      const email = renderOwnerEmail({ ...sent, publicOrigin: 'https://help.caremetric.ai' });
      for (const words of ['last 60 days', 'LinkedIn connection card (Settings → Social media)', 'Paste this on your LinkedIn profile:']) expect(email.html).toContain(words);
    }
    // Any other failure, or without the feature, says nothing new.
    for (const [code, settings] of [['linkedin_unavailable', { reach: true }], ['linkedin_token_invalid', {}]]) {
      const notifier = { send: vi.fn(async () => []) };
      const executors = socialExecutors({ meta: metaOf(), linkedin: memberRefusing(code), settings, notifier, now, log: () => {} });
      await expect(executors['social.founder_post'](action)).rejects.toMatchObject({ code });
      expect(notifier.send).not.toHaveBeenCalled();
    }
  });

  it('says nothing for any other failure, or without the feature', async () => {
    for (const [code, settings] of [['linkedin_unavailable', { reach: true }], ['linkedin_permission', {}]]) {
      const notifier = { send: vi.fn(async () => []) };
      await expect(run('social.post', post, { linkedin: refusing(code), settings, notifier }).promise).rejects.toMatchObject({ code });
      expect(notifier.send).not.toHaveBeenCalled();
    }
  });
});
