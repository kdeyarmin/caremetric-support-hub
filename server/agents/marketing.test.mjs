import { describe, expect, it, vi } from 'vitest';
import { defaultMarketed, marketedNow, markets, productKey } from './marketing.mjs';

describe('the products the team markets', () => {
  it('markets CareMetric Intel only until the owner\'s switches exist, while CareBase is in its pilot', () => {
    expect(defaultMarketed).toEqual(['caremetric-intel']);
  });

  it('reads the owner\'s switches each time it is asked, so a change applies to the next run', async () => {
    const read = vi.fn().mockResolvedValueOnce(['caremetric-intel']).mockResolvedValueOnce(['caremetric-intel', 'carebase']);
    expect(await marketedNow(read)).toEqual(['caremetric-intel']);
    expect(await marketedNow(read)).toEqual(['caremetric-intel', 'carebase']);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('markets nothing on a list it cannot understand, ignores unknown products, and lets a failed read fail the task', async () => {
    expect(await marketedNow(async () => null)).toEqual([]);
    expect(await marketedNow(async () => ['intel', 'breathe', 'carebase'])).toEqual(['caremetric-intel', 'carebase']);
    await expect(marketedNow(async () => { throw Object.assign(new Error('down'), { transient: true }); })).rejects.toMatchObject({ transient: true });
    expect(await marketedNow(['carebase'])).toEqual(['carebase']);
    expect(await marketedNow(null)).toBeNull();
  });

  it('answers per product, with "intel" as the Content Marketer\'s name for Intel, and markets everything without a policy', () => {
    expect(productKey('intel')).toBe('caremetric-intel');
    expect(markets(['caremetric-intel'], 'intel')).toBe(true);
    expect(markets(['caremetric-intel'], 'carebase')).toBe(false);
    expect(markets(['caremetric-intel'], 'advisors')).toBe(false);
    expect(markets(null, 'carebase')).toBe(true);
    expect(markets([], 'caremetric-intel')).toBe(false);
  });
});
