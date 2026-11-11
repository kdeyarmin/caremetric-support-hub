import { describe, expect, it, vi } from 'vitest';
import { account, item, subscription } from '../accounts/fixtures.mjs';
import { billingFigures, composeScorecard, payingAt, payingSince, rankNeeds, searchFigures, searchOpportunityBlocks } from './compose.mjs';
import { scorecardFeature, scorecardHandlers } from './index.mjs';

const origin = 'https://hub.example.test';
// Monday 2 November 2026, 07:50 Eastern (EST, UTC-5): the scorecard is due. The week reported is 26 Oct to 1 Nov.
const monday = new Date('2026-11-02T12:50:00Z');
const at = (days, from = monday) => new Date(from.getTime() + days * 86_400_000).toISOString();
const facts = (carebase = {}, intel = {}, aiSpendCents = 1200) => ({
  aiSpendCents,
  products: [
    { product: 'carebase', countyReports: 0, trialStarts: 0, activated: 0, delivered: 0, replies: 0, bounces: 0, complaints: 0, ...carebase },
    { product: 'caremetric-intel', countyReports: 0, trialStarts: 0, activated: 0, delivered: 0, replies: 0, bounces: 0, complaints: 0, ...intel },
  ],
});
const thisWeek = facts({ countyReports: 1 }, { countyReports: 5, trialStarts: 3, activated: 1, delivered: 40, replies: 4, bounces: 1, complaints: 0 }, 2400);
const lastWeek = facts({ countyReports: 1 }, { countyReports: 2, trialStarts: 1, activated: 1, delivered: 30, replies: 1, bounces: 0, complaints: 0 }, 1200);

const book = () => ({
  generatedAt: monday.toISOString(), mode: 'live', total: 2, truncated: false, coupons: [],
  accounts: [
    // Paying for months: in last week's MRR and this week's.
    account({ slug: 'maple-grove', name: 'Maple Grove Senior Living', subscriptions: [subscription({ app: 'caremetric-intel', created: at(-120), items: [item({ unit_amount: 9900 })] })] }),
    // A trial that converted on Wednesday: new paying this week, not in last week's MRR.
    account({ slug: 'cedar-ridge', name: 'Cedar Ridge Care', subscriptions: [subscription({ app: 'caremetric-intel', created: at(-20), trial_end: at(-5), items: [item({ unit_amount: 4900 })] })] }),
  ],
});

const task = (over = {}) => ({ id: 't1', agentKey: 'chief_of_staff', kind: 'scorecard.weekly', sourceKind: 'schedule', attempts: 1, requestKey: 'schedule:00000000-0000-4000-8000-000000000001:20261102T125000Z', ...over });
const fakeReader = (properties = [
  { property: 'sc-domain:caremetricintel.com', ok: true, current: { clicks: 120 }, previous: { clicks: 100 } },
  { property: 'https://cmcarebase.com/', ok: true, current: { clicks: 7 }, previous: { clicks: 9 } },
  { property: 'sc-domain:caremetricadvisors.com', ok: true, current: { clicks: 50 }, previous: { clicks: 50 } },
]) => ({ state: 'ready', configured: true, totals: vi.fn(async () => ({ properties })) });

function fixture({
  features = new Set([scorecardFeature]), deliveries = [{ channel: 'email', delivery: 'sent' }], status = null, brief = { approvals: { count: 2, oldestAt: at(-1) }, incidents: [] },
  snapshot = book(), pipeline = null, ads = null, searchConsole = null, audit = async site => ({ key: site.key, findings: [] }), store: extra = {},
} = {}) {
  const logs = [];
  const store = {
    scorecardFacts: vi.fn(async ({ since }) => (since.toISOString() === '2026-10-26T04:00:00.000Z' ? thisWeek : lastWeek)),
    briefFacts: vi.fn(async () => { if (brief instanceof Error) throw brief; return brief; }),
    accountsPage: vi.fn(async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; }),
    notificationStatus: vi.fn(async () => status),
    startRun: vi.fn(async () => 'run-1'),
    finishRun: vi.fn(async () => undefined),
    ...extra,
  };
  const notifier = { send: vi.fn(async () => deliveries) };
  const growth = pipeline ? { store: { snapshot: vi.fn(async offset => ({ total: pipeline.length, items: offset ? [] : pipeline })) } } : null;
  const handlers = scorecardHandlers({ store, notifier, publicOrigin: origin, features, growth, ads, searchConsole, env: {}, sites: [{ key: 'intel', label: 'Intel', origin: 'https://caremetricintel.com', variants: ['https://www.caremetricintel.com'] }], audit, log: line => logs.push(line) });
  return { store, notifier, logs, handlers, run: (over, now = monday, signal) => handlers['scorecard.weekly'](task(over), { now: () => now, signal }) };
}

describe('the Monday scorecard task', () => {
  it('is registered only when the database declares the scorecard and the store can read its figures', () => {
    for (const features of [undefined, null, new Set(), new Set(['platform.agents.v1']), 'platform.agents.scorecard.v1']) {
      expect(Object.keys(scorecardHandlers({ store: { scorecardFacts: vi.fn() }, notifier: {}, features, searchConsole: null })), String(features)).toEqual([]);
    }
    expect(Object.keys(scorecardHandlers({ store: {}, notifier: {}, features: new Set([scorecardFeature]), searchConsole: null }))).toEqual([]);
    expect(Object.keys(fixture().handlers)).toEqual(['scorecard.weekly']);
    expect(Object.keys(fixture({ features: [scorecardFeature] }).handlers)).toEqual(['scorecard.weekly']);
  });

  it('reports last week against the week before, under the week\'s key, and records a run', async () => {
    const { run, store, notifier } = fixture();
    const outcome = await run();
    expect(store.scorecardFacts.mock.calls.map(([window]) => [window.since.toISOString(), window.until.toISOString()])).toEqual([
      ['2026-10-26T04:00:00.000Z', '2026-11-02T05:00:00.000Z'], ['2026-10-19T04:00:00.000Z', '2026-10-26T04:00:00.000Z'],
    ]);
    const sent = notifier.send.mock.calls[0][0];
    expect(sent).toMatchObject({ severity: 'warning', dedupeKey: 'scorecard:2026-11-02', agentKey: 'chief_of_staff', taskId: 't1', subject: 'Monday scorecard: 1 decision needs you' });
    expect(outcome.result).toMatchObject({ week: '2026-11-02', reported: '2026-10-26', delivery: ['email:sent'], needsYou: 1, needs: ['approvals'] });
    expect(outcome.result.products['caremetric-intel']).toEqual({
      countyReports: [5, 2], trialStarts: [3, 1], activated: [1, 1], newPaying: [1, 0], delivered: [40, 30], replies: [4, 1], bounces: [1, 0], complaints: [0, 0],
    });
    expect(store.startRun).toHaveBeenCalledWith('t1', 'none', 'scorecard.1');
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, 'Sent the Monday scorecard: One decision needs you this week.', null);
  });

  it('puts money only in the email\'s blocks: never in the subject, the stored body, the run, the result or the log', async () => {
    const { run, store, notifier, logs } = fixture();
    const outcome = await run();
    const { subject, body, blocks } = notifier.send.mock.calls[0][0];
    const words = JSON.stringify(blocks);
    // MRR is the Billing screen's maths: $99 + $49 now, $99 a week earlier. Cost per trial is the AI spend over the trial starts.
    expect(words).toContain('$148.00 (a week earlier $99.00)');
    expect(words).toContain('$8.00 ($24.00 over 3 trials); last week $12.00 ($12.00 over 1 trial)');
    expect(words).toContain('Website visitors","Not connected');
    const kept = JSON.stringify([subject, body, store.startRun.mock.calls, store.finishRun.mock.calls, outcome, logs]);
    for (const secret of ['$', 'Maple Grove', 'Cedar Ridge', 'maple-grove', '148', '9900']) expect(kept, secret).not.toContain(secret);
  });

  it('says what changed and keeps at most three decisions, most urgent first, each with a link', async () => {
    const adsOverview = vi.fn(async () => ({
      adsets: [{ id: 's1', name: 'Set', active: true, dailyBudget: 2000 }],
      ads: [{ id: 'a1', adsetId: 's1', active: true, name: 'Loser', createdAt: at(-30) }, { id: 'a2', adsetId: 's1', active: true, name: 'Winner', createdAt: at(-30) }],
      current: [{ adId: 'a1', impressions: 5000, clicks: 10, spendCents: 9000, results: 0, frequency: 1 }, { adId: 'a2', impressions: 5000, clicks: 200, spendCents: 1000, results: 4, frequency: 1 }],
      previous: [{ adId: 'a1', impressions: 100, clicks: 1, spendCents: 500, results: 0, frequency: 1 }],
    }));
    const { run, notifier } = fixture({
      brief: { approvals: { count: 4 }, incidents: [{ target: 'intel' }] },
      pipeline: [{ product: 'caremetric-intel', stage: 'trial', name: 'Oak Hospice', trial_end: at(-2), events: [] }],
      ads: { settings: {}, sources: () => [{ name: 'Meta', client: { adsOverview } }] },
      audit: async site => ({ key: site.key, findings: [{ code: 'page_error', severity: 'high', title: 'A page returns an error', page: 'https://x.test/' }] }),
    });
    const outcome = await run();
    expect(outcome.result).toMatchObject({ needsYou: 3, needs: ['site_down', 'approvals', 'stuck_deals'], moreNeeds: 2, sources: { ads: 'read' } });
    const { body, blocks } = notifier.send.mock.calls[0][0];
    expect(body).toContain('- 1 product down right now\n- 4 proposals waiting for your approval\n- 1 deal waiting on you in the pipeline');
    expect(body).toContain('Trial starts: 3, up from 1.');
    expect(body).toContain('Replies: 4, up from 1.');
    expect(body).toContain('40 emails delivered, 4 replies, 1 bounce, 0 complaints.');
    // Activated trials did not move, so they are not in "What changed".
    expect(body).not.toContain('Activated trials:');
    const buttons = blocks.filter(block => block.type === 'button').map(block => block.url);
    expect(buttons).toEqual([`${origin}/admin/team`, `${origin}/admin/growth`]);
    // The ad spend is counted in cost per trial: $24 of AI and $100 of ads over 3 trials.
    expect(JSON.stringify(blocks)).toContain('$41.33 ($124.00 over 3 trials)');
    // On Monday one read serves both: the spend of the reported week (as of its end) and the ads losing money now.
    expect(adsOverview.mock.calls).toEqual([[{ signal: undefined, now: new Date('2026-11-02T05:00:00Z') }]]);
  });

  it('reads ad spend for the reported week even when it runs later in the week, and judges the ads on the last seven days', async () => {
    const adsOverview = vi.fn(async () => ({ adsets: [], ads: [], current: [{ adId: 'a', spendCents: 500 }], previous: [] }));
    const { run } = fixture({ ads: { settings: {}, sources: () => [{ name: 'Meta', client: { adsOverview } }] } });
    const thursday = new Date('2026-11-05T15:00:00Z');
    await run({ sourceKind: 'owner', id: 'owner-task', requestKey: 'owner:x' }, thursday);
    expect(adsOverview.mock.calls.map(([input]) => input.now)).toEqual([new Date('2026-11-02T05:00:00Z'), thursday]);
  });

  it('adds organic search clicks per product when Search Console is connected, and says so when it is not', async () => {
    const reader = fakeReader();
    const connected = fixture({ searchConsole: reader });
    const outcome = await connected.run();
    expect(reader.totals).toHaveBeenCalledWith({ signal: undefined, now: monday, days: 7 });
    expect(outcome.result.products.carebase.clicks).toEqual([7, 9]);
    expect(outcome.result.products['caremetric-intel'].clicks).toEqual([120, 100]);
    expect(outcome.result.sources.search).toBe('connected');
    expect(connected.notifier.send.mock.calls[0][0].body).toContain('Organic search clicks: 127, up from 109.');

    const missing = fixture({ searchConsole: { state: 'not_configured', configured: false } });
    const without = await missing.run();
    expect(without.result.products.carebase.clicks).toBeUndefined();
    expect(without.result.sources.search).toBe('not_configured');
    expect(JSON.stringify(missing.notifier.send.mock.calls[0][0].blocks)).toContain('Search Console is not connected');
  });

  it('preserves bounded actionable search insights in the single scorecard, without storing queries', async () => {
    const metrics = { clicks: 1, impressions: 200, ctr: 0.005, position: 9 };
    const query = 'targeted agency territory planning';
    const page = 'https://caremetricintel.com/territories';
    const duplicate = 'https://www.caremetricintel.com/territories';
    const reader = fakeReader();
    reader.read = vi.fn(async () => ({
      window: { current: { startDate: '2026-10-02', endDate: '2026-10-29' } },
      properties: [{
        property: 'sc-domain:caremetricintel.com', ok: true, totals: { current: metrics, previous: metrics },
        queries: [{ keys: ['someone@example.com'], ...metrics }, { keys: [query], ...metrics }, ...Array.from({ length: 8 }, (_, i) => ({ keys: [`agency strategy ${i}`], ...metrics }))],
        pages: Array.from({ length: 8 }, (_, i) => ({ keys: [`${page}/${i}`], ...metrics })),
        pairs: [{ keys: [query, page], ...metrics }, { keys: [query, duplicate], ...metrics }],
      }, { property: 'https://cmcarebase.com/', ok: false, code: 'not_permitted', status: 403 }],
    }));
    const { run, notifier, store, logs } = fixture({ searchConsole: reader, store: { individualReports: vi.fn(async () => false) } });
    const outcome = await run();
    expect(reader.read).toHaveBeenCalledWith({ now: monday, signal: undefined });
    expect(reader.totals).toHaveBeenCalledWith({ now: monday, signal: undefined, days: 7 });
    expect(notifier.send).toHaveBeenCalledTimes(1);
    const { blocks, body, subject } = notifier.send.mock.calls[0][0];
    const details = blocks.find(block => block.type === 'details' && block.rows[0]?.[0] === 'Improve a search snippet');
    expect(details.rows).toHaveLength(3);
    expect(JSON.stringify(blocks)).toContain(query);
    expect(JSON.stringify(blocks)).toContain('2026-10-02 to 2026-10-29');
    expect(JSON.stringify(blocks)).toContain('1 Search Console property could not be read for opportunities');
    expect(JSON.stringify(blocks)).toContain('Run now on Weekly SEO check');
    expect(JSON.stringify(blocks)).not.toContain('someone@example.com');
    const stored = JSON.stringify([body, subject, outcome, store.finishRun.mock.calls, logs]);
    expect(stored).not.toContain(query);
    expect(stored).not.toContain(page);
    expect(outcome.result.products['caremetric-intel'].clicks).toEqual([120, 100]);
  });

  it('keeps click totals when detailed search fails, and opportunities when totals fail', async () => {
    const reader = fakeReader();
    reader.read = vi.fn(async () => { throw Object.assign(new Error('private provider response'), { code: 'rate_limited' }); });
    const withoutDetails = fixture({ searchConsole: reader });
    expect((await withoutDetails.run()).result.products['caremetric-intel'].clicks).toEqual([120, 100]);
    expect(JSON.stringify(withoutDetails.notifier.send.mock.calls[0][0].blocks)).toContain('Search opportunities could not be read');
    expect(JSON.stringify(withoutDetails.logs)).not.toContain('private provider response');

    reader.totals.mockRejectedValue(new Error('totals failed'));
    const metrics = { clicks: 1, impressions: 200, ctr: 0.005, position: 9 };
    reader.read.mockResolvedValue({ properties: [{ property: 'sc-domain:caremetricintel.com', ok: true,
      totals: { current: metrics, previous: metrics }, queries: [{ keys: ['agency territories'], ...metrics }], pages: [], pairs: [] }] });
    const withoutTotals = fixture({ searchConsole: reader });
    expect((await withoutTotals.run()).result.products['caremetric-intel'].clicks).toBeUndefined();
    expect(JSON.stringify(withoutTotals.notifier.send.mock.calls[0][0].blocks)).toContain('agency territories');
  });

  it('does not describe unread search properties as having no opportunities', () => {
    expect(JSON.stringify(searchOpportunityBlocks({ sites: [], failures: [{ code: 'not_permitted' }] }))).toContain('could not be read');
    expect(JSON.stringify(searchOpportunityBlocks({ sites: [{}], striking: [], lowCtr: [], competing: [], failures: [] }))).toContain('No search opportunities met the evidence thresholds');
  });

  it('carries every account the account report would flag, not only those at risk', async () => {
    const owing = book();
    owing.accounts.push(account({ slug: 'birch', name: 'Birch House', subscriptions: [subscription({ app: 'carebase', status: 'past_due', created: at(-90) })], invoices: { open: 1, overdue: 1, remainingCents: 4900 } }));
    const { run, notifier } = fixture({ snapshot: owing, brief: { approvals: { count: 0 }, incidents: [] } });
    const outcome = await run();
    expect(outcome.result.needs).toEqual(['accounts']);
    expect(notifier.send.mock.calls[0][0].body).toContain('- 1 customer account needs attention');
  });

  it('never shows a Search Console property it could not read as zero clicks', async () => {
    const reader = fakeReader([
      { property: 'sc-domain:caremetricintel.com', ok: false, code: 'not_permitted', status: 403 },
      { property: 'https://cmcarebase.com/', ok: true, current: { clicks: 7 }, previous: { clicks: 9 } },
      { property: 'https://home.cmcarebase.com/', ok: false, code: 'rate_limited', status: 429 },
    ]);
    const { run, notifier } = fixture({ searchConsole: reader });
    const outcome = await run();
    expect(outcome.result.products['caremetric-intel'].clicks).toBeUndefined();
    expect(outcome.result.products.carebase.clicks).toEqual([7, 9]);
    const words = JSON.stringify(notifier.send.mock.calls[0][0].blocks);
    expect(words).toContain('Organic search clicks","Search Console could not be read this week');
    expect(words).toContain('Organic search clicks","7 (the 7 days before 9); 1 property could not be read');
    // A product with no property configured has no clicks row at all.
    const none = fixture({ searchConsole: fakeReader([{ property: 'https://cmcarebase.com/', ok: true, current: { clicks: 1 }, previous: { clicks: 1 } }]) });
    expect((await none.run()).result.products['caremetric-intel'].clicks).toBeUndefined();
  });

  it('still sends when an optional source fails, and names what is missing', async () => {
    const { run, notifier, logs } = fixture({ snapshot: Object.assign(new Error('boom'), { code: 'db_down' }), brief: new Error('nope') });
    const outcome = await run();
    expect(outcome.result.sources.billing).toBe('unavailable');
    expect(outcome.result.products.carebase.newPaying).toBeUndefined();
    const words = JSON.stringify(notifier.send.mock.calls[0][0].blocks);
    expect(words).toContain('Billing could not be read this morning');
    expect(words).toContain('The approvals waiting and products down could not be read this morning.');
    expect(logs.map(line => JSON.parse(line))).toEqual([
      { event: 'hub_scorecard_source_unread', source: 'brief', code: 'error' }, { event: 'hub_scorecard_source_unread', source: 'billing', code: 'db_down' },
    ]);
  });

  it('fails when its own figures cannot be read, so the scheduler tries again', async () => {
    const { run, notifier } = fixture({ store: { scorecardFacts: vi.fn(async () => { throw Object.assign(new Error('x'), { code: '57014' }); }) } });
    await expect(run()).rejects.toMatchObject({ code: '57014' });
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('sends once a week: a later run finds the week attempted and does no work; a failed send is tried again', async () => {
    for (const status of ['sent', 'unknown', 'pending', 'suppressed']) {
      const { run, store, notifier } = fixture({ status });
      expect(await run({}, new Date('2026-11-04T12:50:00Z'))).toEqual({ result: { skipped: 'already_attempted', week: '2026-11-02' } });
      expect(store.notificationStatus).toHaveBeenCalledWith('scorecard:2026-11-02');
      expect(store.scorecardFacts).not.toHaveBeenCalled();
      expect(notifier.send).not.toHaveBeenCalled();
    }
    const again = fixture({ status: 'failed' });
    await again.run();
    expect(again.notifier.send).toHaveBeenCalledTimes(1);
  });

  it('keeps the week it was due for when a retry runs on Tuesday, and asks for a retry when the provider refused it', async () => {
    const refused = fixture({ deliveries: [{ channel: 'email', delivery: 'failed' }] });
    await expect(refused.run({}, new Date('2026-11-03T13:00:00Z'))).rejects.toMatchObject({ code: 'notification_failed', transient: true });
    expect(refused.notifier.send.mock.calls[0][0].dedupeKey).toBe('scorecard:2026-11-02');
    expect(refused.store.finishRun).toHaveBeenCalledWith('run-1', 'failed', {}, 'The Monday scorecard was written but not delivered (email:failed).', 'not_delivered');
  });

  it('reports the last full week on Run now, under a key of its own, whatever the setting says', async () => {
    const { run, store, notifier } = fixture({ status: 'sent' });
    const outcome = await run({ sourceKind: 'owner', id: 'owner-task', requestKey: 'owner:x' }, new Date('2026-11-05T15:00:00Z'));
    expect(store.notificationStatus).not.toHaveBeenCalled();
    expect(notifier.send.mock.calls[0][0].dedupeKey).toBe('scorecard:run:owner-task');
    expect(outcome.result).toMatchObject({ week: '2026-11-02', reported: '2026-10-26' });
  });

  it('sends nothing once the scheduler has stopped waiting', async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, notifier } = fixture();
    await expect(run({}, monday, controller.signal)).rejects.toMatchObject({ code: 'task_timeout', transient: true });
    expect(notifier.send).not.toHaveBeenCalled();
  });
});

describe('the scorecard\'s figures', () => {
  it('counts a subscription as paying only from its trial\'s end until it ended', () => {
    const time = Date.parse('2026-11-01T00:00:00Z');
    expect(payingAt(subscription({ created: '2026-10-01T00:00:00Z' }), time)).toBe(true);
    expect(payingAt(subscription({ created: '2026-11-02T00:00:00Z' }), time)).toBe(false);
    expect(payingAt(subscription({ created: '2026-10-01T00:00:00Z', trial_end: '2026-11-03T00:00:00Z' }), time)).toBe(false);
    expect(payingAt(subscription({ status: 'trialing', created: '2026-10-01T00:00:00Z' }), time)).toBe(false);
    expect(payingAt(subscription({ status: 'active', pause_behavior: 'void', created: '2026-10-01T00:00:00Z' }), time)).toBe(false);
    expect(payingAt(subscription({ status: 'canceled', created: '2026-10-01T00:00:00Z', ended_at: '2026-11-04T00:00:00Z' }), time)).toBe(true);
    expect(payingAt(subscription({ status: 'canceled', created: '2026-10-01T00:00:00Z', ended_at: '2026-10-20T00:00:00Z' }), time)).toBe(false);
  });

  it('counts a customer once, when they first start paying: a quick cancel counts, a return after a gap does not', () => {
    expect(payingSince(subscription({ created: '2026-10-01T00:00:00Z', trial_end: '2026-10-15T00:00:00Z' }))).toBe(Date.parse('2026-10-15T00:00:00Z'));
    expect(payingSince(subscription({ status: 'canceled', created: '2026-10-01T00:00:00Z', trial_end: '2026-10-15T00:00:00Z', ended_at: '2026-10-10T00:00:00Z' }))).toBeNull();
    expect(payingSince(subscription({ status: 'trialing', created: '2026-10-01T00:00:00Z' }))).toBeNull();
    const until = new Date('2026-11-02T05:00:00Z');
    const quick = account({ slug: 'quick', subscriptions: [subscription({ app: 'carebase', status: 'canceled', created: at(-10), trial_end: at(-5), ended_at: at(-2) })] });
    const back = account({ slug: 'back', subscriptions: [
      subscription({ app: 'carebase', status: 'canceled', created: at(-200), ended_at: at(-100) }), subscription({ app: 'carebase', created: at(-3) }),
    ] });
    const figures = billingFigures({ accounts: [quick, back], coupons: [] }, { now: monday, until });
    expect(figures.products.carebase.newPaying).toBe(1);
    expect(figures.products.carebase.previousNewPaying).toBe(0);
  });

  it('gives MRR exactly as the Billing screen does, and last week\'s from the subscriptions paying then', () => {
    const figures = billingFigures(book(), { now: monday, until: new Date('2026-11-02T05:00:00Z') });
    expect(figures.products['caremetric-intel']).toEqual({ mrrCents: 14800, previousMrrCents: 9900, newPaying: 1, previousNewPaying: 0 });
    expect(figures.products.carebase).toEqual({ mrrCents: 0, previousMrrCents: 0, newPaying: 0, previousNewPaying: 0 });
    expect(billingFigures(null, { now: monday, until: monday })).toBeNull();
  });

  it('maps Search Console properties to products by their host and leaves other sites out', () => {
    const figures = searchFigures({ properties: [
      { property: 'sc-domain:caremetricintel.com', ok: true, current: { clicks: 10.4 }, previous: { clicks: 3 } },
      { property: 'https://www.caremetricintel.com/', ok: false, code: 'not_permitted' },
      { property: 'https://home.cmcarebase.com/', ok: true, current: { clicks: 2 }, previous: { clicks: 1 } },
      { property: 'sc-domain:help.caremetric.ai', ok: true, current: { clicks: 99 }, previous: { clicks: 99 } },
    ] });
    expect(figures.products).toEqual({
      carebase: { clicks: 2, previous: 1, properties: 1, failed: 0 }, 'caremetric-intel': { clicks: 10, previous: 3, properties: 1, failed: 1 },
    });
  });

  it('ranks what needs the owner and keeps three', () => {
    const ranked = rankNeeds({ incidents: 0, approvals: { count: 1 }, accounts: 2, stuckDeals: 3, failingAds: 1, siteProblems: 4 });
    expect(ranked.kept.map(item => [item.key, item.path])).toEqual([['approvals', '/admin/team'], ['accounts', '/admin/billing?tab=customers'], ['stuck_deals', '/admin/growth']]);
    expect(ranked.more).toBe(2);
    expect(rankNeeds({}).kept).toEqual([]);
  });

  it('shows a connected visitor source and never invents one', () => {
    const shown = composeScorecard({ week: '2026-10-26', facts: { current: thisWeek, previous: lastWeek }, visitors: { products: { carebase: { visitors: 300, previous: 250 } } } });
    expect(JSON.stringify(shown.blocks)).toContain('Website visitors","300 (last week 250)');
    expect(JSON.stringify(shown.blocks)).toContain('Website visitors","Not connected');
    expect(shown.result.sources.visitors).toBe('connected');
    const none = composeScorecard({ week: '2026-10-26', facts: { current: thisWeek, previous: thisWeek } });
    expect(none.body).toContain('Nothing needs you this week.');
    expect(none.subject).toBe('Monday scorecard: nothing needs you');
  });
});
