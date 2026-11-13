import { describe, expect, it } from 'vitest';
import { syntheticMp4 } from './fixtures.mjs';
import { mp4Info } from './mp4.mjs';

describe('reading an MP4 file', () => {
  it('reads the length and the video track\'s picture size, wherever the movie box sits', () => {
    expect(mp4Info(syntheticMp4({ width: 1080, height: 1920, seconds: 30 }))).toEqual({ durationSeconds: 30, width: 1080, height: 1920 });
    expect(mp4Info(syntheticMp4({ width: 1920, height: 1080, seconds: 93, moovLast: true }))).toEqual({ durationSeconds: 93, width: 1920, height: 1080 });
    expect(mp4Info(syntheticMp4({ width: 1080, height: 1080, seconds: 15, version: 1 }))).toEqual({ durationSeconds: 15, width: 1080, height: 1080 });
  });

  it('refuses anything that is not an MP4 with a readable video track', () => {
    expect(mp4Info(Buffer.from('not a video at all, just some text bytes'))).toBeNull();
    expect(mp4Info(syntheticMp4().subarray(0, 60))).toBeNull();
    const noVideo = syntheticMp4();
    noVideo.write('soun', noVideo.indexOf('vide', 0, 'latin1'), 'latin1');
    expect(mp4Info(noVideo)).toBeNull();
    expect(mp4Info('ftyp')).toBeNull();
  });
});
