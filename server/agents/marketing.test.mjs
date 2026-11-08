import { describe, expect, it } from 'vitest';
import { defaultMarketed, marketedProducts, markets, productKey } from './marketing.mjs';

describe('the products the team markets', () => {
  it('markets CareMetric Intel only by default, while CareBase is in its pilot', () => {
    expect(defaultMarketed).toEqual(['caremetric-intel']);
    expect(marketedProducts({})).toEqual(['caremetric-intel']);
    expect(marketedProducts({ HUB_MARKETED_PRODUCTS: '  ' })).toEqual(['caremetric-intel']);
  });

  it('reads the owner\'s list, ignoring unknown keys, so a typo markets less, never more', () => {
    expect(marketedProducts({ HUB_MARKETED_PRODUCTS: 'carebase, Intel ,advisors' })).toEqual(['carebase', 'caremetric-intel', 'advisors']);
    expect(marketedProducts({ HUB_MARKETED_PRODUCTS: 'carebse' })).toEqual([]);
    expect(marketedProducts({ HUB_MARKETED_PRODUCTS: 'none' })).toEqual([]);
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
