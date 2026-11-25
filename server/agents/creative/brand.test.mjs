import { describe, expect, it } from 'vitest';
import { FOUNDERS_COUPON } from '../../founders-sale.mjs';
import { contrastRatio, fontFor, meetsAA, readableOn } from './brand.mjs';
import { liveOffers, offerFor } from './offers.mjs';

describe('brand helpers', () => {
  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThan(4.5);
  });

  it('treats large shown text with the 3:1 floor and everything else with 4.5:1', () => {
    expect(meetsAA(3.2, { fontSize: 90, canvasWidth: 1080 })).toBe(true);
    expect(meetsAA(3.2, { fontSize: 30, canvasWidth: 1080 })).toBe(false);
    expect(meetsAA(4.6, { fontSize: 30, canvasWidth: 1080 })).toBe(true);
  });

  it('keeps a color that passes and otherwise uses the theme\'s own darkest or lightest color', () => {
    const neutrals = { ink: '#07080A', paper: '#F4F4F6' };
    expect(readableOn('#FFFFFF', '#111827', neutrals)).toEqual({ color: '#111827', adjusted: false });
    expect(readableOn('#FFFFFF', '#FFEEDD', neutrals)).toEqual({ color: '#07080A', adjusted: true });
    expect(readableOn('#101116', '#2B2D35', neutrals)).toEqual({ color: '#F4F4F6', adjusted: true });
    // A role with no color of its own is not an adjustment of the owner's choice.
    expect(readableOn('#101116', null, neutrals)).toEqual({ color: '#F4F4F6', adjusted: false });
  });

  it('uses the theme\'s font when the kit names one the Hub does not have', () => {
    expect(fontFor('Comic Sans')).toEqual({ family: 'Inter', substituted: true });
    expect(fontFor('Comic Sans', 'Geist')).toEqual({ family: 'Geist', substituted: true });
    expect(fontFor('inter')).toEqual({ family: 'Inter', substituted: false });
    expect(fontFor('', 'Geist')).toEqual({ family: 'Geist', substituted: false });
  });
});

describe('offers from billing', () => {
  it('reads the Founders Sale from the live coupon', () => {
    expect(FOUNDERS_COUPON).toContain('_75_12m_');
    expect(liveOffers.FOUNDERS75).toMatchObject({ percentOff: 75, months: 12, automatic: true, products: ['carebase', 'caremetric-intel'] });
    expect(offerFor('founders75')?.code).toBe('FOUNDERS75');
    expect(offerFor('SPRING20')).toBeNull();
  });
});
