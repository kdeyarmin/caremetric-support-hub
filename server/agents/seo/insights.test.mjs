import { describe, expect, it } from 'vitest';
import { cleanPage, cleanQuery, searchInsights, typicalFor } from './insights.mjs';

const owners = ['cmcarebase.com', 'home.cmcarebase.com', 'caremetrictrain.com', 'www.caremetricintel.com', 'help.caremetric.ai'];
const row = (keys, clicks, impressions, position, ctr = impressions ? clicks / impressions : 0) => ({ keys, clicks, impressions, ctr, position });
const totals = (current, previous) => ({ current, previous });
const figures = (clicks, impressions, ctr, position) => ({ clicks, impressions, ctr, position });
const property = (name, over = {}) => ({
  property: name, ok: true, totals: totals(figures(120, 4000, 0.03, 12.5), figures(100, 5000, 0.02, 14)), queries: [], pages: [], pairs: [], ...over,
});
const window = { current: { startDate: '2026-10-03', endDate: '2026-10-30' }, previous: { startDate: '2026-09-05', endDate: '2026-10-02' } };
const insightsOf = (properties, options = {}) => searchInsights({ window, properties }, { owners, ...options });

describe('each property', () => {
  it('compares its totals with the 28 days before', () => {
    const [site] = insightsOf([property('sc-domain:cmcarebase.com')]).sites;
    expect(site.property).toBe('sc-domain:cmcarebase.com');
    expect(site.change.clicks).toBeCloseTo(0.2);
    expect(site.change.impressions).toBeCloseTo(-0.2);
    expect(site.change.ctr).toBeCloseTo(0.01);
    expect(site.change.position).toBeCloseTo(-1.5);
    const fresh = insightsOf([property('sc-domain:new.test', { totals: totals(figures(5, 50, 0.1, 9), figures(0, 0, 0, 0)) })]).sites[0];
    expect(fresh.change).toEqual({ clicks: null, impressions: null, ctr: null, position: null });
  });

  it('lists its top searches and pages by clicks, five of each', () => {
    const queries = Array.from({ length: 7 }, (_, index) => row([`search ${index}`], index * 10, 500, 5));
    const pages = [row(['https://cmcarebase.com/a'], 3, 90, 4), row(['https://cmcarebase.com/b'], 9, 50, 3), row(['not an address'], 99, 999, 1)];
    const [site] = insightsOf([property('sc-domain:cmcarebase.com', { queries, pages })]).sites;
    expect(site.topQueries.map(item => item.query)).toEqual(['search 6', 'search 5', 'search 4', 'search 3', 'search 2']);
    expect(site.topPages.map(item => item.page)).toEqual(['https://cmcarebase.com/b', 'https://cmcarebase.com/a']);
  });

  it('lists the properties that could not be read, by code', () => {
    const result = insightsOf([property('sc-domain:cmcarebase.com'), { property: 'https://www.caremetricintel.com/', ok: false, code: 'not_permitted', status: 403 }]);
    expect(result.sites).toHaveLength(1);
    expect(result.failures).toEqual([{ property: 'https://www.caremetricintel.com/', code: 'not_permitted', status: 403 }]);
  });
});

describe('striking distance', () => {
  it('is a search at average position 8 to 20 with real impressions, most seen first, with the page that ranks', () => {
    const queries = [
      row(['just on page one'], 5, 400, 7.9), row(['edge low'], 1, 300, 8), row(['edge high'], 1, 200, 20), row(['too far'], 0, 900, 20.1),
      row(['too rare'], 0, 19, 12), row(['just enough'], 0, 20, 12),
    ];
    const pairs = [row(['edge low', 'https://cmcarebase.com/pricing'], 1, 250, 8), row(['edge low', 'https://cmcarebase.com/'], 0, 50, 15)];
    const result = insightsOf([property('sc-domain:cmcarebase.com', { queries, pairs })]);
    expect(result.striking.map(item => [item.query, item.page])).toEqual([['edge low', 'https://cmcarebase.com/pricing'], ['edge high', null], ['just enough', null]]);
  });
});

describe('seen often, rarely clicked', () => {
  it('is a first-page page clicked less than half as often as its position usually is, with many impressions', () => {
    expect(typicalFor(1)).toBe(0.28);
    expect(typicalFor(6.4)).toBe(0.05);
    expect(typicalFor(14)).toBe(0.025);
    const pages = [
      row(['https://cmcarebase.com/low'], 6, 1200, 6), // 0.5% at 6, where 5% is usual
      row(['https://cmcarebase.com/fine'], 40, 1000, 6), // 4%
      row(['https://cmcarebase.com/rare'], 0, 99, 3), // too few impressions
      row(['https://cmcarebase.com/deep'], 0, 5000, 11), // not on the first page: ranking, not the snippet, is the problem
      row(['https://cmcarebase.com/top'], 10, 200, 1), // 5% at 1, where 28% is usual
    ];
    const result = insightsOf([property('sc-domain:cmcarebase.com', { pages })]);
    expect(result.lowCtr.map(item => [item.page, item.typical])).toEqual([['https://cmcarebase.com/low', 0.05], ['https://cmcarebase.com/top', 0.28]]);
  });
});

describe('competing', () => {
  it('finds a search two of the company\'s hosts both appear for, in one domain property', () => {
    const pairs = [
      row(['carebase', 'https://cmcarebase.com/'], 20, 300, 9), row(['carebase', 'https://home.cmcarebase.com/'], 4, 120, 14.2),
      row(['carebase', 'https://cmcarebase.com/pricing'], 1, 40, 22),
      row(['training only on one host', 'https://cmcarebase.com/a'], 1, 100, 5), row(['training only on one host', 'https://cmcarebase.com/b'], 1, 100, 6),
      row(['shared with a stranger', 'https://cmcarebase.com/'], 1, 100, 5), row(['shared with a stranger', 'https://elsewhere.test/'], 1, 100, 6),
    ];
    const [entry, ...rest] = insightsOf([property('sc-domain:cmcarebase.com', { pairs })]).competing;
    expect(rest).toEqual([]);
    expect(entry).toEqual({
      query: 'carebase', impressions: 420, clicks: 24,
      hosts: [{ host: 'cmcarebase.com', page: 'https://cmcarebase.com/', clicks: 20, impressions: 300, position: 9 }, { host: 'home.cmcarebase.com', page: 'https://home.cmcarebase.com/', clicks: 4, impressions: 120, position: 14.2 }],
    });
  });

  it('finds it across properties too, counts a page two properties report once, and ignores a search too rare to matter', () => {
    const shared = row(['compliance software', 'https://cmcarebase.com/'], 2, 30, 11);
    const result = insightsOf([
      property('sc-domain:cmcarebase.com', { pairs: [shared, row(['rare one', 'https://cmcarebase.com/x'], 0, 4, 30)] }),
      property('https://cmcarebase.com/', { pairs: [shared] }),
      property('https://www.caremetricintel.com/', { pairs: [row(['compliance software', 'https://www.caremetricintel.com/'], 1, 20, 18), row(['rare one', 'https://www.caremetricintel.com/y'], 0, 4, 40)] }),
    ]);
    expect(result.competing.map(entry => [entry.query, entry.impressions, entry.hosts.map(host => host.host)])).toEqual([['compliance software', 50, ['cmcarebase.com', 'www.caremetricintel.com']]]);
  });
});

describe('what may be shown', () => {
  it('leaves out a search that looks personal, and markup characters', () => {
    expect(cleanQuery('pat@example.test carebase')).toBeNull();
    expect(cleanQuery('call 717-555-0142 about training')).toBeNull();
    expect(cleanQuery('record 12345678')).toBeNull();
    expect(cleanQuery('55 pa code 2800 training')).toBe('55 pa code 2800 training');
    expect(cleanQuery('  <b>alf</b>\u0007 training ')).toBe('b alf /b training');
    expect(cleanQuery('x'.repeat(200))).toHaveLength(80);
    expect(cleanPage('https://cmcarebase.com/a#part')).toBe('https://cmcarebase.com/a');
    expect(cleanPage('javascript:alert(1)')).toBeNull();
    const result = insightsOf([property('sc-domain:cmcarebase.com', {
      queries: [row(['pat@example.test'], 50, 900, 9), row(['alf training'], 10, 900, 9)],
      pairs: [row(['717 555 0142', 'https://cmcarebase.com/'], 1, 50, 9), row(['alf training', 'https://cmcarebase.com/'], 1, 50, 9)],
    })]);
    expect(JSON.stringify(result)).not.toMatch(/example\.test|555/);
    expect(result.sites[0].topQueries.map(item => item.query)).toEqual(['alf training']);
  });

  it('tells searches apart by their whole text, and cuts only the label', () => {
    const stem = 'how to train staff in a pennsylvania personal care home under chapter twenty eight hundred and keep the';
    const [first, second] = [`${stem} records`, `${stem} binders`];
    const pairs = [
      row([first, 'https://cmcarebase.com/a'], 1, 60, 9), row([first, 'https://home.cmcarebase.com/a'], 1, 40, 12),
      row([second, 'https://cmcarebase.com/b'], 1, 50, 9),
    ];
    const queries = [row([first], 2, 100, 10), row([second], 1, 50, 11)];
    const result = insightsOf([property('sc-domain:cmcarebase.com', { pairs, queries })]);
    // The second search is on one host only: it must not be merged into the first, which is on two.
    expect(result.competing).toHaveLength(1);
    expect(result.competing[0].hosts.map(host => host.page)).toEqual(['https://cmcarebase.com/a', 'https://home.cmcarebase.com/a']);
    expect(result.competing[0].query).toHaveLength(80);
    expect(result.striking.map(item => item.page)).toEqual(['https://cmcarebase.com/a', 'https://cmcarebase.com/b']);
    expect(result.queriesFor('https://cmcarebase.com/b')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('binders');
    expect(Object.keys(result.striking[0])).not.toContain('key');
  });

  it('lists a row two overlapping properties both report once, with the first property\'s figures, before the lists are cut to five', () => {
    const same = {
      queries: Array.from({ length: 5 }, (_, index) => row([`search ${index}`], 1, 300 - index, 12)),
      pages: Array.from({ length: 5 }, (_, index) => row([`https://cmcarebase.com/p${index}`], 1, 900 - index, 4)),
      pairs: Array.from({ length: 5 }, (_, index) => row([`search ${index}`, `https://cmcarebase.com/p${index}`], 1, 300 - index, 12)),
    };
    const prefix = {
      queries: [...same.queries.map(item => ({ ...item, impressions: item.impressions + 1000 })), row(['only in the prefix'], 0, 100, 15)],
      pages: [...same.pages.map(item => ({ ...item, clicks: 0, ctr: 0 })), row(['https://cmcarebase.com/extra'], 0, 500, 3)],
      pairs: same.pairs,
    };
    const result = insightsOf([property('sc-domain:cmcarebase.com', same), property('https://cmcarebase.com/', prefix)]);
    expect(result.striking.map(item => item.query)).toEqual(['search 0', 'search 1', 'search 2', 'search 3', 'search 4']);
    // The prefix property's own row is not crowded out by copies: the list holds five different searches either way.
    const listed = new Set(result.striking.map(item => `${item.query} ${item.page}`));
    expect(listed.size).toBe(5);
    // Figures are the first property's, never added together.
    expect(result.striking[0]).toMatchObject({ property: 'sc-domain:cmcarebase.com', impressions: 300 });
    expect(result.lowCtr.map(item => item.page)).toEqual(['https://cmcarebase.com/p0', 'https://cmcarebase.com/p1', 'https://cmcarebase.com/p2', 'https://cmcarebase.com/p3', 'https://cmcarebase.com/p4']);
    expect(result.lowCtr[0]).toMatchObject({ property: 'sc-domain:cmcarebase.com', impressions: 900, clicks: 1 });
    // Copies would fill the five places (p0, p0, p1, p1, p2) and push out a page only the second property has; once each, it is listed.
    const three = { ...same, pages: same.pages.slice(0, 3) };
    const fewer = insightsOf([property('sc-domain:cmcarebase.com', three), property('https://cmcarebase.com/', { ...prefix, pages: [...three.pages, row(['https://cmcarebase.com/extra'], 0, 500, 3)] })]);
    expect(fewer.lowCtr.map(item => item.page)).toEqual(['https://cmcarebase.com/p0', 'https://cmcarebase.com/p1', 'https://cmcarebase.com/p2', 'https://cmcarebase.com/extra']);
  });

  it('gives the searches that show a page, most seen first', () => {
    const pairs = [row(['b', 'https://cmcarebase.com/p'], 1, 10, 5), row(['a', 'https://cmcarebase.com/p'], 1, 30, 5), row(['c', 'https://cmcarebase.com/q'], 1, 99, 5)];
    const result = insightsOf([property('sc-domain:cmcarebase.com', { pairs })]);
    expect(result.queriesFor('https://cmcarebase.com/p')).toEqual(['a', 'b']);
    expect(result.queriesFor('https://cmcarebase.com/none')).toEqual([]);
    expect(result.queriesFor('https://cmcarebase.com/p')).toEqual(['a', 'b']);
  });

  it('is the same for the same figures', () => {
    const input = [property('sc-domain:cmcarebase.com', { queries: [row(['x'], 1, 100, 9), row(['y'], 1, 100, 9)], pages: [row(['https://cmcarebase.com/'], 1, 500, 3)] })];
    const strip = result => JSON.parse(JSON.stringify({ ...result, queriesFor: undefined }));
    expect(strip(insightsOf(input))).toEqual(strip(insightsOf(input)));
    expect(insightsOf(input).striking.map(item => item.query)).toEqual(['x', 'y']);
  });
});
