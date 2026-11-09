import { describe, expect, it } from 'vitest';
import { FOUNDERS_COUPON } from '../../founders-sale.mjs';
import { contrastRatio, fontFor, kitMissing, meetsAA, palette, readableOn } from './brand.mjs';
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

  it('keeps a kit color that passes and substitutes one that does not', () => {
    expect(readableOn('#FFFFFF', '#111827')).toEqual({ color: '#111827', adjusted: false });
    expect(readableOn('#FFFFFF', '#FFEEDD').adjusted).toBe(true);
    expect(palette({ primaryColor: '#0B5394', backgroundColor: '#FFFFFF', textColor: '#111827' }).onPrimary).toBe('#FFFFFF');
  });

  it('names what a blank kit lacks and falls back to Inter', () => {
    expect(kitMissing({})).toEqual(['primaryColor', 'backgroundColor', 'textColor']);
    expect(kitMissing({ primaryColor: '#000000', backgroundColor: '#FFFFFF', textColor: '#111111' })).toEqual([]);
    expect(fontFor('Comic Sans')).toEqual({ family: 'Inter', substituted: true });
    expect(fontFor('inter')).toEqual({ family: 'Inter', substituted: false });
  });
});

describe('offers from billing', () => {
  it('reads the Founders Sale from the live coupon', () => {
    expect(FOUNDERS_COUPON).toContain('_50_12m_');
    expect(liveOffers.FOUNDERS50).toMatchObject({ percentOff: 50, months: 12, automatic: true, products: ['carebase', 'caremetric-intel'] });
    expect(offerFor('founders50')?.code).toBe('FOUNDERS50');
    expect(offerFor('SPRING20')).toBeNull();
  });
});
