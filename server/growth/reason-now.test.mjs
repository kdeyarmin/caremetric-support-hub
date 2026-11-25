import { describe, expect, it, vi } from 'vitest';
import { monthDay, reasonNow, recentReleases, releaseCacheMs, releaseNews, releaseSource } from './reason-now.mjs';
import { draftMessage, criticMaxTokens, criticPromptVersion } from './draft.mjs';
import { readCampaign, campaignBlock } from './campaign.mjs';
import { liveEvaluationCases, gradeCase } from './live-evaluation.mjs';

const now = new Date('2026-11-25T15:00:00Z');
const daysAgo = days => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
const long = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const record = (extra = '') => ({ id: 'cms', source_url: 'https://data.cms.gov/provider-data/', observed_at: now.toISOString(),
  claim: `CMS Provider of Services file, 2026Q3: Valley Home Health (CCN 397001) is a Medicare-certified home health agency in Erie, PA; ownership type: Proprietary${extra}.` });
const site = { id: 'site', source_url: 'https://valleyhh.example/about', observed_at: now.toISOString(), claim: 'Valley Home Health serves Erie County.' };
const news = { id: 'news', source_url: 'https://valleyhh.example/news', observed_at: daysAgo(3), claim: 'Valley Home Health is hiring a community liaison.' };
const release = (title, published) => ({ dataset: 'x', title, data_year: '2025', period_start: null, period_end: null, published, loaded: daysAgo(1) });

describe('the one dated reason a first email goes now', () => {
  it('prefers the brief\'s newest dated trigger, then an undated one from a page read this month', () => {
    const triggers = [{ fact: 'It opened an office in Meadville.', date: daysAgo(40), sourceId: 'site' }, { fact: 'It is hiring a community liaison.', date: daysAgo(10), sourceId: 'news' }];
    expect(reasonNow({ sources: [site, news, record()], triggers, now })).toEqual({ kind: 'trigger', fact: 'It is hiring a community liaison.', date: daysAgo(10), sourceId: 'news' });
    // Too old, from evidence the draft was not given, or undated from a page read long ago: not a reason.
    expect(reasonNow({ sources: [site], triggers: [{ fact: 'It opened an office.', date: daysAgo(200), sourceId: 'site' }], now })).toBeNull();
    expect(reasonNow({ sources: [site], triggers: [{ fact: 'It is hiring.', date: daysAgo(5), sourceId: 'elsewhere' }], now })).toBeNull();
    expect(reasonNow({ sources: [{ ...news, observed_at: daysAgo(45) }], triggers: [{ fact: 'It is hiring.', date: null, sourceId: 'news' }], now })).toBeNull();
    expect(reasonNow({ sources: [news], triggers: [{ fact: 'It is hiring.', date: '', sourceId: 'news' }], now })).toEqual({ kind: 'trigger', fact: 'It is hiring.', date: null, sourceId: 'news' });
  });

  it('reads a recent certification or change of ownership from the Medicare record, and nothing older', () => {
    expect(reasonNow({ sources: [record(`; certified ${long(daysAgo(200))}`)], now })).toEqual({ kind: 'record', fact: `Medicare certified it on ${long(daysAgo(200))}.`, date: daysAgo(200), sourceId: 'cms' });
    expect(reasonNow({ sources: [record(`; certified ${long(daysAgo(900))}; change of ownership recorded ${long(daysAgo(90))}`)], now }))
      .toEqual({ kind: 'record', fact: `A change of ownership was recorded with Medicare on ${long(daysAgo(90))}.`, date: daysAgo(90), sourceId: 'cms' });
    expect(reasonNow({ sources: [record(`; certified ${long(daysAgo(900))}; change of ownership recorded ${long(daysAgo(500))}`)], now })).toBeNull();
    // A date in a web page's words is not the Medicare record's.
    expect(reasonNow({ sources: [{ ...site, claim: `Valley Home Health was certified ${long(daysAgo(30))}.` }], now })).toBeNull();
  });

  it('names a new CMS release for the reader\'s own kind of care, by its month and day, and never one it cannot date', () => {
    const releases = [release('Home Health Care - Provider Data', daysAgo(12)), release('Hospice - Provider Data', daysAgo(5)), release('Nursing Home Care Compare', daysAgo(2)),
      release('Home Health Care - Agencies', null), release('Home Health Care - State', daysAgo(80))];
    expect(monthDay('2026-11-12')).toBe('November 12');
    expect(releaseNews(releases, { setting: 'home_health', now })).toEqual([{ topic: 'home health', date: daysAgo(12), fact: `CMS released new home health data on ${monthDay(daysAgo(12))}.` }]);
    expect(releaseNews(releases, { setting: 'hospice', now }).map(item => item.topic)).toEqual(['hospice']);
    expect(releaseNews(releases, { setting: 'nursing_home', now }).map(item => item.topic)).toEqual(['nursing home']);
    expect(releaseNews(releases, { setting: 'agency', now }).map(item => item.topic)).toEqual(['hospice', 'home health']);
    expect(reasonNow({ sources: [site], releases, setting: 'home_health', now })).toEqual({ kind: 'release', fact: `CMS released new home health data on ${monthDay(daysAgo(12))}.`, date: daysAgo(12), sourceId: 'release' });
    // The release is a source for the checks only; no year, no file name.
    const source = releaseSource(reasonNow({ sources: [site], releases, setting: 'home_health', now }), now);
    expect(source).toMatchObject({ id: 'release', claim: `CMS released new home health data on ${monthDay(daysAgo(12))}.` });
    expect(source.claim).not.toMatch(/20\d\d|Provider Data/);
    expect(releaseSource(null)).toBeNull();
    // Nothing dated at all: no reason, and the email says only that the report is ready.
    expect(reasonNow({ sources: [site], releases: [], now })).toBeNull();
  });

  it('reads Intel\'s releases at most every six hours, and gives none when the feed is off or does not answer', async () => {
    let at = 0;
    const feed = { configured: true, releases: vi.fn(async () => ({ releases: [release('Hospice - Provider Data', '2026-11-20')] })) };
    expect(await recentReleases(feed, { now: () => at })).toHaveLength(1);
    expect(await recentReleases(feed, { now: () => at + 1000 })).toHaveLength(1);
    expect(feed.releases).toHaveBeenCalledTimes(1);
    expect(feed.releases.mock.calls[0][0]).toMatchObject({ sinceDays: 45 });
    at = releaseCacheMs + 1;
    await recentReleases(feed, { now: () => at });
    expect(feed.releases).toHaveBeenCalledTimes(2);
    expect(await recentReleases({ configured: false, releases: vi.fn() })).toEqual([]);
    expect(await recentReleases(null)).toEqual([]);
    expect(await recentReleases({ configured: true, releases: vi.fn(async () => { throw Object.assign(new Error('down'), { code: 'feed_unavailable' }); }) })).toEqual([]);
  });
});

describe('the drafter and the dated reason', () => {
  const report = { label: 'Free market report for Valley Home Health', url: 'https://www.caremetricintel.com/report/abc.def' };
  const intel = { id: 'oi', organization_id: 'gi', product: 'caremetric-intel', name: 'Valley Home Health', version: 1, contact_id: 'c', stage: 'qualified', touches: 0, memory: {},
    policy: { approved_claim: 'Intel shows every referral source in your county.', max_touches: 3 }, evidence: [site], events: [] };
  const work = { kind: 'outreach', action: 'First touch', success: 'Reply' };
  const body = `I put together a free market report for Valley Home Health from Medicare data.\n${report.url}\n\nCMS released new home health data on ${monthDay(daysAgo(12))}, and the report is a quick way to see the county now.`;
  const writer = (citations = ['site', 'release']) => ({ configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: { subject: 'Your Valley Home Health market report', body, citations, needsHuman: false } })) });

  it('gives the writer the reason, lets it state a release, never stores the release as a citation, and records the kind', async () => {
    const model = writer();
    const draft = await draftMessage({ opportunity: intel, work, task: {}, model, report, releases: [release('Home Health Care - Provider Data', daysAgo(12))] });
    expect(draft).toMatchObject({ modelGenerated: true, citations: ['site'] });
    expect(draft.arms.reason).toBe('release');
    const input = JSON.parse(model.run.mock.calls[0][1].user);
    expect(input.reasonNow).toEqual({ fact: `CMS released new home health data on ${monthDay(daysAgo(12))}.`, date: daysAgo(12), sourceId: 'release' });
    expect(input.sources.map(source => source.id)).toEqual(['site', 'release']);
    // The release is never the one citation an outreach email needs.
    expect(await draftMessage({ opportunity: intel, work, task: {}, model: writer(['release']), report, releases: [release('Home Health Care - Provider Data', daysAgo(12))] })).toBeNull();
    // No release and nothing dated: the writer gets no reason, and the email records none.
    const plain = writer(['site']);
    const none = await draftMessage({ opportunity: intel, work, task: {}, model: { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: { subject: 'Your Valley Home Health market report',
      body: `I put together a free market report for Valley Home Health from Medicare data.\n${report.url}`, citations: ['site'], needsHuman: false } })) }, report });
    expect(none.arms.reason).toBe('none');
    expect(plain.run).not.toHaveBeenCalled();
    // A later touch and CareBase get none: only a first cold email is given a reason, and a release is Intel's to name.
    const later = writer(['site']);
    await draftMessage({ opportunity: { ...intel, touches: 1 }, work, task: {}, model: later, report, releases: [release('Home Health Care - Provider Data', daysAgo(12))] });
    expect(JSON.parse(later.run.mock.calls[0][1].user).reasonNow).toBeUndefined();
    const carebase = writer(['site']);
    await draftMessage({ opportunity: { ...intel, product: 'carebase', policy: { approved_claim: 'CareBase supports facility training.' } }, work, task: {}, model: carebase, releases: [release('Home Health Care - Provider Data', daysAgo(12))] });
    expect(JSON.parse(carebase.run.mock.calls[0][1].user).reasonNow).toBeUndefined();
  });

  it('asks the reader once more, with twice the room, when its answer was cut off', async () => {
    const reads = [];
    const run = vi.fn(async (_task, request) => {
      if (request.promptVersion !== criticPromptVersion) return { outcome: 'completed', output: { subject: 'Your Valley Home Health market report', body: `I put together a free market report for Valley Home Health from Medicare data.\n${report.url}`, citations: ['site'], needsHuman: false } };
      reads.push(request.maxTokens);
      if (reads.length === 1) throw Object.assign(new Error('cut off'), { code: 'output_truncated', transient: false });
      return { outcome: 'completed', output: { specific: 4, relevant: 4, clearAsk: 4, wouldReply: 4, weakness: 'none', weakestSentence: '' } };
    });
    const draft = await draftMessage({ opportunity: intel, work, task: {}, model: { configured: true, run }, report, critic: true });
    expect(reads).toEqual([criticMaxTokens, criticMaxTokens * 2]);
    expect(draft.arms.critic).toBe('4');
    // Any other failure leaves the email unread, as before.
    const refused = vi.fn(async (_task, request) => (request.promptVersion === criticPromptVersion ? (() => { throw Object.assign(new Error('x'), { code: 'output_invalid', transient: false }); })()
      : { outcome: 'completed', output: { subject: 'Your Valley Home Health market report', body: `I put together a free market report for Valley Home Health from Medicare data.\n${report.url}`, citations: ['site'], needsHuman: false } }));
    const unread = await draftMessage({ opportunity: intel, work, task: {}, model: { configured: true, run: refused }, report, critic: true });
    expect(unread.arms.critic).toBeUndefined();
    expect(refused.mock.calls.filter(([, request]) => request.promptVersion === criticPromptVersion)).toHaveLength(1);
  });
});

describe('the first email without the trial (campaign version 3)', () => {
  const trialUrl = 'https://www.caremetricintel.com/login?signup=true&utm_source=caremetric&utm_medium=email&utm_campaign=growth-intel-touch1';
  const reportUrl = 'https://www.caremetricintel.com/report/abc.def';
  const reports = { accepts: url => url === reportUrl };
  const opening = `I put together a free market report for Valley Home Health from Medicare data.\n${reportUrl}`;
  it('writes the first email\'s sections without the trial, and still reads an email drafted before the change as it was approved', () => {
    const v3 = campaignBlock(1, { trialUrl, reportUrl, ownReport: true, setting: 'home_health', version: 3 });
    const v2 = campaignBlock(1, { trialUrl, reportUrl, ownReport: true, setting: 'home_health', version: 2 });
    expect(v3).not.toMatch(/free trial|signup=true/);
    expect(v2).toContain('Start your 30-day free trial');
    expect(campaignBlock(1, { trialUrl: null, reportUrl, ownReport: true, setting: 'home_health', version: 3 })).toBe(v3);
    expect(campaignBlock(1, { trialUrl: null, reportUrl, ownReport: true, setting: 'home_health', version: 2 })).toBeNull();
    expect(readCampaign(`${opening}\n\n${v3}`, { reports })).toMatchObject({ version: 3, touch: 1, trialUrl: null, reportUrl, ownReport: true });
    expect(readCampaign(`${opening}\n\n${v2}`, { reports })).toMatchObject({ version: 2, touch: 1, trialUrl, reportUrl });
    // The second email keeps the trial in either version.
    expect(campaignBlock(2, { trialUrl, reportUrl, ownReport: true, setting: 'home_health', version: 3 })).toBe(campaignBlock(2, { trialUrl, reportUrl, ownReport: true, setting: 'home_health', version: 2 }));
  });
});

describe('the live evaluation and the dated reason', () => {
  it('gives each invented agency only the triggers its evidence states, and records the reason kind it was given', () => {
    const cases = liveEvaluationCases(now, { approvedClaim: 'x' });
    const briefed = cases.filter(item => item.briefPart);
    expect(briefed.filter(item => item.trigger === 'cms_record').every(item => item.briefPart.triggers.length === 0)).toBe(true);
    const owner = briefed.find(item => item.trigger === 'new_owner');
    expect(owner.briefPart.triggers[0].date).toBe(daysAgo(90));
    const web = briefed.find(item => item.trigger === 'web');
    expect(web.briefPart.triggers[0]).toMatchObject({ date: null, sourceUrl: 'https://summithomehealthpartners.example/news' });
    expect(gradeCase(cases[0], { modelGenerated: true, arms: { critic: '4', form: 'short', reason: 'record' } })).toMatchObject({ ok: true, wouldReply: 4, reason: 'record' });
  });
});
