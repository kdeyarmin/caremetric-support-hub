/**
 * The internal video renderer: every frame is drawn with satori and resvg (the same primitives as the static layouts), and ffmpeg-static
 * stitches the frames into an H.264 MP4. No browser and no Remotion.
 *
 * A video is a timeline of scenes built from the asset's copy: the hook (the headline, word by word: kinetic text), the beats (the
 * layout's short lines, each in turn), a product screenshot with a slow pan and zoom when the owner has one, the offer or the statistic
 * when the asset has one, and a logo end card with the call to action. Lengths are 6, 15, 30 or 45 to 60 seconds (specs.mjs), in 1:1, 4:5
 * or 9:16. Captions are burned in by default (a dark band with the line being shown) and also returned as WebVTT; the brand kit can turn
 * the burned captions off, and compliance then blocks the video. When `server/agents/creative/music/` holds royalty-free tracks, one is
 * chosen by the asset's id and laid under the video with a fade at each end; otherwise the video is silent.
 *
 * Frames are rendered once per distinct picture: a scene that holds still is one picture repeated, and motion is drawn at 12 pictures a
 * second inside a 24-frame-a-second video, which keeps a 60-second video to a few hundred renders.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { band, colorsIn, cta, dataUri, drawingContext, h, header, imageSize, img, padded, reportOf, text } from './layouts.mjs';
import { renderElement } from './render.mjs';
import { videoLengths } from './specs.mjs';
import { withThemeFiles } from './themes.mjs';

export const musicDirectory = fileURLToPath(new URL('./music/', import.meta.url));
const fps = 24;
const motionFps = 12;
const unavailable = () => Object.assign(new Error('Video rendering is not available on this server.'), { code: 'video_unavailable' });

let ffmpegCache = null;
/** The ffmpeg binary: ffmpeg-static's, else one on the PATH. Null when neither is there. */
export async function ffmpegPath() {
  ffmpegCache ??= (async () => {
    try {
      const { default: bundled } = await import('ffmpeg-static');
      if (bundled) { await access(bundled); return bundled; }
    } catch { /* fall through to the PATH */ }
    try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0 ? 'ffmpeg' : null; } catch { return null; }
  })();
  return ffmpegCache;
}

/** The lines a video shows, in order: the headline, then the beats (or the primary text's sentences), then the call to action. */
export function scriptLines(content) {
  const beats = (Array.isArray(content.overlay?.beats) ? content.overlay.beats : []).filter(Boolean);
  const fallback = String(content.primaryText ?? '').split(/(?<=[.!?])\s+/).map(line => line.trim()).filter(line => line.length > 0 && line.length <= 90);
  return { hook: String(content.headline ?? '').trim(), beats: beats.length ? beats : fallback.slice(0, 6) };
}

/**
 * The timeline: `[{ kind, text, start, end }]` covering exactly `duration` seconds. Shorter videos show fewer beats: 6 seconds is the hook
 * and the end card; 15 seconds adds two beats; 30 seconds four and the screenshot; 45 to 60 seconds up to eight and the screenshot.
 */
export function buildTimeline({ content, lengthKey = '15s', duration = null, screenshot = false }) {
  const { hook, beats } = scriptLines(content);
  const o = content.overlay ?? {};
  const target = duration ?? (lengthKey === '45-60s' ? Math.min(60, Math.max(45, 18 + beats.length * 5)) : videoLengths[lengthKey]?.target ?? 15);
  const room = target <= 6 ? 0 : target <= 15 ? 2 : target <= 30 ? 4 : 8;
  const scenes = [{ kind: 'hook', text: hook }];
  for (const line of beats.slice(0, room)) scenes.push({ kind: 'beat', text: line });
  if (target > 15 && screenshot) scenes.splice(Math.min(2, scenes.length), 0, { kind: 'screenshot', text: beats[room] ?? hook });
  if (target > 6 && (o.offerLine || o.stat)) scenes.push({ kind: o.offerLine ? 'offer' : 'stat', text: o.offerLine || `${o.stat} ${o.statLabel ?? ''}`.trim() });
  const end = Math.min(3, Math.max(1.5, target * 0.2));
  const each = (target - end) / scenes.length;
  let at = 0;
  const timeline = scenes.map(scene => { const item = { ...scene, start: at, end: at + each }; at += each; return item; });
  timeline.push({ kind: 'end', text: content.cta || 'Learn more', start: target - end, end: target });
  return { duration: target, scenes: timeline };
}

const stamp = seconds => {
  const ms = Math.round(seconds * 1000);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
};
/** The captions as WebVTT: one cue per scene, the words the scene shows. */
export function captionsVtt(timeline) {
  return ['WEBVTT', '', ...timeline.scenes.filter(scene => scene.text).flatMap((scene, index) => [String(index + 1), `${stamp(scene.start)} --> ${stamp(scene.end)}`, scene.text, ''])].join('\n');
}

const ease = t => 1 - (1 - Math.min(Math.max(t, 0), 1)) ** 3;

/**
 * One picture of the video at `t` seconds, as an element tree, drawn in the product's brand theme with the drawing context that records its
 * text runs and colors. The end card is the theme's: Emberline's dark canvas with the fire band, the Intel mark, its tagline and the white
 * pill; CareBase's white with its logo lockup over the blue rule and the blue button.
 */
export function drawFrame({ ctx, timeline, t, content, captions }) {
  const { frame, colors, brand, theme } = ctx;
  const scene = timeline.scenes.find(item => t >= item.start && t < item.end) ?? timeline.scenes[timeline.scenes.length - 1];
  const local = t - scene.start;
  const length = scene.end - scene.start;
  const bandHeight = captions ? Math.round(frame.u * 13) : 0;
  const safeBottom = frame.shape === 'tall' ? frame.bottom : frame.pad;
  let body;
  if (scene.kind === 'end') {
    const grow = 0.92 + 0.08 * ease(local / 0.5);
    return h('div', { width: frame.width, height: frame.height, position: 'relative', backgroundColor: colors.background, fontFamily: ctx.body, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
      band(ctx),
      h('div', { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: Math.round(frame.u * 4.5), transform: `scale(${grow.toFixed(3)})` },
        header(ctx, { size: Math.round(frame.u * 10), width: Math.round(frame.inner * 0.6) }),
        theme.tagline ? text(ctx, { role: 'tagline', value: theme.tagline, size: Math.round(frame.u * 5.5), bold: true, color: 'text', background: colors.background, width: frame.inner, maxLines: 2, style: { textAlign: 'center' } }) : null,
        cta(ctx, scene.text, { align: 'center' }),
        text(ctx, { role: 'domain', value: theme.site, size: Math.round(frame.u * 3.4), color: 'muted', background: colors.background, width: frame.inner, maxLines: 1 })));
  }
  const size = Math.round(frame.u * (scene.kind === 'hook' ? 8.5 : 7));
  if (scene.kind === 'screenshot' && ctx.files.screenshots) {
    const shot = Object.values(ctx.files.screenshots)[0];
    ctx.images.push({ kind: 'screenshot', attested: shot.attested === true });
    const dims = imageSize(shot.bytes) ?? { width: 16, height: 10, type: 'image/png' };
    const boxW = frame.inner;
    const boxH = Math.round((frame.height - frame.top - safeBottom - bandHeight) * 0.55);
    const zoom = 1 + 0.12 * ease(local / length);
    const scale = Math.max(boxW / dims.width, boxH / dims.height) * zoom;
    const panX = -Math.round((dims.width * scale - boxW) * ease(local / length) * 0.6);
    body = h('div', { flexDirection: 'column', gap: Math.round(frame.u * 4) },
      text(ctx, { role: 'headline', value: scene.text, size: Math.round(frame.u * 6), bold: true, color: 'text', background: colors.background, width: frame.inner, maxLines: 3 }),
      h('div', { width: boxW, height: boxH, overflow: 'hidden', borderRadius: Math.round(theme.cardRadius * frame.width * 0.6), border: `${Math.max(2, Math.round(frame.u * 0.3))}px solid ${colors.hairline}`, backgroundColor: colors.panel },
        img(dataUri(shot.bytes, dims.type), { width: Math.round(dims.width * scale), height: Math.round(dims.height * scale), marginLeft: panX })));
  } else if (scene.kind === 'offer' || scene.kind === 'stat') {
    // The theme's own callout, as on the offer card.
    const rise = ease(local / 0.5);
    const fill = brand.callout.fill;
    const inner = frame.inner - Math.round(frame.u * 12);
    body = h('div', { flexDirection: 'column', gap: Math.round(frame.u * 3), backgroundColor: fill, border: `${Math.max(2, Math.round(frame.u * 0.3))}px solid ${brand.callout.border}`, borderRadius: Math.round(theme.cardRadius * frame.width), padding: Math.round(frame.u * 6), width: frame.inner, boxSizing: 'border-box', opacity: Number(rise.toFixed(3)), transform: `translateY(${Math.round((1 - rise) * frame.u * 4)}px)` },
      text(ctx, { role: scene.kind, value: scene.text, size: Math.round(frame.u * 8), bold: true, color: brand.callout.accent, background: fill, width: inner, maxLines: 3, lineHeight: 1.05 }),
      scene.kind === 'offer' ? text(ctx, { role: 'fine print', value: 'Applied automatically when paid service starts. Standard pricing after the introductory year.', size: Math.round(frame.u * 3), color: brand.callout.text, background: fill, width: inner, maxLines: 3, lineHeight: 1.3 }) : null);
  } else {
    // Kinetic text: each word rises and fades in, 0.12 seconds after the one before.
    const words = String(scene.text).split(/\s+/).filter(Boolean);
    text(ctx, { role: scene.kind === 'hook' ? 'headline' : 'beat', value: scene.text, size, bold: true, color: 'text', background: colors.background, width: frame.inner, maxLines: 5 });
    const color = ctx.texts[ctx.texts.length - 1].color;
    body = h('div', { flexWrap: 'wrap', width: frame.inner, columnGap: Math.round(size * 0.28), rowGap: Math.round(size * 0.1) },
      ...words.map((word, index) => {
        const shown = ease((local - index * 0.12) / 0.35);
        return h('div', { fontFamily: ctx.heading, fontSize: size, fontWeight: 800, color, lineHeight: 1.1, opacity: Number(shown.toFixed(3)), transform: `translateY(${Math.round((1 - shown) * size * 0.4)}px)` }, word);
      }));
  }
  const mark = Math.round(frame.u * 5.5);
  return wrap(ctx, [header(ctx, { size: mark }),
    h('div', { flexDirection: 'column', justifyContent: 'center', width: frame.inner, height: frame.height - frame.top - safeBottom - bandHeight - mark * 2.6 }, body)], captions ? scene.text : null, bandHeight, safeBottom);
}

/**
 * A scene over the theme's canvas, with the captions in a band of the theme's own colors: Emberline's dark panel with its light text,
 * CareBase's dark heading color with white.
 */
function wrap(ctx, body, caption, bandHeight, safeBottom) {
  const { frame, colors, theme, brand } = ctx;
  const captionFill = theme.mode === 'dark' ? colors.panel : brand.ink;
  const captionText = theme.mode === 'dark' ? 'text' : brand.paper;
  const children = [h('div', { width: frame.width, height: frame.height, position: 'absolute', left: 0, top: 0 },
    padded({ width: frame.width, height: frame.height, left: frame.pad, top: frame.top, bottom: safeBottom }, [...body, h('div', { height: caption ? bandHeight : 1 })]))];
  if (caption) {
    const size = Math.round(frame.u * 3.6);
    children.push(h('div', { position: 'absolute', left: frame.pad, bottom: safeBottom, width: frame.inner, height: bandHeight, backgroundColor: captionFill, borderRadius: Math.round(frame.u * 1.5), alignItems: 'center', justifyContent: 'center', paddingLeft: frame.pad / 2, paddingRight: frame.pad / 2, boxSizing: 'border-box' },
      text(ctx, { role: 'caption', value: caption, size, bold: true, color: captionText, background: captionFill, width: frame.inner - frame.pad, maxLines: 2, style: { textAlign: 'center', justifyContent: 'center' } })));
  }
  return h('div', { width: frame.width, height: frame.height, position: 'relative', backgroundColor: colors.background, fontFamily: ctx.body, overflow: 'hidden' }, children);
}

/** The state a frame shows, so identical pictures are drawn once: a still scene is one state; motion is sampled 12 times a second. */
function stateOf(timeline, t) {
  const scene = timeline.scenes.find(item => t >= item.start && t < item.end) ?? timeline.scenes[timeline.scenes.length - 1];
  const local = t - scene.start;
  const words = String(scene.text).split(/\s+/).filter(Boolean).length;
  const moving = scene.kind === 'screenshot' || local < (scene.kind === 'hook' || scene.kind === 'beat' ? words * 0.12 + 0.35 : 0.5);
  return moving ? `${scene.start}:${Math.floor(local * motionFps)}` : `${scene.start}:still`;
}

/** A royalty-free track from the music folder, chosen by the asset's id, or null. */
export async function pickMusic(id, directory = musicDirectory) {
  let names = [];
  try { names = (await readdir(directory)).filter(name => /\.(mp3|m4a|aac|wav)$/i.test(name)).sort(); } catch { return null; }
  if (!names.length) return null;
  const index = createHash('sha256').update(String(id)).digest().readUInt32BE(0) % names.length;
  return join(directory, names[index]);
}

/** A video file's length in seconds and its picture's size, read from the MP4's movie and track headers. */
export function mp4Info(bytes) {
  const data = Buffer.from(bytes);
  const find = (type, from = 0, to = data.length) => {
    for (let offset = from; offset + 8 <= to;) {
      const size = data.readUInt32BE(offset);
      if (data.toString('latin1', offset + 4, offset + 8) === type) return { offset, size };
      if (size < 8) return null;
      offset += size;
    }
    return null;
  };
  const moov = find('moov');
  if (!moov) return null;
  const mvhd = find('mvhd', moov.offset + 8, moov.offset + moov.size);
  if (!mvhd) return null;
  const v1 = data[mvhd.offset + 8] === 1;
  const timescale = data.readUInt32BE(mvhd.offset + (v1 ? 28 : 20));
  const duration = v1 ? Number(data.readBigUInt64BE(mvhd.offset + 32)) : data.readUInt32BE(mvhd.offset + 24);
  let width = null;
  let height = null;
  for (let trak = find('trak', moov.offset + 8, moov.offset + moov.size); trak; trak = find('trak', trak.offset + trak.size, moov.offset + moov.size)) {
    const tkhd = find('tkhd', trak.offset + 8, trak.offset + trak.size);
    if (!tkhd) continue;
    const w = data.readUInt32BE(tkhd.offset + tkhd.size - 8) / 65536;
    const hgt = data.readUInt32BE(tkhd.offset + tkhd.size - 4) / 65536;
    if (w > 0 && hgt > 0) { width = w; height = hgt; break; }
  }
  return { durationSeconds: timescale ? duration / timescale : null, width, height };
}

/**
 * Renders one video in its product's brand theme. `files` are the owner's brand files (logo, screenshots); the theme's logo and band are
 * added. Returns `{ mp4, durationSeconds, captions (WebVTT), cues, burned,
 * report }`; the report is every text run any frame drew, for the compliance checks. `duration` overrides the length (the smoke test makes
 * a one-second video).
 */
export async function renderVideo({ id = 'video', width, height, product, content, kit, files: given = {}, lengthKey = '15s', duration = null, captions = true, music = true, signal = null, musicDir = musicDirectory }) {
  const binary = await ffmpegPath();
  if (!binary) throw unavailable();
  const files = await withThemeFiles(product, given);
  const ctx = drawingContext({ width, height, product, kit, files });
  const timeline = buildTimeline({ content, lengthKey, duration, screenshot: Boolean(given.screenshots && Object.keys(given.screenshots).length) });
  const frames = Math.max(1, Math.round(timeline.duration * fps));
  const track = music ? await pickMusic(id, musicDir) : null;
  const folder = await mkdtemp(join(tmpdir(), 'creative-'));
  const out = join(folder, 'video.mp4');
  let peakArea = 0;
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0',
      ...(track ? ['-i', track] : []), '-map', '0:v',
      ...(track ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '128k', '-af', `afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, timeline.duration - 1).toFixed(2)}:d=1`] : ['-an']),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', String(fps), '-t', (frames / fps).toFixed(3), '-movflags', '+faststart', out];
    const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let failed = null;
    child.on('error', error => { failed = error; });
    child.stderr.resume();
    const exit = once(child, 'close');
    const stop = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const drawn = new Map();
      for (let index = 0; index < frames; index += 1) {
        if (signal?.aborted || failed) break;
        const t = index / fps;
        const key = stateOf(timeline, t);
        let png = drawn.get(key);
        if (!png) {
          // A fresh context per picture keeps the report to what one picture shows; the runs are kept for the checks.
          const local = drawingContext({ width, height, product, kit, files });
          const picture = drawFrame({ ctx: local, timeline, t, content, captions });
          colorsIn(picture, ctx.painted);
          // Text coverage is a property of one picture: the report keeps the busiest picture's, not the sum over the video.
          peakArea = Math.max(peakArea, local.texts.reduce((sum, run) => sum + run.area, 0));
          png = Buffer.from(await renderElement(picture, { width, height }));
          ctx.texts.push(...local.texts.filter(run => !ctx.texts.some(seen => seen.role === run.role && seen.color === run.color && seen.background === run.background && seen.fontSize === run.fontSize)));
          ctx.images.push(...local.images.filter(image => !ctx.images.some(seen => seen.kind === image.kind)));
          for (const field of local.adjusted) ctx.adjusted.add(field);
          drawn.clear();
          drawn.set(key, png);
        }
        if (!child.stdin.write(png)) await Promise.race([once(child.stdin, 'drain'), exit]);
      }
      child.stdin.end();
      const [code] = await exit;
      if (signal?.aborted) throw Object.assign(new Error('The render was stopped.'), { code: 'render_aborted', transient: true });
      if (failed || code !== 0) throw Object.assign(new Error('ffmpeg could not make the video.'), { code: 'video_encode_failed' });
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    const mp4 = await readFile(out);
    const info = mp4Info(mp4);
    const report = { ...reportOf(ctx, 'video'), textArea: peakArea };
    return { mp4, durationSeconds: info?.durationSeconds ?? frames / fps, width: info?.width ?? width, height: info?.height ?? height, captions: captionsVtt(timeline),
      cues: timeline.scenes.filter(scene => scene.text).length, burned: captions === true, report, music: Boolean(track) };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
