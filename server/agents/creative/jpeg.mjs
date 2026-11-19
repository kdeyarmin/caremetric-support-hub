/**
 * A JPEG copy of an approved Creative Director image, for Instagram (review 2026-11-19). Instagram publishes JPEG only ("JPEG is the only
 * image format supported", Meta's content publishing limitations; stories too), and every creative image is a PNG: the November 18 story
 * was the first creative image sent to Instagram and was refused as meta_invalid_request, while the JPEG brand card always published.
 *
 * The PNG stays the asset; this only re-encodes it with the ffmpeg the Hub already ships for video, on request, a few at a time, with a
 * deadline and a size limit, and keeps the last few in memory (Meta fetches an image once, minutes after the post asks for it).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const failure = code => Object.assign(new Error('The image could not be converted.'), { code });
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Instagram's limit for an image, feed or story. */
export const jpegLimit = 8_000_000;

/** One PNG in, one baseline 4:2:0 JPEG out (high quality), through `ffmpeg`. Rejects with jpeg_failed, jpeg_timeout or jpeg_too_large. */
export function pngToJpeg(png, { ffmpeg, timeoutMs = 15_000, maxBytes = jpegLimit, spawnImpl = spawn } = {}) {
  if (!Buffer.isBuffer(png) || png.length < 8 || !png.subarray(0, 8).equals(pngSignature)) return Promise.reject(failure('jpeg_not_png'));
  if (typeof ffmpeg !== 'string' || !ffmpeg) return Promise.reject(failure('jpeg_unavailable'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-frames:v', '1',
        '-pix_fmt', 'yuvj420p', '-q:v', '2', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { reject(failure('jpeg_unavailable')); return; }
    const chunks = [];
    let size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { try { child.kill('SIGKILL'); } catch { /* already gone */ } reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(failure('jpeg_timeout')), timeoutMs);
    child.on('error', () => finish(failure('jpeg_unavailable')));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) finish(failure('jpeg_too_large')); else chunks.push(chunk);
    });
    child.on('close', code => {
      const bytes = Buffer.concat(chunks);
      // A JPEG starts with FF D8 FF; anything else from ffmpeg is not one.
      if (code === 0 && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) finish(null, bytes);
      else finish(failure('jpeg_failed'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(png);
  });
}

/**
 * `token → { contentType: 'image/jpeg', bytes } | null`: the JPEG copy of the approved or live PNG asset `publicFile(token)` answers with,
 * null when there is none (or it is a video). At most `concurrent` conversions run at once (a request over that waits for one); the last
 * `cacheSize` results are kept for `ttlMs`, keyed by the PNG's own hash, so a re-rendered asset is never served from an older copy.
 */
export function creativeJpegFiles({ publicFile, ffmpeg = async () => (await import('./video.mjs')).ffmpegPath(), convert = pngToJpeg,
  concurrent = 2, cacheSize = 16, ttlMs = 10 * 60_000, clock = () => Date.now() }) {
  const cache = new Map();
  let running = 0;
  const waiting = [];
  const acquire = () => (running < concurrent ? (running += 1, Promise.resolve()) : new Promise(resolve => waiting.push(resolve)));
  const release = () => { const next = waiting.shift(); if (next) next(); else running -= 1; };
  return async function publicJpeg(token) {
    const file = await publicFile(token);
    if (!file || file.contentType !== 'image/png' || !Buffer.isBuffer(file.bytes)) return null;
    const key = createHash('sha256').update(file.bytes).digest('hex');
    const kept = cache.get(key);
    if (kept && clock() - kept.at < ttlMs) return { contentType: 'image/jpeg', bytes: kept.bytes };
    await acquire();
    try {
      const binary = await ffmpeg();
      const bytes = await convert(file.bytes, { ffmpeg: binary });
      cache.delete(key);
      cache.set(key, { bytes, at: clock() });
      while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
      return { contentType: 'image/jpeg', bytes };
    } finally { release(); }
  };
}
