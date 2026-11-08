/* The one layout every Support Hub email is built with: one palette, one structure, an
   HTML part and a plain-text part that say the same thing. It follows the shared
   CareMetric email standard (the same structure, type and neutrals as the other
   CareMetric products; only the brand accent differs).

   Three layouts:
   - "branded": a product notification or customer email. Header band with the wordmark
     (the product's own name when the email is about one product), heading, greeting,
     content blocks, sign-off and footer.
   - "personal": a person-to-person message, such as a support agent's reply. Same
     fonts and colors, no header band; the writer's words are shown exactly as
     written, followed by a signature and a short footer.
   - "letter": a first message to someone who does not know CareMetric yet (a prospect).
     It looks like an email a person typed: white, left-aligned, no card, no band, no
     images, so it reads as a note and is not filed as a promotion. The signature carries
     the product and its website; the footer stays small.

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
/** Keeps a writer's line breaks, indentation and runs of spaces without changing their text. */
function verbatimLine(line) {
  return escapeHtml(line).replace(/\t/g, '    ').replace(/^ +/, spaces => '&nbsp;'.repeat(spaces.length)).replace(/ {2,}/g, spaces => ' ' + '&nbsp;'.repeat(spaces.length - 1));
}
const blankLine = /\n(?:[ \t]*\n)+/;
/** A verbatim line in which each exact address from `links` (https only, longest first) becomes a link; nothing else does. */
function linkedLine(line, links) {
  const html = verbatimLine(line);
  const allowed = [...new Set((Array.isArray(links) ? links : []).filter(url => typeof url === 'string' && /^https:\/\/[^\s"<>]+$/i.test(url)))].sort((a, b) => b.length - a.length);
  if (!allowed.length) return html;
  const pattern = new RegExp(`(${allowed.map(url => escapeHtml(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[\\s.,;:!?)])`, 'g');
  return html.replace(pattern, match => `<a href="${match}" target="_blank" style="color:${palette.brand};text-decoration:underline;">${match}</a>`);
}
const font = `font-family:${fontStack};`;
const paragraphStyle = `margin:0 0 16px;${font}font-size:16px;line-height:24px;color:${palette.body};`;
const smallStyle = `margin:0 0 8px;${font}font-size:13px;line-height:20px;color:${palette.muted};`;
const listText = items => (Array.isArray(items) ? items : []).map(item => String(item ?? '')).filter(item => item.trim());
const linkStyle = `color:${palette.brand};text-decoration:underline;`;
// Link a caller-supplied reference without accepting raw HTML from email copy.
function linkedText(text, link) {
  if (!link?.label) return escapeHtml(text);
  return String(text).split(link.label).map(escapeHtml).join(`<a href="${href(link.url)}" target="_blank" style="${linkStyle}">${escapeHtml(link.label)}</a>`);
}

const blocks = {
  paragraph: {
    html: ({ text, referenceLink }) => `<p style="${paragraphStyle}">${linkedText(text, referenceLink)}</p>`,
    text: ({ text }) => String(text),
  },
  /** Words a person wrote: shown exactly as written, paragraph by paragraph. `links`: exact addresses in it that may be links. */
  message: {
    html: ({ text, links }) => String(text).split(blankLine).map(part => `<p style="${paragraphStyle}">${part.split('\n').map(line => linkedLine(line, links)).join('<br>')}</p>`).join('\n'),
    text: ({ text }) => String(text),
  },
  button: {
    html: ({ label, url }) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px;">
<tr><td align="center" bgcolor="${palette.brand}" style="border-radius:8px;background-color:${palette.brand};">
<a href="${href(url)}" target="_blank" style="display:inline-block;padding:12px 24px;${font}font-size:16px;line-height:20px;font-weight:700;color:${palette.onBrand};text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
</td></tr></table>
<p style="${smallStyle}margin-bottom:16px;">If the button doesn't work, copy this link into your browser:<br><a href="${href(url)}" target="_blank" style="${linkStyle}word-break:break-all;">${escapeHtml(url)}</a></p>`,
    text: ({ label, url }) => `${label}:\n${url}`,
  },
  /** Numbered steps: a brand-colored number beside each step. */
  steps: {
    html: ({ items }) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
${listText(items).map((item, index) => `<tr><td valign="top" width="36" style="padding:0 12px 12px 0;width:36px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="28" height="28" bgcolor="${palette.brand}" style="width:28px;height:28px;border-radius:14px;background-color:${palette.brand};${font}font-size:14px;line-height:28px;font-weight:700;color:${palette.onBrand};">${index + 1}</td></tr></table></td><td valign="top" style="padding:3px 0 12px;${font}font-size:16px;line-height:24px;color:${palette.body};">${escapeHtml(item)}</td></tr>`).join('\n')}
</table>`,
    text: ({ items }) => listText(items).map((item, index) => `${index + 1}. ${item}`).join('\n'),
  },
  /** A short list of points, each with a check mark. */
  checklist: {
    html: ({ items }) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
${listText(items).map(item => `<tr><td valign="top" width="24" style="padding:0 10px 8px 0;width:24px;${font}font-size:16px;line-height:24px;font-weight:700;color:${palette.brand};">&#10003;</td><td valign="top" style="padding:0 0 8px;${font}font-size:16px;line-height:24px;color:${palette.body};">${escapeHtml(item)}</td></tr>`).join('\n')}
</table>`,
    text: ({ items }) => listText(items).map(item => `- ${item}`).join('\n'),
  },
  details: {
    html: ({ rows }) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;background-color:${palette.panel};border:1px solid ${palette.hairline};border-radius:8px;border-collapse:separate;">
<tr><td style="padding:12px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows.map(([label, value]) => `<tr><td valign="top" style="padding:4px 12px 4px 0;width:40%;${font}font-size:14px;line-height:20px;color:${palette.muted};">${escapeHtml(label)}</td><td valign="top" style="padding:4px 0;${font}font-size:14px;line-height:20px;font-weight:600;color:${palette.heading};word-break:break-word;">${escapeHtml(value)}</td></tr>`).join('\n')}
</table></td></tr></table>`,
    text: ({ rows }) => rows.map(([label, value]) => `${label}: ${value}`).join('\n'),
  },
  callout: {
    html: ({ tone = 'info', title, text, referenceLink }) => {
      const colors = calloutTones[tone] ?? calloutTones.info;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:separate;">
<tr><td style="padding:12px 16px;background-color:${colors.fill};border:1px solid ${colors.border};border-left:4px solid ${colors.accent};border-radius:8px;${font}font-size:15px;line-height:22px;color:${colors.text};">${title ? `<strong>${escapeHtml(title)}</strong> ` : ''}${linkedText(text, referenceLink)}</td></tr></table>`;
    },
    text: ({ title, text }) => (title ? `${title} ${text}` : String(text)),
  },
};
const footerHtml = line => (typeof line === 'string' ? escapeHtml(line) : `<a href="${href(line.url)}" target="_blank" style="${linkStyle}">${escapeHtml(line.label)}</a>`);
/** A signature line is text or a { label, url } link (a website). In plain text a link is its address. */
const signatureText = line => (typeof line === 'string' ? line : String(line?.url ?? ''));
const preheaderHtml = (preheader, background) => (preheader && String(preheader).trim()
  ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${background};">${escapeHtml(String(preheader).trim())}</div>\n` : '');
const headDocument = title => `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>`;

/** A letter: what a person would type in their email program, with a small footer. */
function renderLetter({ title, preheader, blocks: content, signature, footer }) {
  const letterFont = `font-family:${fontStack};font-size:15px;line-height:23px;color:#1F2937;`;
  const paragraphs = content.map(block => renderBlock(block, 'html')).join('\n')
    .replace(new RegExp(paragraphStyle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `margin:0 0 14px;${letterFont}`);
  const [signer, ...details] = signature;
  const html = `${headDocument(title)}
</head>
<body style="margin:0;padding:0;background-color:#FFFFFF;">
${preheaderHtml(preheader, '#FFFFFF')}<table role="presentation" ${LAYOUT_MARKER}="letter" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="background-color:#FFFFFF;">
<tr><td style="padding:24px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
<tr><td style="${letterFont}word-break:break-word;overflow-wrap:break-word;">
${paragraphs}
${signer ? `<p style="margin:18px 0 0;${letterFont}">${escapeHtml(signer)}</p>` : ''}
${details.map(line => `<p style="margin:0;font-family:${fontStack};font-size:14px;line-height:21px;color:${palette.muted};">${typeof line === 'string' ? escapeHtml(line) : `<a href="${href(line.url)}" target="_blank" style="color:${palette.brand};text-decoration:none;">${escapeHtml(line.label)}</a>`}</p>`).join('\n')}
<p style="margin:28px 0 0;padding-top:12px;border-top:1px solid ${palette.hairline};font-family:${fontStack};font-size:12px;line-height:18px;color:${palette.muted};">${footer.map(footerHtml).join('<br>')}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  const text = [
    ...content.map(block => renderBlock(block, 'text')),
    signature.length ? signature.map(signatureText).join('\n') : null,
    footer.map(line => (typeof line === 'string' ? line : `${line.label}: ${line.url}`)).join('\n'),
  ].filter(part => part !== null && part !== '').join('\n\n');
  return { html, text };
}
function renderBlock(block, kind) {
  const renderer = blocks[block?.type];
  if (!renderer) throw new TypeError(`Unknown email block: ${block?.type}`);
  return renderer[kind](block);
}

/**
 * Builds one email. Returns { html, text }.
 * @param {object} email
 * @param {'branded'|'personal'|'letter'} [email.layout] branded notification (default), person-to-person message, or a letter to a prospect
 * @param {string} email.title the subject, used as the document title
 * @param {string} [email.brand] the wordmark in the branded header: the product's name for an email about one product
 * @param {string} [email.preheader] one-sentence inbox preview (every layout)
 * @param {string} [email.heading] the headline (branded layout)
 * @param {string|null} [email.recipientName] greets "Hi <name>," or "Hello," (branded layout)
 * @param {Array<object>} email.blocks paragraph | message | steps | checklist | button | details | callout
 * @param {Array<string|{label: string, url: string}>} [email.signature] sign-off lines; the first is the signer, a { label, url } line a link
 * @param {Array<string|{label: string, url: string}>} email.footer why they received it, how to get help;
 *   a { label, url } line is a link (an unsubscribe link, say)
 */
export function renderEmail({ layout = 'branded', title, brand = PRODUCT_WORDMARK, preheader, heading, recipientName, blocks: content, signature = [`— The ${SUPPORT_TEAM_NAME} team`], footer, referenceLink = null }) {
  if (layout === 'letter') return renderLetter({ title, preheader, blocks: content, signature, footer });
  const branded = layout !== 'personal';
  const greeting = branded ? (recipientName && String(recipientName).trim() ? `Hi ${String(recipientName).trim()},` : 'Hello,') : null;
  const [signer, ...signatureDetails] = signature;

  const body = [
    branded && heading ? `<h1 style="margin:0 0 16px;${font}font-size:22px;line-height:30px;font-weight:700;color:${palette.heading};">${linkedText(heading, referenceLink)}</h1>` : '',
    greeting ? `<p style="${paragraphStyle}">${escapeHtml(greeting)}</p>` : '',
    ...content.map(block => renderBlock({ ...block, referenceLink }, 'html')),
    signer ? `<p style="margin:24px 0 0;${font}font-size:16px;line-height:24px;font-weight:600;color:${palette.heading};">${escapeHtml(signer)}</p>` : '',
    ...signatureDetails.map(line => `<p style="margin:0;${font}font-size:14px;line-height:20px;color:${palette.muted};">${typeof line === 'string' ? escapeHtml(line) : `<a href="${href(line.url)}" target="_blank" style="${linkStyle}">${escapeHtml(line.label)}</a>`}</p>`),
  ].filter(Boolean).join('\n');

  const html = `${headDocument(title)}
<style>
body { margin: 0; padding: 0; }
@media only screen and (max-width: 620px) {
  .cm-canvas { padding: 16px 8px !important; }
  .cm-body { padding: 24px !important; }
  .cm-footer { padding: 16px 24px 20px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:${palette.canvas};">
${preheaderHtml(preheader, palette.canvas)}<table role="presentation" ${LAYOUT_MARKER}="${branded ? 'branded' : 'personal'}" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.canvas}" style="background-color:${palette.canvas};">
<tr><td class="cm-canvas" align="center" style="padding:32px 16px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.card}" style="max-width:600px;background-color:${palette.card};border:1px solid ${palette.hairline};border-radius:12px;border-collapse:separate;">
${branded ? `<tr><td bgcolor="${palette.brand}" style="padding:20px 32px;background-color:${palette.brand};border-radius:11px 11px 0 0;${font}font-size:20px;line-height:28px;font-weight:700;color:${palette.onBrand};">${escapeHtml(brand || PRODUCT_WORDMARK)}</td></tr>\n` : ''}<tr><td class="cm-body" style="padding:32px;${font}font-size:16px;line-height:24px;color:${palette.body};word-break:break-word;overflow-wrap:break-word;">
${body}
</td></tr>
<tr><td class="cm-footer" align="center" style="padding:20px 32px 24px;border-top:1px solid ${palette.hairline};">
${footer.map(line => `<p style="${smallStyle}text-align:center;">${footerHtml(line)}</p>`).join('\n')}
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
    ...content.map(block => renderBlock(block, 'text')),
    signature.length ? signature.map(signatureText).join('\n') : null,
    footer.map(line => (typeof line === 'string' ? line : `${line.label}: ${line.url}`)).join('\n'),
  ].filter(part => part !== null && part !== '').join('\n\n');

  return { html, text };
}
