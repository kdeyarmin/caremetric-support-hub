/**
 * Color and type helpers the renderer and the compliance checks share: WCAG contrast, and the bundled fonts.
 *
 * Fonts are bundled (@fontsource), so rendering needs no network: Geist, CareMetric Intel's typeface (Emberline), and Inter, the closest
 * open match for the system UI stack CareBase's app and emails use. A brand kit that names a font the Hub does not bundle renders in the
 * theme's own font and the compliance result says so. To offer another font, add its @fontsource package and list its files in `fontFiles`.
 * The brand colors themselves live in themes.mjs.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const defaultFont = 'Inter';
const fontFiles = Object.freeze({
  Inter: Object.freeze({ 400: '@fontsource/inter/files/inter-latin-400-normal.woff', 600: '@fontsource/inter/files/inter-latin-600-normal.woff',
    700: '@fontsource/inter/files/inter-latin-700-normal.woff', 800: '@fontsource/inter/files/inter-latin-800-normal.woff' }),
  Geist: Object.freeze({ 400: '@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff', 600: '@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff',
    700: '@fontsource/geist-sans/files/geist-sans-latin-700-normal.woff', 800: '@fontsource/geist-sans/files/geist-sans-latin-800-normal.woff' }),
});
export const availableFonts = Object.freeze(Object.keys(fontFiles));

let fontCache = null;
/** The bundled fonts as satori takes them: [{ name, data, weight, style }]. Read once. */
export async function loadFonts() {
  fontCache ??= Promise.all(Object.entries(fontFiles).flatMap(([name, weights]) => Object.entries(weights).map(async ([weight, path]) => ({
    name, data: await readFile(require.resolve(path)), weight: Number(weight), style: 'normal',
  }))));
  return fontCache;
}

/** The font a kit names, if the Hub bundles it, else `fallback` (the theme's font); `substituted` is true when the kit asked for another. */
export function fontFor(name, fallback = defaultFont) {
  const wanted = typeof name === 'string' ? name.trim() : '';
  const found = availableFonts.find(font => font.toLowerCase() === wanted.toLowerCase());
  return { family: found ?? (availableFonts.includes(fallback) ? fallback : defaultFont), substituted: Boolean(wanted) && !found };
}

const hex = /^#[0-9A-Fa-f]{6}$/;
export const isColor = value => typeof value === 'string' && hex.test(value);

/** WCAG 2.x relative luminance of a #RRGGBB color. */
export function luminance(color) {
  const channel = index => {
    const value = parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG contrast ratio between two colors, 1 to 21. */
export function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Whether text passes WCAG AA: 4.5:1, or 3:1 for large text (24 CSS pixels, or 18.66 bold). An ad is seen smaller than it is made: a feed
 * shows a 1080-pixel-wide image about 400 CSS pixels wide, so a size on the canvas counts at `displayWidth / canvasWidth` of itself.
 */
export function meetsAA(ratio, { fontSize, bold = false, canvasWidth = 1080, displayWidth = 400 } = {}) {
  const shown = fontSize * Math.min(displayWidth / canvasWidth, 1);
  const large = shown >= 24 || (bold && shown >= 18.66);
  return ratio >= (large ? 3 : 4.5);
}

/**
 * `preferred` for text on `background` if it passes AA for that text, else whichever of the theme's own darkest (`ink`) and lightest
 * (`paper`) colors contrasts more. `adjusted` says the preferred color was replaced.
 */
export function readableOn(background, preferred, { ink, paper, fontSize = 40, bold = false, canvasWidth = 1080 }) {
  if (isColor(preferred) && meetsAA(contrastRatio(preferred, background), { fontSize, bold, canvasWidth })) return { color: preferred, adjusted: false };
  return { color: contrastRatio(ink, background) >= contrastRatio(paper, background) ? ink : paper, adjusted: isColor(preferred) };
}
