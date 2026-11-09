import { describe, expect, it } from 'vitest';
import { replyBody, smsLimit, templateNames } from './templates.mjs';

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
      const body = replyBody(template, 'sms');
      expect(body.length, template).toBeLessThanOrEqual(smsLimit);
      expect(body.startsWith('Hello, ')).toBe(true);
      expect(body).not.toContain('\n');
    }
  });

  it('says nothing about AI, calls, deletion, security, compliance, prices or outcomes, in any version', () => {
    for (const template of templateNames) {
      for (const route of ['email', 'chat', 'sms']) {
        const body = replyBody(template, route);
        expect(body, `${template}/${route}`).not.toMatch(/\bAI\b|assistant|artificial|robot|bot\b|automat/i);
        expect(body, `${template}/${route}`).not.toMatch(/\bcall(?:s|ing)?\b|phone|voicemail|\d{3}[-. ]\d{3,4}/i);
        expect(body, `${template}/${route}`).not.toMatch(/delet|secure|security|encrypt|complian|HIPAA|\bhours?\b|\bdays?\b|minutes?|soon|refund|guarantee|\$|price|cost|free|discount/i);
        expect(body, `${template}/${route}`).not.toMatch(/ALR|Assisted Living Residence|auditor/);
      }
    }
  });

  it('names no day, promises no personal follow-up and offers no time to meet, in any reply (no personal demos with anyone)', () => {
    for (const template of ['standard', 'phi', 'sales']) for (const route of ['email', 'chat', 'sms']) {
      expect(replyBody(template, route), template).not.toMatch(/today|tomorrow|personally|call|meeting|demo|pick a time|set a time|https?:/i);
    }
    for (const route of ['email', 'chat', 'sms']) expect(replyBody('sales', route)).toMatch(/will reply here with/);
  });

  it('refuses a template it does not know', () => {
    expect(() => replyBody('improvised', 'email')).toThrow(TypeError);
  });
});

describe('the sales reply', () => {
  it('thanks the prospect and says the information will come here', () => {
    expect(replyBody('sales', 'email')).toBe('Hello,\n\nThank you for reaching out to CareMetric. We have your request and will reply here with the information you need.');
    expect(replyBody('sales', 'chat')).toBe(replyBody('sales', 'email'));
    expect(replyBody('sales', 'sms')).toBe('Hello, Thanks for reaching out to CareMetric. We have your request and will reply here with what you need.');
  });

  it('never offers a booking page, even when asked to (no personal demos with anyone, owner decision 2026-11-09)', () => {
    const booking = 'https://cal.example.test/caremetric/intro';
    for (const route of ['email', 'chat', 'sms']) expect(replyBody('sales', route, { bookingUrl: booking })).toBe(replyBody('sales', route));
  });
});
