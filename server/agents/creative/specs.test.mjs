import { describe, expect, it } from 'vitest';
import { placements, placementsFor, textLimits, validateAsset, videoLengths, videoPlacement } from './specs.mjs';

const size = key => [placements[key].width, placements[key].height];

describe('platform specs', () => {
  it('lists exactly the sizes each platform takes', () => {
    expect(size('meta.feed_square')).toEqual([1080, 1080]);
    expect(size('meta.feed_portrait')).toEqual([1080, 1350]);
    expect(size('meta.story')).toEqual([1080, 1920]);
    expect(size('linkedin.single_image')).toEqual([1200, 627]);
    expect(size('linkedin.square')).toEqual([1080, 1080]);
    expect(size('google.landscape')).toEqual([1200, 628]);
    expect(size('google.square')).toEqual([1200, 1200]);
    expect(size('google.rectangle')).toEqual([300, 250]);
    expect(size('youtube.thumbnail')).toEqual([1280, 720]);
    expect(placementsFor('linkedin', 'video').map(spec => spec.aspect)).toEqual(['1:1', '4:5', '9:16']);
    expect(placementsFor('meta', 'video').map(spec => spec.aspect)).toEqual(['1:1', '4:5', '9:16']);
    expect(placementsFor('google', 'video')).toEqual([]);
    expect(videoPlacement('youtube', '4:5').aspect).toBe('1:1');
  });

  it('holds the copy and video limits it was checked against', () => {
    expect(textLimits.meta.primaryText).toEqual({ recommended: 125, max: 2200 });
    expect(textLimits.meta.headline.recommended).toBe(40);
    expect(textLimits.linkedin.primaryText).toEqual({ recommended: 150, max: 600 });
    expect(textLimits.linkedin.headline).toEqual({ recommended: 70, max: 200 });
    expect(textLimits.google.headline.max).toBe(30);
    expect(textLimits.google.primaryText.max).toBe(90);
    expect(textLimits.youtube.headline.max).toBe(100);
    expect(placements['google.rectangle'].maxBytes).toBe(150 * 1024);
    expect(placements['youtube.thumbnail'].maxBytes).toBe(2 * 1024 * 1024);
    expect(placements['linkedin.video_square'].minSeconds).toBe(3);
    expect(placements['linkedin.video_square'].maxSeconds).toBe(1800);
    expect(placements['youtube.video_vertical'].maxSeconds).toBe(180);
    expect(Object.keys(videoLengths)).toEqual(['6s', '15s', '30s', '45-60s']);
    expect([videoLengths['45-60s'].min, videoLengths['45-60s'].max]).toEqual([45, 60]);
  });
});

describe('validateAsset', () => {
  const ok = { placement: 'meta.feed_square', width: 1080, height: 1080, bytes: 120_000, contentType: 'image/png', copy: { headline: 'Short headline', primaryText: 'A short primary text.' } };

  it('passes an asset that fits its placement', () => {
    expect(validateAsset(ok)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('blocks the wrong size, type or file size, and an unknown placement', () => {
    expect(validateAsset({ ...ok, width: 1080, height: 1081 }).errors.map(item => item.code)).toEqual(['wrong_dimensions']);
    expect(validateAsset({ ...ok, contentType: 'video/mp4' }).errors.map(item => item.code)).toEqual(['wrong_type']);
    expect(validateAsset({ ...ok, placement: 'google.rectangle', width: 300, height: 250, bytes: 160 * 1024 }).errors.map(item => item.code)).toEqual(['too_large']);
    expect(validateAsset({ ...ok, placement: 'tiktok.feed' }).errors.map(item => item.code)).toEqual(['unknown_placement']);
  });

  it('blocks copy over a hard limit and warns past where the feed cuts it off', () => {
    expect(validateAsset({ ...ok, copy: { headline: 'x'.repeat(256) } }).errors.map(item => item.code)).toEqual(['text_too_long']);
    const warned = validateAsset({ ...ok, copy: { headline: 'x'.repeat(41), primaryText: 'y'.repeat(126) } });
    expect(warned.ok).toBe(true);
    expect(warned.warnings.map(item => item.code)).toEqual(['text_over_recommended', 'text_over_recommended']);
    expect(validateAsset({ ...ok, placement: 'google.square', width: 1200, height: 1200, copy: { headline: 'x'.repeat(31) } }).errors.map(item => item.code)).toEqual(['text_too_long']);
  });

  it('checks a video\'s length, its length format and its captions', () => {
    const video = { placement: 'linkedin.video_square', width: 1080, height: 1080, bytes: 1_000_000, contentType: 'video/mp4', durationSeconds: 15, lengthKey: '15s', captions: true };
    expect(validateAsset(video).ok).toBe(true);
    expect(validateAsset({ ...video, durationSeconds: 2, lengthKey: null }).errors.map(item => item.code)).toEqual(['video_too_short']);
    expect(validateAsset({ ...video, placement: 'meta.video_vertical', width: 1080, height: 1920, durationSeconds: 61, lengthKey: null }).errors.map(item => item.code)).toEqual(['video_too_long']);
    expect(validateAsset({ ...video, durationSeconds: 20 }).errors.map(item => item.code)).toEqual(['length_mismatch']);
    expect(validateAsset({ ...video, lengthKey: '45-60s', durationSeconds: 50 }).ok).toBe(true);
    expect(validateAsset({ ...video, captions: false }).errors.map(item => item.code)).toEqual(['captions_missing']);
    expect(validateAsset({ ...video, durationSeconds: null }).errors.map(item => item.code)).toEqual(['duration_unknown']);
  });
});
