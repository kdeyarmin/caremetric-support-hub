import { describe, expect, it } from 'vitest';
import { assetIdFromLink, fatigue, joinResults, learningsFrom, rates, refreshPlan, scorecard } from './performance.mjs';

const id = n => `00000000-0000-4000-8000-00000000000${n}`;
const link = n => `https://cmcarebase.com/?utm_source=meta&utm_medium=paid&utm_campaign=creative-1&utm_content=${id(n)}#pricing`;
const week = (impressions, clicks, spendCents, frequency) => rates({ impressions, clicks, spendCents, results: 0, frequencyWeight: frequency * impressions });

describe('creative performance', () => {
  it('reads the asset id from an ad link\'s utm_content', () => {
    expect(assetIdFromLink(link(1))).toBe(id(1));
    expect(assetIdFromLink('https://cmcarebase.com/')).toBeNull();
    expect(assetIdFromLink('not a link')).toBeNull();
  });

  it('joins ad results to assets by utm_content across ads', () => {
    const overview = {
      ads: [{ id: 'ad1', copy: { link: link(1) } }, { id: 'ad2', copy: { link: link(1) } }, { id: 'ad3', copy: { link: 'https://cmcarebase.com/' } }],
      current: [{ adId: 'ad1', impressions: 1000, clicks: 20, spendCents: 1000, frequency: 2 }, { adId: 'ad2', impressions: 1000, clicks: 10, spendCents: 1000, frequency: 4 }],
      previous: [],
    };
    const joined = joinResults([{ platform: 'meta', overview }]);
    expect(joined.size).toBe(1);
    expect(joined.get(id(1))).toMatchObject({ ads: 2, current: { impressions: 2000, clicks: 30, frequency: 3, cpmCents: 1000 } });
  });

  it('calls an asset tired on two of three signals, never on one', () => {
    expect(fatigue({ current: week(2000, 20, 2400, 3.5), previous: week(2000, 40, 2000, 2) })).toEqual({ fatigued: true, signals: ['ctr_falling', 'frequency_high', 'cpm_rising'] });
    expect(fatigue({ current: week(2000, 20, 2000, 2), previous: week(2000, 40, 2000, 2) })).toEqual({ fatigued: false, signals: ['ctr_falling'] });
    expect(fatigue({ current: week(2000, 40, 2000, 3.4), previous: week(2000, 40, 2000, 2) }).fatigued).toBe(false);
    expect(fatigue({ current: week(500, 1, 2000, 9), previous: week(2000, 40, 2000, 2) }).fatigued).toBe(false);
  });

  it('retires tired assets, builds on winners and learns which patterns win', () => {
    const assets = [1, 2, 3].map(n => ({ id: id(n), product: 'carebase', platform: 'meta', placement: 'meta.feed_square', kind: 'static', layout: n === 1 ? 'checklist' : 'headline', hookType: n === 1 ? 'problem' : 'offer', headline: `H${n}` }));
    const results = new Map([
      [id(1), { current: week(3000, 90, 3000, 2), previous: week(3000, 90, 3000, 2), ads: 1 }],
      [id(2), { current: week(3000, 30, 3600, 3.6), previous: week(3000, 60, 3000, 2), ads: 1 }],
      [id(3), { current: week(3000, 45, 3000, 2), previous: week(0, 0, 0, 0), ads: 1 }],
    ]);
    const rows = scorecard(assets, results, [{ assetId: id(1), leads: 3, trials: 1 }]);
    expect(rows.find(row => row.id === id(1))).toMatchObject({ leads: 3, trials: 1, fatigued: false });
    const plan = refreshPlan(rows);
    expect(plan.retire.map(row => row.id)).toEqual([id(2)]);
    expect(plan.winners.map(row => row.id)).toEqual([id(1), id(3)]);
    const learned = learningsFrom(rows);
    expect(learned.find(item => item.kind === 'hook' && item.value === 'problem')).toMatchObject({ verdict: 'win', samples: 1 });
    expect(learned.find(item => item.kind === 'hook' && item.value === 'offer')?.verdict).toBe('lose');
    expect(learned.some(item => item.kind === 'format')).toBe(false);
  });
});
