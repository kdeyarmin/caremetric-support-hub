import { describe, expect, it } from 'vitest';
import { emailThemes } from '../../email-layout.mjs';
import { imageSize } from './layouts.mjs';
import { brandThemes, effectiveKit, themeAsset, themeColors, themeFor, themeSummaries, withThemeFiles } from './themes.mjs';

describe('brand themes', () => {
  it('uses the same colors as each product\'s emails (and so its app)', () => {
    const intel = themeFor('caremetric-intel');
    expect(intel).toMatchObject({ key: 'emberline', mode: 'dark', font: 'Geist', tagline: 'Set your marketing on FIRE!', site: 'caremetricintel.com' });
    const email = (palette, role) => palette[role].toUpperCase();
    const ip = emailThemes.intel.palette;
    expect(intel.colors).toMatchObject({ primary: email(ip, 'brand'), background: email(ip, 'canvas'), text: email(ip, 'heading'), surface: email(ip, 'card') });
    expect(intel.colors.primary).toBe('#FF7A45');
    expect(intel.callout.fill).toBe(emailThemes.intel.callouts.info.fill.toUpperCase());

    const carebase = themeFor('carebase');
    expect(carebase).toMatchObject({ key: 'carebase', mode: 'light', font: 'Inter', tagline: null, site: 'cmcarebase.com' });
    const cp = emailThemes.carebase.palette;
    expect(carebase.colors).toMatchObject({ primary: email(cp, 'brand'), background: email(cp, 'card'), text: email(cp, 'heading') });
    expect(carebase.colors.primary).toBe('#2563EB');
    expect(carebase.rule).toEqual({ role: 'primary', share: 3 / 600 });

    expect(themeFor('hub')).toBeNull();
    expect(Object.isFrozen(brandThemes['caremetric-intel'].colors)).toBe(true);
  });

  it('bundles each product\'s official logo and Intel\'s fire band at their stated sizes', async () => {
    for (const theme of Object.values(brandThemes)) {
      for (const file of [theme.logo, theme.band].filter(Boolean)) {
        expect(imageSize(await themeAsset(file.file)), file.file).toEqual({ width: file.width, height: file.height, type: 'image/png' });
      }
    }
  });

  it('a blank brand kit is the theme itself', () => {
    for (const product of ['caremetric-intel', 'carebase']) {
      const brand = effectiveKit(product, {});
      const theme = themeFor(product);
      expect(brand.colors).toMatchObject({ ...theme.colors, accent: theme.colors.primary });
      expect(brand.overrides).toEqual([]);
      expect(brand.headingFont).toBe(theme.font);
      expect([...brand.allowed].sort()).toEqual(themeColors(theme).sort());
      expect(brand.allowed.has(brand.ink) && brand.allowed.has(brand.paper)).toBe(true);
    }
    expect(effectiveKit('caremetric-intel', {}).button).toEqual({ fill: '#F4F4F6', text: '#07080A', pill: true });
    expect(effectiveKit('carebase', {}).button).toEqual({ fill: '#2563EB', text: '#FFFFFF', pill: false });
    expect(effectiveKit('carebase', { primaryColor: '', textColor: 'blue' }).overrides).toEqual([]);
    expect(() => effectiveKit('hub', {})).toThrow(expect.objectContaining({ code: 'theme_missing' }));
  });

  it('an owner\'s kit color overrides its role and joins the allowed colors; the color on it comes from the theme', () => {
    const brand = effectiveKit('carebase', { primaryColor: '#0b5394', accentColor: '#C2410C', headingFont: 'Geist' });
    expect(brand.colors.primary).toBe('#0B5394');
    expect(brand.colors.accent).toBe('#C2410C');
    expect(brand.overrides.sort()).toEqual(['accent', 'primary']);
    expect(brand.allowed.has('#0B5394') && brand.allowed.has('#C2410C')).toBe(true);
    expect([brand.ink, brand.paper]).toContain(brand.colors.onPrimary);
    expect(brand.button.fill).toBe('#0B5394');
    expect(brand.headingFont).toBe('Geist');
    expect(brand.bodyFont).toBe('Inter');
    expect(brand.allowed.has('#FF00FF')).toBe(false);
  });

  it('adds the theme\'s logo and band to a render\'s files, and keeps the owner\'s own logo', async () => {
    const intel = await withThemeFiles('caremetric-intel', {});
    expect(intel.themeLogo).toMatchObject({ type: 'image/png', needs: 'dark' });
    expect(imageSize(intel.band.bytes)).toMatchObject({ width: 1200, height: 200 });
    const carebase = await withThemeFiles('carebase', { logo: { bytes: Buffer.from('x'), type: 'image/png' } });
    expect(carebase.themeLogo).toMatchObject({ needs: 'white' });
    expect(carebase.band).toBeUndefined();
    expect(carebase.logo.bytes.toString()).toBe('x');
    expect(await withThemeFiles('hub', { a: 1 })).toEqual({ a: 1 });
  });

  it('summarizes each theme for the brand kit editor', () => {
    const summaries = themeSummaries();
    expect(summaries.map(item => item.product).sort()).toEqual(['carebase', 'caremetric-intel']);
    expect(summaries.find(item => item.product === 'caremetric-intel')).toMatchObject({ name: 'Emberline', mode: 'dark', colors: { primaryColor: '#FF7A45', backgroundColor: '#07080A' } });
  });
});
