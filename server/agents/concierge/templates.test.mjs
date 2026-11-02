import { describe, expect, it } from 'vitest';
import { replyBody, smsLimit, templateNames } from './templates.mjs';

describe('the fixed replies', () => {
  it('has the two replies the Concierge offers', () => {
    expect(templateNames).toEqual(['standard', 'phi']);
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

  it('says nothing about AI, calls, deletion, security, compliance or time, in any version', () => {
    for (const template of templateNames) {
      for (const route of ['email', 'chat', 'sms']) {
        const body = replyBody(template, route);
        expect(body, `${template}/${route}`).not.toMatch(/\bAI\b|assistant|artificial|robot|bot\b/i);
        expect(body, `${template}/${route}`).not.toMatch(/\bcall(?:s|ing)?\b|phone|voicemail|\d{3}[-. ]\d{3,4}/i);
        expect(body, `${template}/${route}`).not.toMatch(/delet|secure|security|encrypt|complian|HIPAA|\bhours?\b|\bdays?\b|minutes?|soon|today|refund|guarantee/i);
        expect(body, `${template}/${route}`).not.toMatch(/ALR|auditor/);
      }
    }
  });

  it('refuses a template it does not know', () => {
    expect(() => replyBody('improvised', 'email')).toThrow(TypeError);
  });
});
