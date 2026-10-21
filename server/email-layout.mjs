/* The one layout every Support Hub email is built with: one palette, one structure, an
   HTML part and a plain-text part that say the same thing. It follows the shared
   CareMetric email standard (the same structure, type and neutrals as the other
   CareMetric products; only the brand accent differs).

   Two layouts:
   - "branded": a product notification. Header band with the wordmark, heading,
     greeting, content blocks, sign-off and footer.
   - "personal": a person-to-person message, such as a support agent's reply. Same
     fonts and colors, no header band; the writer's words are shown exactly as
     written, followed by a signature and a short footer.

   Every interpolated value is escaped here. Only links the caller built itself may be
   passed as a button or link URL; message text is never turned into links. */

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
const font = `font-family:${fontStack};`;
const paragraphStyle = `margin:0 0 16px;${font}font-size:16px;line-height:24px;color:${palette.body};`;
const smallStyle = `margin:0 0 8px;${font}font-size:13px;line-height:20px;color:${palette.muted};`;
const linkStyle = `color:${palette.brand};text-decoration:underline;`;

const blocks = {
  paragraph: {
    html: ({ text }) => `<p style="${paragraphStyle}">${escapeHtml(text)}</p>`,
    text: ({ text }) => String(text),
  },
  /** Words a person wrote: shown exactly as written, paragraph by paragraph. */
  message: {
    html: ({ text }) => String(text).split(blankLine).map(part => `<p style="${paragraphStyle}">${part.split('\n').map(verbatimLine).join('<br>')}</p>`).join('\n'),
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
  details: {
    html: ({ rows }) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;background-color:${palette.panel};border:1px solid ${palette.hairline};border-radius:8px;border-collapse:separate;">
<tr><td style="padding:12px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows.map(([label, value]) => `<tr><td valign="top" style="padding:4px 12px 4px 0;width:40%;${font}font-size:14px;line-height:20px;color:${palette.muted};">${escapeHtml(label)}</td><td valign="top" style="padding:4px 0;${font}font-size:14px;line-height:20px;font-weight:600;color:${palette.heading};word-break:break-word;">${escapeHtml(value)}</td></tr>`).join('\n')}
</table></td></tr></table>`,
    text: ({ rows }) => rows.map(([label, value]) => `${label}: ${value}`).join('\n'),
  },
  callout: {
    html: ({ tone = 'info', title, text }) => {
      const colors = calloutTones[tone] ?? calloutTones.info;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:separate;">
<tr><td style="padding:12px 16px;background-color:${colors.fill};border:1px solid ${colors.border};border-left:4px solid ${colors.accent};border-radius:8px;${font}font-size:15px;line-height:22px;color:${colors.text};">${title ? `<strong>${escapeHtml(title)}</strong> ` : ''}${escapeHtml(text)}</td></tr></table>`;
    },
    text: ({ title, text }) => (title ? `${title} ${text}` : String(text)),
  },
};
function renderBlock(block, kind) {
  const renderer = blocks[block?.type];
  if (!renderer) throw new TypeError(`Unknown email block: ${block?.type}`);
  return renderer[kind](block);
}

/**
 * Builds one email. Returns { html, text }.
 * @param {object} email
 * @param {'branded'|'personal'} [email.layout] branded notification (default) or person-to-person message
 * @param {string} email.title the subject, used as the document title
 * @param {string} [email.preheader] one-sentence inbox preview (branded layout)
 * @param {string} [email.heading] the headline (branded layout)
 * @param {string|null} [email.recipientName] greets "Hi <name>," or "Hello," (branded layout)
 * @param {Array<object>} email.blocks paragraph | message | button | details | callout
 * @param {string[]} [email.signature] sign-off lines; the first is the signer
 * @param {string[]} email.footer why they received it, how to get help
 */
export function renderEmail({ layout = 'branded', title, preheader, heading, recipientName, blocks: content, signature = [`— The ${SUPPORT_TEAM_NAME} team`], footer }) {
  const branded = layout !== 'personal';
  const greeting = branded ? (recipientName && String(recipientName).trim() ? `Hi ${String(recipientName).trim()},` : 'Hello,') : null;
  const [signer, ...signatureDetails] = signature;

  const body = [
    branded && heading ? `<h1 style="margin:0 0 16px;${font}font-size:22px;line-height:30px;font-weight:700;color:${palette.heading};">${escapeHtml(heading)}</h1>` : '',
    greeting ? `<p style="${paragraphStyle}">${escapeHtml(greeting)}</p>` : '',
    ...content.map(block => renderBlock(block, 'html')),
    signer ? `<p style="margin:24px 0 0;${font}font-size:16px;line-height:24px;font-weight:600;color:${palette.heading};">${escapeHtml(signer)}</p>` : '',
    ...signatureDetails.map(line => `<p style="margin:0;${font}font-size:14px;line-height:20px;color:${palette.muted};">${escapeHtml(line)}</p>`),
  ].filter(Boolean).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
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
${branded && preheader ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${palette.canvas};">${escapeHtml(preheader)}</div>\n` : ''}<table role="presentation" ${LAYOUT_MARKER}="${branded ? 'branded' : 'personal'}" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.canvas}" style="background-color:${palette.canvas};">
<tr><td class="cm-canvas" align="center" style="padding:32px 16px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.card}" style="max-width:600px;background-color:${palette.card};border:1px solid ${palette.hairline};border-radius:12px;border-collapse:separate;">
${branded ? `<tr><td bgcolor="${palette.brand}" style="padding:20px 32px;background-color:${palette.brand};border-radius:11px 11px 0 0;${font}font-size:20px;line-height:28px;font-weight:700;color:${palette.onBrand};">${escapeHtml(PRODUCT_WORDMARK)}</td></tr>\n` : ''}<tr><td class="cm-body" style="padding:32px;${font}font-size:16px;line-height:24px;color:${palette.body};word-break:break-word;overflow-wrap:break-word;">
${body}
</td></tr>
<tr><td class="cm-footer" align="center" style="padding:20px 32px 24px;border-top:1px solid ${palette.hairline};">
${footer.map(line => `<p style="${smallStyle}text-align:center;">${escapeHtml(line)}</p>`).join('\n')}
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
    signature.length ? signature.join('\n') : null,
    footer.join('\n'),
  ].filter(part => part !== null && part !== '').join('\n\n');

  return { html, text };
}
