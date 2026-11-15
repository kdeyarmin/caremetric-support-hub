import { describe, expect, it, vi } from 'vitest';
import { slotFor, socialHandlers } from './tasks.mjs';
import { socialConfig, socialTeam } from './index.mjs';
import { catalogBlocks } from '../content/features.mjs';

const canary = 'CANARY-9d41e7';
const now = () => new Date('2026-11-09T13:15:00Z'); // Monday 08:15 Eastern
const task = (kind, over = {}) => ({ id: 't1', agentKey: 'social_manager', kind, attempts: 1, sourceKind: 'schedule', requestKey: 'x', agent: { autonomy: 'propose', config: {} }, payload: {}, ...over });
const metaOf = (over = {}) => ({
  configured: { pages: true, instagram: true, ads: true },
  recentPosts: vi.fn(async () => [{ platform: 'facebook', id: 'p1', text: 'Which training is due next? Tell us below.', at: '2026-11-05T15:00:00Z', reactions: 12, comments: 5, shares: 2, url: 'https://facebook.com/p1' }]),
  recentInbox: vi.fn(async () => []),
  readItem: vi.fn(async () => ({ text: `How much is CareBase? ${canary}`, fromPage: false, answered: false, history: [] })),
  adsOverview: vi.fn(async () => ({ adsets: [], ads: [], current: [], previous: [] })),
  ...over,
});
const linkedinPost = 'urn:li:share:7100000000000000001';
const linkedinComment = 'urn:li:comment:(urn:li:activity:7100000000000000009,7200000000000000002)';
const linkedinOf = (over = {}) => ({
  configured: { page: true, ads: true },
  recentPosts: vi.fn(async () => [{ platform: 'linkedin', id: linkedinPost, text: 'Referral sources you can see in one place.', at: '2026-11-04T13:45:00Z', reactions: 9, comments: 2, shares: 0, url: 'https://www.linkedin.com/feed/update/x/' }]),
  recentInbox: vi.fn(async () => []),
  readItem: vi.fn(async () => ({ text: `Does this work for hospice? ${canary}`, fromPage: false, answered: false, history: [] })),
  adsOverview: vi.fn(async () => ({ adsets: [], ads: [], current: [], previous: [] })),
  ...over,
});
const harness = ({ meta = metaOf(), linkedin = null, model = null, customerTextToAi = false, settings = {}, imageUrls = ['https://cdn.example.com/brand-1.jpg'], openTargets = [], marketed = null, creative = null, videos = false } = {}) => {
  const sent = [];
  let next = 0;
  const store = {
    ...(videos ? { socialVideoStage: vi.fn() } : {}),
    socialOpenTargets: vi.fn(async () => openTargets), socialSchedule: vi.fn(async () => true), notificationCount: vi.fn(async () => 0),
    proposeAction: vi.fn(async () => ({ id: `a${++next}`, status: 'proposed', created: true })), enqueue: vi.fn(async () => `task-${++next}`),
    startRun: vi.fn(async () => 'r'), finishRun: vi.fn(async () => undefined),
  };
  const notifier = { send: vi.fn(async input => { sent.push(input); return [{ channel: 'email', delivery: 'sent' }]; }) };
  const handlers = socialHandlers({ store, notifier, model, meta, linkedin, settings, imageUrls, customerTextToAi, publicOrigin: 'https://help.caremetric.ai', marketed, log: () => {}, creative });
  return { store, notifier, sent, meta, linkedin, handlers };
};
const modelReturning = output => ({ configured: true, run: vi.fn(async () => ({ outcome: 'completed', output })) });

describe('the weekly social plan', () => {
  const posts = [
    { platform: 'facebook', product: 'carebase', pillar: 'tip', day: 2, text: 'Annual training hours piling up? Keep each staff member\'s training in one place.', linkId: 'carebase-training-requirements', hashtags: ['PersonalCareHome'] },
    { platform: 'instagram', product: 'caremetric-intel', pillar: 'engagement', day: 3, text: 'Which county is your team focusing on this month? Link in bio.', linkId: '', hashtags: ['HomeHealth', 'Hospice'] },
    { platform: 'facebook', product: 'carebase', pillar: 'offer', day: 4, text: 'CareBase ensures compliance in every home.', linkId: '', hashtags: [] },
    { platform: 'linkedin', product: 'caremetric-intel', pillar: 'capability', day: 2, text: 'CareMetric Intel keeps outreach, follow-up and recorded referrals in one place.', linkId: 'intel-home', hashtags: ['HomeHealth'] },
    { platform: 'facebook', product: 'carebase', pillar: 'tip', day: 5, text: 'See https://example.org', linkId: 'not-a-page', hashtags: [] },
  ];

  it('tags a product link the model wrote into a post\'s text, replacing any tags it wrote', async () => {
    const model = modelReturning({ posts: [{ platform: 'facebook', product: 'carebase', pillar: 'offer', day: 2, text: 'Start a 30-day free trial: https://cmcarebase.com/signup?utm_source=x&utm_medium=y&utm_campaign=z', linkId: '', hashtags: [] }] });
    const h = harness({ model });
    await h.handlers['social.plan'](task('social.plan'), { now });
    expect(h.store.proposeAction.mock.calls[0][0].input).toMatchObject({ link: null,
      message: 'Start a 30-day free trial: https://cmcarebase.com/signup?utm_source=facebook&utm_medium=social&utm_campaign=social-carebase&utm_content=post' });
  });

  it('proposes checked Facebook and Instagram posts held for their time slots, and emails LinkedIn posts to paste', async () => {
    const model = modelReturning({ posts });
    const h = harness({ model });
    const outcome = await h.handlers['social.plan'](task('social.plan'), { now });
    const request = model.run.mock.calls[0][1];
    expect(request.promptVersion).toBe('social-plan.7');
    // Each marketed product's published catalog follows the prompt (content/features.mjs).
    expect(request.system.slice(1)).toEqual(catalogBlocks(JSON.parse(request.user).products));
    expect(request.system.length).toBeGreaterThan(1);
    expect(JSON.parse(request.user)).toMatchObject({ weekStarting: '2026-11-09', postsToWrite: { facebook: 4, instagram: 3, linkedin: 4 }, bestRecent: [{ platform: 'facebook', engagement: 28 }] });
    expect(h.store.proposeAction).toHaveBeenCalledTimes(2);
    const [facebook, instagram] = h.store.proposeAction.mock.calls.map(call => call[0]);
    expect(facebook).toMatchObject({ kind: 'social.post', targetKind: 'social_post', targetId: 'facebook:2026-11-09:1',
      input: { platform: 'facebook', product: 'carebase', link: 'https://cmcarebase.com/pa-training-requirements?utm_source=facebook&utm_medium=social&utm_campaign=social-carebase&utm_content=post', scheduledFor: '2026-11-10T15:30:00.000Z', imageUrl: null } });
    expect(facebook.input.message).toMatch(/#PersonalCareHome$/);
    expect(instagram).toMatchObject({ targetId: 'instagram:2026-11-09:1', input: { platform: 'instagram', link: null, imageUrl: 'https://cdn.example.com/brand-1.jpg', scheduledFor: '2026-11-11T17:15:00.000Z' } });
    expect(h.store.socialSchedule.mock.calls).toEqual([['a1', null], ['a2', null]]);
    expect(h.sent[0]).toMatchObject({ subject: 'Social plan: 2 posts to approve', dedupeKey: 'social:plan:2026-11-09' });
    expect(JSON.stringify(h.sent[0].blocks)).toContain('CareMetric Intel keeps outreach, follow-up and recorded referrals in one place.\\n\\nhttps://www.caremetricintel.com/?utm_source=linkedin&utm_medium=social&utm_campaign=social-intel&utm_content=post\\n\\n#HomeHealth');
    expect(outcome).toMatchObject({ status: 'awaiting_approval', result: { proposed: 2, linkedin: 1, rejected: { compliance_assurance: 1, link: 1 } } });
  });

  it('plans once a week unless the owner asks, and needs a model', async () => {
    const h = harness({ model: modelReturning({ posts }) });
    h.store.notificationCount.mockResolvedValue(1);
    expect((await h.handlers['social.plan'](task('social.plan'), { now })).result).toEqual({ skipped: 'already_planned', week: '2026-11-09' });
    expect((await h.handlers['social.plan'](task('social.plan', { sourceKind: 'owner' }), { now })).result.proposed).toBe(2);
    expect((await harness().handlers['social.plan'](task('social.plan'), { now })).result).toEqual({ skipped: 'model_not_configured' });
  });

  it('skips Instagram without images, and never proposes a target that is still open', async () => {
    const h = harness({ model: modelReturning({ posts }), imageUrls: [], openTargets: ['social.post:facebook:2026-11-09:1'] });
    const outcome = await h.handlers['social.plan'](task('social.plan'), { now });
    expect(h.store.proposeAction).not.toHaveBeenCalled();
    expect(outcome.result.proposed).toBe(0);
  });

  it('with LinkedIn connected, proposes LinkedIn posts too (the link beside the text, as a card) and learns from their engagement', async () => {
    const model = modelReturning({ posts });
    const linkedin = linkedinOf();
    const h = harness({ model, linkedin });
    const outcome = await h.handlers['social.plan'](task('social.plan'), { now });
    expect(linkedin.recentPosts).toHaveBeenCalled();
    expect(JSON.parse(model.run.mock.calls[0][1].user).bestRecent.map(post => post.platform)).toEqual(['facebook', 'linkedin']);
    const proposed = h.store.proposeAction.mock.calls.map(call => call[0]);
    expect(proposed.map(call => call.targetId)).toEqual(['facebook:2026-11-09:1', 'instagram:2026-11-09:1', 'linkedin:2026-11-09:1']);
    expect(proposed[2]).toMatchObject({ kind: 'social.post', input: { platform: 'linkedin', product: 'caremetric-intel', link: 'https://www.caremetricintel.com/?utm_source=linkedin&utm_medium=social&utm_campaign=social-intel&utm_content=post', linkLabel: expect.any(String),
      scheduledFor: '2026-11-10T13:45:00.000Z', imageUrl: 'https://cdn.example.com/brand-1.jpg' } });
    expect(proposed[2].preview).toContain('Image: https://cdn.example.com/brand-1.jpg');
    expect(proposed[2].input.message).not.toContain('https://');
    expect(outcome.result).toMatchObject({ proposed: 3, linkedin: 0 });
    expect(JSON.stringify(h.sent[0].blocks)).not.toContain('LinkedIn post 1');
  });

  it('schedules each post at least an hour ahead and within the week', () => {
    expect(slotFor({ week: '2026-11-09', day: 1, platform: 'facebook', now: new Date('2026-11-09T15:00:00Z') })).toBe('2026-11-10T15:30:00.000Z');
    expect(slotFor({ week: '2026-11-09', day: 7, platform: 'instagram', now: now() })).toBe('2026-11-15T17:15:00.000Z');
  });
});

describe('comments and messages', () => {
  const item = { platform: 'facebook', kind: 'comment', id: '1_10', parentId: '1111_1', url: 'https://facebook.com/c/10' };

  it('gives each new comment or message its own task, by id only, and tells the owner once', async () => {
    const meta = metaOf({ recentInbox: vi.fn(async () => [item, { platform: 'messenger', kind: 'message', id: 'm_1', parentId: 't_1', url: null }]) });
    const h = harness({ meta });
    const outcome = await h.handlers['social.inbox'](task('social.inbox'), { now });
    expect(h.store.enqueue.mock.calls[0]).toEqual(['social_manager', 'social.interaction', 'social:facebook:comment:1_10',
      { payload: item, priority: 4, sourceKind: 'agent', sourceRef: 'facebook:comment' }]);
    expect(outcome.result).toEqual({ seen: 2, enqueued: 2, comments: 1, messages: 1 });
    expect(h.sent[0].subject).toBe('2 new social comments and messages');
  });

  it('reads whether Meta is connected on each run, so a Page connected in Settings is used without a restart', async () => {
    const meta = metaOf({ configured: { pages: false, instagram: false, ads: false }, recentInbox: vi.fn(async () => [item]) });
    const h = harness({ meta });
    expect((await h.handlers['social.inbox'](task('social.inbox'), { now })).result).toEqual({ skipped: 'meta_not_configured' });
    meta.configured = { pages: true, instagram: false, ads: false };
    expect((await h.handlers['social.inbox'](task('social.inbox'), { now })).result).toEqual({ seen: 1, enqueued: 1, comments: 1, messages: 0 });
  });

  it('warns the owner once a day when Meta refuses the token', async () => {
    const meta = metaOf({ recentInbox: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'meta_token_invalid' }); }) });
    const h = harness({ meta });
    expect((await h.handlers['social.inbox'](task('social.inbox'), { now })).result).toEqual({ skipped: 'meta_token_invalid' });
    expect(h.sent[0]).toMatchObject({ severity: 'warning', dedupeKey: 'social:access:meta_token_invalid:2026-11-09' });
  });

  it('reads LinkedIn comments beside Meta\'s, and one platform refusing does not stop the other', async () => {
    const onLinkedIn = { platform: 'linkedin', kind: 'comment', id: linkedinComment, parentId: linkedinPost, url: 'https://www.linkedin.com/feed/update/x/' };
    const both = harness({ meta: metaOf({ recentInbox: vi.fn(async () => [item]) }), linkedin: linkedinOf({ recentInbox: vi.fn(async () => [onLinkedIn]) }) });
    expect((await both.handlers['social.inbox'](task('social.inbox'), { now })).result).toEqual({ seen: 2, enqueued: 2, comments: 2, messages: 0 });
    expect(both.store.enqueue.mock.calls[1][2]).toBe(`social:linkedin:comment:${linkedinComment}`);
    const refused = harness({ meta: metaOf({ recentInbox: vi.fn(async () => [item]) }),
      linkedin: linkedinOf({ recentInbox: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'linkedin_token_invalid' }); }) }) });
    expect((await refused.handlers['social.inbox'](task('social.inbox'), { now })).result).toEqual({ seen: 1, enqueued: 1, comments: 1, messages: 0, refused: ['linkedin_token_invalid'] });
    expect(refused.sent[0]).toMatchObject({ severity: 'warning', subject: 'The Social Media Manager cannot reach LinkedIn', dedupeKey: 'social:access:linkedin_token_invalid:2026-11-09' });
    expect(refused.sent[0].body).toContain('Settings → Social media → LinkedIn');
  });

  it('on LinkedIn, replies through LinkedIn and proposes deleting spam (LinkedIn has no hide), but never once deletions would be automatic', async () => {
    const onLinkedIn = { platform: 'linkedin', kind: 'comment', id: linkedinComment, parentId: linkedinPost, url: 'https://www.linkedin.com/feed/update/x/' };
    const reply = harness({ customerTextToAi: true, linkedin: linkedinOf(), model: modelReturning({ intent: 'question', possiblePhi: false, needsOwner: false, hide: false, product: 'caremetric-intel',
      reply: 'Yes, it is built for home health and hospice teams. You can start a 30-day free trial: https://www.caremetricintel.com/' }) });
    await reply.handlers['social.interaction'](task('social.interaction', { payload: onLinkedIn }), { now });
    expect(reply.linkedin.readItem).toHaveBeenCalled();
    expect(reply.meta.readItem).not.toHaveBeenCalled();
    expect(reply.store.proposeAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'social.reply', targetId: `linkedin:${linkedinComment}`,
      input: expect.objectContaining({ platform: 'linkedin', kind: 'comment', id: linkedinComment, parentId: linkedinPost }) }));
    const spamReading = { intent: 'spam', possiblePhi: false, needsOwner: false, hide: true, product: 'unknown', reply: '' };
    const spam = harness({ customerTextToAi: true, linkedin: linkedinOf(), model: modelReturning(spamReading) });
    await spam.handlers['social.interaction'](task('social.interaction', { payload: onLinkedIn }), { now });
    expect(spam.store.proposeAction.mock.calls[0][0]).toMatchObject({ kind: 'social.moderate', input: { operation: 'delete', platform: 'linkedin', id: linkedinComment, parentId: linkedinPost, reason: 'spam' } });
    expect(spam.store.proposeAction.mock.calls[0][0].preview).toMatch(/^Delete a LinkedIn comment/);
    const trusted = { autonomy: 'act', config: { auto_approve_kinds: ['social.reply', 'social.moderate'] } };
    const handedOver = harness({ customerTextToAi: true, linkedin: linkedinOf(), model: modelReturning(spamReading) });
    expect((await handedOver.handlers['social.interaction'](task('social.interaction', { payload: onLinkedIn, agent: trusted }), { now })).result).toMatchObject({ outcome: 'left_for_owner', reason: 'spam' });
    expect(handedOver.store.proposeAction).not.toHaveBeenCalled();
    const personal = harness({ customerTextToAi: true, model: modelReturning({}), linkedin: linkedinOf({ readItem: vi.fn(async () => ({ text: 'Dad\'s MRN 1234567', fromPage: false, answered: false, history: [] })) }) });
    expect((await personal.handlers['social.interaction'](task('social.interaction', { payload: onLinkedIn, agent: trusted }), { now })).result).toMatchObject({ outcome: 'left_for_owner', reason: 'personal_information' });
    expect(personal.store.proposeAction).not.toHaveBeenCalled();
    expect(personal.sent[0].body).toContain('Please delete it yourself');
    // A hidden Meta comment can be shown again, so hiding stays automatic once handed over.
    const meta = harness({ customerTextToAi: true, model: modelReturning(spamReading) });
    await meta.handlers['social.interaction'](task('social.interaction', { payload: item, agent: trusted }), { now });
    expect(meta.store.proposeAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'social.moderate', input: expect.objectContaining({ operation: 'hide' }) }));
    await expect(harness().handlers['social.interaction'](task('social.interaction', { payload: { ...onLinkedIn, kind: 'message' } }), { now })).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('drafts a checked reply when customer text may reach the model, and keeps no word of the comment', async () => {
    const model = modelReturning({ intent: 'pricing', possiblePhi: false, needsOwner: false, hide: false, product: 'carebase',
      reply: 'Thanks for asking. CareBase Core is $199 per facility per month, and you can start a 30-day free trial: https://cmcarebase.com/signup' });
    const h = harness({ model, customerTextToAi: true });
    const outcome = await h.handlers['social.interaction'](task('social.interaction', { payload: item }), { now });
    expect(model.run.mock.calls[0][1].user).toContain(`How much is CareBase? ${canary}`);
    expect(h.store.proposeAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'social.reply', targetKind: 'social_item', targetId: 'facebook:1_10',
      input: expect.objectContaining({ platform: 'facebook', kind: 'comment', id: '1_10', intent: 'pricing', product: 'carebase' }) }));
    // The reply's product link carries the Social Media Manager's tags for the platform it answers on.
    expect(h.store.proposeAction.mock.calls[0][0].input.message).toMatch(/free trial: https:\/\/cmcarebase\.com\/signup\?utm_source=facebook&utm_medium=social&utm_campaign=social-carebase&utm_content=reply$/);
    expect(outcome).toMatchObject({ status: 'awaiting_approval', result: { reply: 'drafted', intent: 'pricing' } });
    expect(JSON.stringify([h.store.proposeAction.mock.calls, h.sent, outcome])).not.toContain(canary);
  });

  it('leaves it to the owner without the switch, when the model says so, or when the draft fails a check', async () => {
    expect((await harness().handlers['social.interaction'](task('social.interaction', { payload: item }), { now })).result).toMatchObject({ outcome: 'left_for_owner', reason: 'customer_text_to_ai_off' });
    const owner = harness({ model: modelReturning({ intent: 'complaint', possiblePhi: false, needsOwner: true, hide: false, product: 'unknown', reply: '' }), customerTextToAi: true });
    expect((await owner.handlers['social.interaction'](task('social.interaction', { payload: item }), { now })).result).toMatchObject({ reason: 'needs_owner', intent: 'complaint' });
    const bad = harness({ model: modelReturning({ intent: 'question', possiblePhi: false, needsOwner: false, hide: false, product: 'carebase', reply: 'We guarantee you will pass.' }), customerTextToAi: true });
    expect((await bad.handlers['social.interaction'](task('social.interaction', { payload: item }), { now })).result).toMatchObject({ reason: 'draft_guarantee' });
    expect(bad.store.proposeAction).not.toHaveBeenCalled();
  });

  it('proposes hiding spam, and hiding a public comment with personal information before any model sees it', async () => {
    const spam = harness({ model: modelReturning({ intent: 'spam', possiblePhi: false, needsOwner: false, hide: true, product: 'unknown', reply: '' }), customerTextToAi: true });
    await spam.handlers['social.interaction'](task('social.interaction', { payload: item }), { now });
    expect(spam.store.proposeAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'social.moderate', input: expect.objectContaining({ operation: 'hide', reason: 'spam' }) }));
    const model = modelReturning({});
    const personal = harness({ model, customerTextToAi: true, meta: metaOf({ readItem: vi.fn(async () => ({ text: 'Mom\'s DOB 01/01/1900, MRN 1234567', fromPage: false, answered: false, history: [] })) }) });
    await personal.handlers['social.interaction'](task('social.interaction', { payload: item }), { now });
    expect(model.run).not.toHaveBeenCalled();
    expect(personal.store.proposeAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'social.moderate', input: expect.objectContaining({ reason: 'personal_information' }) }));
    expect(personal.sent[0]).toMatchObject({ severity: 'warning', subject: 'A Facebook comment may contain personal information' });
    expect(JSON.stringify(personal.sent)).not.toMatch(/1900|1234567/);
  });

  it('skips what was answered, deleted, its own or past the reply window', async () => {
    for (const [read, reason] of [[{ answered: true }, 'answered'], [{ gone: true }, 'gone'], [{ fromPage: true }, 'own']]) {
      const h = harness({ meta: metaOf({ readItem: vi.fn(async () => ({ text: 'x', history: [], ...read })) }) });
      expect((await h.handlers['social.interaction'](task('social.interaction', { payload: item }), { now })).result).toMatchObject({ outcome: 'skipped', reason });
    }
    const closed = harness({ meta: metaOf({ readItem: vi.fn(async () => ({ text: 'x', history: [], open: false, answered: false })) }) });
    expect((await closed.handlers['social.interaction'](task('social.interaction', { payload: { platform: 'messenger', kind: 'message', id: 'm_1', parentId: 't_1' } }), { now })).result.reason).toBe('window_closed');
    await expect(harness().handlers['social.interaction'](task('social.interaction', { payload: { platform: 'tiktok', kind: 'comment', id: '1' } }), { now })).rejects.toMatchObject({ code: 'invalid_payload' });
  });
});

describe('the daily ad review', () => {
  const overview = {
    adsets: [{ id: '40', name: 'PA operators', active: true, dailyBudget: 2000, objective: 'OUTCOME_LEADS' }],
    ads: [
      { id: '50', name: 'Training hook', adsetId: '40', active: true, createdAt: '2026-10-01T00:00:00Z', imageHash: 'img1', copy: { message: 'Track annual training hours across your homes.', headline: 'Start free', description: '30-day trial', link: 'https://cmcarebase.com/signup' } },
      { id: '51', name: 'Generic', adsetId: '40', active: true, createdAt: '2026-10-01T00:00:00Z', imageHash: 'img2', copy: { message: 'Software for care homes.', headline: 'Learn more', description: '', link: 'https://cmcarebase.com/' } },
    ],
    current: [{ adId: '50', impressions: 6000, clicks: 120, spendCents: 4000, frequency: 1.6, results: 5 }, { adId: '51', impressions: 6000, clicks: 20, spendCents: 3500, frequency: 1.6, results: 0 }],
    previous: [],
  };

  it('proposes pausing the loser and new copy for the ad set it leaves with one ad, using the winner\'s image', async () => {
    const model = modelReturning({ variants: [
      { angle: 'survey readiness', message: 'Getting ready for your next DHS inspection? CareBase keeps staff training, resident records and survey documentation in one place.', headline: 'Try CareBase free', description: '30-day free trial', callToAction: 'SIGN_UP' },
      { angle: 'bad', message: 'Are you struggling with debt? CareBase is the answer for every home in Pennsylvania today.', headline: 'Try it', description: 'Free', callToAction: 'LEARN_MORE' },
    ] });
    const h = harness({ model, meta: metaOf({ adsOverview: vi.fn(async () => overview) }) });
    const outcome = await h.handlers['social.ads'](task('social.ads'), { now });
    const calls = h.store.proposeAction.mock.calls.map(call => call[0]);
    expect(calls[0]).toMatchObject({ kind: 'social.ad_pause', targetKind: 'social_ad', targetId: '51', input: { adId: '51', adsetId: '40' } });
    expect(calls[0].preview).toMatch(/^Pause the Meta ad "Generic" in the ad set "PA operators": it spent \$35\.00 in 7 days with no result\.$/);
    expect(calls[1]).toMatchObject({ kind: 'social.ad_create', targetKind: 'social_adset', targetId: '40:2026-11-09:1',
      input: { adsetId: '40', imageHash: 'img1', link: 'https://cmcarebase.com/signup?utm_source=facebook&utm_medium=paid_social&utm_campaign=social-carebase&utm_content=ad', callToAction: 'SIGN_UP', product: 'carebase', basedOn: '50' } });
    expect(outcome.result).toMatchObject({ pause: 1, create: 1, rejected: 1, budget: 0 });
    // Done, not waiting: an undecided proposal must never stop tomorrow's review from pausing a losing ad.
    expect(outcome.status).toBe('done');
    expect(h.sent[0]).toMatchObject({ subject: 'Ad review: 2 changes to approve', dedupeKey: 'social:ads:2026-11-09' });
  });

  it('proposes a measured budget increase only under the owner\'s cap, and nothing twice', async () => {
    const winning = { ...overview, current: [{ ...overview.current[0] }, { adId: '51', impressions: 6000, clicks: 110, spendCents: 3000, frequency: 1.6, results: 4 }] };
    const h = harness({ settings: { targetCostCents: 2000, maxDailyBudgetCents: 3000 }, meta: metaOf({ adsOverview: vi.fn(async () => winning) }) });
    await h.handlers['social.ads'](task('social.ads'), { now });
    expect(h.store.proposeAction.mock.calls[0][0]).toMatchObject({ kind: 'social.ad_budget', targetId: '40', input: { adsetId: '40', from: 2000, to: 2400 } });
    expect(h.store.proposeAction.mock.calls[0][0].preview).toContain('Only you can approve a budget change.');
    const again = harness({ settings: { targetCostCents: 2000, maxDailyBudgetCents: 3000 }, openTargets: ['social.ad_budget:40'], meta: metaOf({ adsOverview: vi.fn(async () => winning) }) });
    expect((await again.handlers['social.ads'](task('social.ads'), { now })).result).toMatchObject({ budget: 0, skipped: 1 });
  });
});

describe('the daily ad review on LinkedIn', () => {
  it('reviews LinkedIn creatives with the same rules, under targets that never collide with Meta\'s', async () => {
    const overview = {
      adsets: [{ id: '610001', name: 'PA operators', active: true, dailyBudget: 2000, currency: 'USD', objective: 'WEBSITE_VISIT' }],
      ads: [
        { id: '820001', name: 'Survey', adsetId: '610001', active: true, createdAt: '2026-10-01T00:00:00Z', imageHash: null, copy: { message: 'Track annual training hours across your homes.', headline: 'Start free', description: '30-day trial', link: 'https://cmcarebase.com/signup' } },
        { id: '820002', name: 'Generic', adsetId: '610001', active: true, createdAt: '2026-10-01T00:00:00Z', imageHash: null, copy: { message: 'Software for care homes.', headline: 'Learn more', description: '', link: 'https://cmcarebase.com/' } },
      ],
      current: [{ adId: '820001', impressions: 6000, clicks: 120, spendCents: 4000, frequency: 1.6, results: 5 }, { adId: '820002', impressions: 6000, clicks: 20, spendCents: 3500, frequency: 1.6, results: 0 }],
      previous: [],
    };
    const linkedin = linkedinOf({ adsOverview: vi.fn(async () => overview) });
    const h = harness({ linkedin, meta: metaOf({ configured: { pages: true, instagram: true, ads: false } }), model: modelReturning({ variants: [] }) });
    const outcome = await h.handlers['social.ads'](task('social.ads'), { now });
    expect(h.meta.adsOverview).not.toHaveBeenCalled();
    const [pause] = h.store.proposeAction.mock.calls.map(call => call[0]);
    expect(pause).toMatchObject({ kind: 'social.ad_pause', targetKind: 'social_ad', targetId: 'linkedin:820002', input: { adId: '820002', adsetId: '610001', platform: 'linkedin' } });
    expect(pause.preview).toMatch(/^Pause the LinkedIn ad "Generic" in the LinkedIn campaign "PA operators"/);
    expect(outcome.result).toMatchObject({ adsets: 1, pause: 1 });
    const again = harness({ linkedin, openTargets: ['social.ad_pause:linkedin:820002'], meta: metaOf({ configured: { pages: true, instagram: true, ads: false } }) });
    expect((await again.handlers['social.ads'](task('social.ads'), { now })).result).toMatchObject({ pause: 0 });
  });
});

describe('only the products the team markets', () => {
  const intelOnly = ['caremetric-intel'];
  it('plans posts for Intel only while CareBase is in its pilot, and leaves a question about CareBase to the owner', async () => {
    const model = modelReturning({ posts: [
      { platform: 'facebook', product: 'carebase', pillar: 'tip', day: 2, text: 'Annual training hours piling up? Keep each staff member\'s training in one place.', linkId: '', hashtags: [] },
      { platform: 'facebook', product: 'caremetric-intel', pillar: 'capability', day: 3, text: 'CareMetric Intel keeps outreach, follow-up and recorded referrals in one place.', linkId: 'intel-home', hashtags: ['HomeHealth'] },
    ] });
    const h = harness({ model, marketed: intelOnly });
    const outcome = await h.handlers['social.plan'](task('social.plan'), { now });
    const user = JSON.parse(model.run.mock.calls[0][1].user);
    expect(user.products).toEqual(['caremetric-intel']);
    expect(Object.keys(user.links)).toEqual(['caremetric-intel']);
    expect(h.store.proposeAction.mock.calls.map(call => call[0].input.product)).toEqual(['caremetric-intel']);
    expect(outcome.result.rejected).toEqual({ not_marketed: 1 });
    expect((await harness({ model, marketed: [] }).handlers['social.plan'](task('social.plan'), { now })).result).toEqual({ skipped: 'no_marketed_product' });

    const item = { platform: 'facebook', kind: 'comment', id: '1_10', parentId: '1111_1', url: 'https://facebook.com/c/10' };
    const question = harness({ customerTextToAi: true, marketed: intelOnly, model: modelReturning({ intent: 'pricing', possiblePhi: false, needsOwner: false, hide: false, product: 'carebase', reply: 'Thanks for asking. You can start a 30-day free trial: https://cmcarebase.com/signup' }) });
    expect((await question.handlers['social.interaction'](task('social.interaction', { payload: item }), { now })).result).toMatchObject({ outcome: 'left_for_owner', reason: 'product_not_marketed' });
    expect(question.store.proposeAction).not.toHaveBeenCalled();
  });

  it('writes no new CareBase ad and raises no CareBase budget, but may still pause a losing CareBase ad', async () => {
    const overview = {
      adsets: [{ id: '40', name: 'PA operators', active: true, dailyBudget: 2000, objective: 'OUTCOME_LEADS' }],
      ads: [
        { id: '50', name: 'Training hook', adsetId: '40', active: true, createdAt: '2026-10-01T00:00:00Z', imageHash: 'img1', copy: { message: 'Track annual training hours across your homes.', headline: 'Start free', description: '30-day trial', link: 'https://cmcarebase.com/signup' } },
        { id: '51', name: 'Generic', adsetId: '40', active: true, createdAt: '2026-10-01T00:00:00Z', imageHash: 'img2', copy: { message: 'Software for care homes.', headline: 'Learn more', description: '', link: 'https://cmcarebase.com/' } },
      ],
      current: [{ adId: '50', impressions: 6000, clicks: 120, spendCents: 4000, frequency: 1.6, results: 5 }, { adId: '51', impressions: 6000, clicks: 20, spendCents: 3500, frequency: 1.6, results: 0 }],
      previous: [],
    };
    const model = modelReturning({ variants: [{ angle: 'survey readiness', message: 'Getting ready for your next DHS inspection? CareBase keeps staff training, resident records and survey documentation in one place.', headline: 'Try CareBase free', description: '30-day free trial', callToAction: 'SIGN_UP' }] });
    const h = harness({ model, marketed: intelOnly, meta: metaOf({ adsOverview: vi.fn(async () => overview) }) });
    await h.handlers['social.ads'](task('social.ads'), { now });
    expect(h.store.proposeAction.mock.calls.map(call => call[0].kind)).toEqual(['social.ad_pause']);
    expect(model.run).not.toHaveBeenCalled();
    const winning = { ...overview, current: [overview.current[0], { adId: '51', impressions: 6000, clicks: 110, spendCents: 3000, frequency: 1.6, results: 4 }] };
    const budget = harness({ marketed: intelOnly, settings: { targetCostCents: 2000, maxDailyBudgetCents: 3000 }, meta: metaOf({ adsOverview: vi.fn(async () => winning) }) });
    expect((await budget.handlers['social.ads'](task('social.ads'), { now })).result).toMatchObject({ budget: 0 });
    expect(budget.store.proposeAction).not.toHaveBeenCalled();
    // The same holds when the ads send people to the product's other sites, or to a site that is no marketed product's.
    for (const link of ['https://home.cmcarebase.com/pricing', 'https://caremetrictrain.com/', 'https://caremetricadvisors.com/contact']) {
      const elsewhere = { ...winning, ads: winning.ads.map(ad => ({ ...ad, copy: { ...ad.copy, link } })) };
      const held = harness({ marketed: intelOnly, settings: { targetCostCents: 2000, maxDailyBudgetCents: 3000 }, meta: metaOf({ adsOverview: vi.fn(async () => elsewhere) }) });
      expect((await held.handlers['social.ads'](task('social.ads'), { now })).result, link).toMatchObject({ budget: 0 });
      expect(held.store.proposeAction, link).not.toHaveBeenCalled();
    }
  });
});

describe('the weekly social report', () => {
  it('reports posts, ads and what waits for the owner, once a week', async () => {
    const h = harness({ openTargets: ['social.post:facebook:2026-11-09:1'] });
    const outcome = await h.handlers['social.report'](task('social.report'), { now });
    expect(h.sent[0]).toMatchObject({ subject: 'Social media weekly: 1 post, $0.00 ad spend', dedupeKey: 'social:report:2026-11-09' });
    expect(h.sent[0].body).toBe('1 post in the last 7 days with 28 engagement points; ads spent $0.00 for 0 results. 1 change waiting for you.');
    expect(outcome.result).toMatchObject({ posts: 1, waiting: 1 });
  });
});

describe('registration', () => {
  it('registers nothing without the feature, and reads its configuration from the environment', () => {
    expect(socialTeam({ features: new Set() }).handlers({})).toEqual({});
    const config = socialConfig({ HUB_META_ACCESS_TOKEN: 'EAAG-system-user-token-0123456789', HUB_META_PAGE_ID: '1111', HUB_SOCIAL_IMAGE_URLS: 'https://cdn.example.com/a.jpg, http://insecure.example.com/b.jpg,nope',
      HUB_SOCIAL_AD_MAX_DAILY_BUDGET_CENTS: '5000', HUB_SOCIAL_TARGET_COST_PER_RESULT_CENTS: 'abc' });
    expect(config.imageUrls).toEqual(['https://cdn.example.com/a.jpg']);
    expect(config.settings).toEqual({ maxDailyBudgetCents: 5000, targetCostCents: null, eventPosts: false, founderPosts: false, founderPostsPerWeek: 3 });
    const team = socialTeam({ social: config, features: new Set(['platform.agents.social.v1']) });
    expect(team.meta.configured).toEqual({ pages: true, instagram: false, ads: false });
    expect(Object.keys(team.handlers({ store: {}, notifier: {} })).sort()).toEqual(['social.ads', 'social.inbox', 'social.interaction', 'social.plan', 'social.report']);
    expect(Object.keys(team.executors({})).sort()).toEqual(['social.ad_budget', 'social.ad_create', 'social.ad_pause', 'social.founder_post', 'social.moderate', 'social.post', 'social.reply']);
    expect(team.linkedin.configured).toEqual({ page: false, ads: false, member: false });
    const withLinkedIn = socialConfig({ HUB_LINKEDIN_ACCESS_TOKEN: 'AQX-linkedin-member-token-0123456789', HUB_LINKEDIN_ORGANIZATION_ID: '5550001', HUB_LINKEDIN_AD_ACCOUNT_ID: '5080001' });
    expect(withLinkedIn.linkedin).toMatchObject({ organizationId: '5550001', adAccountId: '5080001', version: '202609' });
    expect(socialTeam({ social: withLinkedIn, features: ['platform.agents.social.v1'] }).linkedin.configured).toEqual({ page: true, ads: true, member: false });
  });
});

describe('approved creative from the Creative Director', () => {
  const token = 'f'.repeat(64);
  const approvedAsset = (over = {}) => ({ id: '22222222-2222-4222-8222-222222222222', token, product: 'caremetric-intel', platform: 'meta', placement: 'meta.feed_square', kind: 'static',
    headline: 'Territory plans from public data', primaryText: 'CareMetric Intel brings targeted marketing and territory analysis into one place for your team.',
    description: 'Free trial', cta: 'Start free trial', landingUrl: 'https://www.caremetricintel.com/?utm_source=meta&utm_medium=paid&utm_campaign=creative-1&utm_content=22222222-2222-4222-8222-222222222222', ...over });
  const planModel = () => modelReturning({ posts: [{ platform: 'instagram', product: 'caremetric-intel', pillar: 'tip', day: 2, text: 'Which county sends your agency the most referrals? Map it before you plan the week.', linkId: '', hashtags: ['homehealth'] }] });

  it.each(['facebook', 'instagram', 'linkedin'])('proposes an approved %s video with its exact URL and captions', async platform => {
    const asset = approvedAsset({ kind: 'video', contentType: 'video/mp4', placement: platform === 'linkedin' ? 'linkedin.video_square' : 'meta.video_vertical', platform: platform === 'linkedin' ? 'linkedin' : 'meta' });
    const creative = { approved: vi.fn(async ({ platform: wanted }) => wanted === asset.platform ? [asset] : []) };
    const model = modelReturning({ posts: [{ platform, product: 'caremetric-intel', pillar: 'capability', day: 2,
      text: 'CareMetric Intel brings territory planning and outreach into one place for your team.', linkId: 'intel-home', hashtags: [] }] });
    const h = harness({ creative, model, videos: true, imageUrls: [], linkedin: linkedinOf() });
    await h.handlers['social.plan'](task('social.plan'), { now });
    expect(h.store.proposeAction).toHaveBeenCalledTimes(1);
    const post = h.store.proposeAction.mock.calls[0][0];
    expect(post.input).toMatchObject({ videoUrl: `https://help.caremetric.ai/api/creative/a/${token}.mp4`, imageUrl: null, creativeAssetId: asset.id });
    expect(post.preview).toContain('Video: approved creative');
    if (platform !== 'instagram') expect(post.input.message).toContain('https://www.caremetricintel.com/');
  });

  it.each([['facebook', 'meta', 'meta.video_landscape'], ['linkedin', 'linkedin', 'linkedin.video_landscape']])('uses the owner\'s own 16:9 video for a %s post', async (platform, assetPlatform, placement) => {
    const asset = approvedAsset({ kind: 'video', contentType: 'video/mp4', placement, platform: assetPlatform, width: 1920, height: 1080 });
    const creative = { approved: vi.fn(async ({ platform: wanted }) => wanted === assetPlatform ? [asset] : []) };
    const model = modelReturning({ posts: [{ platform, product: 'caremetric-intel', pillar: 'capability', day: 2,
      text: 'CareMetric Intel brings territory planning and outreach into one place for your team.', linkId: 'intel-home', hashtags: [] }] });
    const h = harness({ creative, model, videos: true, imageUrls: [], linkedin: linkedinOf() });
    await h.handlers['social.plan'](task('social.plan'), { now });
    expect(h.store.proposeAction.mock.calls[0][0].input).toMatchObject({ videoUrl: `https://help.caremetric.ai/api/creative/a/${token}.mp4`, creativeAssetId: asset.id });
  });

  it('never puts a 16:9 video on Instagram, which takes Reels', async () => {
    const creative = { approved: vi.fn(async () => [approvedAsset({ kind: 'video', contentType: 'video/mp4', placement: 'meta.video_landscape' })]) };
    const h = harness({ creative, videos: true, model: planModel(), imageUrls: [] });
    await h.handlers['social.plan'](task('social.plan'), { now });
    expect(h.store.proposeAction).not.toHaveBeenCalled();
  });

  it('does not select videos without the durable video feature or unsupported Instagram shapes', async () => {
    const creative = { approved: vi.fn(async () => [approvedAsset({ kind: 'video', contentType: 'video/mp4', placement: 'meta.video_square' })]) };
    for (const videos of [false, true]) {
      const h = harness({ creative, videos, model: planModel(), imageUrls: [] });
      await h.handlers['social.plan'](task('social.plan'), { now });
      expect(h.store.proposeAction).not.toHaveBeenCalled();
    }
  });

  it('uses an approved image for an Instagram post, marks the post with the asset, and tells the Creative Director the plan was written', async () => {
    const creative = { approved: vi.fn(async ({ platform }) => (platform === 'meta' ? [approvedAsset()] : [])), planned: vi.fn(async () => 'task') };
    const { store, handlers } = harness({ model: planModel(), imageUrls: [], creative });
    await handlers['social.plan'](task('social.plan'), { now });
    const post = store.proposeAction.mock.calls.map(([input]) => input).find(input => input.input.platform === 'instagram');
    expect(post.input.imageUrl).toBe(`https://help.caremetric.ai/api/creative/a/${token}.png`);
    expect(post.input.creativeAssetId).toBe(approvedAsset().id);
    expect(creative.planned).toHaveBeenCalledWith('2026-11-09');
  });

  it('plans exactly as before without the Creative Director', async () => {
    const { store, handlers } = harness({ model: planModel() });
    await handlers['social.plan'](task('social.plan'), { now });
    const post = store.proposeAction.mock.calls.map(([input]) => input).find(input => input.input.platform === 'instagram');
    expect(post.input.imageUrl).toBe('https://cdn.example.com/brand-1.jpg');
    expect(post.input).not.toHaveProperty('creativeAssetId');
  });

  it.each([true, false])('starts a new ad from approved creative when the model is configured: %s', async configured => {
    const adset = { id: '120200000000001', name: 'Intel prospecting', effective_status: 'ACTIVE' };
    const meta = metaOf({ adsOverview: vi.fn(async () => ({
      adsets: [{ id: adset.id, name: adset.name, active: true, dailyBudget: 2000 }],
      ads: [{ id: '1', name: 'Only ad', adsetId: adset.id, active: true, createdAt: '2026-10-01T00:00:00Z', imageHash: null, copy: { message: 'm', headline: 'h', description: 'd', link: 'https://www.caremetricintel.com/' } }],
      current: [], previous: [],
    })) });
    const model = modelReturning({ variants: [] });
    model.configured = configured;
    const creative = { approved: vi.fn(async ({ platform }) => (platform === 'meta' ? [approvedAsset()] : [])) };
    const { store, handlers } = harness({ meta, model, creative });
    await handlers['social.ads'](task('social.ads'), { now });
    const created = store.proposeAction.mock.calls.map(([input]) => input).find(input => input.kind === 'social.ad_create');
    expect(created.input).toMatchObject({ creativeAssetId: approvedAsset().id, imageUrl: `https://help.caremetric.ai/api/creative/a/${token}.png`, link: approvedAsset().landingUrl, callToAction: 'SIGN_UP' });
    expect(model.run).not.toHaveBeenCalled();
  });

  it('skips a refresh without a model or usable approved creative', async () => {
    const meta = metaOf({ adsOverview: vi.fn(async () => ({
      adsets: [{ id: '40', name: 'Intel prospecting', active: true, dailyBudget: 2000 }],
      ads: [{ id: '1', name: 'Only ad', adsetId: '40', active: true, createdAt: '2026-10-01T00:00:00Z', copy: { link: 'https://www.caremetricintel.com/' } }],
      current: [], previous: [],
    })) });
    const creative = { approved: vi.fn(async () => [approvedAsset({ primaryText: 'We guarantee results.' })]) };
    const { store, handlers } = harness({ meta, model: null, creative });
    const outcome = await handlers['social.ads'](task('social.ads'), { now });
    expect(creative.approved).toHaveBeenCalled();
    expect(store.proposeAction).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({ create: 0, skipped: 1 });
  });
});

describe('event posts, article links and stories', () => {
  const token = 'c'.repeat(64);
  const storyAsset = { id: '33333333-3333-4333-8333-333333333333', token, product: 'caremetric-intel', platform: 'meta', placement: 'meta.story', kind: 'static' };
  const feed = { configured: true,
    releases: vi.fn(async () => ({ releases: [{ dataset: 'home_health_compare', title: 'Home Health Care Agencies', data_year: '2026', period_start: null, period_end: null, published: '2026-10-28', loaded: '2026-11-02' }] })),
    observances: vi.fn(async () => ({ observances: [{ id: 'np-week', name: 'National Nurse Practitioner Week', category: 'people', audience: 'Nurse practitioners', sponsor: 'AANP', start: '2026-11-15', end: '2026-11-21', idea: 'x' }] })) };
  const setup = ({ posts = [], eventPosts = true, articles = [], stories = [storyAsset] } = {}) => {
    const model = modelReturning({ posts });
    const creative = { approved: vi.fn(async ({ platform }) => (platform === 'meta' ? stories : [])) };
    const sent = [];
    let next = 0;
    const store = { socialOpenTargets: vi.fn(async () => []), socialSchedule: vi.fn(async () => true), notificationCount: vi.fn(async () => 0),
      proposeAction: vi.fn(async () => ({ id: `a${++next}`, status: 'proposed', created: true })), startRun: vi.fn(async () => 'r'), finishRun: vi.fn(async () => undefined),
      socialRecentArticles: vi.fn(async () => articles) };
    const meta = metaOf({ publishStory: vi.fn() });
    const handlers = socialHandlers({ store, notifier: { send: vi.fn(async input => { sent.push(input); return [{ channel: 'email', delivery: 'sent' }]; }) }, model, meta, linkedin: null,
      settings: { eventPosts }, imageUrls: [], publicOrigin: 'https://help.caremetric.ai', marketed: ['caremetric-intel'], log: () => {}, creative, feed });
    return { handlers, store, model, sent };
  };

  it('offers the week\'s releases and observances only while the owner\'s setting is on, and keeps the data pillar to one post about them', async () => {
    const data = (day, text) => ({ platform: 'facebook', product: 'caremetric-intel', pillar: 'data', day, text, linkId: '', hashtags: [] });
    const on = setup({ posts: [data(2, 'National Nurse Practitioner Week starts November 15. Thank the nurse practitioners who refer to you.'), data(4, 'CMS released new home health agency data for 2026.')] });
    const done = await on.handlers['social.plan'](task('social.plan'), { now });
    expect(JSON.parse(on.model.run.mock.calls[0][1].user).events).toEqual({ releases: [{ title: 'Home Health Care Agencies', dataYear: '2026', published: '2026-10-28' }],
      observances: [{ name: 'National Nurse Practitioner Week', honors: 'Nurse practitioners', start: '2026-11-15', end: '2026-11-21' }] });
    const dataPosts = on.store.proposeAction.mock.calls.filter(([item]) => item.input.pillar === 'data');
    expect(dataPosts).toHaveLength(1);
    expect(done.result.rejected.data_pillar).toBe(1);
    const off = setup({ eventPosts: false, posts: [data(2, 'National Nurse Practitioner Week starts November 15. Thank the nurse practitioners who refer to you.')] });
    await off.handlers['social.plan'](task('social.plan'), { now });
    expect(JSON.parse(off.model.run.mock.calls[0][1].user).events).toBeUndefined();
    expect(off.store.proposeAction.mock.calls.some(([item]) => item.input.pillar === 'data')).toBe(false);
  });

  it('lets a post link to an article published lately, by id', async () => {
    const articles = [{ slug: 'county-market-basics', product: 'caremetric-intel', title: 'County market basics' }];
    const h = setup({ articles, posts: [{ platform: 'facebook', product: 'caremetric-intel', pillar: 'resource', day: 2, text: 'A short guide to reading your county\'s market.', linkId: 'article-county-market-basics', hashtags: [] }] });
    await h.handlers['social.plan'](task('social.plan'), { now });
    expect(JSON.parse(h.model.run.mock.calls[0][1].user).links['caremetric-intel']).toContainEqual({ id: 'article-county-market-basics', label: 'County market basics' });
    const post = h.store.proposeAction.mock.calls.find(([item]) => item.input.pillar === 'resource')[0];
    expect(post.input.link).toBe('https://www.caremetricintel.com/resources/county-market-basics');
  });

  it('proposes up to two approved story images a week, Instagram first, each to approve', async () => {
    const h = setup({ stories: [storyAsset, { ...storyAsset, id: '44444444-4444-4444-8444-444444444444' }, { ...storyAsset, id: '55555555-5555-4555-8555-555555555555' }] });
    const done = await h.handlers['social.plan'](task('social.plan'), { now });
    const stories = h.store.proposeAction.mock.calls.map(([item]) => item).filter(item => item.input.format === 'story');
    expect(stories.map(item => [item.input.platform, item.targetId])).toEqual([['instagram', 'instagram:2026-11-09:story1'], ['facebook', 'facebook:2026-11-09:story2']]);
    expect(stories[0].input).toMatchObject({ message: '', link: null, imageUrl: `https://help.caremetric.ai/api/creative/a/${token}.png`, creativeAssetId: storyAsset.id, product: 'caremetric-intel' });
    expect(done.result.stories).toBe(2);
    expect(h.sent[0].body).toContain('(2 stories)');
  });
});

describe('posts for the founder\'s own profile', () => {
  const founderDraft = (day, text) => ({ platform: 'founder', product: 'caremetric-intel', pillar: 'tip', day, text, linkId: '', hashtags: ['HomeHealth'] });
  const texts = ['Most agencies I talk to plan visits from memory. Writing down which referral sources you saw last month, and which you did not, changes the week.',
    'Building CareMetric taught me that a marketer needs one list for the day, not ten reports. That is what we keep trying to make simpler.',
    'Public Medicare data shows where people live and who serves them. It does not show who refers, so record your own referrals as they come in.'];
  const setup = ({ member = true, founderPosts = true, perWeek = 2 } = {}) => {
    const model = modelReturning({ posts: texts.map((text, index) => founderDraft(index + 2, text)) });
    const linkedin = linkedinOf({ configured: { page: true, ads: true, member } });
    const h = harness({ model, linkedin, settings: { founderPosts, founderPostsPerWeek: perWeek }, marketed: ['caremetric-intel'] });
    return { ...h, model };
  };

  it('asks for the week\'s number and proposes each as its own post to approve, never automatically', async () => {
    const h = setup();
    const done = await h.handlers['social.plan'](task('social.plan'), { now });
    expect(JSON.parse(h.model.run.mock.calls[0][1].user).postsToWrite.founder).toBe(2);
    const founder = h.store.proposeAction.mock.calls.map(([item]) => item).filter(item => item.kind === 'social.founder_post');
    expect(founder.map(item => [item.targetKind, item.targetId])).toEqual([['social_item', 'founder:2026-11-09:1'], ['social_item', 'founder:2026-11-09:2']]);
    expect(founder[0].input).toMatchObject({ product: 'caremetric-intel', message: `${texts[0]}\n\n#HomeHealth` });
    expect(founder[0].preview).toContain('once you approve it');
    expect(done.result.founder).toBe(2);
  });

  it('says a post publishes on its own once the owner has handed founder posts over, and still emails them without the founder\'s token', async () => {
    const handedOver = { autonomy: 'act', config: { auto_approve_kinds: ['social.founder_post'] } };
    const h = setup();
    await h.handlers['social.plan'](task('social.plan', { agent: handedOver }), { now });
    const founder = h.store.proposeAction.mock.calls.map(([item]) => item).filter(item => item.kind === 'social.founder_post');
    expect(founder).toHaveLength(2);
    expect(founder[0].preview).toContain('on its own (you handed founder posts over)');
    expect(founder[0].preview).not.toContain('once you approve it');
    const unconnected = setup({ member: false });
    await unconnected.handlers['social.plan'](task('social.plan', { agent: handedOver }), { now });
    expect(unconnected.store.proposeAction.mock.calls.some(([item]) => item.kind === 'social.founder_post')).toBe(false);
    expect(JSON.stringify(unconnected.sent[0].blocks)).toContain('they publish at their time slots on their own instead');
  });

  it('emails them to copy without the founder\'s own token, and writes none while the setting is off', async () => {
    const h = setup({ member: false });
    await h.handlers['social.plan'](task('social.plan'), { now });
    expect(h.store.proposeAction.mock.calls.some(([item]) => item.kind === 'social.founder_post')).toBe(false);
    expect(JSON.stringify(h.sent[0].blocks)).toContain('Posts for your own LinkedIn profile, to copy');
    const off = setup({ founderPosts: false });
    await off.handlers['social.plan'](task('social.plan'), { now });
    expect(JSON.parse(off.model.run.mock.calls[0][1].user).postsToWrite.founder).toBeUndefined();
    expect(off.store.proposeAction.mock.calls.some(([item]) => item.kind === 'social.founder_post')).toBe(false);
  });
});
