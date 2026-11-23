import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LAYOUT_MARKER, escapeHtml } from '../../email-layout.mjs';
import {
  cardTermsWords, dueTemplates, foundersWords, httpsOrigin, lifecycleEmail, lifecycleInput, lifecyclePreview, lifecycleProducts, lifecycleReadiness, lifecycleTemplates,
  lifecycleWording, parseLifecycleInput, periodKey, planEmails, renderLifecycleEmail, stillApplies, unsubscribeLabel, wordingHash,
} from './lifecycle.mjs';
import { trialCardTerms } from '../content/facts.mjs';
import { textProblems } from '../content/validate.mjs';

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
// Every email each product has (the trial path's `value_followup` only where the product has its next steps: Intel).
const offered = product => lifecycleTemplates.filter(template => template !== 'value_followup' || lifecycleProducts[product].next);
const every = () => Object.entries(products).flatMap(([product, productName]) => offered(product).map(template =>
  ({ template, product, link: null, input: lifecycleInput(trial({ product, productName }), template) })));

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

  it('sends a cancelling account only the cancellation check-in, and nothing to one past due or on a product without customer emails', () => {
    expect(dueTemplates(trial({ cancelling: true }), now)).toEqual(['cancel_save']);
    expect(dueTemplates(paying({ cancelling: true }), now)).toEqual(['cancel_save']);
    expect(dueTemplates(paying({ cancelling: true, firstPaidAt: ago(50) }), now)).toEqual(['cancel_save'], 'never a testimonial request to a leaving customer');
    expect(dueTemplates(trial({ status: 'past_due', cancelling: true }), now)).toEqual([]);
    // A subscription that has not ended its trial yet, or never had one, is not an ended trial.
    for (const status of ['past_due', 'unpaid', 'paused', 'canceled', 'incomplete']) expect(dueTemplates(trial({ status }), now), status).toEqual([]);
    expect(dueTemplates(trial({ product: 'breathe' }), now)).toEqual([]);
    expect(dueTemplates(trial({ product: 'constructor' }), now)).toEqual([]);
    expect(dueTemplates(null, now)).toEqual([]);
  });
});

describe('the cancellation and win-back emails', () => {
  const ended = (over = {}) => trial({ status: 'canceled', trialStart: ago(35), trialEnd: ago(5), ...over });
  it('checks in once a trial has ended unpaid, within 14 days', () => {
    for (const status of ['canceled', 'incomplete_expired', 'paused']) expect(dueTemplates(ended({ status }), now), status).toEqual(['trial_ended']);
    expect(dueTemplates(ended({ trialEnd: ago(13.9) }), now)).toEqual(['trial_ended']);
    expect(dueTemplates(ended({ trialEnd: ago(14) }), now)).toEqual([], 'after 14 days the moment has passed');
    expect(dueTemplates(ended({ trialEnd: ahead(1) }), now)).toEqual([], 'cancelled during its trial: not ended yet');
    expect(dueTemplates(ended({ firstPaidAt: ago(40) }), now)).toEqual([], 'a customer who paid is not a lost trial');
    expect(dueTemplates(ended({ trialEnd: null }), now)).toEqual([]);
    // Stripe keeps the cancellation fields on a trial that was set to cancel and then ended: it is an ended trial all the same.
    expect(dueTemplates(ended({ cancelling: true }), now)).toEqual(['trial_ended']);
    expect(stillApplies('trial_ended', ended({ cancelling: true }))).toBe(true);
    expect(stillApplies('cancel_save', ended({ cancelling: true }))).toBe(false);
  });
  it('is planned only when the run may send them', () => {
    const accounts = [trial({ tenant: 'a-leaving', cancelling: true }), ended({ tenant: 'b-ended' })];
    expect(planEmails(accounts, now).candidates).toEqual([]);
    expect(planEmails(accounts, now, { save: true }).candidates.map(entry => `${entry.fact.tenant}:${entry.template}`)).toEqual(['a-leaving:cancel_save', 'b-ended:trial_ended']);
    expect(planEmails([trial({ tenant: 'c', cancelling: true, emails: emails({ cancel_save: 'rejected' }) })], now, { save: true }).candidates).toEqual([], 'once per account and product');
  });
  it('still fits only while the plan is still being cancelled, or the trial is still ended and unpaid', () => {
    expect(stillApplies('cancel_save', trial({ cancelling: true }))).toBe(true);
    expect(stillApplies('cancel_save', paying({ cancelling: true }))).toBe(true);
    expect(stillApplies('cancel_save', trial())).toBe(false, 'the customer changed their mind');
    expect(stillApplies('trial_ended', ended())).toBe(true);
    expect(stillApplies('trial_ended', trial())).toBe(false, 'a new trial started');
    expect(stillApplies('trial_ended', paying())).toBe(false, 'they subscribed');
    expect(stillApplies('trial_ended', null)).toBe(false, 'past the 14 days the facts no longer list the account');
  });
  it('asks what got in the way, by reply, with no price, offer or call', () => {
    const words = template => lifecycleWording(lifecycleInput(trial({ product: 'caremetric-intel', productName: 'CareMetric Intel' }), template));
    expect(words('cancel_save')).toContain('is ending its CareMetric Intel plan');
    expect(words('cancel_save')).toContain('would you tell us what didn\'t work?');
    expect(words('trial_ended')).toContain('Your CareMetric Intel trial for Maple Grove Senior Living has ended.');
    expect(words('trial_ended')).toContain('Would you tell us what got in the way?');
    for (const template of ['cancel_save', 'trial_ended']) {
      expect(words(template)).not.toMatch(/\$|%|Founders Sale|\bcall\b|demo|meeting|discount/i);
      expect(words(template)).toContain('https://www.caremetricintel.com/Help');
    }
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
    expect(new Set(every().map(({ input }) => input.periodKey)).size).toBe(lifecycleTemplates.length * 2 - 1);
    for (const { input, template, product } of every()) expect(input.periodKey).toBe(`account:${template}:maple-grove:${product}`);
  });
});

describe('the emails', () => {
  it('greets, says one thing, offers help by reply and signs off as the product team, with the subject and headline first', () => {
    const preview = lifecyclePreview(lifecycleInput(trial(), 'welcome'), { postalAddress: postal });
    expect(preview).toBe([
      'Subject: Welcome to CareMetric CareBase: your first three steps', '',
      'Welcome to CareMetric CareBase', '',
      'Hello,', '',
      'Thanks for starting a CareMetric CareBase trial for Maple Grove Senior Living. These three steps get you to the first result worth seeing: each role\'s training assigned, with its records kept in one place for when a surveyor asks to see them.', '',
      '1. Add your facility, whether it is a personal care home or an Assisted Living Facility (ALF).',
      '2. Import your staff roster from a spreadsheet, or add a few people by hand.',
      '3. Choose the training each role needs and assign it.', '',
      'Open the help center:', 'https://cmcarebase.com/app/help', '',
      'Each step has a short guide. If anything\'s unclear, just reply and we\'ll help you through it.', '',
      'The CareMetric CareBase team', 'https://cmcarebase.com', '',
      'You\'re getting this email because Maple Grove Senior Living has a CareMetric CareBase account.',
      `${unsubscribeLabel}: a personal link is added when the email is sent`,
      postal,
      // The CareBase theme's own footer lines.
      'Need help? Email support@caremetric.ai.',
      'CareMetric CareBase · cmcarebase.com',
    ].join('\n'));
  });

  it('has a subject and a purpose for each template', () => {
    const subjects = Object.fromEntries(offered('carebase').map(template => [template, lifecycleEmail(lifecycleInput(trial(), template)).subject]));
    expect(subjects).toEqual({
      welcome: 'Welcome to CareMetric CareBase: your first three steps', setup_nudge: 'Need a hand getting set up in CareMetric CareBase?',
      trial_checkin: 'Before your CareMetric CareBase trial ends', testimonial_ask: 'Would you share a sentence about CareMetric CareBase?',
      cancel_save: 'Before your CareMetric CareBase plan ends', trial_ended: 'Thank you for trying CareMetric CareBase',
      card_reminder: 'Keep your CareMetric CareBase plan after your trial', midtrial_nudge: 'The one step that shows what CareMetric CareBase can do',
    });
    expect(() => lifecycleEmail(lifecycleInput(trial(), 'value_followup'))).toThrow('Unknown customer email.');
    const words = template => lifecycleWording(lifecycleInput(trial({ product: 'caremetric-intel', productName: 'CareMetric Intel' }), template));
    expect(words('welcome')).toContain('1. Open Setup from the Dashboard and name your agency.');
    // Each email says what the customer gets (email review 2026-11-17): where the first steps lead, and what stays when the plan starts.
    expect(lifecycleEmail(lifecycleInput(trial({ product: 'caremetric-intel', productName: 'CareMetric Intel' }), 'welcome')).subject).toBe('Welcome to CareMetric Intel: your first three steps');
    expect(words('welcome')).toContain('These three steps get you to the first result worth seeing: a list of the highest-ranked physicians for outreach in the county your trial covers.');
    expect(words('setup_nudge')).toContain('Setup ends with the first result worth seeing: a list of the highest-ranked physicians for outreach in the county your trial covers.');
    expect(words('trial_checkin')).toContain('Everything you\'ve built stays in place when your plan starts: your lists, your accounts and every visit you\'ve logged.');
    expect(words('welcome')).toContain('https://www.caremetricintel.com/Help');
    expect(words('setup_nudge')).toContain('offer a hand with setup');
    expect(words('setup_nudge')).toContain('just reply and tell us what you\'d like to get done first');
    expect(words('trial_checkin')).toContain('This is a personal check-in, not a billing notice.');
    expect(words('trial_checkin')).toContain('Is anything getting in the way');
    expect(words('trial_checkin')).toContain('If you decide to keep CareMetric Intel, the Founders Sale applies on its own: eligible subscription charges are 50% off for the first 12 months of paid service, starting when your trial ends, with no code needed. Standard pricing resumes after that year.');
    expect(words('trial_checkin')).not.toContain('https://www.caremetricintel.com/Help');
  });

  it('asks for a testimonial with consent wording, and a reply is how a customer says yes', () => {
    const words = lifecycleWording(lifecycleInput(paying(), 'testimonial_ask'));
    expect(words).toContain('Would you share a sentence or two about how it\'s going?');
    expect(words).toContain('just reply to say yes');
    expect(words).toContain('We\'d use your words only with your permission, only in the form you approve');
    expect(words).toContain('with or without your name and organization, as you prefer');
    expect(words).toContain('If you\'d rather not, there\'s no need to reply.');
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
      // CareMetric's own address in the themes' footers (support@caremetric.ai) is an address, not a mention of AI.
      // The card reminder's terms (Intel's own wording) are checked word for word in the trial path's tests.
      const text = lifecyclePreview(input, { postalAddress: postal }).replace(foundersWords(input.productName), '').replace(cardTermsWords, '').replace(/\bsupport@caremetric\.ai\b/g, '');
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

  it('never offers a time to meet, a call or a demo: no booking button, even on an email proposed with one (owner decision 2026-11-09)', () => {
    for (const { input, template } of every()) {
      expect(input.bookingUrl, template).toBeNull();
      expect(lifecycleWording(input), template).not.toMatch(/pick a time|together|meeting|demo|cal\.example/i);
    }
    // An email proposed before this change keeps its booking link in its facts, but the link is never shown: its wording no
    // longer matches the approved hash, so the executor refuses it (wording_changed) instead of sending a meeting offer.
    const old = { ...lifecycleInput(trial(), 'welcome'), bookingUrl: booking };
    expect(parseLifecycleInput(old)).toEqual(old);
    expect(lifecycleWording(old)).not.toContain(booking);
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
      // and fire image), or CareBase's logo on white over its blue rule; the images are the Hub's copies on the sending domain.
      expect(email.html).toContain(`${LAYOUT_MARKER}="branded"`);
      if (input.product === 'caremetric-intel') {
        expect(email.html).toContain('data-theme="intel"');
        expect(email.html).toContain('https://help.caremetric.ai/email/intel-emberline-fire.png');
        expect(email.html).toContain('Set your marketing on FIRE!');
      } else {
        expect(email.html).toContain('data-theme="carebase"');
        expect(email.html).toContain('https://help.caremetric.ai/email/carebase-lockup.png');
      }
      expect(email.html).toContain(escapeHtml(lifecycleEmail(input).preheader));
      expect(email.html).toContain(`<a href="${unsubscribeUrl}" target="_blank"`);
      expect(email.html).toContain(`>${unsubscribeLabel}</a>`);
      expect(email.html).toContain(escapeHtml(postal));
      // The first two emails, the mid-trial emails and the cancellation and win-back emails link to the product's help as a button;
      // the check-in and the testimonial request do not; the card reminder links to the billing page where the product has one.
      const linksHelp = ['welcome', 'setup_nudge', 'midtrial_nudge', 'value_followup', 'cancel_save', 'trial_ended'].includes(input.template)
        || (input.template === 'card_reminder' && !lifecycleProducts[input.product].billingUrl);
      expect(email.html.includes(`href="${lifecycleProducts[input.product].helpUrl}"`), input.template).toBe(linksHelp);
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
    const input = lifecycleInput(trial(), 'welcome');
    expect(input.textHash).toBe(createHash('sha256').update(lifecycleWording(input)).digest('hex'));
    expect(wordingHash(input)).toBe(input.textHash);
    expect(wordingHash({ ...input, tenantName: 'Someone Else' })).not.toBe(input.textHash);
    expect(wordingHash({ ...input, helpUrl: 'https://cmcarebase.com/app/help/elsewhere' })).not.toBe(input.textHash);
    // The footer is not part of what the owner approves: a new postal address does not change the hash.
    expect(lifecyclePreview(input, { postalAddress: 'Elsewhere' })).not.toBe(lifecyclePreview(input, { postalAddress: postal }));
  });
});

describe('the action\'s facts', () => {
  it('are a fixed whitelist with no address, and survive a round trip', () => {
    const input = lifecycleInput(trial({ hasEmail: true }), 'trial_checkin');
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

describe('the trial path (team review 2026-11-17, stage 4)', () => {
  const intel = (over = {}) => trial({ product: 'caremetric-intel', productName: 'CareMetric Intel', cardConfirmedAt: null, activeAt: null,
    firstValueAt: null, countyChosen: false, emails: emails({ card_reminder: null, midtrial_nudge: null, value_followup: null }), ...over });
  const due = (fact, at = now) => dueTemplates(fact, at, { trialPath: true });

  it('counts an Intel trial from its start, card or not (owner decision 2026-11-23: no card is needed to start one)', () => {
    expect(due(intel({ trialStart: ago(0.5), created: ago(0.5) }))).toEqual(['welcome']);
    expect(due(intel({ trialStart: ago(1), created: ago(1), cardConfirmedAt: ago(0.5) }))).toEqual(['welcome']);
    expect(due(intel({ trialStart: ago(4), created: ago(4) }))).toEqual(['setup_nudge']);
    // A card confirmed later does not restart the trial's days.
    expect(due(intel({ trialStart: ago(5), cardConfirmedAt: ago(1) }))).toEqual(['setup_nudge']);
    // Without the trial path the same trial is welcomed as before.
    expect(dueTemplates(intel({ trialStart: ago(1), created: ago(1) }), now)).toEqual(['welcome']);
  });

  it('reminds an Intel trial with no card once in its last week, from 7 days left to 1, and never one with a card or a CareBase trial', () => {
    const late = (left, over = {}) => intel({ trialStart: ago(30 - left), created: ago(30 - left), trialEnd: ahead(left), ...over });
    expect(due(late(7.5))).toEqual([]);
    expect(due(late(7))).toEqual(['card_reminder']);
    expect(due(late(6))).toEqual(['card_reminder']);
    // The personal check-in follows in its own run (one email an account a run, the reminder first).
    expect(due(late(4))).toEqual(['card_reminder', 'trial_checkin']);
    expect(due(late(1.5))).toEqual(['card_reminder']);
    expect(due(late(1))).toEqual([]);
    expect(due(late(6, { cardConfirmedAt: ago(3) }))).toEqual([]);
    expect(due(late(4, { cardConfirmedAt: ago(3) }))).toEqual(['trial_checkin']);
    expect(due(trial({ trialStart: ago(24), trialEnd: ahead(6) }))).toEqual([]);
    expect(due(late(6, { cancelling: true }))).toEqual(['cancel_save']);
    expect(due(intel({ trialStart: ago(24), trialEnd: null }))).toEqual([]);
  });

  it('reads Intel\'s use from its activity events, and CareBase\'s from usage reports', () => {
    expect(due(intel({ trialStart: ago(4) }))).toEqual(['setup_nudge']);
    expect(due(intel({ trialStart: ago(4), hasUsage: false, activeAt: ago(1) }))).toEqual([]);
    expect(due(intel({ trialStart: ago(4), hasUsage: true }))).toEqual(['setup_nudge'], 'Intel sends no usage reports');
    expect(due(trial({ trialStart: ago(4) }))).toEqual(['setup_nudge']);
    expect(due(trial({ trialStart: ago(4), hasUsage: true }))).toEqual([]);
  });

  it('fills the middle of the trial: the next step without first value, what to do next with it, never with 5 days or fewer left', () => {
    expect(due(intel({ trialStart: ago(12) }))).toEqual(['midtrial_nudge']);
    expect(due(intel({ trialStart: ago(12), firstValueAt: ago(3), activeAt: ago(1) }))).toEqual(['value_followup']);
    expect(due(intel({ trialStart: ago(9) }))).toEqual([]);
    expect(due(intel({ trialStart: ago(17) }))).toEqual([]);
    expect(due(intel({ trialStart: ago(12), trialEnd: ahead(5) }))).toEqual(['card_reminder', 'trial_checkin']);
    expect(due(intel({ trialStart: ago(12), cardConfirmedAt: ago(12), trialEnd: ahead(5) }))).toEqual(['trial_checkin']);
    // CareBase has no next steps written: with usage it gets nothing in the middle; without, the next step.
    expect(due(trial({ trialStart: ago(12), hasUsage: true }))).toEqual([]);
    expect(due(trial({ trialStart: ago(12) }))).toEqual(['midtrial_nudge']);
  });

  it('thanks an ended Intel trial for trying, with or without a card: it did start', () => {
    const ended = over => intel({ status: 'canceled', trialStart: ago(31), trialEnd: ago(1), ...over });
    expect(due(ended())).toEqual(['trial_ended']);
    expect(due(ended({ cardConfirmedAt: ago(30) }))).toEqual(['trial_ended']);
    expect(due(ended({ firstPaidAt: ago(1) }))).toEqual([]);
  });

  it('proposes the new emails only with the trial path, and each at most once', () => {
    const fact = intel({ trialStart: ago(24), created: ago(24), trialEnd: ahead(6) });
    expect(planEmails([fact], now).candidates.map(entry => entry.template)).toEqual([]);
    expect(planEmails([fact], now, { trialPath: true }).candidates.map(entry => entry.template)).toEqual(['card_reminder']);
    expect(planEmails([{ ...fact, emails: { ...fact.emails, card_reminder: 'executed' } }], now, { trialPath: true }).candidates).toEqual([]);
  });

  it('still fits only while it applies: the card reminder while the trial has no card, the rest whether or not it has one', () => {
    const sent = (template, over) => stillApplies(template, intel(over), { trialPath: true });
    expect(sent('card_reminder', {})).toBe(true);
    expect(sent('card_reminder', { cardConfirmedAt: ago(0) })).toBe(false);
    expect(sent('card_reminder', { cancelling: true })).toBe(false);
    expect(sent('card_reminder', { status: 'canceled' })).toBe(false);
    expect(stillApplies('card_reminder', trial(), { trialPath: true })).toBe(false, 'a CareBase trial has nothing to add');
    expect(sent('welcome', {})).toBe(true);
    expect(sent('welcome', { cardConfirmedAt: ago(0) })).toBe(true);
    expect(sent('setup_nudge', { activeAt: ago(0) })).toBe(false);
    expect(sent('midtrial_nudge', { firstValueAt: ago(0) })).toBe(false);
    expect(sent('value_followup', { firstValueAt: ago(1) })).toBe(true);
    expect(sent('value_followup', { firstValueAt: ago(1), cancelling: true })).toBe(false);
    expect(sent('trial_ended', { status: 'canceled' })).toBe(true);
    expect(stillApplies('card_reminder', intel(), {})).toBe(false, 'never without the trial path');
  });

  it('states Intel\'s terms as Intel does, never that a card is needed to start, and links the card reminder to Billing', () => {
    expect(cardTermsWords).toBe('Add a card in Billing before the trial ends to keep your plan; it then bills automatically after the trial unless you cancel. Without a card, the trial simply ends.');
    // The fact sheet's terms go on in the same words (docs/GTM_FACTS.md).
    expect(trialCardTerms).toBe(`No credit card is needed to start your trial. ${cardTermsWords}`);
    const input = lifecycleInput(intel(), 'card_reminder');
    expect(input.helpUrl).toBe('https://www.caremetricintel.com/Billing');
    const email = lifecycleEmail(input);
    expect(email.subject).toBe('Keep your CareMetric Intel plan after your trial');
    const words = lifecycleWording(input);
    expect(words).toContain('Your CareMetric Intel trial for Maple Grove Senior Living ends within a week.');
    expect(words).toContain(cardTermsWords);
    expect(words).toContain('Everything you\'ve built stays in place when your plan continues: your lists, your accounts and every visit you\'ve logged.');
    expect(words).toContain('Open Billing');
    expect(words).not.toMatch(/required|one step left|hasn't (?:started|begun)|finish starting/i);
    expect(textProblems(words, { product: 'intel' })).not.toContain('trial_terms');
    // The card reminder is the one customer email that names the card.
    for (const template of ['welcome', 'setup_nudge', 'midtrial_nudge', 'value_followup', 'trial_checkin', 'trial_ended', 'cancel_save']) {
      expect(lifecycleWording(lifecycleInput(intel(), template)), template).not.toMatch(/credit card|\bcard\b/i);
    }
    expect(lifecycleInput(intel(), 'midtrial_nudge').helpUrl).toBe('https://www.caremetricintel.com/Help');
    expect(lifecycleWording(lifecycleInput(intel(), 'midtrial_nudge'))).toContain('build a first list: the highest-ranked physicians for outreach in that county');
    // A plan continues after an Intel trial only with a card, so "what to do next" no longer says it starts on its own.
    expect(lifecycleWording(lifecycleInput(intel(), 'value_followup'))).toContain('When you keep your plan after the trial, everything you\'ve built stays in place.');
    expect(lifecycleWording(lifecycleInput(intel(), 'value_followup'))).not.toMatch(/starts on its own/);
  });
});
