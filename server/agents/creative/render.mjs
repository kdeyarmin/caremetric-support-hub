/**
 * Static rendering with no browser: a layout (layouts.mjs) becomes SVG with satori and a PNG with @resvg/resvg-js, at the placement's
 * exact size. Both libraries are loaded the first time something is rendered, never at server start, so a Hub without them (or with a
 * native binding that cannot load) still starts; rendering then fails with `renderer_unavailable` and the asset is tried again later.
 */
import { loadFonts } from './brand.mjs';
import { drawStatic } from './layouts.mjs';

let engine = null;
const unavailable = () => Object.assign(new Error('The renderer could not be loaded.'), { code: 'renderer_unavailable' });

/** satori and resvg, loaded once. */
export async function renderEngine() {
  engine ??= (async () => {
    try {
      const [{ default: satori }, { Resvg }, fonts] = await Promise.all([import('satori'), import('@resvg/resvg-js'), loadFonts()]);
      return { satori, Resvg, fonts };
    } catch {
      engine = null;
      throw unavailable();
    }
  })();
  return engine;
}

/** An element tree at an exact size, as PNG bytes. */
export async function renderElement(element, { width, height }) {
  const { satori, Resvg, fonts } = await renderEngine();
  const svg = await satori(element, { width, height, fonts });
  const image = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } }).render();
  if (image.width !== width || image.height !== height) throw Object.assign(new Error('The render came out at the wrong size.'), { code: 'render_size_mismatch' });
  return image.asPng();
}

/**
 * Renders one static asset. Returns `{ png, width, height, report }`: the PNG at exactly `width` x `height` and the layout's report for
 * the compliance checks.
 */
export async function renderStatic({ layout, width, height, product, content, kit, files = {} }) {
  const { element, report } = drawStatic({ layout, width, height, product, content, kit, files });
  const png = await renderElement(element, { width, height });
  return { png: Buffer.from(png), width, height, report };
}

/** Width and height from a PNG's header (for tests and checks). */
export function pngSize(bytes) {
  const data = Buffer.from(bytes);
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}
