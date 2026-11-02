import { describe, expect, it } from 'vitest';
import { alertWords, categoryWord, channelWord, decide, productWord, replyFor, replyRoute } from './policy.mjs';

describe('how loudly the owner is told', () => {
  it('texts the owner about an outage, a security concern and a legal matter', () => {
    for (const category of ['outage', 'security', 'legal']) expect(decide({ category }), category).toEqual({ severity: 'urgent' });
  });

  it('emails a warning for billing and cancellation, and information for the rest', () => {
    for (const category of ['billing', 'cancellation']) expect(decide({ category }), category).toEqual({ severity: 'warning' });
    for (const category of ['sales', 'general']) expect(decide({ category }), category).toEqual({ severity: 'info' });
  });

  it('never makes a message with identifiers quieter than a warning', () => {
    expect(decide({ category: 'general', phi: true })).toEqual({ severity: 'warning' });
    expect(decide({ category: 'sales', phi: true })).toEqual({ severity: 'warning' });
    expect(decide({ category: 'outage', phi: true })).toEqual({ severity: 'urgent' });
  });

  it('does not triage an automatic reply, and treats an unknown category as information', () => {
    expect(decide({ category: 'auto_reply' })).toEqual({ severity: null });
    expect(decide({ category: 'mystery' })).toEqual({ severity: 'info' });
  });
});

describe('the words of an alert', () => {
  const base = { category: 'general', phi: false, severity: 'info', channel: 'email', productSlug: 'carebase', reference: 1042, minutes: 5 };

  it('names the kind, the channel, the product, the reference and the age, and promises nothing was sent', () => {
    expect(alertWords(base)).toEqual({
      subject: 'New email: CM-1042 for CareBase',
      body: 'An email for CareBase reached the Hub 5 minutes ago. It looks like a general question.\n\nOpen CM-1042 in Communications. Nothing has been sent to the customer.',
    });
  });

  it('puts everything an urgent text needs in its subject', () => {
    const words = alertWords({ ...base, category: 'outage', severity: 'urgent', channel: 'chat', productSlug: null, minutes: 1 });
    expect(words.subject).toBe('Urgent: possible outage report (CM-1042, chat)');
    expect(words.body).toContain('A chat reached the Hub a minute ago.');
    expect(words.body).toContain('This was flagged by simple word matching, so it may be a false alarm.');
    expect(words.subject.length).toBeLessThan(100);
  });

  it('warns not to copy a message that appears to contain identifiers', () => {
    const words = alertWords({ ...base, phi: true, severity: 'warning' });
    expect(words.body).toContain('appears to contain personal identifiers');
    expect(words.body).toContain('Please do not forward or copy it');
    expect(words.body).not.toContain('Nothing has been sent');
  });

  it('says so in the subject when a general message carries identifiers', () => {
    expect(alertWords({ ...base, phi: true, severity: 'warning' }).subject).toBe('New email: CM-1042 for CareBase, personal identifiers');
  });

  it('adds the kind to the subject of a flagged, non-urgent message', () => {
    expect(alertWords({ ...base, category: 'billing', severity: 'warning', channel: 'sms', productSlug: 'breathe' }).subject).toBe('New text message: CM-1042 for Breathe, billing question');
  });

  it('copes with an unknown age, channel or product', () => {
    const words = alertWords({ ...base, minutes: null, channel: 'carrier_pigeon', productSlug: 'new-product' });
    expect(words.subject).toBe('New message: CM-1042 for new-product');
    expect(words.body).toContain('reached the Hub just now');
  });

  it('has a word for every channel, category and product it knows', () => {
    expect(['phone', 'sms', 'email', 'chat', 'web_form'].map(channelWord)).toEqual(['phone-line message', 'text message', 'email', 'chat', 'web form message']);
    expect(categoryWord('billing')).toBe('billing question');
    expect(categoryWord('mystery')).toBe('general question');
    expect(productWord('advisors')).toBe('Healthcare Advisors');
    expect(productWord(null)).toBeNull();
  });
});

describe('which reply to offer the owner', () => {
  it('offers the acknowledgment for a plain question, and the identifier notice when it carries identifiers', () => {
    expect(replyFor({ category: 'general' })).toBe('standard');
    expect(replyFor({ category: 'general', phi: true })).toBe('phi');
    expect(replyFor({ category: 'general', productSlug: 'carebase', inquiryType: 'technical_support' })).toBe('standard');
  });

  it('leaves everything but a plain question to the owner', () => {
    for (const category of ['outage', 'security', 'legal', 'billing', 'cancellation', 'sales', 'auto_reply', 'mystery']) {
      expect(replyFor({ category }), category).toBeNull();
      expect(replyFor({ category, phi: true }), `${category} with identifiers`).toBeNull();
    }
  });

  it('leaves an Advisors or sales conversation to the owner, even a plain one', () => {
    expect(replyFor({ category: 'general', productSlug: 'advisors' })).toBeNull();
    expect(replyFor({ category: 'general', inquiryType: 'advisors' })).toBeNull();
    expect(replyFor({ category: 'general', inquiryType: 'sales', phi: true })).toBeNull();
  });

  it('leaves a conversation filed as billing to the owner, whatever its words say', () => {
    // A phone-line message tagged billing may read only "Please help", which no word rule can tell from a plain question.
    expect(replyFor({ category: 'general', inquiryType: 'billing' })).toBeNull();
    expect(replyFor({ category: 'general', inquiryType: 'billing', phi: true })).toBeNull();
    expect(replyFor({ category: 'general', inquiryType: 'customer_service' })).toBe('standard');
  });
});

describe('how a reply would travel', () => {
  it('answers chat, text and email in their own channel, when they can be reached', () => {
    expect(replyRoute({ channel: 'chat' })).toBe('chat');
    expect(replyRoute({ channel: 'sms', canText: true })).toBe('sms');
    expect(replyRoute({ channel: 'email', canEmail: true })).toBe('email');
    expect(replyRoute({ channel: 'sms', canText: false })).toBeNull();
    expect(replyRoute({ channel: 'email', canEmail: false, canText: true })).toBeNull();
  });

  it('answers a phone-line message or a web form by email when there is an address, else by text', () => {
    for (const channel of ['phone', 'web_form']) {
      expect(replyRoute({ channel, canEmail: true, canText: true })).toBe('email');
      expect(replyRoute({ channel, canEmail: true })).toBe('email');
      expect(replyRoute({ channel, canText: true })).toBe('sms');
      expect(replyRoute({ channel })).toBeNull();
    }
  });
});
