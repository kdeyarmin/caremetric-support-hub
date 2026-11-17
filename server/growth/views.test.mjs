import { describe, expect, it, vi } from 'vitest';
import { intelFeedFeature, intelFeedReader, intelReportViewsUrl } from './intel-feed.mjs';
import { growthReportViewsFeature, viewsHandlers } from './views.mjs';
import { reportLinks } from './report-link.mjs';
import { draftMessage } from './draft.mjs';
import { unviewedTouchAngle, viewedTouchAngle } from './playbook.mjs';

const key = 'feed-secret-0123456789abcdef0123456789';
const respond = body => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
const view = (id, ref = '0b6a3a50-1111-4c2b-9d0e-0123456789ab') => ({ id, ref, ccn: '397001', county_fips: null, setting: 'hha', viewed_at: '2026-11-16T15:00:00.000Z' });

describe('reading report opens from Intel', () => {
  it('posts a signed page request to Intel\'s report-views address and reads the opens', async () => {
    const fetchImpl = respond({ contract: 'caremetric.report-views.v1', views: [view(7)], next_after_id: 7 });
    const feed = intelFeedReader({ features: new Set([intelFeedFeature]), enabled: true, key, fetchImpl, now: () => 1794225600_000 });
    const answer = await feed.reportViews({ afterId: 6 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(intelReportViewsUrl);
    expect(JSON.parse(init.body)).toEqual({ after_id: 6, limit: 200 });
    expect(init.headers['X-CareMetric-Signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(answer).toEqual({ contract: 'caremetric.report-views.v1', views: [view(7)], next_after_id: 7 });
  });
});

describe('growth.views', () => {
  const setup = ({ enabled = true, pages = [{ views: [view(1), view(2)], next_after_id: 2 }], saved = { recorded: 1, ignored: 1, firstViews: [{ opportunity: 'o1', name: 'Valley Home Health', viewedAt: '2026-11-16T15:00:00Z' }] } } = {}) => {
    const store = { reportViewsCursor: vi.fn(async () => '0'), reportViewsRecord: vi.fn(async () => saved) };
    const feed = { configured: true, reportViews: vi.fn(async () => pages.shift() ?? { views: [], next_after_id: 2 }) };
    const notifier = { send: vi.fn() };
    const run = (task = { id: 't', agentKey: 'marketing_manager', agent: { autonomy: 'propose' } }) =>
      viewsHandlers({ growth: { store, views: { enabled, feed } }, features: new Set([growthReportViewsFeature]), notifier })['growth.views'](task);
    return { store, feed, notifier, run };
  };
  it('reads the opens since the last read, has the database record them, and tells the owner about an agency\'s first open', async () => {
    const { store, feed, notifier, run } = setup();
    expect((await run()).result).toEqual({ read: 2, recorded: 1, ignored: 1, firstViews: 1 });
    expect(feed.reportViews).toHaveBeenCalledWith(expect.objectContaining({ afterId: 0, limit: 200 }));
    expect(store.reportViewsRecord).toHaveBeenCalledWith([{ id: 1, ref: view(1).ref, ccn: '397001', viewed_at: view(1).viewed_at },
      { id: 2, ref: view(2).ref, ccn: '397001', viewed_at: view(2).viewed_at }], 2);
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Valley Home Health opened its market report', dedupeKey: 'growth:report-viewed:o1' }));
  });
  it('does nothing when off or in Observe, and stops at an empty page', async () => {
    expect((await setup({ enabled: false }).run()).result).toEqual({ skipped: 'off' });
    expect((await setup().run({ id: 't', agent: { autonomy: 'observe' } })).result).toEqual({ skipped: 'observe_only' });
    const quiet = setup({ pages: [{ views: [], next_after_id: 0 }] });
    expect((await quiet.run()).result).toEqual({ read: 0, recorded: 0, ignored: 0, firstViews: 0 });
    expect(quiet.store.reportViewsRecord).not.toHaveBeenCalled();
  });
});

describe('the Hub\'s own check never counts as an open', () => {
  it('checks that a report opens with a link signed without the reference, and offers the link with it', async () => {
    const fetchImpl = vi.fn(async () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const links = reportLinks({ key, fetchImpl, now: () => 1794225600_000 });
    const o = { id: '0b6a3a50-1111-4c2b-9d0e-0123456789ab', product: 'caremetric-intel', name: 'Valley Home Health',
      evidence: [{ claim: 'Listed in the CMS Provider of Services file (2026Q3): Valley Home Health (CCN 397001) is a Medicare-certified home health agency in Erie, PA.' }] };
    const link = await links.checkedLinkFor(o);
    const claimsOf = url => JSON.parse(Buffer.from(url.split('/report/')[1].split('.')[0], 'base64url').toString());
    expect(claimsOf(fetchImpl.mock.calls[0][0])).not.toHaveProperty('r');
    expect(claimsOf(link.url).r).toBe(o.id);
  });
});

describe('the second email follows whether the report was opened', () => {
  const now = new Date().toISOString();
  const o = (events) => ({ id: 'opp', organization_id: 'org', product: 'caremetric-intel', name: 'Valley Home Health', domain: 'valleyhh.org', stage: 'contacted', touches: 1, contact_id: 'c1', memory: {}, events,
    policy: { approved_claim: 'Intel shows every referral source in your county.', experiment_enabled: false, max_touches: 3 },
    evidence: [{ id: 'e1', claim: 'Valley Home Health serves Erie County.', source_url: 'https://valleyhh.org/about', confidence: 'high', observed_at: now }] });
  const report = { label: 'Free market report for Valley Home Health', url: 'https://www.caremetricintel.com/report/abc.def' };
  const draft = async (events, views = true) => {
    const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: { subject: 'Turning a report into visits', body: 'Which physicians in Erie County certify the most patients?\n\nhttps://www.caremetricintel.com/', citations: ['e1'], needsHuman: false } })) };
    const result = await draftMessage({ opportunity: o(events), work: { kind: 'outreach', action: 'a', success: 'b' }, task: { id: 't' }, model, report, views });
    return { result, input: JSON.parse(model.run.mock.calls[0][1].user) };
  };
  it('picks up from the report when someone opened it, brings a new angle when nobody did, and records which as an arm', async () => {
    const opened = await draft([{ kind: 'report_viewed', occurred_at: now }]);
    expect(opened.input.touchPlan).toBe(viewedTouchAngle);
    expect(opened.result.arms.viewed).toBe('yes');
    const unopened = await draft([]);
    expect(unopened.input.touchPlan).toBe(unviewedTouchAngle);
    expect(unopened.result.arms.viewed).toBe('no');
    // With the setting off nothing is read about opens, and no arm is recorded: the second email points to the report again and offers
    // the trial, as it does when nobody opened it (every second email offers the trial since 2026-11-17, draft.mjs).
    const off = await draft([], false);
    expect(off.input.touchPlan).toBe(unviewedTouchAngle);
    expect(off.result.arms.viewed).toBeUndefined();
    const ignored = await draft([{ kind: 'report_viewed', occurred_at: now }], false);
    expect(ignored.input.touchPlan).toBe(unviewedTouchAngle);
    expect(ignored.result.arms.viewed).toBeUndefined();
    expect(opened.result).toMatchObject({ modelGenerated: true });
    expect(unopened.result).toMatchObject({ modelGenerated: true });
  });

  it('offers the free trial in both second emails, in plain words, and never says whether the report was opened or what the trial needs', () => {
    for (const plan of [viewedTouchAngle, unviewedTouchAngle]) {
      expect(plan).toMatch(/^Second email to an agency whose market report was sent with the first\. Do not say or hint that you know whether anyone opened it\./);
      // The writer writes the opening; the email's own sections offer the trial (campaign.mjs).
      expect(plan).toMatch(/The email adds: a week of the work in CareMetric Intel in four steps, the Founders Sale, the 30-day free trial with its link, and the market report's link again\./);
      expect(plan).toMatch(/No link in your words, and nothing about the credit card or billing\./);
      expect(plan).not.toMatch(/credit card is required|canceling before it ends|card terms/);
    }
    // After an open the opening moves on from the report; otherwise it leads with a page of it.
    expect(viewedTouchAngle).toMatch(/Pick up where a report leaves an agency/);
    expect(unviewedTouchAngle).toMatch(/lead with one page of the report/);
  });
});
