import { describe, expect, it } from 'vitest';
import { bookingLink, replyBody, smsLimit, templateNames } from './templates.mjs';

describe('the fixed replies', () => {
  it('has the three replies the Concierge offers', () => {
    expect(templateNames).toEqual(['standard', 'phi', 'sales']);
  });

  it('greets, then says the message arrived and a person will review it', () => {
    expect(replyBody('standard', 'email')).toBe('Hello,\n\nThank you for contacting CareMetric Support. We have your message and a member of our team will review it and reply here.');
    expect(replyBody('standard', 'chat')).toBe(replyBody('standard', 'email'));
  });

  it('asks the sender to resend without identifiers, and quotes, confirms and promises nothing', () => {
    const body = replyBody('phi', 'email');
    expect(body).toContain('not set up to receive patient or resident information');
    expect(body).toContain('without names, dates of birth, record numbers or health details');
    expect(body).toContain('a member of our team will review it');
  });

  it('fits a text message in one message of 320 characters', () => {
    for (const template of templateNames) {
      for (const bookingUrl of [null, booking, `https://example.test/${'b'.repeat(180)}`]) {
        const body = replyBody(template, 'sms', { bookingUrl });
        expect(body.length, template).toBeLessThanOrEqual(smsLimit);
        expect(body.startsWith('Hello, ')).toBe(true);
        expect(body).not.toContain('\n');
      }
    }
  });

  it('says nothing about AI, calls, deletion, security, compliance, prices or outcomes, in any version', () => {
    for (const template of templateNames) {
      for (const route of ['email', 'chat', 'sms']) {
        for (const bookingUrl of [null, booking]) {
          const body = replyBody(template, route, { bookingUrl });
          expect(body, `${template}/${route}`).not.toMatch(/\bAI\b|assistant|artificial|robot|bot\b|automat/i);
          expect(body, `${template}/${route}`).not.toMatch(/\bcall(?:s|ing)?\b|phone|voicemail|\d{3}[-. ]\d{3,4}/i);
          expect(body, `${template}/${route}`).not.toMatch(/delet|secure|security|encrypt|complian|HIPAA|\bhours?\b|\bdays?\b|minutes?|soon|refund|guarantee|\$|price|cost|free|discount/i);
          expect(body, `${template}/${route}`).not.toMatch(/ALR|Assisted Living Residence|auditor/);
        }
      }
    }
  });

  it('names no day and promises no personal follow-up, in any reply (CareMetric sells without meetings)', () => {
    for (const template of ['standard', 'phi', 'sales']) for (const route of ['email', 'chat', 'sms']) expect(replyBody(template, route), template).not.toMatch(/today|tomorrow|personally|call|meeting|demo/i);
    for (const route of ['email', 'chat', 'sms']) expect(replyBody('sales', route)).toMatch(/will reply here with/);
  });

  it('refuses a template it does not know', () => {
    expect(() => replyBody('improvised', 'email')).toThrow(TypeError);
  });
});

const booking = 'https://cal.example.test/caremetric/intro';

describe('the sales reply', () => {
  it('thanks the prospect and says the information will come here', () => {
    expect(replyBody('sales', 'email')).toBe('Hello,\n\nThank you for reaching out to CareMetric. We have your request and will reply here with the information you need.');
    expect(replyBody('sales', 'chat')).toBe(replyBody('sales', 'email'));
    expect(replyBody('sales', 'sms')).toBe('Hello, Thanks for reaching out to CareMetric. We have your request and will reply here with what you need.');
  });

  it('offers the owner\'s booking page when one is set', () => {
    expect(replyBody('sales', 'email', { bookingUrl: booking })).toBe(
      `Hello,\n\nThank you for reaching out to CareMetric. We have your request and will reply here with the information you need.\n\nIf you would like to set a time now, pick a time that suits you: ${booking}`);
    expect(replyBody('sales', 'sms', { bookingUrl: booking })).toBe(
      `Hello, Thanks for reaching out to CareMetric. We have your request and will reply here with what you need. Or pick a time that suits you: ${booking}`);
  });

  it('leaves the link out of a text message it would not fit, and out of every other reply', () => {
    const long = `https://cal.example.test/${'x'.repeat(170)}`;
    expect(bookingLink(long)).toBe(long);
    expect(replyBody('sales', 'sms', { bookingUrl: long })).toBe(replyBody('sales', 'sms'));
    expect(replyBody('sales', 'email', { bookingUrl: long })).toContain(long);
    for (const template of ['standard', 'phi']) for (const route of ['email', 'sms']) expect(replyBody(template, route, { bookingUrl: booking })).not.toContain('cal.example.test');
  });

  it('offers only an https booking address with a host and no credentials, spaces or control characters', () => {
    for (const value of [null, undefined, '', 42, 'cal.example.test/me', 'http://cal.example.test/me', 'javascript:alert(1)', 'https://user:pass@cal.example.test/me',
      'https://cal.example.test/a b', ' https://cal.example.test/me', 'https://cal.example.test/me\n', `https://cal.example.test/${'x'.repeat(200)}`, 'ftp://cal.example.test', 'https://']) {
      expect(bookingLink(value), String(value)).toBeNull();
      expect(replyBody('sales', 'email', { bookingUrl: value }), String(value)).toBe(replyBody('sales', 'email'));
    }
    expect(bookingLink('https://cal.example.test')).toBe('https://cal.example.test/');
    expect(bookingLink('https://cal.example.test/me?ref=hub')).toBe('https://cal.example.test/me?ref=hub');
  });
});
