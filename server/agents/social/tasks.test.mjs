import { describe, expect, it, vi } from 'vitest';
import { slotFor, socialHandlers } from './tasks.mjs';
import { socialConfig, socialTeam } from './index.mjs';

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
const harness = ({ meta = metaOf(), model = null, customerTextToAi = false, settings = {}, imageUrls = ['https://cdn.example.com/brand-1.jpg'], openTargets = [] } = {}) => {
  const sent = [];
  let next = 0;
  const store = {
    socialOpenTargets: vi.fn(async () => openTargets), socialSchedule: vi.fn(async () => true), notificationCount: vi.fn(async () => 0),
    proposeAction: vi.fn(async () => ({ id: `a${++next}`, status: 'proposed', created: true })), enqueue: vi.fn(async () => `task-${++next}`),
    startRun: vi.fn(async () => 'r'), finishRun: vi.fn(async () => undefined),
  };
  const notifier = { send: vi.fn(async input => { sent.push(input); return [{ channel: 'email', delivery: 'sent' }]; }) };
  const handlers = socialHandlers({ store, notifier, model, meta, settings, imageUrls, customerTextToAi, publicOrigin: 'https://help.caremetric.ai', log: () => {} });
  return { store, notifier, sent, meta, handlers };
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

  it('proposes checked Facebook and Instagram posts held for their time slots, and emails LinkedIn posts to paste', async () => {
    const model = modelReturning({ posts });
    const h = harness({ model });
    const outcome = await h.handlers['social.plan'](task('social.plan'), { now });
    const request = model.run.mock.calls[0][1];
    expect(request.promptVersion).toBe('social-plan.2');
    expect(JSON.parse(request.user)).toMatchObject({ weekStarting: '2026-11-09', postsToWrite: { facebook: 3, instagram: 2, linkedin: 3 }, bestRecent: [{ platform: 'facebook', engagement: 28 }] });
    expect(h.store.proposeAction).toHaveBeenCalledTimes(2);
    const [facebook, instagram] = h.store.proposeAction.mock.calls.map(call => call[0]);
    expect(facebook).toMatchObject({ kind: 'social.post', targetKind: 'social_post', targetId: 'facebook:2026-11-09:1',
      input: { platform: 'facebook', product: 'carebase', link: 'https://cmcarebase.com/pa-training-requirements', scheduledFor: '2026-11-10T15:30:00.000Z', imageUrl: null } });
    expect(facebook.input.message).toMatch(/#PersonalCareHome$/);
    expect(instagram).toMatchObject({ targetId: 'instagram:2026-11-09:1', input: { platform: 'instagram', link: null, imageUrl: 'https://cdn.example.com/brand-1.jpg', scheduledFor: '2026-11-11T17:15:00.000Z' } });
    expect(h.store.socialSchedule.mock.calls).toEqual([['a1', null], ['a2', null]]);
    expect(h.sent[0]).toMatchObject({ subject: 'Social plan: 2 posts to approve', dedupeKey: 'social:plan:2026-11-09' });
    expect(JSON.stringify(h.sent[0].blocks)).toContain('CareMetric Intel keeps outreach, follow-up and recorded referrals in one place.\\n\\nhttps://www.caremetricintel.com/\\n\\n#HomeHealth');
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

  it('warns the owner once a day when Meta refuses the token', async () => {
    const meta = metaOf({ recentInbox: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'meta_token_invalid' }); }) });
    const h = harness({ meta });
    expect((await h.handlers['social.inbox'](task('social.inbox'), { now })).result).toEqual({ skipped: 'meta_token_invalid' });
    expect(h.sent[0]).toMatchObject({ severity: 'warning', dedupeKey: 'social:access:meta_token_invalid:2026-11-09' });
  });

  it('drafts a checked reply when customer text may reach the model, and keeps no word of the comment', async () => {
    const model = modelReturning({ intent: 'pricing', possiblePhi: false, needsOwner: false, hide: false, product: 'carebase',
      reply: 'Thanks for asking. CareBase Core is $199 per facility per month, and you can start a 30-day free trial: https://cmcarebase.com/signup' });
    const h = harness({ model, customerTextToAi: true });
    const outcome = await h.handlers['social.interaction'](task('social.interaction', { payload: item }), { now });
    expect(model.run.mock.calls[0][1].user).toContain(`How much is CareBase? ${canary}`);
    expect(h.store.proposeAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'social.reply', targetKind: 'social_item', targetId: 'facebook:1_10',
      input: expect.objectContaining({ platform: 'facebook', kind: 'comment', id: '1_10', intent: 'pricing', product: 'carebase' }) }));
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
    expect(calls[0].preview).toMatch(/^Pause the ad "Generic" in "PA operators": it spent \$35\.00 in 7 days with no result\.$/);
    expect(calls[1]).toMatchObject({ kind: 'social.ad_create', targetKind: 'social_adset', targetId: '40:2026-11-09:1',
      input: { adsetId: '40', imageHash: 'img1', link: 'https://cmcarebase.com/signup', callToAction: 'SIGN_UP', product: 'carebase', basedOn: '50' } });
    expect(outcome.result).toMatchObject({ pause: 1, create: 1, rejected: 1, budget: 0 });
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
    expect(config.settings).toEqual({ maxDailyBudgetCents: 5000, targetCostCents: null });
    const team = socialTeam({ social: config, features: new Set(['platform.agents.social.v1']) });
    expect(team.meta.configured).toEqual({ pages: true, instagram: false, ads: false });
    expect(Object.keys(team.handlers({ store: {}, notifier: {} })).sort()).toEqual(['social.ads', 'social.inbox', 'social.interaction', 'social.plan', 'social.report']);
    expect(Object.keys(team.executors({})).sort()).toEqual(['social.ad_budget', 'social.ad_create', 'social.ad_pause', 'social.moderate', 'social.post', 'social.reply']);
  });
});
