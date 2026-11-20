import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appServer } from './http.mjs';
import { LAYOUT_MARKER } from './email-layout.mjs';
import {
  emailRows, greetingName, invitationEmail, invitationPage, invitationProfiles, invitationTokenPattern, newInvitationToken, offerRows, readyEmail, signupLink,
  unknownInvitationPage, welcomePagePolicy,
} from './customer-invitations.mjs';
import { discountLabel, durationWords, invitationRecordSchema, normalizedRecord, offerAmounts, plural, regularPriceLabel, yourPriceLabel } from '../src/billing/invitationProtocol.ts';

const hostile = '<script>alert(1)</script>';
const invitation = (overrides = {}) => ({
  id: '00000000-0000-4000-8000-0000000000c1', app: 'carebase', contact_name: 'Jane Doe', contact_email: 'jane@maple.test', organization_name: 'Maple Grove',
  plan_name: 'CareBase Core', unit_label: 'facility', pricing_model: 'per_unit', quantity: 3, unit_amount: 19900, currency: 'usd', interval: 'month', interval_count: 1,
  discount_percent: 50, discount_duration: 'repeating', discount_months: 12, note: '', status: 'pending', expires_at: '2026-12-19T17:00:00Z', ...overrides,
});
const link = 'https://help.caremetric.ai/welcome/' + 'a'.repeat(43);

describe('the price and discount words', () => {
  it('states the regular price, the discount and what they pay, as Stripe rounds it', () => {
    const offer = invitation();
    expect(regularPriceLabel(offer)).toBe('$597.00 per month ($199.00 per facility × 3)');
    expect(regularPriceLabel({ ...offer, quantity: 1 })).toBe('$199.00 per facility per month');
    expect(regularPriceLabel({ ...offer, pricing_model: 'flat', quantity: 1, unit_amount: 199000, interval: 'year' })).toBe('$1,990.00 per year');
    expect(discountLabel(offer)).toBe('50% off for your first 12 months');
    expect(yourPriceLabel(offer)).toBe('$298.50 per month for your first 12 months, then $597.00 per month');
    expect(offerAmounts({ unit_amount: 999, quantity: 1, discount_percent: 33.33 })).toEqual({ regular: 999, discount: 333, discounted: 666 });
    expect(discountLabel({ ...offer, discount_percent: 12.5, discount_duration: 'forever' })).toBe('12.5% off for as long as you subscribe');
    expect(discountLabel({ ...offer, discount_percent: 0 })).toBe('No discount');
    expect(yourPriceLabel({ ...offer, discount_percent: 0 })).toBe('$597.00 per month');
    expect(discountLabel({ ...offer, discount_percent: 100, discount_duration: 'forever' })).toBe('Complimentary (100% off) for as long as you subscribe');
    expect(yourPriceLabel({ ...offer, discount_percent: 100, discount_duration: 'forever' })).toBe('$0.00 (complimentary)');
    expect(durationWords({ discount_duration: 'once', discount_months: null, interval: 'month' })).toBe('on your first month\'s invoice');
    expect(durationWords({ discount_duration: 'once', discount_months: null, interval: 'year' })).toBe('on your first year');
    expect(durationWords({ discount_duration: 'repeating', discount_months: 1, interval: 'month' })).toBe('for your first month');
    expect([plural('facility', 2), plural('seat', 3), plural('branch', 2), plural('facility', 1), plural('', 2)]).toEqual(['facilities', 'seats', 'branches', 'facility', 'units']);
  });

  it('accepts only a complete invitation, and stores a 0% discount with no duration', () => {
    const record = { app: 'breathe', contact_name: ' Sam Lee ', contact_email: ' Sam@Keystone.TEST ', organization_name: 'Keystone', price: 'price_1', quantity: 1,
      discount_percent: 0, discount_duration: 'repeating', discount_months: 6, note: 'Line one\r\nLine two' };
    const parsed = normalizedRecord(invitationRecordSchema.parse(record));
    expect(parsed).toMatchObject({ contact_name: 'Sam Lee', contact_email: 'sam@keystone.test', discount_duration: 'forever', discount_months: null, note: 'Line one\nLine two' });
    for (const change of [{ discount_percent: 100.01 }, { discount_percent: 33.333 }, { discount_percent: -1 }, { quantity: 0 }, { contact_email: 'nope' },
      { organization_name: 'A' }, { app: 'pennsync' }, { note: 'x'.repeat(1001) }, { contact_name: 'Bell\u0007' }, { discount_percent: 10, discount_duration: 'repeating', discount_months: null }]) {
      expect(invitationRecordSchema.safeParse({ ...record, ...change }).success, JSON.stringify(change)).toBe(false);
    }
    expect(invitationRecordSchema.safeParse({ ...record, extra: true }).success).toBe(false);
  });

  it('accepts any discount with up to two decimals, though value × 100 is inexact in binary', () => {
    const record = { app: 'carebase', contact_name: 'Jane', contact_email: 'jane@maple.test', organization_name: 'Maple', price: 'price_1', quantity: 1,
      discount_percent: 0, discount_duration: 'forever', discount_months: null, note: '' };
    for (const percent of [1.1, 17.99, 0.07, 0.29, 33.33, 57.01, 99.99, 100]) {
      const parsed = invitationRecordSchema.safeParse({ ...record, discount_percent: percent });
      expect(parsed.success, String(percent)).toBe(true);
      expect(parsed.data.discount_percent).toBe(percent);
    }
    for (const percent of [12.345, 0.001, 99.995]) expect(invitationRecordSchema.safeParse({ ...record, discount_percent: percent }).success, String(percent)).toBe(false);
  });
});

describe('the invitation email', () => {
  it('welcomes them in the application\'s own look, describes it, states their price and links to the welcome page', () => {
    for (const [app, theme] of [['carebase', 'carebase'], ['breathe', 'breathe'], ['caremetric-intel', 'intel']]) {
      const email = invitationEmail(invitation({ app }), link);
      const profile = invitationProfiles[app];
      expect(email.subject).toBe(`Your ${profile.name} account for Maple Grove`);
      expect(email.html).toContain(`${LAYOUT_MARKER}="branded" data-theme="${theme}"`);
      expect(email.text).toContain(`Welcome to ${profile.name}`);
      expect(email.text).toContain(`CareMetric has invited Maple Grove to ${profile.name}.`);
      expect(email.text).toContain(profile.summary);
      expect(email.text).toContain('Price: $298.50 per month for your first 12 months, then $597.00 per month');
      expect(email.text).toContain('You will pay through Stripe, the payment service CareMetric uses.');
      expect(email.text).toContain(`Review the invitation:\n${link}`);
      expect(email.text).toContain('expires on December 19, 2026');
      expect(email.text).toContain(`The ${profile.name} team`);
    }
  });

  it('reads as an account notice, not an offer: the breakdown and the feature list stay on the welcome page', () => {
    // Microsoft 365 filed the first production invitation as junk with SPF, DKIM and DMARC passing; promotional wording is one signal.
    for (const overrides of [{}, { discount_percent: 100, discount_duration: 'forever', discount_months: null }, { discount_percent: 100 }, { discount_percent: 0 }]) {
      for (const app of Object.keys(invitationProfiles)) {
        const email = invitationEmail(invitation({ app, ...overrides }), link);
        const ready = readyEmail(invitation({ app, ...overrides }), 'https://example.test/signup');
        for (const text of [email.subject, email.text, ready.subject, ready.text]) {
          expect(text, JSON.stringify(overrides)).not.toMatch(/complimentary|discount|% off|\$0\.00|free|securely|activate/i);
        }
        for (const highlight of invitationProfiles[app].highlights) expect(email.text).not.toContain(highlight);
        // Every image and link in the invitation is on help.caremetric.ai, the sending domain.
        for (const [, url] of email.html.matchAll(/(?:href|src)="([^"]+)"/g)) expect(url).toMatch(/^https:\/\/help\.caremetric\.ai\//);
      }
    }
  });

  it('tells a customer with no charge that no card is needed, and when invoices start', () => {
    const forever = invitationEmail(invitation({ discount_percent: 100, discount_duration: 'forever', discount_months: null }), link);
    expect(forever.text).toContain('CareMetric has set up CareMetric CareBase for Maple Grove.');
    expect(forever.text).toContain('Price: No charge\n');
    expect(forever.text).toContain('No card is needed.');
    expect(forever.text).toContain(`Accept the invitation:\n${link}`);
    expect(forever.text).not.toMatch(/Stripe/);
    const limited = invitationEmail(invitation({ discount_percent: 100 }), link);
    expect(limited.text).toContain('Price: No charge for your first 12 months, then $597.00 per month ($199.00 per facility × 3)');
    expect(limited.text).toContain('When the no-charge period ends, CareBase invoices at the regular price are emailed to you.');
  });

  it('greets by first name, keeps a title, and escapes everything the owner or customer typed', () => {
    expect([greetingName('Jane Doe'), greetingName('Dr. Sam Lee'), greetingName('Cher'), greetingName('  ')]).toEqual(['Jane', 'Dr. Sam Lee', 'Cher', null]);
    const email = invitationEmail(invitation({ contact_name: hostile, organization_name: hostile, note: `Hello ${hostile}\nKevin`, plan_name: hostile }), link);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.text).toContain(`Hello ${hostile}\nKevin`);
    expect(() => invitationEmail(invitation(), 'javascript:alert(1)')).toThrow();
  });

  it('sends the sign-up link with the invitation\'s code once the plan is active', () => {
    const token = newInvitationToken();
    expect(invitationTokenPattern.test(token)).toBe(true);
    const signup = signupLink('https://cmbreathe.com/breathe/signup', token);
    expect(signup).toBe(`https://cmbreathe.com/breathe/signup?hub_invite=${token}`);
    expect(signupLink('https://example.test/join?ref=hub', token)).toBe(`https://example.test/join?ref=hub&hub_invite=${token}`);
    expect(signupLink('https://cmcarebase.com/signup', token, { app: 'carebase', entitlement: 'train_single_facility' }))
      .toBe(`https://cmcarebase.com/signup?product=train&hub_invite=${token}`);
    expect(signupLink('https://cmcarebase.com/signup', token, { app: 'carebase', entitlement: 'core' })).toBe(`https://cmcarebase.com/signup?hub_invite=${token}`);
    expect(signupLink('https://cmbreathe.com/breathe/signup', token, { app: 'breathe', entitlement: 'launch_founder' }))
      .toBe(`https://cmbreathe.com/breathe/signup?plan=launch_founder&hub_invite=${token}`);
    expect(signupLink('https://www.caremetricintel.com/login?signup=true', token, { app: 'caremetric-intel', entitlement: 'growth' }))
      .toBe(`https://www.caremetricintel.com/login?signup=true&hub_invite=${token}`);
    const email = readyEmail(invitation({ app: 'breathe', discount_percent: 100, discount_duration: 'forever', discount_months: null }), signup);
    expect(email.subject).toBe('Create your CareMetric Breathe sign-in');
    expect(email.html).toContain('data-theme="breathe"');
    expect(email.text).toContain(`Create your Breathe sign-in:\n${signup}`);
    expect(email.text).toContain('Maple Grove\'s CareBase Core plan is active.');
    expect(email.text).toContain('Price: No charge\n');
    expect(readyEmail(invitation(), signup).text).toContain('Thank you for your payment. Maple Grove\'s CareBase Core plan is active.');
  });

  it('lists the quantity only for a per-unit price', () => {
    expect(offerRows(invitation()).map(([label]) => label)).toEqual(['Plan', 'Quantity', 'Regular price', 'Your discount', 'Your price']);
    expect(offerRows(invitation({ pricing_model: 'flat', quantity: 1, discount_percent: 0 })).map(([label]) => label)).toEqual(['Plan', 'Regular price', 'Your price']);
    expect(emailRows(invitation()).map(([label]) => label)).toEqual(['Plan', 'Quantity', 'Price']);
    expect(emailRows(invitation({ pricing_model: 'flat', quantity: 1, discount_percent: 0 }))).toEqual([['Plan', 'CareBase Core'], ['Price', '$199.00 per month']]);
  });
});

describe('the welcome page', () => {
  const token = 'b'.repeat(43);
  it('shows the offer and a form that accepts it, in the application\'s look', () => {
    const html = invitationPage(invitation({ app: 'caremetric-intel' }), { token });
    expect(html).toContain(`<form method="post" action="/welcome/${token}"`);
    expect(html).toContain('Accept and continue to secure payment');
    // The application's logos are the Hub's own copies, shown from the page's own origin.
    expect(html).toContain('<img src="/email/intel-logo-reverse.png"');
    expect(html).toContain('<img src="/email/intel-emberline-fire.png"');
    expect(invitationPage(invitation(), { token })).toContain('<img src="/email/carebase-lockup.png"');
    expect(welcomePagePolicy).toContain("img-src 'self' data:;");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(invitationPage(invitation({ discount_percent: 100 }), { token })).toContain('Accept and activate your plan');
    expect(invitationPage(invitation({ organization_name: hostile }), { token })).not.toContain('<script>');
  });

  it('has a page for every state', () => {
    expect(invitationPage(invitation({ status: 'expired' }), { token })).toContain('This invitation has expired');
    expect(invitationPage(invitation({ status: 'revoked' }), { token })).toContain('This invitation was withdrawn');
    const active = invitationPage(invitation({ status: 'active' }), { token, signup: `https://cmcarebase.com/signup?hub_invite=${token}` });
    expect(active).toContain('Your plan is active');
    expect(active).toContain(`href="https://cmcarebase.com/signup?hub_invite=${token}"`);
    expect(active).not.toContain('<form');
    expect(invitationPage(invitation({ status: 'claimed' }), { token })).toContain('Your CareBase account is set up');
    expect(unknownInvitationPage()).toContain('This invitation link is not valid');
  });
});

describe('the welcome page route', () => {
  const origin = 'https://help.caremetric.ai';
  const token = 'c'.repeat(43);
  const invitations = {
    page: vi.fn(async () => ({ status: 200, html: '<p>offer</p>' })),
    accept: vi.fn(async () => ({ redirect: 'https://checkout.stripe.com/c/pay/cs_test_1' })),
    admin: vi.fn(async () => ({ invitations: [] })),
  };
  let server, base;
  beforeAll(async () => {
    server = appServer({ auth: {}, gateway: {}, delegations: {}, origins: [origin], health: async () => {}, invitations });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));

  it('shows the page with its own security policy and passes only a known Checkout return', async () => {
    const response = await fetch(`${base}/welcome/${token}?checkout=done`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe(welcomePagePolicy);
    expect(welcomePagePolicy).toContain("form-action 'self' https://checkout.stripe.com");
    expect(welcomePagePolicy).toContain("script-src 'none'");
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('cache-control')).toBe('no-store');
    // Under the Hub's own no-referrer a browser posts the Accept form with `Origin: null`, which the same-origin check refuses: every
    // acceptance failed in a real browser. same-origin sends the Hub its own Origin and still no referrer to Stripe or the application.
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(invitations.page).toHaveBeenLastCalledWith(token, { checkout: 'done' });
    await fetch(`${base}/welcome/${token}?checkout=elsewhere`);
    expect(invitations.page).toHaveBeenLastCalledWith(token, { checkout: null });
  });

  it('accepts only a POST from the Hub\'s own page, and sends the browser on to Stripe', async () => {
    const refused = await fetch(`${base}/welcome/${token}`, { method: 'POST', headers: { Origin: 'https://evil.test' }, redirect: 'manual' });
    expect(refused.status).toBe(403);
    const opaque = await fetch(`${base}/welcome/${token}`, { method: 'POST', headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }, redirect: 'manual' });
    expect(opaque.status, 'an opaque origin is never taken for the Hub (the page sends its own, above)').toBe(403);
    expect(invitations.accept).not.toHaveBeenCalled();
    const accepted = await fetch(`${base}/welcome/${token}`, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' }, body: '', redirect: 'manual' });
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(invitations.accept).toHaveBeenCalledWith(token);
  });

  it('answers the owner\'s commands only from the Hub\'s own pages', async () => {
    const cross = await fetch(`${base}/api/admin/invitations`, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{"action":"list"}' });
    expect(cross.status).toBe(403);
    const own = await fetch(`${base}/api/admin/invitations`, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: '{"action":"list"}' });
    expect(own.status).toBe(200);
    expect(invitations.admin).toHaveBeenCalledWith(null, { action: 'list' });
  });

});
