/**
 * The static layouts: headline, stat, screenshot frame, quote, offer card, checklist and split. Each is a plain satori element tree (no JSX,
 * no browser) for an exact canvas, drawn in the product's brand theme (themes.mjs) with the owner's brand kit on top:
 *
 * - CareMetric Intel (Emberline): the near-black canvas, the reverse CareMetric logo with the product name, ember accents, white pill
 *   buttons, Emberline's own callout for the offer card, Geist type and the fire band along the bottom.
 * - CareMetric CareBase: white, the CareBase logo lockup over a brand-blue rule, blue accents and buttons, CareBase's own callout for the
 *   offer card.
 *
 * Every layout also returns a report of what it drew: every text run with its color, the color behind it, its size and the area it covers;
 * every image; every color it painted; and the colors the brand allows. compliance.mjs checks contrast, text coverage, images and that every
 * color is a brand color.
 *
 * Every layout adapts to its canvas: square and portrait (feeds), tall (Stories and Reels keep the top 12% and bottom 18% clear of the
 * platform's own buttons), landscape (LinkedIn, Google, the YouTube thumbnail) and the small 300 x 250 rectangle, which shows only the brand,
 * the headline and the call to action.
 */
import { contrastRatio, fontFor, luminance, meetsAA, readableOn } from './brand.mjs';
import { effectiveKit } from './themes.mjs';

export const layouts = Object.freeze(['headline', 'stat', 'screenshot', 'quote', 'offer', 'checklist', 'split']);
export const productNames = Object.freeze({ carebase: 'CareMetric CareBase', 'caremetric-intel': 'CareMetric Intel' });
export const productDomains = Object.freeze({ carebase: 'cmcarebase.com', 'caremetric-intel': 'caremetricintel.com' });

const flat = children => children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false && child !== '');
/** One element. `children` may be strings (text) or elements. */
export const h = (type, style = {}, ...children) => {
  const kids = flat(children);
  return { type, props: { style: type === 'div' ? { display: 'flex', ...style } : style, ...(kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {}) } };
};
export const img = (src, style) => ({ type: 'img', props: { src, width: style.width, height: style.height, style } });

/** Every #RRGGBB color an element tree paints (text, fills and borders), uppercase. */
export function colorsIn(node, found = new Set()) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { for (const child of node) colorsIn(child, found); return found; }
  for (const value of Object.values(node.props?.style ?? {})) {
    for (const match of String(value).matchAll(/#[0-9A-Fa-f]{6}\b/g)) found.add(match[0].toUpperCase());
  }
  colorsIn(node.props?.children, found);
  return found;
}

// Inter's and Geist's average advance is about 0.55 em bold and 0.5 em regular; words wrap, so a line holds a little less.
const charWidth = bold => (bold ? 0.56 : 0.51);
/** Estimated lines `text` takes at `size` in a box `width` wide. */
export function linesFor(text, size, width, bold) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  let lines = words.length ? 1 : 0;
  let used = 0;
  for (const word of words) {
    const w = (word.length + 1) * size * charWidth(bold);
    if (used + w > width && used > 0) { lines += 1; used = w; } else used += w;
  }
  return lines;
}
/** The largest size from `size` down to `min` at which `text` fits in `maxLines` lines of `width`. */
export function fit(text, { width, size, min, maxLines, bold = true }) {
  let current = size;
  while (current > min && linesFor(text, current, width, bold) > maxLines) current = Math.max(min, Math.floor(current * 0.92));
  return current;
}

/** Width and height of a PNG or JPEG, read from its header; null for anything else. */
export function imageSize(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), type: 'image/png' };
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7), type: 'image/jpeg' };
      offset += 2 + length;
    }
  }
  return null;
}
export const dataUri = (bytes, type) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

/** The canvas's shape and the measures every layout shares. */
export function frameOf(width, height) {
  const ratio = width / height;
  const shape = width < 400 ? 'tiny' : ratio > 1.4 ? 'landscape' : ratio < 0.65 ? 'tall' : ratio < 0.9 ? 'portrait' : 'square';
  const u = Math.min(width, height) / 100;
  const pad = Math.round(shape === 'tiny' ? u * 6 : u * 6.5);
  const top = shape === 'tall' ? Math.round(height * 0.12) : pad;
  const bottom = shape === 'tall' ? Math.round(height * 0.18) : pad;
  return { width, height, shape, u, pad, top, bottom, inner: width - pad * 2 };
}

/** What every drawing shares: the canvas, the brand (theme plus kit), the fonts, the files and the report it fills in. */
export function drawingContext({ width, height, product, kit, files = {} }) {
  const brand = effectiveKit(product, kit ?? {});
  const heading = fontFor(kit?.headingFont, brand.theme.font);
  const body = fontFor(kit?.bodyFont, brand.theme.font);
  return { frame: frameOf(width, height), brand, colors: brand.colors, theme: brand.theme, heading: heading.family, body: body.family, texts: [], images: [], product, kit, files,
    adjusted: new Set(), substituted: heading.substituted || body.substituted, painted: new Set() };
}

/** The report a drawing context filled in, for compliance.mjs. `element` adds every color it paints. */
export const reportOf = (ctx, layout, element = null) => {
  if (element) colorsIn(element, ctx.painted);
  return { width: ctx.frame.width, height: ctx.frame.height, layout, theme: ctx.theme.key, texts: ctx.texts, images: ctx.images, adjustments: [...ctx.adjusted].sort(),
    fonts: { substituted: ctx.substituted }, colors: [...ctx.painted].sort(), allowed: [...ctx.brand.allowed].sort() };
};

/**
 * Draws one asset. `content` is the asset's copy and overlay; `kit` the owner's brand kit (blank fields use the theme); `files` the owner's
 * logo and screenshots and the theme's own files (themes.mjs withThemeFiles): `{ logo, themeLogo, band, screenshots: { [id]: { bytes, type,
 * attested } } }`. Returns `{ element, report }`.
 */
export function drawStatic({ layout, width, height, product, content = {}, kit = {}, files = {} }) {
  const ctx = drawingContext({ width, height, product, kit, files });
  const { frame, colors } = ctx;
  let chosen = layouts.includes(layout) ? layout : 'headline';
  const overlay = content.overlay ?? {};
  // A screenshot layout needs a screenshot the owner attested; a stat, a quote or a checklist needs its content. Otherwise: a headline.
  if (chosen === 'screenshot' && !files.screenshots?.[overlay.screenshotId]) chosen = 'headline';
  if (chosen === 'stat' && !overlay.stat) chosen = 'headline';
  if (chosen === 'quote' && !overlay.quote) chosen = 'headline';
  if (chosen === 'checklist' && !(Array.isArray(overlay.checklist) && overlay.checklist.length)) chosen = 'headline';
  if (chosen === 'offer' && !overlay.offerLine) chosen = 'headline';
  if (chosen === 'split' && frame.shape !== 'landscape') chosen = 'headline';
  const body = frame.shape === 'tiny' ? tiny(ctx, content) : bodies[chosen](ctx, content);
  const element = h('div', { width, height, backgroundColor: colors.background, fontFamily: ctx.body, position: 'relative', overflow: 'hidden' }, band(ctx), body);
  return { element, report: reportOf(ctx, chosen, element) };
}

// Which kit field a color role comes from, so a replacement of the owner's own color is reported.
const kitRole = { text: 'text', body: 'text', muted: 'text', accent: 'accent', primary: 'primary', onPrimary: 'primary' };
const kitField = { text: 'textColor', accent: 'accentColor', primary: 'primaryColor' };
/**
 * A text run the report records. `color` is a role of the brand (text, body, muted, accent, onPrimary) or a color of the theme; it is kept
 * where it passes WCAG AA for this size on this background and otherwise replaced by the theme's own darkest or lightest color. A
 * replacement of a color the owner set in the kit is reported (a brand deviation). `area` is the glyph boxes' area.
 */
export function text(ctx, { role, value, size, bold = false, color, background, width, maxLines = 6, lineHeight = 1.15, family = null, style = {} }) {
  const wanted = ctx.colors[color] ?? color;
  const readable = readableOn(background, wanted, { ink: ctx.brand.ink, paper: ctx.brand.paper, fontSize: size, bold, canvasWidth: ctx.frame.width });
  if (readable.adjusted && kitRole[color] && ctx.brand.overrides.includes(kitRole[color])) ctx.adjusted.add(kitField[kitRole[color]]);
  const chars = Math.min(String(value).length, Math.ceil((maxLines * width) / (size * charWidth(bold))));
  ctx.texts.push({ role, color: readable.color, background, fontSize: size, bold, area: Math.round(chars * size * charWidth(bold) * size) });
  return h('div', { fontFamily: family ?? (bold ? ctx.heading : ctx.body), fontSize: size, fontWeight: bold ? 800 : 400, color: readable.color, lineHeight, maxWidth: width, ...style }, value);
}

const radius = (ctx, scale = 1) => Math.round(ctx.theme.cardRadius * ctx.frame.width * scale);

/**
 * The product's mark: the owner's uploaded logo, else the theme's official lockup (Intel's reverse lockup on a dark canvas, CareBase's
 * full-color lockup on white), else the product name beside a bar of the brand color. A theme logo is never put on a background it was not
 * made for: Intel's white lockup needs a dark ground and CareBase's lockup carries its own white one.
 */
const fits = (logo, on) => !logo?.needs || (logo.needs === 'dark' ? luminance(on) < 0.2 : luminance(on) > 0.92);
export function brandMark(ctx, { size = null, background = null } = {}) {
  const { frame, colors, files, product } = ctx;
  const on = background ?? colors.background;
  const height = size ?? Math.round(frame.u * (frame.shape === 'landscape' ? 8 : 7.5));
  const logo = files.logo ?? (files.themeLogo && fits(files.themeLogo, on) ? files.themeLogo : null);
  const dims = logo ? imageSize(logo.bytes) : null;
  if (logo && dims && dims.height > 0) {
    ctx.images.push({ kind: 'logo', attested: true });
    // A tall mark (Intel's) is drawn a little taller than a wide lockup (CareBase's) so the two read at the same weight.
    const tall = dims.height / dims.width > 0.5 ? 1.35 : 1;
    const drawn = Math.round(height * tall);
    return img(dataUri(logo.bytes, dims.type), { width: Math.round((dims.width / dims.height) * drawn), height: drawn });
  }
  return h('div', { alignItems: 'center', gap: Math.round(height * 0.35) },
    h('div', { width: Math.round(height * 0.32), height, backgroundColor: colors.primary, borderRadius: Math.round(height * 0.12) }),
    text(ctx, { role: 'brand', value: productNames[product] ?? 'CareMetric', size: Math.round(height * 0.62), bold: true, color: 'text', background: on, width: frame.inner, maxLines: 1 }));
}

/** The header: the mark, and under it the theme's rule (CareBase's brand-blue line). */
export function header(ctx, options = {}) {
  const { frame, colors, theme } = ctx;
  const mark = brandMark(ctx, options);
  if (!theme.rule) return mark;
  return h('div', { flexDirection: 'column', gap: Math.round(frame.u * 2) }, mark,
    h('div', { width: options.width ?? frame.inner, height: Math.max(3, Math.round(frame.width * theme.rule.share)), backgroundColor: colors[theme.rule.role] }));
}

/** Emberline's fire band along the bottom of the canvas (Intel); nothing for a theme without one. */
export function band(ctx) {
  const { frame, files } = ctx;
  if (!files.band || frame.shape === 'tiny') return null;
  const dims = imageSize(files.band.bytes) ?? { width: 1200, height: 200, type: 'image/png' };
  ctx.images.push({ kind: 'brand', attested: true });
  const height = Math.round((frame.width * dims.height) / dims.width);
  return h('div', { position: 'absolute', left: 0, bottom: 0, width: frame.width, height }, img(dataUri(files.band.bytes, dims.type), { width: frame.width, height }));
}

/** The call to action in the theme's button: Intel's white pill, CareBase's blue button. */
export function cta(ctx, label, { align = 'flex-start' } = {}) {
  const { frame, brand } = ctx;
  const size = Math.round(frame.u * (frame.shape === 'landscape' ? 3.6 : 3.4));
  const rounded = brand.button.pill ? size * 2 : Math.max(4, Math.round(frame.width * (8 / 600)));
  return h('div', { alignSelf: align, backgroundColor: brand.button.fill, borderRadius: rounded, paddingTop: Math.round(size * 0.65), paddingBottom: Math.round(size * 0.65), paddingLeft: size * 1.4, paddingRight: size * 1.4, alignItems: 'center' },
    text(ctx, { role: 'cta', value: label || 'Learn more', size, bold: true, color: brand.button.text, background: brand.button.fill, width: frame.inner * 0.6, maxLines: 1 }));
}

function footer(ctx, content) {
  const { frame, colors, theme } = ctx;
  const size = Math.round(frame.u * 2.6);
  return h('div', { justifyContent: 'space-between', alignItems: 'center', width: frame.inner },
    cta(ctx, content.cta),
    text(ctx, { role: 'domain', value: theme.site, size, color: 'muted', background: colors.background, width: frame.inner * 0.38, maxLines: 1 }));
}

// Yoga adds padding to an explicit size, so a padded box is an outer box at the full size around an inner box of the space left.
export function padded({ width, height, left, right = left, top = left, bottom = top, background = null, inner = {} }, children) {
  return h('div', { width, height, paddingLeft: left, paddingRight: right, paddingTop: top, paddingBottom: bottom, ...(background ? { backgroundColor: background } : {}), boxSizing: 'border-box' },
    h('div', { flexDirection: 'column', justifyContent: 'space-between', width: width - left - right, height: height - top - bottom, ...inner }, children));
}

// On a canvas with the fire band, the footer sits above the band's flame, not on it.
export const bandLift = ctx => (ctx.files.band && ctx.frame.shape !== 'tall' && ctx.frame.shape !== 'tiny' ? Math.round(ctx.frame.width * 0.06) : 0);

// The page sits over the canvas (and the band, which is drawn first), so it has no fill of its own.
function page(ctx, children) {
  const { frame } = ctx;
  return h('div', { position: 'absolute', left: 0, top: 0, width: frame.width, height: frame.height },
    padded({ width: frame.width, height: frame.height, left: frame.pad, top: frame.top, bottom: frame.bottom + bandLift(ctx) }, children));
}

const support = content => {
  const value = String(content.description || content.primaryText || '').trim();
  if (value.length <= 140) return value;
  const sentence = value.split(/(?<=[.!?])\s+/)[0];
  return sentence.length <= 140 ? sentence : `${value.slice(0, 137).trimEnd()}…`;
};
const headlineSize = (ctx, value, share = 1) => fit(value, { width: ctx.frame.inner * share, size: Math.round(ctx.frame.u * (ctx.frame.shape === 'landscape' ? 8.5 : ctx.frame.shape === 'tall' ? 8 : 9)), min: Math.round(ctx.frame.u * 4.6), maxLines: ctx.frame.shape === 'landscape' ? 3 : 4 });

function kicker(ctx, value) {
  if (!value) return null;
  const { frame, colors } = ctx;
  return text(ctx, { role: 'kicker', value: String(value).toUpperCase(), size: Math.round(frame.u * 2.8), bold: true, color: 'accent', background: colors.background, width: frame.inner, maxLines: 2, style: { letterSpacing: 1 } });
}

const bodies = {
  headline(ctx, content) {
    const { frame, colors } = ctx;
    const landscape = frame.shape === 'landscape';
    const width = landscape ? frame.inner * 0.72 : frame.inner;
    const size = headlineSize(ctx, content.headline, landscape ? 0.72 : 1);
    const supporting = support(content);
    return page(ctx, [
      header(ctx),
      h('div', { flexDirection: 'column', gap: Math.round(frame.u * 2.5) },
        h('div', { width: Math.round(frame.u * 12), height: Math.round(frame.u * 1.2), backgroundColor: colors.accent, borderRadius: 4 }),
        kicker(ctx, content.overlay?.kicker),
        text(ctx, { role: 'headline', value: content.headline, size, bold: true, color: 'text', background: colors.background, width, maxLines: 4, lineHeight: 1.08 }),
        supporting ? text(ctx, { role: 'support', value: supporting, size: Math.round(frame.u * (landscape ? 3.6 : 3.8)), color: 'body', background: colors.background, width, maxLines: 3, lineHeight: 1.3 }) : null),
      footer(ctx, content),
    ]);
  },

  stat(ctx, content) {
    const { frame, colors } = ctx;
    const o = content.overlay;
    const landscape = frame.shape === 'landscape';
    const blockWidth = landscape ? frame.inner * 0.45 : frame.inner;
    const wordsWidth = landscape ? frame.inner * 0.5 : frame.inner;
    const statSize = fit(o.stat, { width: blockWidth, size: Math.round(frame.u * (landscape ? 20 : 24)), min: Math.round(frame.u * 10), maxLines: 1 });
    const block = h('div', { flexDirection: 'column', gap: Math.round(frame.u * 1.5), width: blockWidth },
      text(ctx, { role: 'stat', value: o.stat, size: statSize, bold: true, color: 'accent', background: colors.background, width: blockWidth, maxLines: 1, lineHeight: 1 }),
      o.statLabel ? text(ctx, { role: 'stat label', value: o.statLabel, size: Math.round(frame.u * 4), bold: true, color: 'text', background: colors.background, width: blockWidth, maxLines: 2 }) : null);
    const words = h('div', { flexDirection: 'column', gap: Math.round(frame.u * 2), width: wordsWidth },
      text(ctx, { role: 'headline', value: content.headline, size: fit(content.headline, { width: wordsWidth, size: Math.round(frame.u * 6), min: Math.round(frame.u * 3.8), maxLines: 3 }), bold: true, color: 'text', background: colors.background, width: wordsWidth, maxLines: 3 }),
      o.statSource ? text(ctx, { role: 'source', value: `Source: ${o.statSource}`, size: Math.round(frame.u * 2.6), color: 'muted', background: colors.background, width: wordsWidth, maxLines: 2 }) : null);
    return page(ctx, [
      header(ctx),
      landscape ? h('div', { justifyContent: 'space-between', alignItems: 'center', width: frame.inner }, block, words) : h('div', { flexDirection: 'column', gap: Math.round(frame.u * 4) }, block, words),
      footer(ctx, content),
    ]);
  },

  screenshot(ctx, content) {
    const { frame, colors, files } = ctx;
    const shot = files.screenshots[content.overlay.screenshotId];
    ctx.images.push({ kind: 'screenshot', attested: shot.attested === true });
    const dims = imageSize(shot.bytes) ?? { width: 16, height: 10, type: shot.type };
    const landscape = frame.shape === 'landscape';
    const boxW = landscape ? frame.inner * 0.52 : frame.inner;
    const boxH = landscape ? frame.height - frame.top - frame.bottom - bandLift(ctx) : (frame.height - frame.top - frame.bottom) * (frame.shape === 'tall' ? 0.5 : 0.48);
    const bar = Math.round(frame.u * 3.2);
    const scale = Math.min(boxW / dims.width, (boxH - bar) / dims.height);
    const window = h('div', { flexDirection: 'column', borderRadius: radius(ctx, 0.6), overflow: 'hidden', border: `${Math.max(2, Math.round(frame.u * 0.3))}px solid ${colors.hairline}`, backgroundColor: colors.panel, boxShadow: '0 12px 32px rgba(0,0,0,0.18)' },
      h('div', { height: bar, alignItems: 'center', gap: Math.round(bar * 0.3), paddingLeft: Math.round(bar * 0.4), backgroundColor: colors.panel },
        ...[colors.accent, colors.muted, colors.muted].map(dot => h('div', { width: Math.round(bar * 0.32), height: Math.round(bar * 0.32), borderRadius: bar, backgroundColor: dot }))),
      img(dataUri(shot.bytes, dims.type), { width: Math.round(dims.width * scale), height: Math.round(dims.height * scale) }));
    const textWidth = landscape ? frame.inner * 0.42 : frame.inner;
    const words = text(ctx, { role: 'headline', value: content.headline, size: fit(content.headline, { width: textWidth, size: Math.round(frame.u * 7), min: Math.round(frame.u * 4), maxLines: 3 }), bold: true, color: 'text', background: colors.background, width: textWidth, maxLines: 3, lineHeight: 1.08 });
    return page(ctx, landscape
      ? [h('div', { justifyContent: 'space-between', alignItems: 'center', width: frame.inner, height: frame.height - frame.top - frame.bottom - bandLift(ctx) },
        h('div', { flexDirection: 'column', justifyContent: 'space-between', height: '100%', width: textWidth }, header(ctx, { width: textWidth }), words, cta(ctx, content.cta)), window)]
      : [header(ctx), words, h('div', { justifyContent: 'center', width: frame.inner }, window), footer(ctx, content)]);
  },

  quote(ctx, content) {
    const { frame, colors } = ctx;
    const o = content.overlay;
    const width = frame.shape === 'landscape' ? frame.inner * 0.8 : frame.inner;
    const indent = Math.round(frame.u * 6);
    return page(ctx, [
      header(ctx),
      h('div', { gap: Math.round(frame.u * 3) },
        h('div', { width: Math.round(frame.u * 1.4), backgroundColor: colors.accent, borderRadius: 4 }),
        h('div', { flexDirection: 'column', gap: Math.round(frame.u * 2.5) },
          text(ctx, { role: 'quote', value: `“${o.quote}”`, size: fit(o.quote, { width: width - indent, size: Math.round(frame.u * 7), min: Math.round(frame.u * 4), maxLines: 5 }), bold: true, color: 'text', background: colors.background, width: width - indent, maxLines: 5, lineHeight: 1.15 }),
          text(ctx, { role: 'attribution', value: `— ${o.quoteSource || 'CareMetric'}`, size: Math.round(frame.u * 3.4), bold: true, color: 'accent', background: colors.background, width, maxLines: 1 }))),
      footer(ctx, content),
    ]);
  },

  offer(ctx, content) {
    const { frame, colors, brand, product } = ctx;
    const o = content.overlay;
    const landscape = frame.shape === 'landscape';
    const cardW = landscape ? frame.inner * 0.62 : frame.inner;
    const pad = Math.round(frame.u * 5);
    const inner = cardW - pad * 2;
    const fine = 'Applied automatically when paid service starts. Standard pricing after the introductory year.';
    // The theme's own callout: Emberline's ember on dark, CareBase's blue on white.
    const fill = brand.callout.fill;
    const card = h('div', { flexDirection: 'column', gap: Math.round(frame.u * 2), backgroundColor: fill, border: `${Math.max(2, Math.round(frame.u * 0.3))}px solid ${brand.callout.border}`, borderRadius: radius(ctx), padding: pad, width: cardW, boxSizing: 'border-box' },
      text(ctx, { role: 'offer name', value: (o.kicker || 'Founders Sale').toUpperCase(), size: Math.round(frame.u * 3), bold: true, color: brand.callout.text, background: fill, width: inner, maxLines: 1, style: { letterSpacing: 1 } }),
      text(ctx, { role: 'offer', value: o.offerLine, size: fit(o.offerLine, { width: inner, size: Math.round(frame.u * 9), min: Math.round(frame.u * 5), maxLines: 3 }), bold: true, color: brand.callout.accent, background: fill, width: inner, maxLines: 3, lineHeight: 1.05 }),
      text(ctx, { role: 'offer product', value: productNames[product] ?? 'CareMetric', size: Math.round(frame.u * 3.6), bold: true, color: brand.callout.text, background: fill, width: inner, maxLines: 1 }),
      text(ctx, { role: 'fine print', value: fine, size: Math.round(frame.u * 2.5), color: brand.callout.text, background: fill, width: inner, maxLines: 3, lineHeight: 1.3 }));
    const headline = width => text(ctx, { role: 'headline', value: content.headline, size: fit(content.headline, { width, size: Math.round(frame.u * (landscape ? 6 : 6.5)), min: Math.round(frame.u * 3.5), maxLines: landscape ? 4 : 3 }), bold: true, color: 'text', background: colors.background, width, maxLines: landscape ? 4 : 3 });
    return page(ctx, [
      header(ctx),
      landscape ? h('div', { justifyContent: 'space-between', alignItems: 'center', width: frame.inner }, card, headline(frame.inner * 0.33))
        : h('div', { flexDirection: 'column', gap: Math.round(frame.u * 3) }, headline(frame.inner), card),
      footer(ctx, content),
    ]);
  },

  checklist(ctx, content) {
    const { frame, colors } = ctx;
    const items = content.overlay.checklist.slice(0, frame.shape === 'landscape' ? 3 : 5);
    const landscape = frame.shape === 'landscape';
    const width = landscape ? frame.inner * 0.55 : frame.inner;
    const size = Math.round(frame.u * (landscape ? 3.6 : 4));
    const tick = Math.round(size * 1.3);
    const stroke = Math.max(2, Math.round(tick * 0.12));
    const rows = items.map(item => h('div', { alignItems: 'center', gap: Math.round(size * 0.7) },
      h('div', { width: tick, height: tick, borderRadius: tick, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
        h('div', { width: Math.round(tick * 0.28), height: Math.round(tick * 0.52), borderRight: `${stroke}px solid ${colors.onPrimary}`, borderBottom: `${stroke}px solid ${colors.onPrimary}`, transform: 'rotate(45deg)', marginTop: -Math.round(tick * 0.08) })),
      text(ctx, { role: 'checklist item', value: item, size, bold: true, color: 'text', background: colors.background, width: width - tick - size, maxLines: 2 })));
    const head = text(ctx, { role: 'headline', value: content.headline, size: fit(content.headline, { width: landscape ? frame.inner * 0.4 : frame.inner, size: Math.round(frame.u * 7), min: Math.round(frame.u * 4), maxLines: 3 }), bold: true, color: 'text', background: colors.background, width: landscape ? frame.inner * 0.4 : frame.inner, maxLines: 3, lineHeight: 1.08 });
    return page(ctx, [
      header(ctx),
      landscape ? h('div', { justifyContent: 'space-between', alignItems: 'center', width: frame.inner }, head, h('div', { flexDirection: 'column', gap: Math.round(size * 0.8), width }, rows))
        : h('div', { flexDirection: 'column', gap: Math.round(frame.u * 3.5) }, head, h('div', { flexDirection: 'column', gap: Math.round(size * 0.8) }, rows)),
      footer(ctx, content),
    ]);
  },

  // Landscape only. The headline sits on a panel (a light theme's brand color; Emberline's dark card under an ember rule); the mark, the
  // supporting line and the call to action sit on the canvas beside it, where the logo was made to go.
  split(ctx, content) {
    const { frame, colors, theme } = ctx;
    const left = Math.round(frame.width * 0.48);
    const innerLeft = left - frame.pad * 2;
    const right = frame.width - left - frame.pad * 2;
    const supporting = support(content);
    const dark = theme.mode === 'dark';
    const panel = dark ? colors.surface : colors.primary;
    return h('div', { position: 'absolute', left: 0, top: 0, width: frame.width, height: frame.height },
      h('div', { position: 'absolute', left: 0, top: 0 },
        padded({ width: left, height: frame.height, left: frame.pad, background: panel }, [
          h('div', { width: Math.round(frame.u * 12), height: Math.max(3, Math.round(frame.u * 0.8)), backgroundColor: dark ? colors.accent : colors.onPrimary }),
          text(ctx, { role: 'headline', value: content.headline, size: fit(content.headline, { width: innerLeft, size: Math.round(frame.u * 8.5), min: Math.round(frame.u * 4.5), maxLines: 4 }), bold: true, color: dark ? 'text' : 'onPrimary', background: panel, width: innerLeft, maxLines: 4, lineHeight: 1.08 })])),
      h('div', { position: 'absolute', left, top: 0 },
        padded({ width: frame.width - left, height: frame.height, left: frame.pad, bottom: frame.pad + bandLift(ctx) }, [
          h('div', { flexDirection: 'column', gap: Math.round(frame.u * 3) }, header(ctx, { width: right }), kicker(ctx, content.overlay?.kicker)),
          supporting ? text(ctx, { role: 'support', value: supporting, size: fit(supporting, { width: right, size: Math.round(frame.u * 4.4), min: Math.round(frame.u * 3), maxLines: 5, bold: false }), color: 'body', background: colors.background, width: right, maxLines: 5, lineHeight: 1.3 }) : h('div', {}),
          cta(ctx, content.cta)])));
  },
};

function tiny(ctx, content) {
  const { frame, colors } = ctx;
  const value = String(content.headline ?? '');
  return page(ctx, [
    brandMark(ctx, { size: Math.round(frame.u * 9) }),
    text(ctx, { role: 'headline', value, size: fit(value, { width: frame.inner, size: Math.round(frame.u * 11), min: Math.round(frame.u * 7), maxLines: 3 }), bold: true, color: 'text', background: colors.background, width: frame.inner, maxLines: 3, lineHeight: 1.08 }),
    cta(ctx, content.cta),
  ]);
}

/** Whether a text run, as drawn, passes WCAG AA (for tests and checks). */
export const passesContrast = (run, canvasWidth) => meetsAA(contrastRatio(run.color, run.background), { fontSize: run.fontSize, bold: run.bold, canvasWidth });
