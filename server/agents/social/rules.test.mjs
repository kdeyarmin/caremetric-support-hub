import { describe, expect, it } from 'vitest';
import { engagement, evaluateAds, rankPosts } from './rules.mjs';

const now = new Date('2026-11-08T15:00:00Z');
const old = '2026-10-01T00:00:00Z';
const adset = (over = {}) => ({ id: 'S', name: 'PA operators', active: true, dailyBudget: 2000, ...over });
const ad = (id, over = {}) => ({ id, name: `Ad ${id}`, adsetId: 'S', active: true, createdAt: old, imageHash: 'h', copy: { message: 'm', headline: 'h', description: 'd', link: 'https://cmcarebase.com/signup' }, ...over });
const row = (adId, over = {}) => ({ adId, impressions: 5000, clicks: 100, spendCents: 3000, frequency: 1.5, results: 2, ...over });

describe('evaluating ads', () => {
  it('pauses an ad that spent with no result, but never the last active ad of an ad set', () => {
    const two = evaluateAds({ adsets: [adset()], ads: [ad('A'), ad('B')], current: [row('A', { results: 0, spendCents: 2500 }), row('B')], now });
    expect(two.recommendations).toEqual([{ kind: 'pause', adId: 'A', adName: 'Ad A', adsetId: 'S', adsetName: 'PA operators', reason: 'spent $25.00 in 7 days with no result' },
      { kind: 'refresh', adsetId: 'S', adsetName: 'PA operators', basedOn: 'B', reason: 'it has only one active ad to test against' }]);
    const one = evaluateAds({ adsets: [adset()], ads: [ad('A')], current: [row('A', { results: 0, spendCents: 2500 })], now });
    expect(one.recommendations).toEqual([{ kind: 'refresh', adsetId: 'S', adsetName: 'PA operators', basedOn: 'A', reason: 'its only active ad spent $25.00 in 7 days with no result' }]);
  });

  it('pauses on cost per result against the target, and on a click rate far below the ad set\'s', () => {
    const costly = evaluateAds({ adsets: [adset()], ads: [ad('A'), ad('B'), ad('C')], current: [row('A', { spendCents: 9000, results: 1 }), row('B'), row('C')], now, settings: { targetCostCents: 2000 } });
    expect(costly.recommendations[0]).toMatchObject({ kind: 'pause', adId: 'A', reason: 'costs $90.00 per result, more than twice the $20.00 target' });
    const dull = evaluateAds({ adsets: [adset()], ads: [ad('A'), ad('B'), ad('C')], current: [row('A', { clicks: 10 }), row('B'), row('C')], now });
    expect(dull.recommendations[0]).toMatchObject({ kind: 'pause', adId: 'A', reason: 'click rate 0.2% is under half the ad set\'s typical 2.0%' });
  });

  it('waits for learning days and enough delivery before judging', () => {
    const young = evaluateAds({ adsets: [adset()], ads: [ad('A', { createdAt: '2026-11-07T00:00:00Z' }), ad('B')], current: [row('A', { results: 0 }), row('B')], now });
    expect(young.recommendations).toEqual([]);
    const thin = evaluateAds({ adsets: [adset()], ads: [ad('A'), ad('B')], current: [row('A', { results: 0, impressions: 300, spendCents: 500 }), row('B')], now });
    expect(thin.recommendations).toEqual([]);
  });

  it('refreshes a tiring ad and an ad set with fewer than two active ads, and ignores paused ad sets', () => {
    const tired = evaluateAds({ adsets: [adset()], ads: [ad('A'), ad('B')], current: [row('A', { frequency: 4.2, clicks: 50 }), row('B')], previous: [row('A', { clicks: 100 })], now });
    expect(tired.recommendations).toEqual([{ kind: 'refresh', adsetId: 'S', adsetName: 'PA operators', basedOn: 'B', reason: '"Ad A" is tiring: seen 4.2 times per person, click rate down from 2.0% to 1.0%' }]);
    expect(evaluateAds({ adsets: [adset({ active: false })], ads: [ad('A')], current: [row('A', { results: 0 })], now }).recommendations).toEqual([]);
  });

  it('raises a winning ad set\'s budget by at most 20% and never past the cap, and never without a cap', () => {
    const winning = { adsets: [adset()], ads: [ad('A'), ad('B')], current: [row('A', { results: 5, spendCents: 4000 }), row('B', { results: 4, spendCents: 3000 })], now };
    expect(evaluateAds({ ...winning, settings: { targetCostCents: 2000 } }).recommendations).toEqual([]);
    expect(evaluateAds({ ...winning, settings: { targetCostCents: 2000, maxDailyBudgetCents: 5000 } }).recommendations)
      .toEqual([{ kind: 'budget', adsetId: 'S', adsetName: 'PA operators', from: 2000, to: 2400, reason: '9 results at $7.78 each, beating the $20.00 target' }]);
    expect(evaluateAds({ ...winning, settings: { targetCostCents: 2000, maxDailyBudgetCents: 2200 } }).recommendations[0]).toMatchObject({ to: 2200 });
    expect(evaluateAds({ ...winning, settings: { targetCostCents: 2000, maxDailyBudgetCents: 2000 } }).recommendations).toEqual([]);
  });

  it('summarizes every ad set with its spend, results and cost per result', () => {
    const { adsets } = evaluateAds({ adsets: [adset()], ads: [ad('A'), ad('B')], current: [row('A'), row('B', { results: 0 })], now });
    expect(adsets[0]).toMatchObject({ id: 'S', impressions: 10000, clicks: 200, spendCents: 6000, results: 2, costPerResult: 3000, ctr: 0.02, activeAds: 2 });
  });
});

describe('ranking posts', () => {
  it('weighs comments and shares above reactions, and looks back only so far', () => {
    expect(engagement({ reactions: 10, comments: 2, shares: 1 })).toBe(17);
    const ranked = rankPosts([{ id: 'a', at: '2026-11-07T00:00:00Z', reactions: 5 }, { id: 'b', at: '2026-11-06T00:00:00Z', reactions: 1, comments: 4 }, { id: 'c', at: '2026-09-01T00:00:00Z', reactions: 99 }], { now });
    expect(ranked.map(post => [post.id, post.engagement])).toEqual([['b', 9], ['a', 5]]);
  });
});
