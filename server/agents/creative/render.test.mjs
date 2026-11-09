import { describe, expect, it } from 'vitest';
import { checkVisual } from './compliance.mjs';
import { drawStatic, imageSize, layouts } from './layouts.mjs';
import { pngSize, renderStatic } from './render.mjs';
import { withThemeFiles } from './themes.mjs';
import { placements } from './specs.mjs';
import { buildTimeline, captionsVtt, mp4Info, renderVideo } from './video.mjs';
import { content, kit, syntheticPng } from './fixtures.mjs';

const files = { screenshots: { s1: { bytes: syntheticPng(), type: 'image/png', attested: true } } };

describe('static rendering', () => {
  const statics = Object.values(placements).filter(spec => spec.kind === 'static');

  it('renders every layout at every static placement\'s exact size', async () => {
    for (const spec of statics) {
      for (const layout of layouts) {
        const out = await renderStatic({ layout, width: spec.width, height: spec.height, product: 'caremetric-intel', content, kit, files });
        expect(pngSize(out.png), `${layout} at ${spec.key}`).toEqual({ width: spec.width, height: spec.height });
      }
    }
  }, 120_000);

  it('reports the text it drew, which passes WCAG AA with this kit', () => {
    const { report } = drawStatic({ layout: 'headline', width: 1080, height: 1080, product: 'carebase', content, kit, files });
    expect(report.texts.some(run => run.role === 'headline')).toBe(true);
    expect(checkVisual(report).filter(item => item.rule === 'contrast')).toEqual([]);
  });

  it('draws a layout whose content is missing as a headline, and a screenshot layout only with an attested screenshot', () => {
    expect(drawStatic({ layout: 'stat', width: 1080, height: 1080, product: 'carebase', content: { ...content, overlay: {} }, kit }).report.layout).toBe('headline');
    expect(drawStatic({ layout: 'screenshot', width: 1080, height: 1080, product: 'carebase', content, kit, files: {} }).report.layout).toBe('headline');
    const shot = drawStatic({ layout: 'screenshot', width: 1080, height: 1080, product: 'carebase', content, kit, files });
    expect(shot.report.layout).toBe('screenshot');
    expect(shot.report.images).toEqual([{ kind: 'screenshot', attested: true }]);
  });

  it('replaces a kit text color that fails contrast and says so', () => {
    const { report } = drawStatic({ layout: 'headline', width: 1080, height: 1080, product: 'carebase', content, kit: { ...kit, textColor: '#EEEEEE' } });
    expect(report.adjustments).toContain('textColor');
    expect(checkVisual(report).filter(item => item.rule === 'contrast')).toEqual([]);
  });

  it('draws every layout in the product\'s own brand theme when the kit is blank, with no color from outside it', async () => {
    for (const product of ['caremetric-intel', 'carebase']) {
      const themed = await withThemeFiles(product, files);
      for (const [width, height] of [[1080, 1080], [1080, 1920], [1200, 627], [300, 250]]) {
        for (const layout of layouts) {
          const { report } = drawStatic({ layout, width, height, product, content, kit: {}, files: themed });
          const blocks = checkVisual(report).filter(item => item.level === 'block');
          expect(blocks, `${product} ${layout} ${width}x${height}`).toEqual([]);
          expect(report.colors.every(color => report.allowed.includes(color))).toBe(true);
          expect(report.adjustments).toEqual([]);
        }
      }
    }
  });

  it('Intel is Emberline: the near-black canvas, the ember accent, the white pill, the reverse logo and the fire band', async () => {
    const { element, report } = drawStatic({ layout: 'offer', width: 1080, height: 1080, product: 'caremetric-intel', content, kit: {}, files: await withThemeFiles('caremetric-intel', {}) });
    expect(element.props.style.backgroundColor).toBe('#07080A');
    expect(report.theme).toBe('emberline');
    expect(report.colors).toEqual(expect.arrayContaining(['#07080A', '#F4F4F6', '#FF7A45']));
    expect(report.images).toEqual(expect.arrayContaining([{ kind: 'logo', attested: true }, { kind: 'brand', attested: true }]));
    expect(report.texts.find(run => run.role === 'cta')).toMatchObject({ color: '#07080A', background: '#F4F4F6' });
  });

  it('CareBase is white with its logo lockup over the blue rule and a blue button', async () => {
    const { element, report } = drawStatic({ layout: 'headline', width: 1080, height: 1080, product: 'carebase', content, kit: {}, files: await withThemeFiles('carebase', {}) });
    expect(element.props.style.backgroundColor).toBe('#FFFFFF');
    expect(report.theme).toBe('carebase');
    expect(report.colors).toEqual(expect.arrayContaining(['#FFFFFF', '#2563EB', '#0F172A']));
    expect(report.colors).not.toContain('#FF7A45');
    expect(report.images).toEqual([{ kind: 'logo', attested: true }]);
    expect(report.texts.find(run => run.role === 'cta')).toMatchObject({ color: '#FFFFFF', background: '#2563EB' });
  });

  it('never puts a theme logo on a ground it was not made for', async () => {
    // Intel's white lockup on a white kit background: the product name is drawn instead.
    const { report } = drawStatic({ layout: 'headline', width: 1080, height: 1080, product: 'caremetric-intel', content, kit: { backgroundColor: '#FFFFFF' }, files: await withThemeFiles('caremetric-intel', {}) });
    expect(report.images.some(image => image.kind === 'logo')).toBe(false);
    expect(report.texts.find(run => run.role === 'brand')).toMatchObject({ background: '#FFFFFF' });
    expect(checkVisual(report).filter(item => item.level === 'block')).toEqual([]);
  });

  it('reads image sizes from PNG headers', () => {
    expect(imageSize(syntheticPng(320, 200))).toEqual({ width: 320, height: 200, type: 'image/png' });
    expect(imageSize(Buffer.from('not an image'))).toBeNull();
  });
});

describe('video', () => {
  it('builds timelines for every length, ending on the logo card', () => {
    for (const [length, seconds] of [['6s', 6], ['15s', 15], ['30s', 30]]) {
      const timeline = buildTimeline({ content, lengthKey: length });
      expect(timeline.duration).toBe(seconds);
      expect(timeline.scenes.at(-1)).toMatchObject({ kind: 'end', end: seconds });
      expect(timeline.scenes[0].kind).toBe('hook');
    }
    const long = buildTimeline({ content: { ...content, overlay: { ...content.overlay, beats: Array.from({ length: 8 }, (_, index) => `Beat ${index + 1}`) } }, lengthKey: '45-60s', screenshot: true });
    expect(long.duration).toBeGreaterThanOrEqual(45);
    expect(long.duration).toBeLessThanOrEqual(60);
    expect(long.scenes.some(scene => scene.kind === 'screenshot')).toBe(true);
    expect(captionsVtt(long).startsWith('WEBVTT')).toBe(true);
  });

  it('renders a one-second smoke video at its exact size and length', async () => {
    const out = await renderVideo({ id: 'smoke', width: 1080, height: 1920, product: 'caremetric-intel', content, kit, files, duration: 1, music: false });
    expect(out.mp4.subarray(4, 8).toString('latin1')).toBe('ftyp');
    const info = mp4Info(out.mp4);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.durationSeconds).toBeGreaterThan(0.9);
    expect(info.durationSeconds).toBeLessThan(1.1);
    expect(out.burned).toBe(true);
    expect(out.cues).toBeGreaterThan(0);
    expect(out.captions).toContain('-->');
  }, 120_000);
});
