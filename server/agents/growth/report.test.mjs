import { describe, expect, it } from 'vitest';
import { composeGrowthReport, fromSearch, readFacts, suggestionsFor } from './report.mjs';

const since = new Date('2026-10-26T04:00:00Z');
const until = new Date('2026-11-02T05:00:00Z');
const kinds = (counts = {}) => ({ demo_request: 0, consultation: 0, contact: 0, trial_signup: 0, newsletter: 0, savings_model: 0, county_report: 0, ...counts });
const factsOf = (overrides = {}) => ({
  since: since.toISOString(), until: until.toISOString(),
  leads: {
    total: 6, byKind: kinds({ demo_request: 2, contact: 1, trial_signup: 1, newsletter: 2 }),
    byProduct: [{ product: 'carebase', count: 4 }, { product: 'caremetric-intel', count: 2 }],
    bySource: [{ source: 'google', count: 3 }, { source: 'direct', count: 2 }, { source: 'linkedin.com', count: 1 }], otherSources: 0,
    landingPaths: [{ path: '/pricing', count: 3 }, { path: '/', count: 2 }], campaigns: [{ campaign: 'fall-launch', count: 2 }],
  },
  trials: { started: 1, subscriptions: 1, converted: 1 },
  replies: { replied: 3, medianMinutes: 42 },
  unanswered: { count: 0, oldestMinutes: null, byKind: {} },
  ...overrides,
});
const leadsOf = (overrides = {}) => ({ ...factsOf().leads, ...overrides });
const codes = facts => suggestionsFor(facts).map(item => item.code);

describe('the weekly growth report', () => {
  it('counts the week\'s leads by kind, product and source, trials, replies and what waits, in plain words', () => {
    const report = composeGrowthReport(factsOf(), { since, until, publicOrigin: 'https://hub.example.test' });
    expect(report.subject).toBe('Weekly growth: 6 leads, 1 trial started (Oct 26 to Nov 1)');
    expect(report.headline).toBe('6 leads from Oct 26 to Nov 1: 2 demo requests, 1 contact request, 1 trial sign-up and 2 newsletter sign-ups.');
    expect(report.body).toContain('By product: CareBase (4), CareMetric Intel (2).');
    expect(report.body).toContain('Where they came from: google (3), direct (2), linkedin.com (1).');
    expect(report.body).toContain('Trials: 1 sign-up and 1 new trial subscription; 1 converted to paid.');
    expect(report.body).toContain('First reply: 42 minutes (median of 3 answered leads).');
    expect(report.body).toContain('Unanswered now: none.');
    expect(report.body).toContain('Top landing pages: /pricing (3), / (2).');
    expect(report.body).toContain('Top campaigns: fall-launch (2).');
    expect(report.body).toMatch(/Suggestions:\n1\. .+\n2\. .+\n3\. .+$/);
    expect(report.blocks[0]).toEqual({ type: 'callout', tone: 'info', title: 'This week.', text: report.headline });
    expect(report.blocks.find(block => block.type === 'details')).toEqual({ type: 'details', rows: [['Demo requests', '2'], ['Contact requests', '1'], ['Trial sign-ups', '1'], ['Newsletter sign-ups', '2']] });
    expect(report.blocks.at(-1)).toEqual({ type: 'button', label: 'Open Leads', url: 'https://hub.example.test/admin/leads' });
    expect(report.result).toEqual({
      leads: 6, byKind: { demo_request: 2, contact: 1, trial_signup: 1, newsletter: 2 }, trials: { started: 1, subscriptions: 1, converted: 1 },
      medianFirstReplyMinutes: 42, unanswered: 0, suggestions: ['trials_started', 'testimonial', 'article'],
    });
  });

  it('says plainly when no lead came in, and still suggests three things', () => {
    const report = composeGrowthReport({ leads: { total: 0, byKind: kinds() }, trials: {}, replies: { replied: 0, medianMinutes: null }, unanswered: { count: 0 } }, { since, until });
    expect(report.subject).toBe('Weekly growth: 0 leads, 0 trials started (Oct 26 to Nov 1)');
    expect(report.headline).toBe('No new leads from Oct 26 to Nov 1.');
    expect(report.body).toContain('First reply: no lead was answered yet.');
    expect(report.result.suggestions).toEqual(['no_leads', 'testimonial', 'article']);
    expect(report.blocks.some(block => block.type === 'button')).toBe(false);
  });

  it('warns in its callout when leads are waiting, and says for how long', () => {
    const report = composeGrowthReport(factsOf({ unanswered: { count: 2, oldestMinutes: 3000, byKind: { demo_request: 2 } } }), { since, until });
    expect(report.blocks[0].tone).toBe('warning');
    expect(report.body).toContain('Unanswered now: 2, the oldest waiting 2 days.');
    expect(report.result.suggestions[0]).toBe('unanswered');
  });

  it('shows five of a long list and says how many more', () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ source: `site${index}.example`, count: 8 - index }));
    const report = composeGrowthReport(factsOf({ leads: leadsOf({ bySource: many, otherSources: 4 }) }), { since, until });
    const rows = report.blocks.filter(block => block.type === 'details')[2].rows;
    expect(rows).toEqual([...many.slice(0, 5).map(item => [item.source, String(item.count)]), ['And more', '3 others'], ['Other sources', '4']]);
    expect(report.body).toContain(', and 4 from other sources.');
  });

  it('survives missing or malformed facts instead of failing the email', () => {
    for (const facts of [null, undefined, {}, { leads: 'x', trials: 4, replies: [], unanswered: 'no' }, { leads: { total: -3, byKind: { demo_request: 'many' }, bySource: [null, { count: 2 }] } }]) {
      const report = composeGrowthReport(facts, { since, until });
      expect(report.subject, JSON.stringify(facts)).toMatch(/^Weekly growth: /);
      expect(report.result.suggestions).toHaveLength(3);
    }
    expect(composeGrowthReport({}, { since: 'nonsense', until: null }).headline).toBe('No new leads from the last seven days.');
  });

  it('escapes nothing itself and carries only labels and counts: the email layout escapes what it shows', () => {
    const report = composeGrowthReport(factsOf({ leads: leadsOf({ campaigns: [{ campaign: '<b>launch</b>', count: 1 }] }) }), { since, until });
    expect(report.body).toContain('<b>launch</b> (1)');
    expect(JSON.stringify(report)).not.toMatch(/@|\+1\d{10}/);
  });
});

describe('the three suggestions', () => {
  it('puts unanswered leads first, by kind', () => {
    expect(suggestionsFor(factsOf({ unanswered: { count: 2, oldestMinutes: 90, byKind: { demo_request: 2 } } }))[0])
      .toEqual({ code: 'unanswered', text: '2 demo requests are still unanswered. Answer them before anything else this week.' });
    expect(suggestionsFor(factsOf({ unanswered: { count: 1, byKind: { contact: 1 } } }))[0].text).toBe('1 contact request is still unanswered. Answer it before anything else this week.');
  });

  it('asks for faster replies when the median first reply took more than an hour', () => {
    expect(suggestionsFor(factsOf({ replies: { replied: 2, medianMinutes: 300 } }))[0]).toEqual({ code: 'slow_reply', text: 'Your median first reply took 5 hours. Aim to answer every new lead within the hour.' });
    expect(codes(factsOf({ replies: { replied: 2, medianMinutes: 60 } }))).not.toContain('slow_reply');
  });

  it('suggests connecting Search Console when no lead came from a search engine', () => {
    const noSearch = factsOf({ leads: leadsOf({ bySource: [{ source: 'direct', count: 4 }, { source: 'linkedin.com', count: 2 }] }) });
    expect(suggestionsFor(noSearch).find(item => item.code === 'no_search').text).toMatch(/^No lead came from a search engine\. Connect Google Search Console/);
    expect(codes(factsOf())).not.toContain('no_search');
    // A search engine could be hiding among the sources not listed, so nothing is claimed then.
    expect(codes(factsOf({ leads: leadsOf({ bySource: [{ source: 'direct', count: 4 }], otherSources: 2 }) }))).not.toContain('no_search');
  });

  it('says when every lead came from one source', () => {
    const one = factsOf({ leads: leadsOf({ total: 3, bySource: [{ source: 'google', count: 3 }] }) });
    expect(suggestionsFor(one).find(item => item.code === 'one_source').text).toBe('Every lead came from google. Try one more channel this week, so a single source drying up cannot stop your leads.');
    const direct = factsOf({ leads: leadsOf({ total: 2, bySource: [{ source: 'direct', count: 2 }] }) });
    expect(suggestionsFor(direct).find(item => item.code === 'one_source').text).toMatch(/^Every lead came from direct visits\./);
    expect(codes(factsOf({ leads: leadsOf({ total: 1, bySource: [{ source: 'google', count: 1 }] }) }))).not.toContain('one_source');
  });

  it('asks for campaign tags, follows up trials, and turns report downloads into demos', () => {
    expect(codes(factsOf({ leads: leadsOf({ campaigns: [] }) }))).toContain('no_campaigns');
    expect(suggestionsFor(factsOf({ trials: { started: 0, subscriptions: 2, converted: 0 } })).find(item => item.code === 'trials_started').text).toMatch(/^2 trials started\. Check in with each one/);
    expect(suggestionsFor(factsOf({ trials: { started: 1, subscriptions: 0 } })).find(item => item.code === 'trials_started').text).toMatch(/^1 trial started\. Check in with them/);
    const downloads = factsOf({ leads: leadsOf({ total: 3, byKind: kinds({ county_report: 2, newsletter: 1 }) }), trials: { started: 0, subscriptions: 0, converted: 0 } });
    expect(suggestionsFor(downloads).find(item => item.code === 'reports_only').text).toBe('3 people downloaded a report or joined a list, but nobody asked to talk. Invite them to a short demo.');
  });

  it('always gives three, never mentions a call, AI, a price or the words a CareBase customer would not use', () => {
    const variants = [factsOf(), {}, factsOf({ unanswered: { count: 3, byKind: { demo_request: 1, consultation: 2 } }, replies: { replied: 1, medianMinutes: 900 } })];
    for (const facts of variants) {
      const list = suggestionsFor(facts);
      expect(list).toHaveLength(3);
      for (const { text } of list) {
        expect(text).not.toMatch(/\bcall(?:s|ing)?\b|phone|voicemail|\bAI\b|\$\d|ALR|Assisted Living Residence|auditor/i);
      }
    }
  });

  it('knows a search engine by its source label', () => {
    for (const label of ['google', 'www.google.com', 'bing', 'duckduckgo.com', 'search.yahoo.com', 'Google']) expect(fromSearch(label), label).toBe(true);
    for (const label of ['direct', 'linkedin.com', 'googleads.example.test', 'newsletter', null]) expect(fromSearch(label), String(label)).toBe(false);
  });

  it('reads the facts defensively', () => {
    expect(readFacts(null)).toMatchObject({ total: 0, bySource: [], replies: { replied: 0, medianMinutes: null }, unanswered: { count: 0, oldestMinutes: null } });
  });
});
