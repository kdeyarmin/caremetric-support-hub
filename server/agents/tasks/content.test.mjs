import { describe, expect, it, vi } from 'vitest';
import { aiError, modelRuntime } from '../runtime/index.mjs';
import { contentFeature } from '../content/executor.mjs';
import { products } from '../content/facts.mjs';
import { completion, fireDrillDraft, outreachDraft, referralDraft } from '../content/fixtures.mjs';
import { promptVersion, systemPrompt } from '../content/prompt.mjs';
import { featuresText } from '../content/features.mjs';
import { topics } from '../content/topics.mjs';
import { contentHandlers, easternDate, onOrAfterFirstWednesday } from './content.mjs';

const dayStart = '2026-11-03T05:00:00.000Z';
// As private.agent_content_state answers: products by the Hub's slug (caremetric-intel), not the backlog's key.
const stored = (topic, status, at) => ({ topic: topic.key, slug: topic.slug, product: products[topic.product].slug, status, at });
const tuesday = new Date('2026-11-03T12:45:00Z');
const task = (over = {}) => ({
  id: 't1', agentKey: 'content_marketer', kind: 'content.weekly', sourceKind: 'owner', requestKey: 'owner:1', attempts: 1,
  agent: { autonomy: 'propose', modelTier: 'draft', config: { effort: 'medium', auto_approve_kinds: [] } }, budget: { dayStart }, ...over,
});
const scheduled = (at, kind = 'content.weekly') => task({ kind, sourceKind: 'schedule', requestKey: `schedule:11111111-1111-4111-8111-111111111111:${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}` });

/** The real runtime against a scripted model, the handler against a recording store and notifier. */
function fixture({ answer = () => completion(fireDrillDraft), remaining = 150, state = {}, recheck = {}, features = new Set([contentFeature]), deliveries = [{ channel: 'email', delivery: 'sent' }], marketed = null } = {}) {
  const logs = [];
  const requests = [];
  const store = {
    budget: vi.fn(async () => ({ budgetCents: 150, spentCents: 150 - remaining, remainingCents: remaining, dayStart })),
    startRun: vi.fn(async () => 'run-1'),
    finishRun: vi.fn(async () => undefined),
    contentState: vi.fn(async slugs => (slugs.length === 1 ? { articles: [], takenSlugs: [], questions: [], outreachMonths: [], ...recheck }
      : { articles: [], takenSlugs: [], questions: [], outreachMonths: [], ...state })),
    proposeAction: vi.fn(async () => ({ id: 'a1', status: 'proposed', requestKey: 'r1', created: true })),
  };
  const client = { messages: { create: vi.fn(async body => { requests.push(body); const value = answer(body); if (value instanceof Error) throw value; return value; }) } };
  const model = modelRuntime({ client, store, log: line => logs.push(line) });
  const notifier = { send: vi.fn(async () => deliveries) };
  const handlers = contentHandlers({ store, notifier, model, features, marketed, log: line => logs.push(line) });
  return { store, client, requests, notifier, logs, handlers, model };
}

describe('the Content Marketer\'s tasks', () => {
  it('register only when the database declares the feature and the model runtime has a key', () => {
    const { model } = fixture();
    expect(Object.keys(fixture().handlers)).toEqual(['content.weekly', 'content.outreach']);
    for (const features of [undefined, null, new Set(), new Set(['platform.agents.v1'])]) {
      expect(contentHandlers({ store: {}, notifier: {}, model, features }), String(features)).toEqual({});
    }
    for (const missing of [null, undefined, modelRuntime({ store: {} }), { configured: 'yes' }]) {
      expect(contentHandlers({ store: {}, notifier: {}, model: missing, features: new Set([contentFeature]) }), 'runtime missing').toEqual({});
    }
  });

  it('reads Eastern calendar dates, and the first Wednesday of a month', () => {
    expect(easternDate(tuesday)).toEqual({ year: 2026, month: 11, day: 3, weekday: 2 });
    expect(easternDate(new Date('2026-11-04T03:00:00Z'))).toEqual({ year: 2026, month: 11, day: 3, weekday: 2 });
    expect(onOrAfterFirstWednesday(new Date('2026-11-03T15:00:00Z'))).toBe(false);
    expect(onOrAfterFirstWednesday(new Date('2026-11-04T15:00:00Z'))).toBe(true);
    expect(onOrAfterFirstWednesday(new Date('2026-11-30T15:00:00Z'))).toBe(true);
    expect(onOrAfterFirstWednesday(new Date('2026-12-01T15:00:00Z'))).toBe(false);
    expect(onOrAfterFirstWednesday(new Date('2026-12-02T15:00:00Z'))).toBe(true);
    expect(onOrAfterFirstWednesday(new Date('2027-09-01T15:00:00Z'))).toBe(true);
  });
});

describe('the weekly help article', () => {
  const fireTopic = topics.find(topic => topic.key === 'pa-fire-drill-requirements');
  // Everything ahead of the fire drill topic in the backlog is taken, so the handler chooses it.
  const before = topics.slice(0, topics.indexOf(fireTopic)).filter(topic => topic.product === 'carebase')
    .map(topic => stored(topic, 'executed', '2026-10-01T00:00:00Z'));
  const state = { articles: [...before, ...topics.filter(topic => topic.product !== 'carebase').map(topic => stored(topic, 'proposed', '2026-09-01T00:00:00Z'))] };

  it('drafts the chosen topic with one cached, metered call and proposes the whole article for the owner', async () => {
    const { handlers, store, requests, logs } = fixture({ state });
    const outcome = await handlers['content.weekly'](task(), { now: () => tuesday });
    expect(store.contentState).toHaveBeenNthCalledWith(1, topics.map(topic => topic.slug));
    expect(requests).toHaveLength(1);
    // The prompt, then the product's own published catalog (content/features.mjs), each cached.
    expect(requests[0]).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 8000, system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: featuresText('carebase'), cache_control: { type: 'ephemeral' } }] });
    expect(requests[0].output_config.effort).toBe('medium');
    expect(requests[0].messages[0].content).toContain('Working title: Fire drill requirements');
    expect(requests[0].messages[0].content).toContain('An unannounced fire drill is held at least once a month (§ 2600.132(a), § 2800.132(a)).');
    expect(store.contentState).toHaveBeenNthCalledWith(2, [fireDrillDraft.slug]);
    expect(store.proposeAction).toHaveBeenCalledTimes(1);
    const proposal = store.proposeAction.mock.calls[0][0];
    expect(proposal).toMatchObject({ taskId: 't1', runId: 'run-1', kind: 'content.publish', targetKind: 'content_item', targetId: fireDrillDraft.slug });
    expect(proposal.input).toMatchObject({ slug: fireDrillDraft.slug, product: 'carebase', topic: 'pa-fire-drill-requirements', kind: 'regulation', promptVersion });
    expect(proposal.preview).toContain(fireDrillDraft.body);
    expect(proposal.preview.endsWith(proposal.input.body)).toBe(true);
    expect(outcome).toEqual({ status: 'awaiting_approval', result: { outcome: 'proposed', topic: 'pa-fire-drill-requirements', slug: fireDrillDraft.slug, url: `https://help.caremetric.ai/help/articles/${fireDrillDraft.slug}`, actionId: 'a1', rewrites: 0 } });
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', expect.objectContaining({ inputTokens: 5200, outputTokens: 2400 }),
      'Drafted the pa-fire-drill-requirements article: it passed the checks.', null);
    // The result, the run and the log carry keys and counts, never the article.
    expect(JSON.stringify([outcome, store.finishRun.mock.calls, logs])).not.toContain('unannounced');
  });

  it('proposes nothing for a draft that fails the checks, and records only why', async () => {
    const bad = { ...fireDrillDraft, body: `${fireDrillDraft.body}\n\nCareBase ensures compliance and costs $4 per resident.` };
    const { handlers, store } = fixture({ state, answer: () => completion(bad) });
    const outcome = await handlers['content.weekly'](task(), { now: () => tuesday });
    expect(outcome).toEqual({ result: { outcome: 'rejected', topic: 'pa-fire-drill-requirements', reasons: ['compliance_assurance', 'unlisted_price'] } });
    expect(store.proposeAction).not.toHaveBeenCalled();
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', expect.anything(), 'Drafted the pa-fire-drill-requirements article: not proposed (compliance_assurance, unlisted_price).', null);
    expect(JSON.stringify([outcome, store.finishRun.mock.calls])).not.toMatch(/ensures compliance|\$4/);
  });

  it('puts the work off to the next Eastern day when the budget is used up, without calling the model', async () => {
    const { handlers, client, store } = fixture({ state, remaining: 1 });
    const outcome = await handlers['content.weekly'](task(), { now: () => tuesday });
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'queued', retryAt: new Date('2026-11-04T05:05:00.000Z'), result: { deferred: 'budget', topic: 'pa-fire-drill-requirements' } });
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'budget_exhausted', {}, expect.any(String), null);
    expect(store.proposeAction).not.toHaveBeenCalled();
  });

  it('records a refusal and lets the scheduler retry a provider outage', async () => {
    const refused = fixture({ state, answer: () => completion({}, { content: [], stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 } }) });
    expect(await refused.handlers['content.weekly'](task(), { now: () => tuesday })).toEqual({ result: { outcome: 'refused', topic: 'pa-fire-drill-requirements' } });
    const outage = fixture({ state, answer: () => aiError('provider_outage', true, { status: 529 }) });
    await expect(outage.handlers['content.weekly'](task(), { now: () => tuesday })).rejects.toMatchObject({ code: 'provider_outage', transient: true });
    expect(outage.store.proposeAction).not.toHaveBeenCalled();
  });

  it('writes on Tuesdays and Fridays (read from the task\'s due time) and on any day the owner asks', async () => {
    const monday = fixture({ state });
    expect(await monday.handlers['content.weekly'](scheduled(new Date('2026-11-02T12:45:00Z')), { now: () => tuesday })).toEqual({ result: { skipped: 'not_a_writing_day' } });
    expect(await monday.handlers['content.weekly'](scheduled(new Date('2026-11-05T12:45:00Z')), { now: () => tuesday })).toEqual({ result: { skipped: 'not_a_writing_day' } });
    expect(monday.client.messages.create).not.toHaveBeenCalled();
    // Friday is the week's second writing day, so a missed or failed Tuesday costs three days, not the week.
    const friday = fixture({ state });
    expect((await friday.handlers['content.weekly'](scheduled(new Date('2026-11-06T12:45:00Z')), { now: () => new Date('2026-11-06T12:45:00Z') })).status).toBe('awaiting_approval');
    // A Tuesday firing deferred to Wednesday by the budget still writes when it runs.
    const deferred = fixture({ state });
    expect((await deferred.handlers['content.weekly'](scheduled(new Date('2026-11-03T12:45:00Z')), { now: () => new Date('2026-11-04T10:00:00Z') })).status).toBe('awaiting_approval');
    const asked = fixture({ state });
    expect((await asked.handlers['content.weekly'](task(), { now: () => new Date('2026-11-06T15:00:00Z') })).status).toBe('awaiting_approval');
  });

  it('does not pay for a draft it could not propose (Observe), nor write when every topic is taken', async () => {
    const observing = fixture({ state });
    expect(await observing.handlers['content.weekly'](task({ agent: { ...task().agent, autonomy: 'observe' } }), { now: () => tuesday })).toEqual({ result: { skipped: 'observe_only' } });
    expect(observing.client.messages.create).not.toHaveBeenCalled();
    const exhausted = fixture({ state: { articles: topics.map(topic => stored(topic, 'executed', '2026-10-01T00:00:00Z')) } });
    expect(await exhausted.handlers['content.weekly'](task(), { now: () => tuesday })).toEqual({ result: { skipped: 'no_topic' } });
    expect(exhausted.client.messages.create).not.toHaveBeenCalled();
  });

  it('refuses an address the model chose that another article already holds, and stops when the task was cancelled', async () => {
    const taken = fixture({ state, recheck: { takenSlugs: [fireDrillDraft.slug] } });
    expect(await taken.handlers['content.weekly'](task(), { now: () => tuesday })).toEqual({ result: { outcome: 'rejected', topic: 'pa-fire-drill-requirements', reasons: ['slug_taken'] } });
    expect(taken.store.proposeAction).not.toHaveBeenCalled();
    const controller = new AbortController();
    const cancelled = fixture({ state, answer: () => { controller.abort(); return completion(fireDrillDraft); } });
    await expect(cancelled.handlers['content.weekly'](task(), { now: () => tuesday, signal: controller.signal })).rejects.toMatchObject({ code: 'task_cancelled' });
    expect(cancelled.store.proposeAction).not.toHaveBeenCalled();
  });

  it('steps away from Intel after an Intel article, reading the products as the database names them', async () => {
    const homeHealth = topics.find(topic => topic.key === 'home-health-referral-marketing');
    const chapters = topics.find(topic => topic.key === 'pa-chapter-2600-vs-2800');
    const questions = [{ product: 'caremetric-intel', inquiryType: 'sales', conversations: 2 }];
    const afterIntel = fixture({ state: { articles: [stored(chapters, 'executed', '2026-10-01T00:00:00Z'), stored(homeHealth, 'executed', '2026-11-01T00:00:00Z')], questions } });
    expect((await afterIntel.handlers['content.weekly'](task(), { now: () => tuesday })).result.topic).toBe('pa-surveyor-visit-readiness');
    const afterCareBase = fixture({ state: { articles: [stored(homeHealth, 'executed', '2026-10-01T00:00:00Z'), stored(chapters, 'executed', '2026-11-01T00:00:00Z')], questions } });
    expect((await afterCareBase.handlers['content.weekly'](task(), { now: () => tuesday })).result.topic).toBe('county-market-data-outreach');
  });

  it('uses the topic the inbox counts point to', async () => {
    const { handlers, requests } = fixture({ answer: () => completion(referralDraft), state: { questions: [{ product: 'caremetric-intel', inquiryType: 'sales', conversations: 9 }] } });
    const outcome = await handlers['content.weekly'](task(), { now: () => tuesday });
    expect(requests[0].messages[0].content).toContain('Product: CareMetric Intel');
    expect(outcome.result).toMatchObject({ outcome: 'proposed', topic: 'home-health-referral-marketing', slug: referralDraft.slug });
  });

  it('notes the Intel address an Intel article will live at, in its result and in the preview the owner approves', async () => {
    const { handlers, store } = fixture({ answer: () => completion(referralDraft), marketed: ['caremetric-intel'] });
    const outcome = await handlers['content.weekly'](task(), { now: () => tuesday });
    expect(outcome.result).toMatchObject({ outcome: 'proposed', slug: referralDraft.slug, url: `https://www.caremetricintel.com/resources/${referralDraft.slug}` });
    const [proposal] = store.proposeAction.mock.calls.at(-1);
    expect(proposal.preview.split('\n').slice(0, 2)).toEqual([
      `Publish on CareMetric Intel's website: https://www.caremetricintel.com/resources/${referralDraft.slug}`,
      `Also readable in the help center (its canonical link points to the address above): https://help.caremetric.ai/help/articles/${referralDraft.slug}`,
    ]);
  });
});

describe('only the products the team markets', () => {
  it('writes articles and outreach for Intel only while CareBase is in its pilot, and nothing when no product is marketed', async () => {
    const articles = fixture({ answer: () => completion(referralDraft), marketed: ['caremetric-intel'] });
    const outcome = await articles.handlers['content.weekly'](task(), { now: () => tuesday });
    expect(topics.find(item => item.key === outcome.result.topic)?.product).toBe('intel');
    expect(articles.store.contentState.mock.calls[0][0].every(slug => topics.find(item => item.slug === slug).product === 'intel')).toBe(true);

    const drafts = fixture({ answer: () => completion(outreachDraft), marketed: ['caremetric-intel'] });
    const sent = await drafts.handlers['content.outreach'](task({ kind: 'content.outreach' }), { now: () => tuesday });
    expect(JSON.stringify(drafts.requests[0].messages)).toContain('only for CareMetric Intel');
    expect(JSON.stringify(drafts.requests[0].messages)).not.toContain('CareBase');
    expect(sent.result.listings + sent.result.pitches).toBeGreaterThan(0);
    expect(drafts.notifier.send.mock.calls[0][0].blocks.filter(block => block.type === 'paragraph').map(block => block.text).join('\n')).not.toMatch(/CareBase|Healthcare Advisors/);

    const none = fixture({ marketed: [] });
    expect((await none.handlers['content.weekly'](task(), { now: () => tuesday })).result).toEqual({ skipped: 'no_marketed_product' });
    expect((await none.handlers['content.outreach'](task({ kind: 'content.outreach' }), { now: () => tuesday })).result).toMatchObject({ skipped: 'no_marketed_product' });
    expect(none.client.messages.create).not.toHaveBeenCalled();
  });
});

describe('the monthly outreach drafts', () => {
  const outreach = (over = {}) => task({ kind: 'content.outreach', ...over });

  it('emails the owner the drafts that pass, and nobody else, under the run\'s own key when the owner asked', async () => {
    const { handlers, notifier, requests, store } = fixture({ answer: () => completion(outreachDraft) });
    const outcome = await handlers['content.outreach'](outreach(), { now: () => tuesday });
    expect(requests).toHaveLength(1);
    expect(requests[0].max_tokens).toBe(6000);
    expect(notifier.send).toHaveBeenCalledTimes(1);
    const sent = notifier.send.mock.calls[0][0];
    expect(sent).toMatchObject({ severity: 'info', dedupeKey: 'content:outreach:run:t1', agentKey: 'content_marketer', taskId: 't1', subject: 'Outreach drafts for November 2026: 2 listings, 1 pitch' });
    expect(JSON.stringify(sent.blocks)).toContain(outreachDraft.pitches[0].subject);
    expect(sent.body).not.toContain('$199');
    expect(outcome).toEqual({ result: { outcome: 'sent', month: '2026-11', delivery: ['email:sent'], listings: 2, pitches: 1, dropped: 0, reasons: [] } });
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', expect.anything(), 'Drafted outreach for 2026-11: 2 listings and 1 pitch passed the checks.', null);
  });

  it('writes on schedule from the first Wednesday, once a month, under the month\'s key', async () => {
    const early = fixture({ answer: () => completion(outreachDraft) });
    expect(await early.handlers['content.outreach'](scheduled(new Date('2026-11-03T13:05:00Z'), 'content.outreach'), { now: () => tuesday }))
      .toEqual({ result: { skipped: 'not_yet_this_month', month: '2026-11' } });
    expect(early.client.messages.create).not.toHaveBeenCalled();
    const due = fixture({ answer: () => completion(outreachDraft) });
    await due.handlers['content.outreach'](scheduled(new Date('2026-11-04T13:05:00Z'), 'content.outreach'), { now: () => new Date('2026-11-04T13:05:30Z') });
    expect(due.notifier.send.mock.calls[0][0].dedupeKey).toBe('content:outreach:2026-11');
    const sent = fixture({ answer: () => completion(outreachDraft), state: { outreachMonths: ['2026-11'] } });
    expect(await sent.handlers['content.outreach'](scheduled(new Date('2026-11-12T13:05:00Z'), 'content.outreach'), { now: () => new Date('2026-11-12T13:05:30Z') }))
      .toEqual({ result: { skipped: 'already_sent', month: '2026-11' } });
    expect(sent.client.messages.create).not.toHaveBeenCalled();
  });

  it('tells the owner when no draft passed, and says when the email did not go', async () => {
    const bad = { listings: [{ ...outreachDraft.listings[0], description: `${outreachDraft.listings[0].description} Only $4 per resident.` }], pitches: [] };
    const { handlers, notifier } = fixture({ answer: () => completion(bad), deliveries: [{ channel: 'email', delivery: 'failed' }] });
    const outcome = await handlers['content.outreach'](outreach(), { now: () => tuesday });
    expect(notifier.send.mock.calls[0][0].subject).toBe('Outreach drafts for November 2026: none passed the checks');
    expect(outcome.result).toMatchObject({ outcome: 'not_delivered', listings: 0, pitches: 0, dropped: 1, reasons: ['unlisted_price'] });
  });
});

describe('reach outside cold email (team review 2026-11-17, stage 6)', () => {
  // Every backlog topic is taken, so only a county topic, or a topic written again after a quarter, is left to write.
  const taken = topics.map(topic => stored(topic, 'executed', '2026-10-20T00:00:00Z'));
  function reachFixture({ countyTopics = true, rosterStates = ['PA'], reach = true, articles = taken, queries = [] } = {}) {
    const base = fixture({ answer: () => completion(referralDraft), state: { articles }, marketed: ['caremetric-intel'] });
    if (reach) base.store.contentRosterCounties = vi.fn(async () => [{ countyFips: '42071', state: 'PA', agencies: 9 }, { countyFips: '42999', state: 'PA', agencies: 2 }]);
    const feed = { configured: true, counties: vi.fn(async () => ({ counties: [{ county_fips: '42071', county_name: 'Lancaster County', state: 'PA' }] })) };
    const searchConsole = { configured: true, read: vi.fn(async () => ({ properties: [{ ok: true, queries: queries.map(text => ({ keys: [text] })) }, { ok: false, queries: [{ keys: ['UNREAD'] }] }] })) };
    const handlers = contentHandlers({ store: base.store, notifier: base.notifier, model: base.model, features: new Set([contentFeature]), marketed: ['caremetric-intel'],
      feed, rosterStates, countyTopics, searchConsole, log: () => {} });
    return { ...base, handlers, feed, searchConsole };
  }

  it('with the switch on, writes about the roster\'s counties that Intel\'s county list names', async () => {
    const h = reachFixture();
    const outcome = await h.handlers['content.weekly'](task(), { now: () => tuesday });
    expect(h.store.contentRosterCounties).toHaveBeenCalledWith(12);
    expect(h.feed.counties).toHaveBeenCalledWith({ states: ['PA'] });
    expect(h.store.contentState.mock.calls[0][0]).toContain('home-health-hospice-lancaster-county-pa');
    expect(h.store.contentState.mock.calls[0][0].filter(slug => slug.startsWith('home-health-hospice-'))).toHaveLength(1);
    expect(h.requests[0].messages[0].content).toContain('Working title: Home health and hospice in Lancaster County, PA');
    expect(outcome.result.topic).toBe('county-42071');
  });

  it('with the switch off, without roster states, or without the feature, writes no county topic', async () => {
    for (const options of [{ countyTopics: false }, { rosterStates: [] }, { reach: false }]) {
      const h = reachFixture(options);
      const outcome = await h.handlers['content.weekly'](task(), { now: () => tuesday });
      expect(h.feed.counties, JSON.stringify(options)).not.toHaveBeenCalled();
      expect(outcome.result, JSON.stringify(options)).toEqual({ skipped: 'no_topic' });
    }
  });

  it('reads Search Console\'s queries only with the feature, and writes a topic again once its quarter is over', async () => {
    const old = topics.map(topic => stored(topic, 'executed', '2026-07-01T00:00:00Z'));
    const h = reachFixture({ countyTopics: false, articles: old, queries: ['Home Health Referral Marketing'] });
    const outcome = await h.handlers['content.weekly'](task(), { now: () => tuesday });
    expect(h.searchConsole.read).toHaveBeenCalledTimes(1);
    const written = topics.find(item => item.key === outcome.result.topic);
    expect(h.requests[0].messages[0].content).toContain(`Suggested slug: ${written.slug.slice(0, 72)}-2026-q4`);
    expect(h.requests[0].messages[0].content).toContain('This is a new article for 2026, quarter 4');
    const before = reachFixture({ countyTopics: false, articles: old, reach: false });
    expect((await before.handlers['content.weekly'](task(), { now: () => tuesday })).result).toEqual({ skipped: 'no_topic' });
    expect(before.searchConsole.read).not.toHaveBeenCalled();
  });
});
