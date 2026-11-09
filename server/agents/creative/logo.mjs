/**
 * Where a logo may go. A logo is only ever placed on a background it sits on cleanly, so creative never shows a logo's own white box on a
 * colored or dark background:
 *
 * - A logo with a **transparent** background goes where its marks stand out: at least 85% of its drawn pixels (the light gray steps in a
 *   chart mark, for one, may be fainter) reach 3:1 against the background, the WCAG contrast for graphics.
 * - A logo with a **solid** background of its own (every JPEG, and a PNG saved on white) goes only on a background of that same color.
 * - A logo whose edges are neither (a photo, a gradient) goes nowhere.
 *
 * `analyzeLogo` reads the logo once, by rendering it with @resvg/resvg-js (loaded on first use, as the renderer is), and `logoFits` answers
 * for one background. layouts.mjs tries the owner's logo, then the product's official logo, then draws the product name; compliance.mjs
 * blocks an asset whose report says a logo was placed anywhere else.
 */
import { createHash } from 'node:crypto';
import { contrastRatio, isColor } from './brand.mjs';

const hex = (r, g, b) => `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
const channels = color => [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
/** The largest difference in any channel, 0 to 255. */
export const colorDistance = (a, b) => Math.max(...channels(a).map((value, index) => Math.abs(value - channels(b)[index])));

// How close two solid colors must be to count as the same background: 3 in a channel, so #FFFFFF is not #F8FAFC.
const sameGround = 3;
const fitShare = 0.85;
const analysisWidth = 240;

let resvg = null;
const cache = new Map();

/**
 * What a logo's background and marks are: `{ ground: 'transparent' | '#RRGGBB' | 'busy', inks: [{ color, share }] }`, where `inks` are the
 * colors of its drawn pixels (rounded, most common first, at most 24) with their share of them. `type` is image/png or image/jpeg.
 */
export async function analyzeLogo(bytes, type = 'image/png') {
  const data = Buffer.from(bytes);
  const key = createHash('sha256').update(data).digest('hex');
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      resvg ??= (await import('@resvg/resvg-js')).Resvg;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${analysisWidth}" height="${analysisWidth}"><image href="data:${type};base64,${data.toString('base64')}" width="${analysisWidth}" height="${analysisWidth}" preserveAspectRatio="xMidYMid meet"/></svg>`;
      // The image is fitted inside a square; what lies outside it is transparent, so only the image's own box is read.
      const size = imageBox(data);
      const picture = new resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } }).render();
      return measure(picture.pixels, picture.width, picture.height, size);
    })().catch(error => { cache.delete(key); throw error; }));
  }
  return cache.get(key);
}

// Where the image lands inside the analysis square (preserveAspectRatio meet), from its own header.
function imageBox(data) {
  let width = 0;
  let height = 0;
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) { width = data.readUInt32BE(16); height = data.readUInt32BE(20); }
  else if (data[0] === 0xff && data[1] === 0xd8) {
    for (let at = 2; at + 9 < data.length;) {
      if (data[at] !== 0xff) break;
      const marker = data[at + 1];
      const length = data.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) { height = data.readUInt16BE(at + 5); width = data.readUInt16BE(at + 7); break; }
      at += 2 + length;
    }
  }
  if (!width || !height) return { left: 0, top: 0, width: analysisWidth, height: analysisWidth };
  const scale = Math.min(analysisWidth / width, analysisWidth / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { left: Math.floor((analysisWidth - w) / 2), top: Math.floor((analysisWidth - h) / 2), width: w, height: h };
}

function measure(pixels, canvasWidth, canvasHeight, box) {
  const at = (x, y) => (y * canvasWidth + x) * 4;
  const left = box.left + 1;
  const top = box.top + 1;
  const right = Math.min(canvasWidth, box.left + box.width) - 2;
  const bottom = Math.min(canvasHeight, box.top + box.height) - 2;
  // The ring two pixels inside the image's edge (the outermost pixel can be softened by scaling).
  const edge = [];
  for (let x = left; x <= right; x += 1) edge.push(at(x, top), at(x, bottom));
  for (let y = top + 1; y < bottom; y += 1) edge.push(at(left, y), at(right, y));
  const clear = edge.filter(index => pixels[index + 3] < 16).length;
  let ground = 'busy';
  // A cut-out logo is mostly clear along its edge (a tightly cropped one touches it in places); a logo saved on a background has none.
  if (clear / edge.length >= 0.6) ground = 'transparent';
  else {
    const solid = edge.filter(index => pixels[index + 3] > 240);
    if (solid.length / edge.length >= 0.9) {
      const middle = [0, 1, 2].map(channel => solid.map(index => pixels[index + channel]).sort((a, b) => a - b)[Math.floor(solid.length / 2)]);
      const color = hex(...middle);
      const even = solid.filter(index => colorDistance(hex(pixels[index], pixels[index + 1], pixels[index + 2]), color) <= 12).length;
      if (even / edge.length >= 0.9) ground = color;
    }
  }
  // The drawn pixels: opaque enough to read, and (on a solid ground) clearly not the ground.
  const counts = new Map();
  let total = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const index = at(x, y);
      if (pixels[index + 3] < 128) continue;
      // resvg's pixels are premultiplied: undo it, then group near-equal colors (each channel to the middle of its 16-wide step).
      const alpha = pixels[index + 3] / 255;
      const color = hex(...[0, 1, 2].map(channel => Math.min(255, Math.floor(Math.min(255, pixels[index + channel] / alpha) / 16) * 16 + 8)));
      if (ground !== 'transparent' && ground !== 'busy' && colorDistance(color, ground) <= 40) continue;
      counts.set(color, (counts.get(color) ?? 0) + 1);
      total += 1;
    }
  }
  const inks = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([color, count]) => ({ color, share: count / total }));
  return { ground, inks };
}

/** Whether a logo (`analyzeLogo`'s result) sits cleanly on `background` (#RRGGBB). Unknown is no. */
export function logoFits(info, background) {
  if (!info || !isColor(background)) return false;
  if (info.ground === 'busy') return false;
  if (info.ground !== 'transparent') return colorDistance(info.ground, background) <= sameGround;
  if (!info.inks?.length) return false;
  const seen = info.inks.reduce((sum, ink) => sum + (contrastRatio(ink.color, background) >= 3 ? ink.share : 0), 0);
  const counted = info.inks.reduce((sum, ink) => sum + ink.share, 0);
  return counted > 0 && seen / counted >= fitShare;
}

/** Why a logo did not fit, in plain words, for the brand deviation note. */
export const misfit = info => (info?.ground === 'busy' ? 'its edges are a picture rather than a plain background'
  : info && info.ground !== 'transparent' ? `it has a solid ${info.ground} background of its own` : 'its colors are too close to this background');
