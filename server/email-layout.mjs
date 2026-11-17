/* The one layout every Support Hub email is built with: one structure, an HTML part and a
   plain-text part that say the same thing. It follows the shared CareMetric email
   standard (the same structure as the other CareMetric products), dressed in a theme:

   - "hub" (the default): the Support Hub's own look, for its notices and support replies,
     and for products without a theme of their own here.
   - "carebase": CareMetric CareBase's email standard, exactly as the CareBase app sends it
     (kdeyarmin/PennTrain supabase/functions/_shared/emailLayout.ts): a white header with the
     official CareBase logo over a 3px brand-blue rule, the app's primary blue (#2563EB) for
     buttons and links, the shared CareMetric neutrals, a plain sign-off and a footer with
     the help line and "CareMetric CareBase · cmcarebase.com". The help line names the one
     address every CareMetric email comes from and replies to (support@caremetric.ai), not the
     app's own hello@ line, so a customer has one address to write to.
   - "intel": CareMetric Intel's Emberline, exactly as the Intel app sends it
     (kdeyarmin/intel server/lib/emailLayout.ts): near-black canvas, dark card, the ember
     accent, the Geist type, a header with the Intel logo and its "Set your marketing on
     FIRE!" tagline over the fire image, pill buttons and dark callouts. An email about
     Intel looks like every other email its customers get from Intel.

   Three layouts:
   - "branded": a product notification or customer email. Header (the wordmark, or the
     theme's own header), heading, greeting, content blocks, sign-off and footer.
   - "personal": a person-to-person message, such as a support agent's reply. Same
     fonts and colors, no header; the writer's words are shown exactly as written,
     followed by a signature and a short footer.
   - "letter": a first message to someone who does not know CareMetric yet (a prospect).
     It reads like an email a person typed: left-aligned, no card, no header, no images,
     so it is read as a note and not filed as a promotion. In the Intel theme it is the
     Intel app's own person-to-person letter. The signature carries the product and its
     website; the footer stays small.

   Every layout can carry a preheader: the line an inbox shows beside the subject.

   Every interpolated value is escaped here. Only links the caller built itself may be
   passed as a button or link URL. Message text is turned into links only where it holds
   one of the exact addresses the caller lists for that block (a product's own pages). */

export const SUPPORT_TEAM_NAME = 'CareMetric Support';
export const SUPPORT_EMAIL = 'support@caremetric.ai';
export const SUPPORT_PHONE_DISPLAY = '(877) 521-2890';
export const PRODUCT_WORDMARK = 'CareMetric Support Hub';

/** Support Hub brand accent (the app's --brand) and the shared CareMetric neutrals. */
export const BRAND_ACCENT = '#264491';
export const BRAND_ACCENT_DARK = '#213A76';
export const BRAND_NAVY = '#15223F';
export const palette = Object.freeze({
  brand: BRAND_ACCENT,
  brandDark: BRAND_ACCENT_DARK,
  brandNavy: BRAND_NAVY,
  onBrand: '#FFFFFF',
  heading: '#0F172A',
  body: '#334155',
  muted: '#64748B',
  hairline: '#E2E8F0',
  panel: '#F8FAFC',
  canvas: '#F1F5F9',
  card: '#FFFFFF',
});
/** Callout tones: light fill, hairline border, 4px left accent, dark text. */
export const calloutTones = Object.freeze({
  info: Object.freeze({ fill: '#EFF6FF', border: '#BFDBFE', accent: BRAND_ACCENT, text: '#1E3A8A' }),
  success: Object.freeze({ fill: '#F0FDF4', border: '#BBF7D0', accent: '#16A34A', text: '#14532D' }),
  warning: Object.freeze({ fill: '#FFFBEB', border: '#FDE68A', accent: '#D97706', text: '#78350F' }),
  danger: Object.freeze({ fill: '#FEF2F2', border: '#FECACA', accent: '#DC2626', text: '#7F1D1D' }),
});
export const fontStack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
/* The footer sits at the bottom of the white card: muted text on white is 4.76:1, on the
   canvas it would be 4.34:1, below WCAG AA. */
/** Present on the outer table of every email built here; tests use it to prove an email uses this layout. */
export const LAYOUT_MARKER = 'data-caremetric-email';

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** Only absolute https (or mailto) links built by the caller; anything else is a programming error. */
function href(url) {
  const value = String(url ?? '');
  if (!/^(https:\/\/[^\s"<>]+|mailto:[^\s"<>]+)$/i.test(value)) throw new TypeError('Email links must be absolute https or mailto URLs.');
  return escapeHtml(value);
}

// ---- Themes ------------------------------------------------------------------------------------------------------------------------

/** CareMetric Intel's Emberline colors (kdeyarmin/intel src/lib/branding.ts, CAREMETRIC_COLORS), as its emails use them. */
// The www host: the bare domain answers with a redirect, which not every mail client's image proxy follows.
export const INTEL_SITE = 'https://www.caremetricintel.com';
export const INTEL_TAGLINE = 'Set your marketing on FIRE!';
export const intelPalette = Object.freeze({
  brand: '#ff7a45', brandDark: '#ff5a1f', onBrand: '#1a0700', heading: '#f4f4f6', body: '#b9bcc6', muted: '#8d919c',
  hairline: '#2b2d35', panel: '#191b21', canvas: '#07080a', card: '#101116',
});
/** CareMetric CareBase's email colors (kdeyarmin/PennTrain supabase/functions/_shared/emailLayout.ts, EMAIL_COLORS). */
export const CAREBASE_SITE = 'https://cmcarebase.com';
export const carebasePalette = Object.freeze({
  brand: '#2563EB', brandDark: '#1D4ED8', onBrand: '#FFFFFF', heading: '#0F172A', body: '#334155', muted: '#64748B',
  hairline: '#E2E8F0', panel: '#F8FAFC', canvas: '#F1F5F9', card: '#FFFFFF',
});
// The CareBase app's email header: its official logo lockup on white over the brand-blue rule. With images blocked, the alt text
// shows the product name in the heading style.
const carebaseHeader = ({ font, theme: { palette: p } }) => `<tr><td class="cm-header" bgcolor="${p.card}" style="background-color:${p.card};border-radius:11px 11px 0 0;border-bottom:3px solid ${p.brand};padding:20px 32px;"><img src="${CAREBASE_SITE}/brand/email-lockup-carebase.png" width="200" height="50" alt="CareMetric CareBase" style="display:block;width:200px;height:50px;border:0;outline:none;text-decoration:none;${font}font-size:20px;line-height:28px;font-weight:700;color:${p.heading};"></td></tr>
`;
const hubHeader = ({ brand, font, theme }) => `<tr><td bgcolor="${theme.palette.brand}" style="padding:20px 32px;background-color:${theme.palette.brand};border-radius:11px 11px 0 0;${font}font-size:20px;line-height:28px;font-weight:700;color:${theme.palette.onBrand};">${escapeHtml(brand || PRODUCT_WORDMARK)}</td></tr>\n`;
// The Intel app's header: its reverse logo, the product name and tagline, then a still of the Emberline fire.
const intelHeader = ({ font, theme: { palette: p } }) => `<tr><td class="cm-header" bgcolor="${p.canvas}" style="${font}background-color:${p.canvas};border-radius:21px 21px 0 0;padding:28px 32px;color:${p.heading};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="100" valign="middle"><img src="${INTEL_SITE}/brand/caremetric-logo-reverse.png" alt="CareMetric Intel" width="76" height="63" style="display:block;width:76px;height:auto;border:0;"></td><td valign="middle" style="${font}text-align:left;"><p style="margin:0 0 8px;font-size:11px;line-height:16px;letter-spacing:1.5px;color:${p.body};">CAREMETRIC INTEL</p><p class="cm-email-tagline" style="margin:0;font-size:25px;line-height:32px;font-weight:600;color:${p.heading};">${escapeHtml(INTEL_TAGLINE)}</p></td></tr></table>
</td></tr>
<tr class="cm-fire"><td bgcolor="${p.canvas}" style="padding:0;background-color:${p.canvas};border-bottom:1px solid ${p.brandDark};"><img src="${INTEL_SITE}/brand/emberline-fire.png" alt="" role="presentation" width="600" height="100" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
`;

export const emailThemes = Object.freeze({
  hub: Object.freeze({
    key: 'hub', palette, callouts: calloutTones, fontStack, colorScheme: 'light', cardRadius: 12,
    button: Object.freeze({ fill: palette.brand, text: palette.onBrand, weight: 700, radius: 8 }),
    linkAttributes: '', header: hubHeader, signerStrong: true, footerAfter: Object.freeze([]),
    letter: Object.freeze({ background: '#FFFFFF', text: '#1F2937', fontSize: 15, lineHeight: 23 }),
  }),
  carebase: Object.freeze({
    key: 'carebase', palette: carebasePalette, colorScheme: 'light', cardRadius: 12,
    callouts: Object.freeze({
      info: Object.freeze({ fill: '#EFF6FF', border: '#BFDBFE', accent: carebasePalette.brand, text: '#1E3A8A' }),
      success: Object.freeze({ fill: '#F0FDF4', border: '#BBF7D0', accent: '#16A34A', text: '#14532D' }),
      warning: Object.freeze({ fill: '#FFFBEB', border: '#FDE68A', accent: '#D97706', text: '#78350F' }),
      danger: Object.freeze({ fill: '#FEF2F2', border: '#FECACA', accent: '#DC2626', text: '#7F1D1D' }),
    }),
    fontStack,
    button: Object.freeze({ fill: carebasePalette.brand, text: carebasePalette.onBrand, weight: 700, radius: 8 }),
    linkAttributes: '', header: carebaseHeader, signerStrong: false,
    footerAfter: Object.freeze([`Need help? Email ${SUPPORT_EMAIL}.`, 'CareMetric CareBase · cmcarebase.com']),
    letter: Object.freeze({ background: '#FFFFFF', text: carebasePalette.heading, fontSize: 15, lineHeight: 23 }),
  }),
  intel: Object.freeze({
    key: 'intel', palette: intelPalette, colorScheme: 'dark', cardRadius: 22,
    callouts: Object.freeze({
      info: Object.freeze({ fill: '#2a1913', border: '#743b28', accent: intelPalette.brand, text: '#ffd0b3' }),
      success: Object.freeze({ fill: '#10251b', border: '#28533b', accent: '#4ade80', text: '#a7f3c4' }),
      warning: Object.freeze({ fill: '#2c2110', border: '#6b4b1c', accent: '#fbbf24', text: '#fde68a' }),
      danger: Object.freeze({ fill: '#2c1619', border: '#75343b', accent: '#f87171', text: '#fecaca' }),
    }),
    fontStack: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    // White pill buttons on the dark card, as in the app.
    button: Object.freeze({ fill: intelPalette.heading, text: intelPalette.canvas, weight: 600, radius: 999 }),
    // SendGrid never rewrites a link in an Intel email, as in the app.
    linkAttributes: ' clicktracking="off" rel="noopener"', header: intelHeader, signerStrong: false,
    footerAfter: Object.freeze([`Questions? Email ${SUPPORT_EMAIL}.`, INTEL_TAGLINE, 'CareMetric Intel · caremetricintel.com']),
    letter: Object.freeze({ background: intelPalette.card, text: intelPalette.body, fontSize: 16, lineHeight: 24 }),
  }),
});
/** The theme of the app a product's customers use: Intel's Emberline, CareBase's look, or the Hub's own for anything else. */
export const themeFor = product => (product === 'caremetric-intel' || product === 'intel' ? 'intel' : product === 'carebase' ? 'carebase' : 'hub');

/** The styles one email is built with, from its theme. */
function stylesFor(themeKey) {
  const theme = emailThemes[themeKey] ?? emailThemes.hub;
  const p = theme.palette;
  const font = `font-family:${theme.fontStack};`;
  return {
    theme, p, font,
    paragraph: `margin:0 0 16px;${font}font-size:16px;line-height:24px;color:${p.body};`,
    small: `margin:0 0 8px;${font}font-size:13px;line-height:20px;color:${p.muted};`,
    link: `color:${p.brand};text-decoration:underline;`,
    anchor: (url, label, style) => `<a href="${href(url)}" target="_blank"${theme.linkAttributes} style="${style}">${escapeHtml(label)}</a>`,
  };
}

// ---- Blocks ------------------------------------------------------------------------------------------------------------------------

/** Keeps a writer's line breaks, indentation and runs of spaces without changing their text. */
function verbatimLine(line) {
  return escapeHtml(line).replace(/\t/g, '    ').replace(/^ +/, spaces => '&nbsp;'.repeat(spaces.length)).replace(/ {2,}/g, spaces => ' ' + '&nbsp;'.repeat(spaces.length - 1));
}
const blankLine = /\n(?:[ \t]*\n)+/;
/** A verbatim line in which each exact address from `links` (https only, longest first) becomes a link; nothing else does. */
function linkedLine(line, links, s) {
  const html = verbatimLine(line);
  const allowed = [...new Set((Array.isArray(links) ? links : []).filter(url => typeof url === 'string' && /^https:\/\/[^\s"<>]+$/i.test(url)))].sort((a, b) => b.length - a.length);
  if (!allowed.length) return html;
  const pattern = new RegExp(`(${allowed.map(url => escapeHtml(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[\\s.,;:!?)])`, 'g');
  return html.replace(pattern, match => `<a href="${match}" target="_blank"${s.theme.linkAttributes} style="${s.link}">${match}</a>`);
}
/**
 * A line that is exactly one of the allowed addresses, shown as the label the caller gave for it ("Open your agency's market report
 * (PDF)"), or null when it has none. Only the HTML part: the plain-text part keeps the address.
 */
function labelledLine(line, links, labels, s) {
  const url = String(line).trim();
  const label = labels && typeof labels === 'object' && Object.hasOwn(labels, url) ? labels[url] : null;
  if (typeof label !== 'string' || !label.trim() || !Array.isArray(links) || !links.includes(url) || !/^https:\/\/[^\s"<>]+$/i.test(url)) return null;
  return s.anchor(url, label.trim(), `${s.link}font-weight:600;`);
}
const listText = items => (Array.isArray(items) ? items : []).map(item => String(item ?? '')).filter(item => item.trim());
// Link a caller-supplied reference without accepting raw HTML from email copy.
function linkedText(text, link, s) {
  if (!link?.label) return escapeHtml(text);
  return String(text).split(link.label).map(escapeHtml).join(s.anchor(link.url, link.label, s.link));
}

const blocks = {
  paragraph: {
    html: ({ text, referenceLink }, s) => `<p style="${s.paragraph}">${linkedText(text, referenceLink, s)}</p>`,
    text: ({ text }) => String(text),
  },
  /**
   * Words a person wrote: shown exactly as written, paragraph by paragraph. `links`: exact addresses in it that may be links.
   * `labels`: what a link on a line of its own is called instead of its address ({ address: label }), in the HTML part only.
   */
  message: {
    html: ({ text, links, labels }, s) => String(text).split(blankLine).map(part => `<p style="${s.paragraph}">${part.split('\n').map(line => labelledLine(line, links, labels, s) ?? linkedLine(line, links, s)).join('<br>')}</p>`).join('\n'),
    text: ({ text }) => String(text),
  },
  button: {
    html: ({ label, url }, s) => {
      const b = s.theme.button;
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px;">
<tr><td align="center" bgcolor="${b.fill}" style="border-radius:${b.radius}px;background-color:${b.fill};">
${s.anchor(url, label, `display:inline-block;padding:12px 24px;${s.font}font-size:16px;line-height:20px;font-weight:${b.weight};color:${b.text};text-decoration:none;border-radius:${b.radius}px;`)}
</td></tr></table>
<p style="${s.small}margin-bottom:16px;">If the button doesn't work, copy this link into your browser:<br>${s.anchor(url, url, `${s.link}word-break:break-all;`)}</p>`;
    },
    text: ({ label, url }) => `${label}:\n${url}`,
  },
  /** Numbered steps: a number in the accent color beside each step. */
  steps: {
    html: ({ items }, s) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
${listText(items).map((item, index) => `<tr><td valign="top" width="36" style="padding:0 12px 12px 0;width:36px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="28" height="28" bgcolor="${s.p.brand}" style="width:28px;height:28px;border-radius:14px;background-color:${s.p.brand};${s.font}font-size:14px;line-height:28px;font-weight:700;color:${s.p.onBrand};">${index + 1}</td></tr></table></td><td valign="top" style="padding:3px 0 12px;${s.font}font-size:16px;line-height:24px;color:${s.p.body};">${escapeHtml(item)}</td></tr>`).join('\n')}
</table>`,
    text: ({ items }) => listText(items).map((item, index) => `${index + 1}. ${item}`).join('\n'),
  },
  /** A short list of points, each with a check mark. */
  checklist: {
    html: ({ items }, s) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
${listText(items).map(item => `<tr><td valign="top" width="24" style="padding:0 10px 8px 0;width:24px;${s.font}font-size:16px;line-height:24px;font-weight:700;color:${s.p.brand};">&#10003;</td><td valign="top" style="padding:0 0 8px;${s.font}font-size:16px;line-height:24px;color:${s.p.body};">${escapeHtml(item)}</td></tr>`).join('\n')}
</table>`,
    text: ({ items }) => listText(items).map(item => `- ${item}`).join('\n'),
  },
  details: {
    html: ({ rows }, s) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;background-color:${s.p.panel};border:1px solid ${s.p.hairline};border-radius:8px;border-collapse:separate;">
<tr><td style="padding:12px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows.map(([label, value]) => `<tr><td valign="top" style="padding:4px 12px 4px 0;width:40%;${s.font}font-size:14px;line-height:20px;color:${s.p.muted};">${escapeHtml(label)}</td><td valign="top" style="padding:4px 0;${s.font}font-size:14px;line-height:20px;font-weight:600;color:${s.p.heading};word-break:break-word;">${escapeHtml(value)}</td></tr>`).join('\n')}
</table></td></tr></table>`,
    text: ({ rows }) => rows.map(([label, value]) => `${label}: ${value}`).join('\n'),
  },
  callout: {
    html: ({ tone = 'info', title, text, referenceLink }, s) => {
      const colors = s.theme.callouts[tone] ?? s.theme.callouts.info;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:separate;">
<tr><td bgcolor="${colors.fill}" style="padding:12px 16px;background-color:${colors.fill};border:1px solid ${colors.border};border-left:4px solid ${colors.accent};border-radius:8px;${s.font}font-size:15px;line-height:22px;color:${colors.text};">${title ? `<strong>${escapeHtml(title)}</strong> ` : ''}${linkedText(text, referenceLink, s)}</td></tr></table>`;
    },
    text: ({ title, text }) => (title ? `${title} ${text}` : String(text)),
  },
};
// ---- Marketing blocks ---------------------------------------------------------------------------------------------------------------
// The sections of a marketing email to a prospect (growth/campaign.mjs; email review 2026-11-17: a plain letter read as something to
// throw away). Built from the theme's own colors, so they follow the product's look. Every value is escaped here.
const eyebrowStyle = s => `margin:0 0 8px;${s.font}font-size:12px;line-height:16px;letter-spacing:1.6px;font-weight:700;color:${s.p.brand};`;
const titleStyle = s => `margin:0 0 16px;${s.font}font-size:22px;line-height:29px;font-weight:800;color:${s.p.heading};`;
/** A pill button in the theme's accent, with no copy-this-link fallback under it: a marketing link is long, and the text part carries it. */
const accentButton = (label, url, s, quiet = false) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 6px;">
<tr><td align="center" bgcolor="${quiet ? s.p.heading : s.p.brandDark}" style="border-radius:999px;background-color:${quiet ? s.p.heading : s.p.brandDark};">
${s.anchor(url, `${label} \u2192`, `display:inline-block;padding:15px 28px;${s.font}font-size:17px;line-height:20px;font-weight:700;color:${quiet ? s.p.canvas : s.p.onBrand};text-decoration:none;border-radius:999px;`)}
</td></tr></table>`;
const sectionRule = s => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px;"><tr><td style="border-top:1px solid ${s.p.hairline};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
const marketingBlocks = {
  /** One primary action in the accent color, with a short note under it. */
  action: {
    html: ({ label, url, note, quiet }, s) => `${accentButton(label, url, s, quiet === true)}${note ? `\n<p style="${s.small}margin-bottom:18px;">${escapeHtml(note)}</p>` : ''}`,
    text: ({ label, url }) => `${label}:\n${url}`,
  },
  /** A preview card: what a report holds, as tiles whose values the reader opens the report to see. */
  tiles: {
    html: ({ eyebrow, title, subtitle, items, value }, s) => {
      const cells = listOf(items).map(label => `<td width="50%" valign="top" style="padding:5px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${s.p.card};border:1px solid ${s.p.hairline};border-radius:10px;border-collapse:separate;"><tr><td style="padding:11px 12px 10px;">
<p style="margin:0 0 4px;${s.font}font-size:11px;line-height:15px;letter-spacing:0.8px;font-weight:700;color:${s.p.muted};">${escapeHtml(label)}</p>
<p style="margin:0;${s.font}font-size:17px;line-height:22px;font-weight:700;color:${s.p.brand};">${escapeHtml(value)}</p></td></tr></table></td>`);
      const rows = [];
      for (let i = 0; i < cells.length; i += 2) rows.push(`<tr>${cells[i]}${cells[i + 1] ?? '<td width="50%"></td>'}</tr>`);
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;background-color:${s.p.panel};border:1px solid ${s.p.hairline};border-top:3px solid ${s.p.brandDark};border-radius:12px;border-collapse:separate;"><tr><td style="padding:16px 13px 11px;">
${eyebrow ? `<p style="margin:0 5px 2px;${s.font}font-size:11px;line-height:15px;letter-spacing:1.4px;font-weight:700;color:${s.p.brand};">${escapeHtml(eyebrow)}</p>` : ''}
<p style="margin:0 5px 10px;${s.font}font-size:19px;line-height:25px;font-weight:700;color:${s.p.heading};">${escapeHtml(title)}${subtitle ? `<br><span style="font-size:14px;font-weight:500;color:${s.p.body};">${escapeHtml(subtitle)}</span>` : ''}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('\n')}</table></td></tr></table>`;
    },
    text: ({ title, items }) => `${title}: ${listOf(items).join(', ')}`,
  },
  /** What the product does: numbered points, each a bold title and a line under it, under a section heading. */
  features: {
    html: ({ eyebrow, title, items }, s) => `${sectionRule(s)}${eyebrow ? `<p style="${eyebrowStyle(s)}">${escapeHtml(eyebrow)}</p>` : ''}<h2 style="${titleStyle(s)}">${escapeHtml(title)}</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px;">
${pairsOf(items).map(([name, words], index) => `<tr><td valign="top" width="44" style="padding:0 0 18px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="32" height="32" bgcolor="${s.p.brandDark}" style="width:32px;height:32px;border-radius:16px;background-color:${s.p.brandDark};${s.font}font-size:15px;line-height:32px;font-weight:800;color:${s.p.onBrand};">${index + 1}</td></tr></table></td>
<td valign="top" style="padding:0 0 18px;"><p style="margin:0 0 3px;${s.font}font-size:17px;line-height:24px;font-weight:700;color:${s.p.heading};">${escapeHtml(name)}</p><p style="margin:0;${s.font}font-size:15px;line-height:23px;color:${s.p.body};">${escapeHtml(words)}</p></td></tr>`).join('\n')}
</table>`,
    text: ({ title, items }) => [title, ...pairsOf(items).map(([name, words], index) => `${index + 1}. ${name}\n${words}`)].join('\n\n'),
  },
  /** Labeled cards, one per step ("Monday", "Every day"), under a section heading. */
  cards: {
    html: ({ title, items }, s) => `<h2 style="${titleStyle(s)}">${escapeHtml(title)}</h2>
${listOf(items).map(item => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;background-color:${s.p.panel};border:1px solid ${s.p.hairline};border-left:3px solid ${s.p.brandDark};border-radius:10px;border-collapse:separate;"><tr><td style="padding:14px 16px 13px;">
<p style="margin:0 0 4px;${s.font}font-size:11px;line-height:15px;letter-spacing:1.3px;font-weight:700;color:${s.p.brand};">${escapeHtml(String(item?.tag ?? '').toUpperCase())}</p>
<p style="margin:0 0 3px;${s.font}font-size:17px;line-height:24px;font-weight:700;color:${s.p.heading};">${escapeHtml(item?.title)}</p>
<p style="margin:0;${s.font}font-size:15px;line-height:23px;color:${s.p.body};">${escapeHtml(item?.text)}</p></td></tr></table>`).join('\n')}`,
    text: ({ title, items }) => [title, ...listOf(items).map(item => `${item?.tag}: ${item?.title}\n${item?.text}`)].join('\n\n'),
  },
  /** A row of figures: a large value over a small label, two to a row. */
  stats: {
    html: ({ items }, s) => {
      const cells = pairsOf(items).map(([value, label]) => `<td width="50%" valign="top" style="padding:10px 6px;"><p style="margin:0;${s.font}font-size:24px;line-height:28px;font-weight:800;color:${s.p.heading};">${escapeHtml(value)}</p><p style="margin:2px 0 0;${s.font}font-size:13px;line-height:18px;color:${s.p.muted};">${escapeHtml(label)}</p></td>`);
      const rows = [];
      for (let i = 0; i < cells.length; i += 2) rows.push(`<tr>${cells[i]}${cells[i + 1] ?? '<td width="50%"></td>'}</tr>`);
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;background-color:${s.p.canvas};border:1px solid ${s.p.hairline};border-radius:12px;border-collapse:separate;"><tr><td style="padding:8px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('\n')}</table></td></tr></table>`;
    },
    text: ({ items }) => pairsOf(items).map(([value, label]) => `${value} ${label}`).join('. '),
  },
  /** Someone's own words, with their name and role under them. */
  quote: {
    html: ({ text, name, role }, s) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;"><tr><td style="border-left:3px solid ${s.p.brandDark};padding:2px 0 2px 16px;">
<p style="margin:0 0 10px;${s.font}font-size:17px;line-height:27px;font-style:italic;color:${s.p.heading};">&ldquo;${escapeHtml(text)}&rdquo;</p>
${name ? `<p style="margin:0;${s.font}font-size:15px;line-height:22px;font-weight:700;color:${s.p.heading};">${escapeHtml(name)}</p>` : ''}${role ? `<p style="margin:0;${s.font}font-size:14px;line-height:21px;color:${s.p.muted};">${escapeHtml(role)}</p>` : ''}</td></tr></table>`,
    text: ({ text }) => `"${text}"`,
  },
  /** A current offer, in the theme's highlighted callout. */
  offer: {
    html: ({ eyebrow, title, text }, s) => {
      const colors = s.theme.callouts.info;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;background-color:${colors.fill};border:1px solid ${colors.border};border-radius:14px;border-collapse:separate;"><tr><td style="padding:20px 20px 18px;">
${eyebrow ? `<p style="${eyebrowStyle(s)}margin-bottom:6px;">${escapeHtml(eyebrow)}</p>` : ''}<p style="margin:0 0 8px;${s.font}font-size:24px;line-height:30px;font-weight:800;color:${s.p.heading};">${escapeHtml(title)}</p>
<p style="margin:0;${s.font}font-size:15px;line-height:23px;color:${colors.text};">${escapeHtml(text)}</p></td></tr></table>`;
    },
    text: ({ title, text }) => `${title}\n${text}`,
  },
  /** The closing panel: a heading, a sentence, one button, and an optional second link and note under it. */
  panel: {
    html: ({ title, text, button, link, note }, s) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;background-color:${s.p.panel};border:1px solid ${s.p.brandDark};border-radius:14px;border-collapse:separate;"><tr><td style="padding:22px 20px 20px;">
<h2 style="margin:0 0 8px;${s.font}font-size:22px;line-height:29px;font-weight:800;color:${s.p.heading};">${escapeHtml(title)}</h2>
<p style="margin:0 0 16px;${s.font}font-size:16px;line-height:25px;color:${s.p.body};">${escapeHtml(text)}</p>
${button ? accentButton(button.label, button.url, s, button.quiet === true) : ''}
${link ? `<p style="margin:12px 0 0;${s.font}font-size:15px;line-height:22px;color:${s.p.body};">${link.lead ? `${escapeHtml(link.lead)} ` : ''}${s.anchor(link.url, link.label, `color:${s.p.brand};font-weight:700;text-decoration:underline;`)}</p>` : ''}
${note ? `<p style="margin:10px 0 0;${s.font}font-size:14px;line-height:21px;color:${s.p.muted};">${escapeHtml(note)}</p>` : ''}</td></tr></table>`,
    text: ({ title, text, button }) => `${title}\n${text}${button ? `\n${button.url}` : ''}`,
  },
  /** Short points with a check mark, each with a bold lead, under a small heading, then an optional linked line. */
  points: {
    html: ({ title, items, link }, s) => `${sectionRule(s)}${title ? `<p style="margin:0 0 12px;${s.font}font-size:12px;line-height:16px;letter-spacing:1.6px;font-weight:700;color:${s.p.muted};">${escapeHtml(String(title).toUpperCase())}</p>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px;">
${pairsOf(items).map(([lead, words]) => `<tr><td valign="top" width="26" style="padding:0 8px 12px 0;${s.font}font-size:16px;line-height:23px;font-weight:700;color:${s.p.brand};">&#10003;</td><td valign="top" style="padding:0 0 12px;${s.font}font-size:15px;line-height:23px;color:${s.p.body};"><strong style="color:${s.p.heading};">${escapeHtml(lead)}</strong> ${escapeHtml(words)}</td></tr>`).join('\n')}
</table>${link ? `\n<p style="margin:4px 0 18px;${s.font}font-size:16px;line-height:25px;color:${s.p.body};">${link.lead ? `${escapeHtml(link.lead)} ` : ''}${s.anchor(link.url, link.label, `color:${s.p.brand};font-weight:700;text-decoration:underline;`)}</p>` : ''}`,
    text: ({ title, items }) => [title, ...pairsOf(items).map(([lead, words]) => `- ${lead} ${words}`)].filter(Boolean).join('\n'),
  },
};
const listOf = items => (Array.isArray(items) ? items : []);
const pairsOf = items => listOf(items).filter(item => Array.isArray(item) && item.length >= 2).map(item => [String(item[0] ?? ''), String(item[1] ?? '')]);
Object.assign(blocks, marketingBlocks);

function renderBlock(block, kind, s) {
  const renderer = blocks[block?.type];
  if (!renderer) throw new TypeError(`Unknown email block: ${block?.type}`);
  return renderer[kind](block, s);
}
const footerHtml = (line, s) => (typeof line === 'string' ? escapeHtml(line) : s.anchor(line.url, line.label, s.link));
const footerText = line => (typeof line === 'string' ? line : `${line.label}: ${line.url}`);
/** A signature line is text or a { label, url } link (a website). In plain text a link is its address. */
const signatureText = line => (typeof line === 'string' ? line : String(line?.url ?? ''));
const preheaderHtml = (preheader, background) => (preheader && String(preheader).trim()
  ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${background};">${escapeHtml(String(preheader).trim())}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>\n` : '');
const headDocument = (title, s) => `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="${s.theme.colorScheme}">
<meta name="supported-color-schemes" content="${s.theme.colorScheme}">
<title>${escapeHtml(title)}</title>`;

// ---- Layouts -----------------------------------------------------------------------------------------------------------------------

/** A letter: what a person would type in their email program, with a small footer. */
function renderLetter({ title, preheader, blocks: content, signature, footer, s }) {
  const l = s.theme.letter;
  const letterFont = `${s.font}font-size:${l.fontSize}px;line-height:${l.lineHeight}px;color:${l.text};`;
  const letter = { ...s, paragraph: `margin:0 0 14px;${letterFont}` };
  const [signer, ...details] = signature;
  const html = `${headDocument(title, s)}
</head>
<body bgcolor="${l.background}" style="margin:0;padding:0;background-color:${l.background};">
${preheaderHtml(preheader, l.background)}<table role="presentation" ${LAYOUT_MARKER}="letter" data-theme="${s.theme.key}" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${l.background}" style="background-color:${l.background};">
<tr><td style="padding:24px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
<tr><td style="${letterFont}word-break:break-word;overflow-wrap:break-word;">
${content.map(block => renderBlock(block, 'html', letter)).join('\n')}
${signer ? `<p style="margin:18px 0 0;${letterFont}">${escapeHtml(signer)}</p>` : ''}
${details.map(line => `<p style="margin:0;${s.font}font-size:14px;line-height:21px;color:${s.p.muted};">${typeof line === 'string' ? escapeHtml(line) : s.anchor(line.url, line.label, `color:${s.p.brand};text-decoration:none;`)}</p>`).join('\n')}
<p style="margin:28px 0 0;padding-top:12px;border-top:1px solid ${s.p.hairline};${s.font}font-size:12px;line-height:18px;color:${s.p.muted};">${footer.map(line => footerHtml(line, s)).join('<br>')}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  const text = [
    ...content.map(block => renderBlock(block, 'text', letter)),
    signature.length ? signature.map(signatureText).join('\n') : null,
    footer.map(footerText).join('\n'),
  ].filter(part => part !== null && part !== '').join('\n\n');
  return { html, text };
}

/**
 * Builds one email. Returns { html, text }.
 * @param {object} email
 * @param {'branded'|'personal'|'letter'} [email.layout] branded notification (default), person-to-person message, or a letter to a prospect
 * @param {'hub'|'intel'} [email.theme] the look: the Hub's own (default) or a product app's (see themeFor)
 * @param {string} email.title the subject, used as the document title
 * @param {string} [email.brand] the wordmark in the Hub theme's branded header: the product's name for an email about one product
 * @param {string} [email.preheader] one-sentence inbox preview (every layout)
 * @param {string} [email.eyebrow] a short line above the headline, shown in capitals (branded layout; a marketing email)
 * @param {string} [email.heading] the headline (branded layout)
 * @param {string} [email.greeting] the whole greeting line, in place of "Hi <name>," (branded layout)
 * @param {string|null} [email.recipientName] greets "Hi <name>," or "Hello," (branded layout)
 * @param {Array<object>} email.blocks paragraph | message | steps | checklist | button | details | callout, and for a marketing
 *   email: action | tiles | features | cards | stats | quote | offer | panel | points
 * @param {Array<string|{label: string, url: string}>} [email.signature] sign-off lines; the first is the signer, a { label, url } line a link
 * @param {Array<string|{label: string, url: string}>} email.footer why they received it, how to get help;
 *   a { label, url } line is a link (an unsubscribe link, say). A theme may add its own lines after them.
 */
export function renderEmail({ layout = 'branded', theme = 'hub', title, brand = PRODUCT_WORDMARK, preheader, eyebrow = null, heading, recipientName, greeting: greetingLine = null, blocks: content, signature = [`— The ${SUPPORT_TEAM_NAME} team`], footer: callerFooter, referenceLink = null }) {
  const s = stylesFor(theme);
  // A theme's own lines follow the caller's footer; with no footer (the approved wording alone) there are none.
  const footer = callerFooter.length ? [...callerFooter, ...s.theme.footerAfter.filter(line => !callerFooter.includes(line))] : [];
  if (layout === 'letter') return renderLetter({ title, preheader, blocks: content, signature, footer: callerFooter, s });
  const branded = layout !== 'personal';
  // `greeting` gives the whole line when the caller has its own ("Hello Jane,", as a letter to a prospect opens).
  const greeting = branded ? (greetingLine && String(greetingLine).trim() ? String(greetingLine).trim() : recipientName && String(recipientName).trim() ? `Hi ${String(recipientName).trim()},` : 'Hello,') : null;
  const [signer, ...signatureDetails] = signature;
  const { p, font } = s;

  const body = [
    branded && eyebrow ? `<p style="${eyebrowStyle(s)}">${escapeHtml(String(eyebrow).toUpperCase())}</p>` : '',
    branded && heading ? `<h1 style="margin:0 0 16px;font-family:${s.theme.headingFontStack ?? s.theme.fontStack};font-size:${s.theme.headingFontStack ? '26px;line-height:32px;font-weight:600' : '22px;line-height:30px;font-weight:700'};color:${p.heading};">${linkedText(heading, referenceLink, s)}</h1>` : '',
    greeting ? `<p style="${s.paragraph}">${escapeHtml(greeting)}</p>` : '',
    ...content.map(block => renderBlock({ ...block, referenceLink }, 'html', s)),
    signer ? `<p style="margin:24px 0 0;${font}font-size:16px;line-height:24px;${s.theme.signerStrong ? `font-weight:600;color:${p.heading}` : `color:${p.body}`};">${escapeHtml(signer)}</p>` : '',
    ...signatureDetails.map(line => `<p style="margin:0;${font}font-size:14px;line-height:20px;color:${p.muted};">${typeof line === 'string' ? escapeHtml(line) : s.anchor(line.url, line.label, s.link)}</p>`),
  ].filter(Boolean).join('\n');

  const radius = s.theme.cardRadius;
  const html = `${headDocument(title, s)}
<style>
body { margin: 0; padding: 0; }
@media only screen and (max-width: 620px) {
  .cm-canvas { padding: 16px 8px !important; }
  .cm-header { padding: 18px 24px !important; }
  .cm-email-tagline { font-size: 21px !important; line-height: 28px !important; }
  .cm-body { padding: 24px !important; }
  .cm-footer { padding: 16px 24px 20px !important; }
}
</style>
</head>
<body bgcolor="${p.canvas}" style="margin:0;padding:0;background-color:${p.canvas};">
${preheaderHtml(preheader, p.canvas)}<table role="presentation" ${LAYOUT_MARKER}="${branded ? 'branded' : 'personal'}" data-theme="${s.theme.key}" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.canvas}" style="background-color:${p.canvas};">
<tr><td class="cm-canvas" align="center" style="padding:32px 16px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.card}" style="max-width:600px;background-color:${p.card};border:1px solid ${p.hairline};border-radius:${radius}px;border-collapse:separate;">
${branded ? s.theme.header({ brand, font, theme: s.theme }) : ''}<tr><td class="cm-body" bgcolor="${p.card}" style="padding:32px;background-color:${p.card};${font}font-size:16px;line-height:24px;color:${p.body};word-break:break-word;overflow-wrap:break-word;">
${body}
</td></tr>
<tr><td class="cm-footer" align="center" style="padding:20px 32px 24px;border-top:1px solid ${p.hairline};">
${footer.map(line => `<p style="${s.small}text-align:center;">${footerHtml(line, s)}</p>`).join('\n')}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;

  const text = [
    branded && heading ? heading : null,
    greeting,
    ...content.map(block => renderBlock(block, 'text', s)),
    signature.length ? signature.map(signatureText).join('\n') : null,
    footer.map(footerText).join('\n'),
  ].filter(part => part !== null && part !== '').join('\n\n');

  return { html, text };
}
