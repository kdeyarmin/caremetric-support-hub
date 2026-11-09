import { describe, expect, it } from 'vitest';
import { analyzeLogo, colorDistance, logoFits, misfit } from './logo.mjs';
import { brandThemes, themeAsset } from './themes.mjs';
import { cutOutLogo, pictureLogo, whiteBoxJpeg, whiteBoxLogo } from './fixtures.mjs';

const backgrounds = { white: '#FFFFFF', offWhite: '#F8FAFC', gray: '#F1F5F9', blue: '#2563EB', black: '#07080A', card: '#101116' };
const fitsOn = info => Object.entries(backgrounds).filter(([, color]) => logoFits(info, color)).map(([name]) => name);

describe('where a logo may go', () => {
  it('reads a logo\'s own background: cut out, solid (PNG or JPEG) or a picture', async () => {
    expect((await analyzeLogo(cutOutLogo(), 'image/png')).ground).toBe('transparent');
    expect((await analyzeLogo(whiteBoxLogo(), 'image/png')).ground).toBe('#FFFFFF');
    expect((await analyzeLogo(whiteBoxJpeg(), 'image/jpeg')).ground).toBe('#FFFFFF');
    expect((await analyzeLogo(pictureLogo(), 'image/png')).ground).toBe('busy');
  });

  it('never puts a logo\'s own white box anywhere but on that same white', async () => {
    for (const [bytes, type] of [[whiteBoxLogo(), 'image/png'], [whiteBoxJpeg(), 'image/jpeg']]) {
      expect(fitsOn(await analyzeLogo(bytes, type))).toEqual(['white']);
    }
    expect(fitsOn(await analyzeLogo(pictureLogo(), 'image/png'))).toEqual([]);
  });

  it('puts a cut-out logo where its marks stand out (3:1)', async () => {
    expect(fitsOn(await analyzeLogo(cutOutLogo([15, 23, 42]), 'image/png'))).toEqual(['white', 'offWhite', 'gray', 'blue']);
    expect(fitsOn(await analyzeLogo(cutOutLogo([255, 255, 255]), 'image/png'))).toEqual(['blue', 'black', 'card']);
  });

  it('places the official logos only where they belong: Intel\'s white lockup on dark or brand blue, CareBase\'s on white and its light panels', async () => {
    const intel = await analyzeLogo(await themeAsset(brandThemes['caremetric-intel'].logo.file), 'image/png');
    expect(intel.ground).toBe('transparent');
    expect(fitsOn(intel)).toEqual(['blue', 'black', 'card']);
    const carebase = await analyzeLogo(await themeAsset(brandThemes.carebase.logo.file), 'image/png');
    expect(carebase.ground).toBe('transparent');
    expect(fitsOn(carebase)).toEqual(['white', 'offWhite', 'gray']);
  });

  it('says no when it cannot tell, and says why a logo was left out', async () => {
    expect(logoFits(null, '#FFFFFF')).toBe(false);
    expect(logoFits({ ground: 'transparent', inks: [] }, '#FFFFFF')).toBe(false);
    expect(logoFits(await analyzeLogo(cutOutLogo(), 'image/png'), 'white')).toBe(false);
    expect(colorDistance('#FFFFFF', '#F8FAFC')).toBe(7);
    expect(misfit({ ground: '#FFFFFF' })).toBe('it has a solid #FFFFFF background of its own');
    expect(misfit({ ground: 'busy' })).toContain('picture');
    expect(misfit({ ground: 'transparent' })).toContain('too close');
  });
});
