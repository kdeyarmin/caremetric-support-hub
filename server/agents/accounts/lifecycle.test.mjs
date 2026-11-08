import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LAYOUT_MARKER, escapeHtml } from '../../email-layout.mjs';
import {
  bookingLink, dueTemplates, foundersWords, httpsOrigin, lifecycleEmail, lifecycleInput, lifecyclePreview, lifecycleProducts, lifecycleReadiness, lifecycleTemplates,
  lifecycleWording, parseLifecycleInput, periodKey, planEmails, renderLifecycleEmail, stillApplies, unsubscribeLabel, wordingHash,
} from './lifecycle.mjs';

const now = new Date('2026-11-03T13:20:00Z');
const day = 86_400_000;
const ago = days => new Date(now.getTime() - days * day).toISOString();
const ahead = days => new Date(now.getTime() + days * day).toISOString();
const emails = (over = {}) => ({ welcome: null, setup_nudge: null, trial_checkin: null, testimonial_ask: null, ...over });
const trial = (over = {}) => ({
  tenant: 'maple-grove', tenantName: 'Maple Grove Senior Living', product: 'carebase', productName: 'CareMetric CareBase', status: 'trialing',
  trialStart: ago(1), trialEnd: ahead(29), created: ago(1), firstPaidAt: null, cancelling: false, hasEmail: true, suppressed: false, hasUsage: false,
  openUrgentCases: 0, emails: emails(), ...over,
});
const paying = (over = {}) => trial({ status: 'active', trialStart: ago(80), trialEnd: ago(50), created: ago(80), firstPaidAt: ago(50), ...over });
const booking = 'https://cal.example.com/caremetric/setup';
const postal = 'CareMetric, 100 Example Street, Altoona, PA 16601';
const unsubscribeUrl = `https://hub.example.test/api/email/unsubscribe/${'b'.repeat(64)}`;
const products = { carebase: 'CareMetric CareBase', 'caremetric-intel': 'CareMetric Intel' };
const every = () => Object.entries(products).flatMap(([product, productName]) => lifecycleTemplates.flatMap(template =>
  [null, booking].map(link => ({ template, product, link, input: lifecycleInput(trial({ product, productName }), template, { bookingUrl: link }) }))));

describe('which email an account is due', () => {
  it('welcomes a trial on days 0 to 2, offers setup help on days 3 to 6 only while no usage was reported, and checks in when 3 to 5 days are left', () => {
    const due = over => dueTemplates(trial(over), now);
    expect(due({ trialStart: ago(0) })).toEqual(['welcome']);
    expect(due({ trialStart: ago(2.9) })).toEqual(['welcome']);
    expect(due({ trialStart: ago(3) })).toEqual(['setup_nudge']);
    expect(due({ trialStart: ago(6.9) })).toEqual(['setup_nudge']);
    expect(due({ trialStart: ago(3), hasUsage: true })).toEqual([]);
    expect(due({ trialStart: ago(7) })).toEqual([]);
    expect(due({ trialStart: ago(-1) })).toEqual([], 'a trial that has not started yet is not welcomed');
    expect(due({ trialStart: ago(20), trialEnd: ahead(5) })).toEqual(['trial_checkin']);
    expect(due({ trialStart: ago(20), trialEnd: ahead(2.5) })).toEqual(['trial_checkin']);
    expect(due({ trialStart: ago(20), trialEnd: ahead(5.5) })).toEqual([]);
    expect(due({ trialStart: ago(20), trialEnd: ahead(2) })).toEqual([], 'too late for a check-in: Stripe\'s own notice is about to arrive');
    expect(due({ trialStart: null, created: ago(1) })).toEqual(['welcome'], 'a trial with no start date counts from its subscription');
  });

  it('puts the most pressing email first when two are due together', () => {
    // A short trial: the second day is also five days before its end.
    expect(dueTemplates(trial({ trialStart: ago(2), trialEnd: ahead(5) }), now)).toEqual(['welcome', 'trial_checkin']);
    expect(dueTemplates(trial({ trialStart: ago(4), trialEnd: ahead(3) }), now)).toEqual(['trial_checkin', 'setup_nudge']);
  });

  it('asks a paying account for a testimonial 45 to 60 days after its first paid invoice, never with an open urgent case', () => {
    expect(dueTemplates(paying({ firstPaidAt: ago(45) }), now)).toEqual(['testimonial_ask']);
    expect(dueTemplates(paying({ firstPaidAt: ago(60.9) }), now)).toEqual(['testimonial_ask']);
    expect(dueTemplates(paying({ firstPaidAt: ago(44.9) }), now)).toEqual([]);
    expect(dueTemplates(paying({ firstPaidAt: ago(61) }), now)).toEqual([]);
    expect(dueTemplates(paying({ firstPaidAt: null }), now)).toEqual([], 'with no paid invoice there is no "paying for 45 days"');
    expect(dueTemplates(paying({ openUrgentCases: 1 }), now)).toEqual([]);
  });

  it('sends nothing to an account that is cancelling, past due, or on a product without customer emails', () => {
    expect(dueTemplates(trial({ cancelling: true }), now)).toEqual([]);
    expect(dueTemplates(paying({ cancelling: true }), now)).toEqual([]);
    for (const status of ['past_due', 'unpaid', 'paused', 'canceled', 'incomplete']) expect(dueTemplates(trial({ status }), now), status).toEqual([]);
    expect(dueTemplates(trial({ product: 'breathe' }), now)).toEqual([]);
    expect(dueTemplates(trial({ product: 'constructor' }), now)).toEqual([]);
    expect(dueTemplates(null, now)).toEqual([]);
  });
});

describe('whether an approved email still fits when it is sent', () => {
  it('keeps the trial emails for a trial and the testimonial for a paying account', () => {
    for (const template of ['welcome', 'setup_nudge', 'trial_checkin']) {
      expect(stillApplies(template, trial()), template).toBe(true);
      expect(stillApplies(template, paying()), template).toBe(false);
      expect(stillApplies(template, trial({ cancelling: true })), template).toBe(false);
      expect(stillApplies(template, null), template).toBe(false);
    }
    expect(stillApplies('setup_nudge', trial({ hasUsage: true }))).toBe(false);
    expect(stillApplies('welcome', trial({ hasUsage: true }))).toBe(true);
    expect(stillApplies('testimonial_ask', paying())).toBe(true);
    expect(stillApplies('testimonial_ask', paying({ openUrgentCases: 2 }))).toBe(false);
    expect(stillApplies('testimonial_ask', paying({ status: 'past_due' }))).toBe(false);
    expect(stillApplies('testimonial_ask', trial())).toBe(false);
    expect(stillApplies('improvised', trial())).toBe(false);
  });
});

describe('what one run proposes', () => {
  it('takes the most pressing template that was never proposed, one per account, and skips accounts without a usable address', () => {
    const accounts = [
      trial({ tenant: 'a-welcome' }),
      trial({ tenant: 'b-proposed', emails: emails({ welcome: 'rejected' }) }),
      trial({ tenant: 'c-no-email', hasEmail: false }),
      trial({ tenant: 'd-unsubscribed', suppressed: true }),
      paying({ tenant: 'e-paying' }),
      trial({ tenant: 'e-paying', product: 'caremetric-intel', productName: 'CareMetric Intel' }),
      trial({ tenant: 'f-checkin', trialStart: ago(25), trialEnd: ahead(4) }),
      trial({ tenant: 'g-nothing', trialStart: ago(10) }),
      trial({ tenant: 'h-next', trialStart: ago(2), trialEnd: ahead(5), emails: emails({ welcome: 'executed' }) }),
    ];
    const { candidates, skipped } = planEmails(accounts, now);
    expect(candidates.map(entry => [entry.fact.tenant, entry.fact.product, entry.template])).toEqual([
      ['a-welcome', 'carebase', 'welcome'], ['e-paying', 'caremetric-intel', 'welcome'],
      ['f-checkin', 'carebase', 'trial_checkin'], ['h-next', 'carebase', 'trial_checkin'],
    ]);
    expect(skipped).toEqual({ noAddress: 1, suppressed: 1, sameAccount: 1 });
  });

  it('keys every email by its period: the template, the account and the product', () => {
    expect(periodKey({ template: 'welcome', tenant: 'maple-grove', product: 'carebase' })).toBe('account:welcome:maple-grove:carebase');
    expect(new Set(every().map(({ input }) => input.periodKey)).size).toBe(lifecycleTemplates.length * 2);
    for (const { input, template, product } of every()) expect(input.periodKey).toBe(`account:${template}:maple-grove:${product}`);
  });
});

describe('the emails', () => {
  it('greets, says one thing, offers help by reply and signs off as the product team, with the subject and headline first', () => {
    const preview = lifecyclePreview(lifecycleInput(trial(), 'welcome'), { postalAddress: postal });
    expect(preview).toBe([
      'Subject: Welcome to CareMetric CareBase', '',
      'Welcome to CareMetric CareBase', '',
      'Hello,', '',
      'Thank you for starting a CareMetric CareBase trial for Maple Grove Senior Living. Here is the quickest way to see it working with your own team:', '',
      '1. Add your facility, whether it is a personal care home or an Assisted Living Facility (ALF).',
      '2. Import your staff roster from a spreadsheet, or add a few people by hand.',
      '3. Choose the training each role needs and assign it.', '',
      'Open the help center:', 'https://cmcarebase.com/app/help', '',
      'Each step has a short guide. If anything is unclear, reply to this email and we will help you through it.', '',
      'The CareMetric CareBase team', 'https://cmcarebase.com', '',
      'You are receiving this email because Maple Grove Senior Living has a CareMetric CareBase account.',
      `${unsubscribeLabel}: a personal link is added when the email is sent`,
      postal,
      // The CareBase theme's own footer lines.
      'Need help? Email hello@caremetric.ai.',
      'CareMetric CareBase · cmcarebase.com',
    ].join('\n'));
  });

  it('has a subject and a purpose for each template', () => {
    const subjects = Object.fromEntries(lifecycleTemplates.map(template => [template, lifecycleEmail(lifecycleInput(trial(), template)).subject]));
    expect(subjects).toEqual({
      welcome: 'Welcome to CareMetric CareBase', setup_nudge: 'Need a hand getting set up in CareMetric CareBase?',
      trial_checkin: 'How is your CareMetric CareBase trial going?', testimonial_ask: 'Would you share a sentence about CareMetric CareBase?',
    });
    const words = template => lifecycleWording(lifecycleInput(trial({ product: 'caremetric-intel', productName: 'CareMetric Intel' }), template));
    expect(words('welcome')).toContain('1. Open Setup from the Dashboard and name your agency.');
    expect(words('welcome')).toContain('https://www.caremetricintel.com/Help');
    expect(words('setup_nudge')).toContain('offer a hand with setup');
    expect(words('setup_nudge')).toContain('reply to this email and tell us what you would like to get done first');
    expect(words('trial_checkin')).toContain('This is a personal check-in, not a billing notice.');
    expect(words('trial_checkin')).toContain('Is anything getting in the way');
    expect(words('trial_checkin')).toContain('If you decide to keep CareMetric Intel, the Founders Sale applies on its own: eligible subscription charges are 50% off for the first 12 months of paid service, starting when your trial ends, with no code needed. Standard pricing resumes after that year.');
    expect(words('trial_checkin')).not.toContain('https://www.caremetricintel.com/Help');
  });

  it('asks for a testimonial with consent wording, and a reply is how a customer says yes', () => {
    const words = lifecycleWording(lifecycleInput(paying(), 'testimonial_ask'));
    expect(words).toContain('Would you be willing to share a sentence or two about your experience?');
    expect(words).toContain('reply to this email to say yes');
    expect(words).toContain('We would use your words only with your permission, only in the form you approve');
    expect(words).toContain('with or without your name and organization, as you prefer');
    expect(words).toContain('If you would rather not, there is no need to reply.');
  });

  it('uses the company vocabulary for CareBase and never the regulation\'s own facility name or an auditor', () => {
    const carebase = every().filter(entry => entry.product === 'carebase').map(({ input }) => lifecyclePreview(input, { postalAddress: postal })).join('\n');
    expect(carebase).toContain('Assisted Living Facility');
    expect(carebase).toContain('(ALF)');
    expect(carebase).toContain('surveyor');
    for (const entry of every()) {
      const text = lifecyclePreview(entry.input, { postalAddress: postal });
      expect(text, `${entry.product}/${entry.template}`).not.toMatch(/\bALRs?\b|Assisted Living Residences?|auditors?/i);
    }
    const intel = every().filter(entry => entry.product === 'caremetric-intel').map(({ input }) => lifecycleWording(input)).join('\n');
    expect(intel).not.toMatch(/Assisted Living|\bALF\b|surveyor|personal care home/i);
  });

  it('says nothing about AI, calls, prices, promises or Stripe\'s notices, in any email', () => {
    for (const { input, template, product, link } of every()) {
      // The trial check-in's Founders Sale paragraph (owner decision 2026-11-08) is checked word for word elsewhere; everything else holds.
      // CareMetric's own addresses in the themes' footers (support@ and hello@caremetric.ai) are addresses, not a mention of AI.
      const text = lifecyclePreview(input, { postalAddress: postal }).replace(foundersWords(input.productName), '').replace(/[\w.+-]+@caremetric\.ai\b/g, '');
      const label = `${product}/${template}/${link ? 'booking' : 'plain'}`;
      expect(text, label).not.toMatch(/\bAI\b|artificial|assistant|robot|\bbots?\b|automat/i);
      expect(text, label).not.toMatch(/\bcall(?:s|ed|ing)?\b|phone|voicemail|\bdial/i);
      expect(text, label).not.toMatch(/\$|€|\bUSD\b|%|\bprice|\bcost|\bfree\b|discount|invoice|payment|card\b|charge|refund|credit/i);
      expect(text, label).not.toMatch(/guarantee|promise|within \d|\bhours?\b|\bminutes?\b|by tomorrow|\btoday\b|\bsoon\b|\bwill be\b/i);
      expect(text, label).not.toMatch(/\btrial (?:ends|expires) on\b|\d{1,2}\/\d{1,2}|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/);
      // No digits beyond the numbered first steps and the links and the footer's postal address.
      const words = lifecycleWording(input).replace(foundersWords(input.productName), '').replace(/https:\/\/\S+/g, '').replace(/^\d\. /gm, '');
      expect(words, label).not.toMatch(/\d/);
    }
  });

  it('includes the owner\'s booking link only when one is set, and never in the testimonial request', () => {
    for (const { input, template, link } of every()) {
      const words = lifecycleWording(input);
      expect(words.includes(booking), `${template}/${link}`).toBe(Boolean(link) && template !== 'testimonial_ask');
      if (link && template !== 'testimonial_ask') expect(words).toMatch(/Pick a time to go through (?:setup|it) together:\nhttps:\/\/cal\.example\.com\/caremetric\/setup/);
    }
    expect(bookingLink(' https://cal.example.com/x ')).toBe('https://cal.example.com/x');
    for (const bad of ['http://cal.example.com/x', 'javascript:alert(1)', 'https://cal.example.com/a b', '', null, undefined, 42, `https://${'a'.repeat(400)}.com`]) {
      expect(bookingLink(bad), String(bad)).toBeNull();
      expect(lifecycleInput(trial(), 'welcome', { bookingUrl: bad }).bookingUrl).toBeNull();
    }
  });

  it('is short', () => {
    for (const { input, template } of every()) expect(lifecycleWording(input).length, template).toBeLessThan(1200);
  });

  it('clips and flattens names, so a name cannot reshape the email', () => {
    const input = lifecycleInput(trial({ tenantName: `  Maple\n\nGrove   ${'Very Long '.repeat(20)}`, productName: 'CareMetric\tCareBase' }), 'welcome');
    expect(input.tenantName).not.toMatch(/\s{2}|\n/);
    expect(input.tenantName.length).toBeLessThanOrEqual(80);
    expect(input.tenantName.endsWith('…')).toBe(true);
    expect(input.productName).toBe('CareMetric CareBase');
    expect(lifecycleInput(trial({ tenantName: '   ' }), 'welcome').tenantName).toBe('maple-grove');
    expect(() => lifecycleInput(trial({ product: 'breathe' }), 'welcome')).toThrow(TypeError);
    expect(() => lifecycleInput(trial(), 'improvised')).toThrow(TypeError);
    expect(() => lifecycleInput(trial({ tenant: 'Not A Slug' }), 'welcome')).toThrow(TypeError);
  });
});

describe('the sent email', () => {
  it('is the approved wording, then why it was sent, the personal unsubscribe link and the postal address', () => {
    for (const { input } of every()) {
      const email = renderLifecycleEmail(input, { unsubscribeUrl, postalAddress: postal });
      const preview = lifecyclePreview(input, { postalAddress: postal });
      expect(`Subject: ${email.subject}\n\n${email.text}`).toBe(preview.replace(`${unsubscribeLabel}: a personal link is added when the email is sent`, `${unsubscribeLabel}: ${unsubscribeUrl}`));
      expect(preview.startsWith(lifecycleWording(input))).toBe(true);
      // The branded layout in the theme of the product's app, with its inbox preview: Intel's Emberline header (its logo, tagline
      // and fire image), or CareBase's logo on white over its blue rule.
      expect(email.html).toContain(`${LAYOUT_MARKER}="branded"`);
      if (input.product === 'caremetric-intel') {
        expect(email.html).toContain('data-theme="intel"');
        expect(email.html).toContain('https://caremetricintel.com/brand/emberline-fire.png');
        expect(email.html).toContain('Set your marketing on FIRE!');
      } else {
        expect(email.html).toContain('data-theme="carebase"');
        expect(email.html).toContain('https://cmcarebase.com/brand/email-lockup-carebase.png');
      }
      expect(email.html).toContain(escapeHtml(lifecycleEmail(input).preheader));
      expect(email.html).toContain(`<a href="${unsubscribeUrl}" target="_blank"`);
      expect(email.html).toContain(`>${unsubscribeLabel}</a>`);
      expect(email.html).toContain(escapeHtml(postal));
      // The first two emails link to the product's getting-started help as a button; the check-in and the testimonial request do not.
      expect(email.html.includes(`href="${lifecycleProducts[input.product].helpUrl}"`), input.template).toBe(['welcome', 'setup_nudge'].includes(input.template));
    }
  });

  it('escapes names in the HTML part and keeps them as text in the plain part', () => {
    const hostile = '<script>alert(1)</script> & "Co"';
    const input = lifecycleInput(trial({ tenantName: hostile }), 'testimonial_ask');
    const email = renderLifecycleEmail(input, { unsubscribeUrl, postalAddress: postal });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain(escapeHtml(hostile));
    expect(email.text).toContain(hostile);
  });

  it('keeps a hash of the approved wording, so different words can never go out under the same approval', () => {
    const input = lifecycleInput(trial(), 'welcome', { bookingUrl: booking });
    expect(input.textHash).toBe(createHash('sha256').update(lifecycleWording(input)).digest('hex'));
    expect(wordingHash(input)).toBe(input.textHash);
    expect(wordingHash({ ...input, tenantName: 'Someone Else' })).not.toBe(input.textHash);
    expect(wordingHash({ ...input, bookingUrl: null })).not.toBe(input.textHash);
    // The footer is not part of what the owner approves: a new postal address does not change the hash.
    expect(lifecyclePreview(input, { postalAddress: 'Elsewhere' })).not.toBe(lifecyclePreview(input, { postalAddress: postal }));
  });
});

describe('the action\'s facts', () => {
  it('are a fixed whitelist with no address, and survive a round trip', () => {
    const input = lifecycleInput(trial({ hasEmail: true }), 'trial_checkin', { bookingUrl: booking });
    expect(Object.keys(input).sort()).toEqual(['bookingUrl', 'helpUrl', 'periodKey', 'product', 'productName', 'template', 'tenant', 'tenantName', 'textHash']);
    expect(JSON.stringify(input)).not.toContain('@');
    expect(parseLifecycleInput(input)).toEqual(input);
    expect(parseLifecycleInput({ ...input, to: 'someone@example.test' })).toEqual(input);
  });

  it('refuse anything out of shape', () => {
    const input = lifecycleInput(trial(), 'welcome');
    for (const broken of [
      null, [], 'text', { ...input, template: 'improvised' }, { ...input, tenant: 'Bad Slug' }, { ...input, product: 'breathe' }, { ...input, tenantName: '' },
      { ...input, productName: 7 }, { ...input, helpUrl: 'http://cmcarebase.com/app/help' }, { ...input, bookingUrl: 'javascript:alert(1)' },
      { ...input, periodKey: 'account:welcome:someone-else:carebase' }, { ...input, textHash: 'abc' }, { ...input, tenantName: 'x'.repeat(201) },
    ]) expect(parseLifecycleInput(broken), JSON.stringify(broken)).toBeNull();
  });
});

describe('whether the Hub can send customer email', () => {
  it('needs a sender, the postal address and an https origin, and says which is missing', () => {
    const mail = { configured: true, send: async () => ({}) };
    expect(lifecycleReadiness({ mail, postalAddress: postal, publicOrigin: 'https://hub.example.test/' })).toEqual({ ready: true, missing: [] });
    expect(lifecycleReadiness({ mail: { configured: false, send: async () => ({}) }, postalAddress: postal, publicOrigin: 'https://hub.example.test' }).missing).toEqual(['mail']);
    expect(lifecycleReadiness({ mail, postalAddress: '  ', publicOrigin: 'https://hub.example.test' }).missing).toEqual(['postal_address']);
    expect(lifecycleReadiness({ mail, postalAddress: postal, publicOrigin: 'http://hub.example.test' }).missing).toEqual(['public_origin']);
    expect(lifecycleReadiness({ mail, postalAddress: postal, publicOrigin: 'https://hub.example.test/path' }).missing).toEqual(['public_origin']);
    expect(lifecycleReadiness({ mail, postalAddress: postal, publicOrigin: 'https://hub.example.test#mail' }).missing).toEqual(['public_origin']);
    expect(lifecycleReadiness().missing).toEqual(['mail', 'postal_address', 'public_origin']);
  });

  it('builds the unsubscribe link only on a bare https origin, so nothing can come between the origin and the path', () => {
    for (const [value, origin] of [
      ['https://hub.example.test', 'https://hub.example.test'], ['https://hub.example.test/', 'https://hub.example.test'],
      [' https://HUB.example.test:8443/ ', 'https://hub.example.test:8443'], ['https://support-hub-web-production.up.railway.app', 'https://support-hub-web-production.up.railway.app'],
    ]) expect(httpsOrigin(value), value).toBe(origin);
    for (const value of [
      // A fragment or a query, even an empty one, would swallow the link's path: the link would request "/".
      'https://hub.example.test#mail', 'https://hub.example.test/#mail', 'https://hub.example.test#', 'https://hub.example.test?x=1', 'https://hub.example.test/?', 'https://hub.example.test?',
      // Credentials, a path, a second slash, another scheme, or something that is not an origin at all.
      'https://user:secret@hub.example.test', 'https://user@hub.example.test', 'https://hub.example.test/hub', 'https://hub.example.test//', 'https:///hub.example.test',
      'https:\\\\hub.example.test', 'http://hub.example.test', 'ftp://hub.example.test', 'javascript:alert(1)', 'https://', 'https://hub example.test', 'hub.example.test', '',
      null, undefined, 42, {},
    ]) expect(httpsOrigin(value), String(value)).toBeNull();
  });
});
