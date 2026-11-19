import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it, vi } from 'vitest';
import { creativeJpegFiles, pngToJpeg } from './jpeg.mjs';

// Review 2026-11-19: Instagram publishes JPEG only, and every Creative Director image is a PNG.
const png = (width = 108, height = 192, color = '#0b3d91') => Buffer.from(new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/><circle cx="50" cy="60" r="30" fill="#ffffff"/></svg>`).render().asPng());
const bundled = (await import('ffmpeg-static').catch(() => ({ default: null }))).default;
const haveFfmpeg = typeof bundled === 'string' && existsSync(bundled);

/** A stand-in child process: `script(child)` decides what it writes and how it ends. */
function fakeSpawn(script) {
  return vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn(() => { child.killed = true; });
    setImmediate(() => script(child));
    return child;
  });
}

describe('a PNG as a JPEG', () => {
  it.skipIf(!haveFfmpeg)('re-encodes a rendered PNG with the bundled ffmpeg', async () => {
    const jpeg = await pngToJpeg(png(), { ffmpeg: bundled });
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
    // A baseline JPEG's frame header (SOF0) carries the image's height and width.
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    expect([jpeg.readUInt16BE(sof + 5), jpeg.readUInt16BE(sof + 7)]).toEqual([192, 108]);
  });

  it('refuses anything but a PNG, and works only with an ffmpeg', async () => {
    const spawnImpl = fakeSpawn(() => {});
    await expect(pngToJpeg(Buffer.from('not an image'), { ffmpeg: 'ffmpeg', spawnImpl })).rejects.toMatchObject({ code: 'jpeg_not_png' });
    await expect(pngToJpeg(png(), { ffmpeg: null, spawnImpl })).rejects.toMatchObject({ code: 'jpeg_unavailable' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('fails a conversion that ends badly, overruns its deadline or grows past Instagram\'s limit, and stops it', async () => {
    const failed = fakeSpawn(child => { child.stdout.write(Buffer.from('oops')); child.emit('close', 1); });
    await expect(pngToJpeg(png(), { ffmpeg: 'ffmpeg', spawnImpl: failed })).rejects.toMatchObject({ code: 'jpeg_failed' });
    const notJpeg = fakeSpawn(child => { child.stdout.write(Buffer.from('not a jpeg')); child.emit('close', 0); });
    await expect(pngToJpeg(png(), { ffmpeg: 'ffmpeg', spawnImpl: notJpeg })).rejects.toMatchObject({ code: 'jpeg_failed' });
    let hung;
    const stuck = fakeSpawn(child => { hung = child; });
    await expect(pngToJpeg(png(), { ffmpeg: 'ffmpeg', spawnImpl: stuck, timeoutMs: 20 })).rejects.toMatchObject({ code: 'jpeg_timeout' });
    expect(hung.kill).toHaveBeenCalled();
    let big;
    const huge = fakeSpawn(child => { big = child; child.stdout.write(Buffer.alloc(64, 0xff)); });
    await expect(pngToJpeg(png(), { ffmpeg: 'ffmpeg', spawnImpl: huge, maxBytes: 32 })).rejects.toMatchObject({ code: 'jpeg_too_large' });
    expect(big.kill).toHaveBeenCalled();
  });
});

describe('the JPEG copies of approved images', () => {
  const token = 'a'.repeat(64);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  it('answers only for an approved PNG, and keeps a copy keyed by the image itself', async () => {
    let file = { contentType: 'image/png', bytes: png() };
    const publicFile = vi.fn(async value => (value === token ? file : null));
    const convert = vi.fn(async () => jpeg);
    const copies = creativeJpegFiles({ publicFile, convert, ffmpeg: async () => 'ffmpeg' });
    expect(await copies(token)).toEqual({ contentType: 'image/jpeg', bytes: jpeg });
    expect(await copies(token)).toEqual({ contentType: 'image/jpeg', bytes: jpeg });
    expect(convert).toHaveBeenCalledTimes(1);
    // The approval is read every time: a retired asset is gone at once, kept copy or not.
    expect(publicFile).toHaveBeenCalledTimes(2);
    file = null;
    expect(await copies(token)).toBeNull();
    // A different image under the same token is converted afresh, never served from the older copy.
    file = { contentType: 'image/png', bytes: png(108, 192, '#aa0000') };
    await copies(token);
    expect(convert).toHaveBeenCalledTimes(2);
    file = { contentType: 'video/mp4', bytes: Buffer.from('mp4') };
    expect(await copies(token)).toBeNull();
    expect(await copies('b'.repeat(64))).toBeNull();
  });

  it('runs only a few conversions at once, and lets a failed one through to the caller', async () => {
    let active = 0, most = 0;
    const convert = vi.fn(async () => { active += 1; most = Math.max(most, active); await new Promise(resolve => setTimeout(resolve, 10)); active -= 1; return jpeg; });
    const images = Array.from({ length: 4 }, (_, index) => png(100 + index, 192));
    const copies = creativeJpegFiles({ publicFile: async value => ({ contentType: 'image/png', bytes: images[Number(value)] }), convert, ffmpeg: async () => 'ffmpeg', concurrent: 2 });
    await Promise.all(['0', '1', '2', '3'].map(copies));
    expect(convert).toHaveBeenCalledTimes(4);
    expect(most).toBe(2);
    const broken = creativeJpegFiles({ publicFile: async () => ({ contentType: 'image/png', bytes: png() }), convert: async () => { throw Object.assign(new Error('x'), { code: 'jpeg_failed' }); },
      ffmpeg: async () => 'ffmpeg', concurrent: 1 });
    await expect(broken(token)).rejects.toMatchObject({ code: 'jpeg_failed' });
    // The slot is given back after a failure.
    await expect(broken(token)).rejects.toMatchObject({ code: 'jpeg_failed' });
  });
});
