import { describe, expect, it } from 'vitest';
import { LAYOUT_MARKER, PRODUCT_WORDMARK, calloutTones, escapeHtml, palette, renderEmail } from './email-layout.mjs';
import { htmlToText, replySubject, supportReplyEmail } from './communications.mjs';
import { bulkEmailHtml, composeBulkEmail } from './bulk-email.mjs';
import { lifecycleInput, renderLifecycleEmail } from './agents/accounts/lifecycle.mjs';

const hostile = '<script>alert(1)</script>';
const allowedColors = new Set([...Object.values(palette), ...Object.values(calloutTones).flatMap(tone => Object.values(tone))].map(color => color.toUpperCase()));

/** Every email the Hub sends, plus the branded layout every future notification will use. */
const emails = {
  'support reply': () => supportReplyEmail({ subject: `Login help ${hostile}`, reference: 1042, body: `Hi ${hostile},\n\nWe reset your access.\n\nThanks,\nSam` }),
  'bulk announcement': () => {
    const message = { subject: `Maintenance ${hostile}`, body: `Hello ${hostile},\n\nWe will be down Saturday.`, applications: `PennSync ${hostile}`, unsubscribeUrl: `https://hub.example/api/email/unsubscribe/${'a'.repeat(64)}`, postalAddress: `1 Main St ${hostile}` };
    return { html: bulkEmailHtml(message), text: composeBulkEmail(message) };
  },
  'customer check-in email': () => renderLifecycleEmail(
    lifecycleInput({ tenant: 'maple-grove', tenantName: `Maple ${hostile}`, product: 'carebase', productName: 'CareMetric CareBase' }, 'welcome', { bookingUrl: 'https://cal.example.com/owner' }),
    { unsubscribeUrl: `https://hub.example/api/email/unsubscribe/${'a'.repeat(64)}`, postalAddress: `1 Main St ${hostile}` }),
  'branded notification layout': () => renderEmail({
    title: `Update for ${hostile}`, preheader: `A summary for ${hostile}.`, heading: `Your request ${hostile}`, recipientName: hostile,
    blocks: [
      { type: 'paragraph', text: `Paragraph ${hostile}` },
      { type: 'button', label: `Open ${hostile}`, url: 'https://hub.example.com/requests?id=1&view=full' },
      { type: 'details', rows: [['Organization', hostile], ['Reference', 'CM-1042']] },
      ...Object.keys(calloutTones).map(tone => ({ type: 'callout', tone, title: `${tone}:`, text: hostile })),
    ],
    footer: [`You're receiving this because ${hostile}.`],
  }),
};

describe('every outgoing email uses the shared layout', () => {
  for (const [name, build] of Object.entries(emails)) {
    describe(name, () => {
      const email = build();
      it('is built by the shared layout with the email document essentials', () => {
        expect(email.html).toContain(`${LAYOUT_MARKER}=`);
        expect(email.html).toMatch(/^<!DOCTYPE html>\n<html lang="en"/);
        expect(email.html).toContain('<meta charset="utf-8">');
        expect(email.html).toContain('<meta name="color-scheme" content="light">');
        expect(email.html).toContain('role="presentation"');
      });
      it('escapes every interpolated value', () => {
        expect(email.html).not.toContain(hostile);
        expect(email.html).not.toMatch(/<script/i);
        expect(email.html).toContain(escapeHtml(hostile));
      });
      it('ships a plain-text part that says the same thing', () => {
        expect(email.text.trim().length).toBeGreaterThan(0);
        expect(email.text).not.toMatch(/<\/?(p|div|table|tr|td|a|h1|br|strong)\b|style="/i);
        expect(email.text).toContain(hostile);
      });
      it('uses only the shared palette', () => {
        const colors = email.html.match(/#[0-9A-Fa-f]{6}\b/g) ?? [];
        expect(colors.length).toBeGreaterThan(0);
        expect(colors.filter(color => !allowedColors.has(color.toUpperCase()))).toEqual([]);
      });
    });
  }
});

describe('layout behavior', () => {
  it('greets by name only when one is known', () => {
    const base = { title: 't', heading: 'h', blocks: [], footer: ['f'] };
    expect(renderEmail({ ...base, recipientName: 'Jordan' }).text).toContain('Hi Jordan,');
    for (const recipientName of [null, undefined, '', '  ']) expect(renderEmail({ ...base, recipientName }).text).toContain('Hello,');
    expect(renderEmail({ ...base, recipientName: null }).text).not.toMatch(/Hi (undefined|null|,)/);
  });
  it('puts the branded header, preheader and a bulletproof button with a link fallback in notifications', () => {
    const email = emails['branded notification layout']();
    expect(email.html).toContain(`>${PRODUCT_WORDMARK}</td>`);
    expect(email.html).toContain('display:none');
    expect(email.html).toContain('href="https://hub.example.com/requests?id=1&amp;view=full"');
    expect(email.html).toContain("If the button doesn't work, copy this link into your browser:");
    expect(email.text).toContain('\nhttps://hub.example.com/requests?id=1&view=full');
  });
  it('accepts only absolute https or mailto links', () => {
    for (const url of ['javascript:alert(1)', 'http://hub.example.com', '/relative', 'https://hub.example.com/"onmouseover="x']) {
      expect(() => renderEmail({ title: 't', blocks: [{ type: 'button', label: 'Go', url }], footer: [] }), url).toThrow(TypeError);
    }
  });
  it('links a footer line given as { label, url }, and writes it out in the text part', () => {
    const email = renderEmail({ layout: 'personal', title: 't', blocks: [], signature: [], footer: ['Why.', { label: 'Unsubscribe', url: 'https://hub.example/u?a=1&b=2' }] });
    expect(email.html).toContain('<a href="https://hub.example/u?a=1&amp;b=2" target="_blank"');
    expect(email.html).toContain('>Unsubscribe</a>');
    expect(email.text.endsWith('Why.\nUnsubscribe: https://hub.example/u?a=1&b=2')).toBe(true);
    expect(() => renderEmail({ title: 't', blocks: [], footer: [{ label: 'x', url: 'javascript:alert(1)' }] })).toThrow(TypeError);
  });
  it('refuses unknown blocks instead of dropping content', () => {
    expect(() => renderEmail({ title: 't', blocks: [{ type: 'raw', html: '<b>x</b>' }], footer: [] })).toThrow(TypeError);
  });
});

describe('product emails', () => {
  it('puts the product\'s own name in the branded header, and numbered steps and check marks in both parts', () => {
    const email = renderEmail({ title: 'Welcome', brand: 'CareMetric Intel', heading: 'Welcome', preheader: 'Your first steps.', blocks: [
      { type: 'steps', items: ['Name your agency.', 'Pick your counties.', ' '] },
      { type: 'checklist', items: ['Only with your permission', 'Only in the form you approve'] },
    ], footer: ['Footer'] });
    expect(email.html).toContain('>CareMetric Intel</td></tr>');
    expect(email.html).not.toContain(PRODUCT_WORDMARK);
    expect(email.html).toMatch(/>1<\/td><\/tr><\/table><\/td><td [^>]+>Name your agency\.<\/td>/);
    expect(email.html).toContain('&#10003;');
    expect(email.text).toContain('1. Name your agency.\n2. Pick your counties.');
    expect(email.text).not.toContain('3.');
    expect(email.text).toContain('- Only with your permission\n- Only in the form you approve');
  });

  it('writes a letter to a prospect: white, no card or header, with a preview, a sign-off with the website and a small footer', () => {
    const email = renderEmail({ layout: 'letter', title: 'Physician outreach', preheader: 'A question about your outreach.',
      blocks: [{ type: 'message', text: 'Hello,\n\nTry it here:\nhttps://www.caremetricintel.com/', links: ['https://www.caremetricintel.com/'] }],
      signature: ['The CareMetric Intel team', { label: 'caremetricintel.com', url: 'https://www.caremetricintel.com' }],
      footer: ['CareMetric', { label: 'Unsubscribe', url: 'https://hub.example.org/u/t' }] });
    expect(email.html).toContain(`${LAYOUT_MARKER}="letter"`);
    expect(email.html).not.toContain(PRODUCT_WORDMARK);
    expect(email.html).not.toContain(palette.canvas);
    expect(email.html).toContain('A question about your outreach.</div>');
    expect(email.html).toContain('<a href="https://www.caremetricintel.com/" target="_blank"');
    expect(email.html).toContain('>caremetricintel.com</a>');
    expect(email.text).toBe('Hello,\n\nTry it here:\nhttps://www.caremetricintel.com/\n\nThe CareMetric Intel team\nhttps://www.caremetricintel.com\n\nCareMetric\nUnsubscribe: https://hub.example.org/u/t');
  });

  it('turns only the exact approved addresses in a message into links, never other text or a longer address', () => {
    const html = renderEmail({ layout: 'personal', title: 'T', signature: [], footer: [], blocks: [{ type: 'message',
      text: 'See https://www.caremetricintel.com/Help or https://www.caremetricintel.com/ and https://evil.example/ and https://www.caremetricintel.com/Helpx', links: ['https://www.caremetricintel.com/', 'https://www.caremetricintel.com/Help', 'javascript:alert(1)'] }] }).html;
    expect(html.match(/<a href="([^"]+)"/g)).toEqual(['<a href="https://www.caremetricintel.com/Help"', '<a href="https://www.caremetricintel.com/"']);
    expect(html).toContain('https://evil.example/ and https://www.caremetricintel.com/Helpx');
    expect(renderEmail({ layout: 'personal', title: 'T', signature: [], footer: [], blocks: [{ type: 'message', text: 'https://www.caremetricintel.com/' }] }).html).not.toContain('<a href');
  });
});

describe('support reply email', () => {
  const body = 'Hi Jordan,\n\nWe reissued the certificate.\n  1. Sign out\n  2. Sign in\n\nThanks,\nSam';
  const reply = supportReplyEmail({ subject: 'RE: Course certificate missing [CM-1001]', reference: 1042, body });
  it('keeps the subject and its machine-read reference exactly as replySubject builds it', () => {
    expect(reply.subject).toBe(replySubject('RE: Course certificate missing [CM-1001]', 1042));
    expect(reply.subject).toBe('Re: Course certificate missing [CM-1042]');
  });
  it('is a person-to-person message: no product header, the agent words untouched, then the signature', () => {
    expect(reply.html).toContain(`${LAYOUT_MARKER}="personal"`);
    expect(reply.html).not.toContain(PRODUCT_WORDMARK);
    expect(reply.text.startsWith(`${body}\n\n— CareMetric Support\nReference CM-1042\n\n`)).toBe(true);
    expect(reply.text).toContain('Reply to this email to continue the conversation');
    expect(reply.html).toContain('Hi Jordan,</p>');
    expect(reply.html).toContain('We reissued the certificate.<br>&nbsp;&nbsp;1. Sign out<br>&nbsp;&nbsp;2. Sign in</p>');
    expect(reply.html).toContain('Reference CM-1042');
    expect(reply.html).not.toMatch(/<a\s/i);
  });
  it('reads back cleanly when the customer replies from an HTML-only mail client that quotes it', () => {
    const inner = /<body[^>]*>([\s\S]*)<\/body>/.exec(reply.html)[1];
    const gmailStyle = `<div dir="ltr">Got it, thanks!</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Tue, Oct 20, 2026 at 9:00 AM CareMetric Support &lt;support@caremetric.ai&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${inner}</blockquote></div>`;
    // Some clients quote the whole original document, head and conditional comments included.
    for (const quoted of [gmailStyle, `<html><body><p>Got it, thanks!</p><blockquote>${reply.html}</blockquote></body></html>`]) {
      const text = htmlToText(quoted);
      expect(text.startsWith('Got it, thanks!')).toBe(true);
      for (const line of ['Hi Jordan,', 'We reissued the certificate.', '1. Sign out', '— CareMetric Support', 'Reference CM-1042']) expect(text).toContain(line);
      expect(text).not.toMatch(/<\/?(p|div|table|tr|td|br|a|html|head|body|meta|style|title|blockquote)\b|&[a-z#0-9]+;|font-family|@media|\[if mso\]|Course certificate missing/i);
    }
  });
});
