import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_IMAGE_ORIGIN, LAYOUT_MARKER, PRODUCT_WORDMARK, calloutTones, emailImagePaths, emailThemes, escapeHtml, intelPalette, palette, renderEmail, themeFor,
} from './email-layout.mjs';
import { htmlToText, replySubject, supportReplyEmail } from './communications.mjs';
import { bulkEmailHtml, composeBulkEmail } from './bulk-email.mjs';
import { lifecycleInput, renderLifecycleEmail } from './agents/accounts/lifecycle.mjs';

const hostile = '<script>alert(1)</script>';
/** The colors an email in a theme may use: its palette, callouts, letter and button colors. */
const themeColors = key => {
  const theme = emailThemes[key] ?? emailThemes.hub;
  return new Set([...Object.values(theme.palette), ...Object.values(theme.callouts).flatMap(tone => Object.values(tone)), theme.letter.background, theme.letter.text, theme.button.fill, theme.button.text]
    .map(color => color.toUpperCase()));
};

/** One of every marketing block, each value carrying `value`. */
const marketingSections = value => [
  { type: 'message', text: `Opening ${value}` },
  { type: 'tiles', eyebrow: `REPORT ${value}`, title: `Your report ${value}`, subtitle: `From data ${value}`, items: [`ONE ${value}`, 'TWO', 'THREE'], value: `inside ${value}` },
  { type: 'action', label: `Open ${value}`, url: 'https://intel.example.com/report/abc?a=1&b=2', note: `Opens ${value}` },
  { type: 'features', eyebrow: `WHAT ${value}`, title: `What it does ${value}`, items: [[`Finds ${value}`, `Every source ${value}`], ['Plans', 'Each week']] },
  { type: 'stats', items: [[`150+ ${value}`, `datasets ${value}`], ['Daily', 'checks'], ['3,200+', 'counties']] },
  { type: 'quote', text: `I built it ${value}`, name: `Dr. ${value}`, role: `Founder ${value}` },
  { type: 'cards', title: `A week ${value}`, items: [{ tag: `Monday ${value}`, title: `Pick ${value}`, text: `Who to see ${value}` }] },
  { type: 'offer', eyebrow: `SALE ${value}`, title: `Half off ${value}`, text: `For a year ${value}` },
  { type: 'panel', title: `Try it ${value}`, text: `Free ${value}`, button: { label: `Start ${value}`, url: 'https://intel.example.com/?utm_source=a&utm_medium=b', quiet: true },
    link: { lead: `Still here ${value}:`, label: `Open ${value}`, url: 'https://intel.example.com/report/abc' }, note: `Reply ${value}` },
  { type: 'points', title: `In short ${value}`, items: [[`Finds ${value}`, `sources ${value}`]], link: { lead: `When ready ${value}:`, label: `start ${value}`, url: 'https://intel.example.com/' } },
];

/** Every email the Hub sends, plus the branded layout every future notification will use. */
const emails = {
  'support reply': () => supportReplyEmail({ subject: `Login help ${hostile}`, reference: 1042, body: `Hi ${hostile},\n\nWe reset your access.\n\nThanks,\nSam` }),
  'bulk announcement': () => {
    const message = { subject: `Maintenance ${hostile}`, body: `Hello ${hostile},\n\nWe will be down Saturday.`, applications: `PennSync ${hostile}`, unsubscribeUrl: `https://hub.example/api/email/unsubscribe/${'a'.repeat(64)}`, postalAddress: `1 Main St ${hostile}` };
    return { html: bulkEmailHtml(message), text: composeBulkEmail(message) };
  },
  'customer check-in email': () => renderLifecycleEmail(
    lifecycleInput({ tenant: 'maple-grove', tenantName: `Maple ${hostile}`, product: 'carebase', productName: 'CareMetric CareBase' }, 'welcome'),
    { unsubscribeUrl: `https://hub.example/api/email/unsubscribe/${'a'.repeat(64)}`, postalAddress: `1 Main St ${hostile}` }),
  'Intel customer email': () => renderLifecycleEmail(
    lifecycleInput({ tenant: 'riverbend', tenantName: `Riverbend ${hostile}`, product: 'caremetric-intel', productName: 'CareMetric Intel' }, 'trial_checkin', {}),
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
  // The sections of a marketing email to an agency (growth/campaign.mjs), in each theme.
  ...Object.fromEntries(['intel', 'hub', 'carebase', 'breathe'].map(theme => [`marketing email layout (${theme})`, () => renderEmail({
    theme, title: `Report for ${hostile}`, preheader: `A report for ${hostile}.`, eyebrow: `Ready ${hostile}`, heading: `Your report ${hostile}`, greeting: `Hello ${hostile},`,
    blocks: marketingSections(hostile),
    signature: [`Founder ${hostile}`, 'CareMetric'], footer: [`1 Main St ${hostile}`],
  })])),
};

describe('every outgoing email uses the shared layout', () => {
  for (const [name, build] of Object.entries(emails)) {
    describe(name, () => {
      const email = build();
      it('is built by the shared layout with the email document essentials', () => {
        expect(email.html).toContain(`${LAYOUT_MARKER}=`);
        expect(email.html).toMatch(/^<!DOCTYPE html>\n<html lang="en"/);
        expect(email.html).toContain('<meta charset="utf-8">');
        expect(email.html).toMatch(/<meta name="color-scheme" content="(light|dark)">/);
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
      it('uses only its theme\'s palette', () => {
        const colors = email.html.match(/#[0-9A-Fa-f]{6}\b/g) ?? [];
        const allowed = themeColors(/data-theme="([a-z]+)"/.exec(email.html)?.[1]);
        expect(colors.length).toBeGreaterThan(0);
        expect(colors.filter(color => !allowed.has(color.toUpperCase()))).toEqual([]);
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

describe('marketing sections (email review 2026-11-17)', () => {
  const render = (blocks, over = {}) => renderEmail({ theme: 'intel', title: 'Your market report', heading: 'Your market report', blocks, signature: [], footer: ['CareMetric'], ...over });
  it('puts a short line in capitals above the headline, and opens with the caller\'s own greeting', () => {
    const email = render([{ type: 'message', text: 'Opening.' }], { eyebrow: 'Your free market report is ready', greeting: 'Hello Jane,' });
    expect(email.html).toMatch(/>YOUR FREE MARKET REPORT IS READY<\/p>\n<h1 [^>]*>Your market report<\/h1>\n<p [^>]*>Hello Jane,<\/p>/);
    expect(email.text.startsWith('Your market report\n\nHello Jane,\n\nOpening.')).toBe(true);
    // Without them an email is as before: no line above the headline, and the usual greeting.
    const plain = render([{ type: 'message', text: 'Opening.' }]);
    expect(plain.html).not.toContain('letter-spacing:1.6px');
    expect(plain.html).toContain('>Hello,</p>');
    // A personal email has no headline, so no line above it.
    expect(render([], { layout: 'personal', eyebrow: 'Above' }).html).not.toContain('ABOVE');
  });
  it('lays out a report card, one accent button, numbered points, figures, a signed quote, step cards, an offer and a closing panel', () => {
    const email = render(marketingSections('x'));
    // A button is one link in the accent color, with no "copy this link" line under it: a marketing link is long.
    expect(email.html).toContain('<a href="https://intel.example.com/report/abc?a=1&amp;b=2" target="_blank"');
    expect(email.html).toContain('>Open x \u2192</a>');
    expect(email.html).not.toMatch(/copy|paste/i);
    expect(email.html).toContain(`bgcolor="${intelPalette.brandDark}"`);
    // The closing panel's quiet button is light on the dark card, so the report's button stays the one accent above it.
    expect(email.html).toContain(`bgcolor="${intelPalette.heading}"`);
    expect(email.html).toContain('&ldquo;I built it x&rdquo;');
    expect(email.html).toContain('>MONDAY X</p>');
    expect(email.html).toContain('>IN SHORT X</p>');
    expect(email.html).toMatch(/>1<\/td>[\s\S]*>2<\/td>/);
    // The text part says the same thing, in order, with each link written out.
    for (const part of ['Your report x: ONE x, TWO, THREE', 'Open x:\nhttps://intel.example.com/report/abc?a=1&b=2', 'What it does x\n\n1. Finds x\nEvery source x\n\n2. Plans\nEach week',
      '150+ x datasets x. Daily checks. 3,200+ counties', '"I built it x"', 'A week x\n\nMonday x: Pick x\nWho to see x', 'Half off x\nFor a year x',
      'Try it x\nFree x\nhttps://intel.example.com/?utm_source=a&utm_medium=b', 'In short x\n- Finds x sources x']) expect(email.text, part).toContain(part);
  });
  it('accepts only absolute https links in a button, a panel and a linked line', () => {
    for (const url of ['javascript:alert(1)', 'http://intel.example.com', '/relative', 'https://intel.example.com/"onmouseover="x']) {
      expect(() => render([{ type: 'action', label: 'Go', url }]), url).toThrow(TypeError);
      expect(() => render([{ type: 'panel', title: 't', text: 'x', button: { label: 'Go', url } }]), url).toThrow(TypeError);
      expect(() => render([{ type: 'panel', title: 't', text: 'x', link: { label: 'Go', url } }]), url).toThrow(TypeError);
      expect(() => render([{ type: 'points', items: [['a', 'b']], link: { label: 'Go', url } }]), url).toThrow(TypeError);
    }
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
    expect(email.html).toContain('>A question about your outreach.&#847;');
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

describe('product themes', () => {
  const footer = ['You\'re getting this email because Riverbend Home Health has a CareMetric Intel account.', { label: 'Unsubscribe', url: 'https://hub.example.org/u/t' }];
  it('dresses an Intel email in Emberline, as the Intel app sends it: header, fire, dark card, pill button, its footer lines', () => {
    const email = renderEmail({ theme: 'intel', title: 'Welcome', heading: 'Welcome to CareMetric Intel', preheader: 'Your first steps.',
      blocks: [{ type: 'button', label: 'Open the Help page', url: 'https://www.caremetricintel.com/Help' }, { type: 'callout', tone: 'success', text: 'Founders Sale.' }],
      signature: ['The CareMetric Intel team'], footer });
    expect(email.html).toContain('data-theme="intel"');
    expect(email.html).toContain('<meta name="color-scheme" content="dark">');
    expect(email.html).toContain('<img src="https://help.caremetric.ai/email/intel-logo-reverse.png" alt="CareMetric Intel"');
    expect(email.html).toContain('<img src="https://help.caremetric.ai/email/intel-emberline-fire.png" alt=""');
    expect(email.html).toContain('>Set your marketing on FIRE!</p>');
    expect(email.html).toContain(`background-color:${intelPalette.canvas};`);
    expect(email.html).toContain(`background-color:${intelPalette.card};`);
    expect(email.html).toContain(`border-radius:999px;background-color:${intelPalette.heading};`);
    expect(email.html).toContain(`background-color:${emailThemes.intel.callouts.success.fill};`);
    expect(email.html).toContain("font-family:'Geist',");
    expect(email.html).toContain('clicktracking="off"');
    expect(email.html).not.toContain(PRODUCT_WORDMARK);
    expect(email.html).not.toContain(palette.brand);
    expect(email.text.endsWith('Unsubscribe: https://hub.example.org/u/t\nQuestions? Email support@caremetric.ai.\nSet your marketing on FIRE!\nCareMetric Intel · caremetricintel.com')).toBe(true);
  });

  it('writes an Intel letter as the Intel app\'s own letter: dark, no header, the ember accent on its links', () => {
    const email = renderEmail({ layout: 'letter', theme: 'intel', title: 'T', blocks: [{ type: 'message', text: 'Hello,\n\nhttps://www.caremetricintel.com/', links: ['https://www.caremetricintel.com/'] }],
      signature: ['The CareMetric Intel team', { label: 'caremetricintel.com', url: 'https://www.caremetricintel.com' }], footer });
    expect(email.html).toContain(`${LAYOUT_MARKER}="letter" data-theme="intel"`);
    expect(email.html).toContain(`<body bgcolor="${intelPalette.card}"`);
    expect(email.html).toContain(`color:${intelPalette.body};`);
    expect(email.html).toContain(`color:${intelPalette.brand};text-decoration:underline;">https://www.caremetricintel.com/</a>`);
    expect(email.html).not.toContain('emberline-fire.png');
    expect(email.text).not.toContain('Set your marketing on FIRE!');
  });

  it('keeps the Hub\'s own look by default and for every product without a theme here', () => {
    expect(themeFor('caremetric-intel')).toBe('intel');
    expect(themeFor('intel')).toBe('intel');
    expect(themeFor('carebase')).toBe('carebase');
    expect(themeFor('breathe')).toBe('breathe');
    for (const product of ['advisors', null, undefined]) expect(themeFor(product)).toBe('hub');
    const email = renderEmail({ title: 'T', heading: 'H', blocks: [], footer: ['F'] });
    expect(email.html).toContain('data-theme="hub"');
    expect(email.html).toContain(`>${PRODUCT_WORDMARK}</td></tr>`);
    expect(email.html).toContain('<meta name="color-scheme" content="light">');
    expect(email.html).not.toContain('clicktracking');
    expect(renderEmail({ theme: 'nonsense', title: 'T', blocks: [], footer: [] }).html).toContain('data-theme="hub"');
  });
});

describe('email images', () => {
  it('come only from the Hub\'s own address on the sending domain, and each one is a PNG the Hub serves', async () => {
    expect(EMAIL_IMAGE_ORIGIN).toBe('https://help.caremetric.ai');
    for (const theme of Object.keys(emailThemes)) {
      const { html } = renderEmail({ theme, title: 'T', heading: 'H', blocks: [], footer: ['F'] });
      for (const [, src] of html.matchAll(/<img src="([^"]+)"/g)) expect(src, theme).toMatch(/^https:\/\/help\.caremetric\.ai\/email\/[a-z-]+\.png$/);
    }
    for (const path of Object.values(emailImagePaths)) {
      const file = await readFile(new URL(`../public${path}`, import.meta.url));
      expect(file.subarray(0, 8).toString('hex'), path).toBe('89504e470d0a1a0a');
    }
  });
});

describe('the CareBase theme', () => {
  it('dresses a CareBase email as the CareBase app sends it: its logo on white over the blue rule, its blue, its footer', () => {
    const email = renderEmail({ theme: 'carebase', title: 'Welcome', heading: 'Welcome to CareMetric CareBase', preheader: 'First steps.',
      blocks: [{ type: 'button', label: 'Open the help center', url: 'https://cmcarebase.com/app/help' }, { type: 'steps', items: ['Add your facility.'] }],
      signature: ['The CareMetric CareBase team'], footer: ['Reason.'] });
    expect(email.html).toContain('data-theme="carebase"');
    expect(email.html).toContain('<img src="https://help.caremetric.ai/email/carebase-lockup.png" width="200" height="50" alt="CareMetric CareBase"');
    expect(email.html).toContain('border-bottom:3px solid #2563EB;');
    expect(email.html).toContain('border-radius:8px;background-color:#2563EB;');
    expect(email.html).toContain('background-color:#F1F5F9;');
    expect(email.html).not.toContain(PRODUCT_WORDMARK);
    expect(email.text.endsWith('Reason.\nNeed help? Email support@caremetric.ai.\nCareMetric CareBase · cmcarebase.com')).toBe(true);
  });
});

describe('the Breathe theme', () => {
  it('dresses a Breathe email as the Breathe app sends it: the navy band and wordmark, the accent rule, its blue, its footer', () => {
    const email = renderEmail({ theme: 'breathe', title: 'Welcome', heading: 'Welcome to CareMetric Breathe', preheader: 'First steps.',
      blocks: [{ type: 'button', label: 'Create your account', url: 'https://cmbreathe.com/breathe/signup' }],
      signature: ['The CareMetric Breathe team'], footer: ['Reason.'] });
    expect(email.html).toContain('data-theme="breathe"');
    expect(email.html).toContain('linear-gradient(135deg,#0b1426 0%,#11203c 100%)');
    expect(email.html).toContain('>CareMetric Breathe</td>');
    expect(email.html).toContain('linear-gradient(90deg,#54c8ff 0%,#2f6fe6 50%,#f6a722 100%)');
    expect(email.html).toContain('border-radius:8px;background-color:#2f6fe6;');
    expect(email.html).not.toContain(PRODUCT_WORDMARK);
    expect(email.text.endsWith('Reason.\nNeed help? Email support@caremetric.ai.\nCareMetric Breathe · cmbreathe.com')).toBe(true);
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
