import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appServer } from './http.mjs';

// Vite copies public/ to the root of dist/, so serving public/ as dist is what the browser gets in production.
const publicDir = resolve('public');
let server, base;
beforeAll(async () => {
  server = appServer({ auth: {}, gateway: {}, delegations: {}, origins: [], dist: publicDir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));

describe('the favicon', () => {
  it('answers /favicon.ico with an icon, not a 404', async () => {
    const response = await fetch(`${base}/favicon.ico`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/x-icon');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.equals(await readFile(resolve(publicDir, 'favicon.ico')))).toBe(true);
    // An icon directory (reserved 0, type 1) holding 16, 32 and 48 pixel images.
    expect([bytes.readUInt16LE(0), bytes.readUInt16LE(2), bytes.readUInt16LE(4)]).toEqual([0, 1, 3]);
    expect([0, 1, 2].map(entry => bytes.readUInt8(6 + entry * 16))).toEqual([16, 32, 48]);
  });

  it('serves the scalable version as SVG', async () => {
    const response = await fetch(`${base}/favicon.svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(await response.text()).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it('is linked from the app page', async () => {
    const page = await readFile(resolve('index.html'), 'utf8');
    expect(page).toContain('<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />');
    expect(page).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
  });
});
