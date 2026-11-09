/**
 * The brand kit as the renderer uses it: whether it is complete enough to render, the colors each layout may use (every text color
 * checked against WCAG AA contrast, with the nearer of near-black and white substituted where the kit's own color fails), and the fonts.
 *
 * Fonts are bundled (@fontsource/inter), so rendering needs no network. A kit that names a font the Hub does not bundle renders in Inter
 * and the compliance result says so. To offer another font, add its @fontsource package and list its files in `fontFiles`.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const defaultFont = 'Inter';
const fontFiles = Object.freeze({
  Inter: Object.freeze({ 400: '@fontsource/inter/files/inter-latin-400-normal.woff', 600: '@fontsource/inter/files/inter-latin-600-normal.woff',
    700: '@fontsource/inter/files/inter-latin-700-normal.woff', 800: '@fontsource/inter/files/inter-latin-800-normal.woff' }),
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

/** The font a kit names, if the Hub bundles it, else Inter; `substituted` is true when the kit asked for another. */
export function fontFor(name) {
  const wanted = typeof name === 'string' ? name.trim() : '';
  const found = availableFonts.find(font => font.toLowerCase() === wanted.toLowerCase());
  return { family: found ?? defaultFont, substituted: Boolean(wanted) && !found };
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

const ink = '#111827';
const paper = '#FFFFFF';
/** The kit's color for text on `background` if it passes AA for normal text, else whichever of near-black and white contrasts more. */
export function readableOn(background, preferred) {
  if (isColor(preferred) && contrastRatio(preferred, background) >= 4.5) return { color: preferred, adjusted: false };
  const best = contrastRatio(ink, background) >= contrastRatio(paper, background) ? ink : paper;
  return { color: best, adjusted: isColor(preferred) };
}

/** What a kit still needs before anything can be rendered: the three colors every layout uses. */
export function kitMissing(kit) {
  return ['primaryColor', 'backgroundColor', 'textColor'].filter(field => !isColor(kit?.[field]));
}

/**
 * The colors a layout uses, from the kit. Headline and body text sit on the background; the CTA and the accent band sit on the primary
 * color. `adjustments` names each kit color that was replaced for contrast.
 */
export function palette(kit) {
  const background = kit.backgroundColor;
  const primary = kit.primaryColor;
  const accent = isColor(kit.accentColor) ? kit.accentColor : primary;
  const secondary = isColor(kit.secondaryColor) ? kit.secondaryColor : accent;
  const text = readableOn(background, kit.textColor);
  const onPrimary = readableOn(primary, contrastRatio(paper, primary) >= contrastRatio(ink, primary) ? paper : ink);
  const accentText = readableOn(background, accent);
  const onSecondary = readableOn(secondary, paper);
  return {
    background, primary, accent, secondary, text: text.color, onPrimary: onPrimary.color, accentText: accentText.color, onSecondary: onSecondary.color,
    muted: text.color,
    adjustments: [...(text.adjusted ? ['textColor'] : []), ...(accentText.adjusted ? ['accentColor'] : [])],
  };
}
