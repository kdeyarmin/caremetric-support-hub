/**
 * The static layouts, drawn from the brand kit: headline, stat, screenshot frame, quote, offer card, checklist and split. Each is a
 * plain satori element tree (no JSX, no browser) for an exact canvas, plus a report of what it drew: every text run with its color, the
 * color behind it, its size and the area it covers, and every image, so compliance.mjs can check contrast, text coverage and images.
 *
 * Every layout adapts to its canvas: square and portrait (feeds), tall (Stories and Reels keep the top 12% and bottom 18% clear of the
 * platform's own buttons), landscape (LinkedIn, Google, the YouTube thumbnail) and the small 300 x 250 rectangle, which shows only the
 * headline and the call to action.
 */
import { contrastRatio, fontFor, isColor, meetsAA, palette, readableOn } from './brand.mjs';

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

// Inter's average advance is about 0.55 em bold and 0.5 em regular; words wrap, so a line holds a little less.
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

/**
 * Draws one asset. `content` is the asset's copy and overlay; `kit` the brand kit; `files` the logo and screenshots as
 * `{ logo: { bytes, type }, screenshots: { [id]: { bytes, type, attested } } }`. Returns `{ element, report }`.
 */
/** What every drawing shares: the canvas, the colors, the fonts and the report it fills in. */
export function drawingContext({ width, height, product, kit, files = {} }) {
  const heading = fontFor(kit.headingFont);
  const body = fontFor(kit.bodyFont);
  return { frame: frameOf(width, height), colors: palette(kit), heading: heading.family, body: body.family, texts: [], images: [], product, kit, files,
    adjusted: new Set(), substituted: heading.substituted || body.substituted };
}

/** The report a drawing context filled in, for compliance.mjs. */
export const reportOf = (ctx, layout) => ({ width: ctx.frame.width, height: ctx.frame.height, layout, texts: ctx.texts, images: ctx.images,
  adjustments: [...ctx.adjusted].sort(), fonts: { substituted: ctx.substituted } });

export function drawStatic({ layout, width, height, product, content = {}, kit, files = {} }) {
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
  const element = frame.shape === 'tiny' ? tiny(ctx, content) : bodies[chosen](ctx, content);
  return {
    element: h('div', { width, height, backgroundColor: colors.background, fontFamily: ctx.body, position: 'relative', overflow: 'hidden' }, element),
    report: reportOf(ctx, chosen),
  };
}

/**
 * A text run the report records. `color` may be the token "text" or "accent": the brand kit's own color when it passes WCAG AA for this
 * size on this background, otherwise the nearer of near-black and white (and the substitution is reported). `area` is the glyph boxes'
 * area: characters times the advance width times the size.
 */
export function text(ctx, { role, value, size, bold = false, color, background, width, maxLines = 6, lineHeight = 1.15, family = null, style = {} }) {
  let shown = color;
  if (color === 'text' || color === 'accent') {
    const wanted = color === 'text' ? ctx.kit.textColor : (isColor(ctx.kit.accentColor) ? ctx.kit.accentColor : ctx.kit.primaryColor);
    if (isColor(wanted) && meetsAA(contrastRatio(wanted, background), { fontSize: size, bold, canvasWidth: ctx.frame.width })) shown = wanted;
    else {
      shown = readableOn(background, null).color;
      if (isColor(wanted)) ctx.adjusted.add(color === 'text' ? 'textColor' : 'accentColor');
    }
  }
  const chars = Math.min(String(value).length, Math.ceil((maxLines * width) / (size * charWidth(bold))));
  ctx.texts.push({ role, color: shown, background, fontSize: size, bold, area: Math.round(chars * size * charWidth(bold) * size) });
  return h('div', { fontFamily: family ?? (bold ? ctx.heading : ctx.body), fontSize: size, fontWeight: bold ? 800 : 400, color: shown, lineHeight, maxWidth: width, ...style }, value);
}

export function brandMark(ctx, { onColor = null, size = null } = {}) {
  const { frame, colors, files, product } = ctx;
  const height = size ?? Math.round(frame.u * (frame.shape === 'landscape' ? 7 : 6));
  const logo = files.logo;
  const dims = logo ? imageSize(logo.bytes) : null;
  if (logo && dims && dims.height > 0) {
    ctx.images.push({ kind: 'logo', attested: true });
    const w = Math.round((dims.width / dims.height) * height);
    return img(dataUri(logo.bytes, dims.type), { width: w, height });
  }
  const color = onColor ?? 'text';
  const background = onColor ? colors.primary : colors.background;
  return h('div', { alignItems: 'center', gap: Math.round(height * 0.35) },
    h('div', { width: Math.round(height * 0.32), height, backgroundColor: onColor ?? colors.primary, borderRadius: Math.round(height * 0.12) }),
    text(ctx, { role: 'brand', value: productNames[product] ?? 'CareMetric', size: Math.round(height * 0.62), bold: true, color, background, width: frame.inner, maxLines: 1 }));
}

export function cta(ctx, label, { inverse = false, align = 'flex-start' } = {}) {
  const { frame, colors } = ctx;
  const size = Math.round(frame.u * (frame.shape === 'landscape' ? 3.6 : 3.4));
  const background = inverse ? colors.background : colors.primary;
  const color = inverse ? 'text' : colors.onPrimary;
  return h('div', { alignSelf: align, backgroundColor: background, borderRadius: size * 2, paddingTop: Math.round(size * 0.65), paddingBottom: Math.round(size * 0.65), paddingLeft: size * 1.4, paddingRight: size * 1.4, alignItems: 'center' },
    text(ctx, { role: 'cta', value: label || 'Learn more', size, bold: true, color, background, width: frame.inner * 0.6, maxLines: 1 }));
}

function footer(ctx, content, options = {}) {
  const { frame, colors, product } = ctx;
  const size = Math.round(frame.u * 2.6);
  return h('div', { justifyContent: 'space-between', alignItems: 'center', width: frame.inner },
    cta(ctx, content.cta, options),
    text(ctx, { role: 'domain', value: productDomains[product] ?? 'caremetric.ai', size, color: options.inverse ? colors.onPrimary : 'text', background: options.inverse ? colors.primary : colors.background, width: frame.inner * 0.38, maxLines: 1 }));
}

// Yoga adds padding to an explicit size, so a padded box is an outer box at the full size around an inner box of the space left.
export function padded({ width, height, left, right = left, top = left, bottom = top, background, inner = {} }, children) {
  return h('div', { width, height, paddingLeft: left, paddingRight: right, paddingTop: top, paddingBottom: bottom, backgroundColor: background, boxSizing: 'border-box' },
    h('div', { flexDirection: 'column', justifyContent: 'space-between', width: width - left - right, height: height - top - bottom, ...inner }, children));
}

function page(ctx, children, { background = null } = {}) {
  const { frame, colors } = ctx;
  return padded({ width: frame.width, height: frame.height, left: frame.pad, top: frame.top, bottom: frame.bottom, background: background ?? colors.background }, children);
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
      brandMark(ctx),
      h('div', { flexDirection: 'column', gap: Math.round(frame.u * 2.5) },
        h('div', { width: Math.round(frame.u * 12), height: Math.round(frame.u * 1.2), backgroundColor: colors.primary, borderRadius: 4 }),
        kicker(ctx, content.overlay?.kicker),
        text(ctx, { role: 'headline', value: content.headline, size, bold: true, color: 'text', background: colors.background, width, maxLines: 4, lineHeight: 1.08 }),
        supporting ? text(ctx, { role: 'support', value: supporting, size: Math.round(frame.u * (landscape ? 3.6 : 3.8)), color: 'text', background: colors.background, width, maxLines: 3, lineHeight: 1.3 }) : null),
      footer(ctx, content),
    ]);
  },

  stat(ctx, content) {
    const { frame, colors } = ctx;
    const o = content.overlay;
    const landscape = frame.shape === 'landscape';
    const statSize = fit(o.stat, { width: frame.inner * (landscape ? 0.45 : 1), size: Math.round(frame.u * (landscape ? 20 : 24)), min: Math.round(frame.u * 10), maxLines: 1 });
    const block = h('div', { flexDirection: 'column', gap: Math.round(frame.u * 1.5), width: landscape ? frame.inner * 0.45 : frame.inner },
      text(ctx, { role: 'stat', value: o.stat, size: statSize, bold: true, color: 'accent', background: colors.background, width: landscape ? frame.inner * 0.45 : frame.inner, maxLines: 1, lineHeight: 1 }),
      o.statLabel ? text(ctx, { role: 'stat label', value: o.statLabel, size: Math.round(frame.u * 4), bold: true, color: 'text', background: colors.background, width: landscape ? frame.inner * 0.45 : frame.inner, maxLines: 2 }) : null);
    const words = h('div', { flexDirection: 'column', gap: Math.round(frame.u * 2), width: landscape ? frame.inner * 0.5 : frame.inner },
      text(ctx, { role: 'headline', value: content.headline, size: fit(content.headline, { width: landscape ? frame.inner * 0.5 : frame.inner, size: Math.round(frame.u * 6), min: Math.round(frame.u * 3.8), maxLines: 3 }), bold: true, color: 'text', background: colors.background, width: landscape ? frame.inner * 0.5 : frame.inner, maxLines: 3 }),
      o.statSource ? text(ctx, { role: 'source', value: `Source: ${o.statSource}`, size: Math.round(frame.u * 2.6), color: 'text', background: colors.background, width: landscape ? frame.inner * 0.5 : frame.inner, maxLines: 2 }) : null);
    return page(ctx, [
      brandMark(ctx),
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
    const boxH = landscape ? frame.height - frame.top - frame.bottom : (frame.height - frame.top - frame.bottom) * (frame.shape === 'tall' ? 0.5 : 0.48);
    const bar = Math.round(frame.u * 3.2);
    const scale = Math.min(boxW / dims.width, (boxH - bar) / dims.height);
    const shotW = Math.round(dims.width * scale);
    const shotH = Math.round(dims.height * scale);
    const window = h('div', { flexDirection: 'column', borderRadius: Math.round(frame.u * 1.6), overflow: 'hidden', border: `${Math.max(2, Math.round(frame.u * 0.3))}px solid ${colors.secondary}`, backgroundColor: colors.secondary, boxShadow: '0 12px 32px rgba(17,24,39,0.18)' },
      h('div', { height: bar, alignItems: 'center', gap: Math.round(bar * 0.3), paddingLeft: Math.round(bar * 0.4), backgroundColor: colors.secondary },
        ...[0, 1, 2].map(() => h('div', { width: Math.round(bar * 0.32), height: Math.round(bar * 0.32), borderRadius: bar, backgroundColor: colors.onSecondary }))),
      img(dataUri(shot.bytes, dims.type), { width: shotW, height: shotH }));
    const textWidth = landscape ? frame.inner * 0.42 : frame.inner;
    const words = h('div', { flexDirection: 'column', gap: Math.round(frame.u * 1.8), width: textWidth },
      text(ctx, { role: 'headline', value: content.headline, size: fit(content.headline, { width: textWidth, size: Math.round(frame.u * 7), min: Math.round(frame.u * 4), maxLines: 3 }), bold: true, color: 'text', background: colors.background, width: textWidth, maxLines: 3, lineHeight: 1.08 }));
    return page(ctx, landscape
      ? [h('div', { justifyContent: 'space-between', alignItems: 'center', width: frame.inner, height: frame.height - frame.top - frame.bottom },
        h('div', { flexDirection: 'column', justifyContent: 'space-between', height: '100%', width: textWidth }, brandMark(ctx), words, cta(ctx, content.cta)), window)]
      : [brandMark(ctx), words, h('div', { justifyContent: 'center', width: frame.inner }, window), footer(ctx, content)]);
  },

  quote(ctx, content) {
    const { frame, colors } = ctx;
    const o = content.overlay;
    const landscape = frame.shape === 'landscape';
    const width = landscape ? frame.inner * 0.8 : frame.inner;
    return page(ctx, [
      brandMark(ctx),
      h('div', { flexDirection: 'column', gap: Math.round(frame.u * 2.5) },
        h('div', { width: Math.round(frame.u * 3), height: Math.round(frame.u * (landscape ? 14 : 18)), backgroundColor: colors.primary, borderRadius: 4, position: 'absolute', left: 0, top: 0 }),
        h('div', { flexDirection: 'column', gap: Math.round(frame.u * 2.5), paddingLeft: Math.round(frame.u * 6) },
          text(ctx, { role: 'quote', value: `“${o.quote}”`, size: fit(o.quote, { width: width - frame.u * 6, size: Math.round(frame.u * 7), min: Math.round(frame.u * 4), maxLines: 5 }), bold: true, color: 'text', background: colors.background, width: width - frame.u * 6, maxLines: 5, lineHeight: 1.15 }),
          text(ctx, { role: 'attribution', value: `— ${o.quoteSource || 'CareMetric'}`, size: Math.round(frame.u * 3.4), bold: true, color: 'accent', background: colors.background, width, maxLines: 1 }))),
      footer(ctx, content),
    ]);
  },

  offer(ctx, content) {
    const { frame, colors, product } = ctx;
    const o = content.overlay;
    const landscape = frame.shape === 'landscape';
    const cardW = landscape ? frame.inner * 0.62 : frame.inner;
    const pad = Math.round(frame.u * 5);
    const fine = 'Applied automatically when paid service starts. Standard pricing after the introductory year.';
    const card = h('div', { flexDirection: 'column', gap: Math.round(frame.u * 2), backgroundColor: colors.primary, borderRadius: Math.round(frame.u * 3), padding: pad, width: cardW, boxSizing: 'border-box' },
      text(ctx, { role: 'offer name', value: (o.kicker || 'Founders Sale').toUpperCase(), size: Math.round(frame.u * 3), bold: true, color: colors.onPrimary, background: colors.primary, width: cardW - pad * 2, maxLines: 1, style: { letterSpacing: 1 } }),
      text(ctx, { role: 'offer', value: o.offerLine, size: fit(o.offerLine, { width: cardW - pad * 2, size: Math.round(frame.u * 9), min: Math.round(frame.u * 5), maxLines: 3 }), bold: true, color: colors.onPrimary, background: colors.primary, width: cardW - pad * 2, maxLines: 3, lineHeight: 1.05 }),
      text(ctx, { role: 'offer product', value: productNames[product] ?? 'CareMetric', size: Math.round(frame.u * 3.6), bold: true, color: colors.onPrimary, background: colors.primary, width: cardW - pad * 2, maxLines: 1 }),
      text(ctx, { role: 'fine print', value: fine, size: Math.round(frame.u * 2.5), color: colors.onPrimary, background: colors.primary, width: cardW - pad * 2, maxLines: 3, lineHeight: 1.3 }));
    return page(ctx, [
      brandMark(ctx),
      landscape ? h('div', { justifyContent: 'space-between', alignItems: 'center', width: frame.inner }, card,
        text(ctx, { role: 'headline', value: content.headline, size: fit(content.headline, { width: frame.inner * 0.33, size: Math.round(frame.u * 6), min: Math.round(frame.u * 3.5), maxLines: 4 }), bold: true, color: 'text', background: colors.background, width: frame.inner * 0.33, maxLines: 4 }))
        : h('div', { flexDirection: 'column', gap: Math.round(frame.u * 3) },
          text(ctx, { role: 'headline', value: content.headline, size: fit(content.headline, { width: frame.inner, size: Math.round(frame.u * 6.5), min: Math.round(frame.u * 4), maxLines: 3 }), bold: true, color: 'text', background: colors.background, width: frame.inner, maxLines: 3 }), card),
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
    const rows = items.map(item => h('div', { alignItems: 'center', gap: Math.round(size * 0.7) },
      h('div', { width: tick, height: tick, borderRadius: tick, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
        h('div', { width: Math.round(tick * 0.28), height: Math.round(tick * 0.52), borderRight: `${Math.max(2, Math.round(tick * 0.12))}px solid ${colors.onPrimary}`, borderBottom: `${Math.max(2, Math.round(tick * 0.12))}px solid ${colors.onPrimary}`, transform: 'rotate(45deg)', marginTop: -Math.round(tick * 0.08) })),
      text(ctx, { role: 'checklist item', value: item, size, bold: true, color: 'text', background: colors.background, width: width - tick - size, maxLines: 2 })));
    const head = text(ctx, { role: 'headline', value: content.headline, size: fit(content.headline, { width: landscape ? frame.inner * 0.4 : frame.inner, size: Math.round(frame.u * 7), min: Math.round(frame.u * 4), maxLines: 3 }), bold: true, color: 'text', background: colors.background, width: landscape ? frame.inner * 0.4 : frame.inner, maxLines: 3, lineHeight: 1.08 });
    return page(ctx, [
      brandMark(ctx),
      landscape ? h('div', { justifyContent: 'space-between', alignItems: 'center', width: frame.inner }, head, h('div', { flexDirection: 'column', gap: Math.round(size * 0.8), width }, rows))
        : h('div', { flexDirection: 'column', gap: Math.round(frame.u * 3.5) }, head, h('div', { flexDirection: 'column', gap: Math.round(size * 0.8) }, rows)),
      footer(ctx, content),
    ]);
  },

  split(ctx, content) {
    const { frame, colors } = ctx;
    const left = Math.round(frame.width * 0.48);
    const innerLeft = left - frame.pad * 2;
    const right = frame.width - left - frame.pad * 2;
    const supporting = support(content);
    return h('div', { width: frame.width, height: frame.height },
      padded({ width: left, height: frame.height, left: frame.pad, background: colors.primary }, [
        brandMark(ctx, { onColor: colors.onPrimary }),
        text(ctx, { role: 'headline', value: content.headline, size: fit(content.headline, { width: innerLeft, size: Math.round(frame.u * 8.5), min: Math.round(frame.u * 4.5), maxLines: 4 }), bold: true, color: colors.onPrimary, background: colors.primary, width: innerLeft, maxLines: 4, lineHeight: 1.08 })]),
      padded({ width: frame.width - left, height: frame.height, left: frame.pad, background: colors.background }, [
        kicker(ctx, content.overlay?.kicker) ?? h('div', {}),
        supporting ? text(ctx, { role: 'support', value: supporting, size: fit(supporting, { width: right, size: Math.round(frame.u * 4.4), min: Math.round(frame.u * 3), maxLines: 5, bold: false }), color: 'text', background: colors.background, width: right, maxLines: 5, lineHeight: 1.3 }) : h('div', {}),
        cta(ctx, content.cta)]));
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
