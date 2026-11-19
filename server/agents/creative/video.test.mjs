import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Frames are drawn by the real renderer unless a test makes the next frame wait for something or fail.
const drawing = vi.hoisted(() => ({ before: null, fail: false }));
vi.mock('./render.mjs', async importOriginal => {
  const real = await importOriginal();
  return { ...real, renderElement: async (...args) => {
    if (drawing.before) await drawing.before();
    if (drawing.fail) throw new Error('A frame could not be drawn.');
    return real.renderElement(...args);
  } };
});
const { renderVideo } = await import('./video.mjs');
const { content, kit } = await import('./fixtures.mjs');

// A stand-in for ffmpeg: a shell script. One that keeps running writes its process id first, so a test can tell whether it was stopped.
const folders = [];
async function fakeFfmpeg(body) {
  const folder = await mkdtemp(join(tmpdir(), 'fake-ffmpeg-'));
  folders.push(folder);
  const path = join(folder, 'ffmpeg');
  await writeFile(path, `#!/bin/sh\n${body.replaceAll('$FOLDER', folder)}\n`);
  await chmod(path, 0o755);
  return { path, pidFile: join(folder, 'pid') };
}
const waitForFile = async file => {
  for (let tries = 0; tries < 200; tries += 1) {
    try { await access(file); return; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error('The stand-in ffmpeg never started.');
};
const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const video = { id: 'v', width: 320, height: 320, product: 'caremetric-intel', content, kit, duration: 1, music: false };

afterEach(async () => {
  Object.assign(drawing, { before: null, fail: false });
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

describe('the ffmpeg process behind a video', () => {
  it('reports a video ffmpeg stopped making, instead of an uncaught broken pipe', async () => {
    // ffmpeg fails before the first frame reaches it (a bad music file, an encoder error): drawing stops once it exits.
    const { path, pidFile } = await fakeFfmpeg('echo $$ > "$FOLDER/pid"\nexit 1');
    let framesDrawn = 0;
    drawing.before = async () => {
      framesDrawn += 1;
      await waitForFile(pidFile);
      const pid = Number(await readFile(pidFile, 'utf8'));
      while (running(pid)) await new Promise(resolve => setTimeout(resolve, 10));
    };
    await expect(renderVideo({ ...video, ffmpeg: path })).rejects.toMatchObject({ code: 'video_encode_failed' });
    expect(framesDrawn).toBe(1);
  }, 30_000);

  it('keeps a video ffmpeg finished, even when it closed its input before the last frame', async () => {
    // ffmpeg stops reading once it has the frames -t asks for and exits 0: the frames written after that hit a closed pipe, which is fine.
    const { path, pidFile } = await fakeFfmpeg('echo $$ > "$FOLDER/pid"\nexec 0<&-\nfor out; do :; done\nprintf finished > "$out"\nexit 0');
    drawing.before = async () => {
      await waitForFile(pidFile);
      const pid = Number(await readFile(pidFile, 'utf8'));
      while (running(pid)) await new Promise(resolve => setTimeout(resolve, 10));
    };
    const made = await renderVideo({ ...video, ffmpeg: path });
    expect(made.mp4.toString()).toBe('finished');
  }, 30_000);

  it('reports a video ffmpeg could not start', async () => {
    await expect(renderVideo({ ...video, ffmpeg: '/nonexistent/ffmpeg' })).rejects.toMatchObject({ code: 'video_encode_failed' });
  }, 30_000);

  it('stops ffmpeg when a frame cannot be drawn, instead of leaving it waiting for frames', async () => {
    const { path, pidFile } = await fakeFfmpeg('echo $$ > "$FOLDER/pid"\nexec sleep 30');
    drawing.before = () => waitForFile(pidFile);
    drawing.fail = true;
    await expect(renderVideo({ ...video, ffmpeg: path })).rejects.toThrow(/could not be drawn/);
    expect(running(Number(await readFile(pidFile, 'utf8')))).toBe(false);
  }, 30_000);

  it('stops ffmpeg and reports the render as stopped when the task is cancelled', async () => {
    const { path, pidFile } = await fakeFfmpeg('echo $$ > "$FOLDER/pid"\nexec sleep 30');
    const controller = new AbortController();
    drawing.before = async () => { await waitForFile(pidFile); controller.abort(); };
    await expect(renderVideo({ ...video, ffmpeg: path, signal: controller.signal })).rejects.toMatchObject({ code: 'render_aborted' });
    expect(running(Number(await readFile(pidFile, 'utf8')))).toBe(false);
  }, 30_000);
});
