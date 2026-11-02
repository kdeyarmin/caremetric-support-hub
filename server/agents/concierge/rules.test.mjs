import { describe, expect, it } from 'vitest';
import { categorize } from './rules.mjs';

const category = (text, subject = null) => categorize({ text, subject }).category;

describe('message categories by word matching', () => {
  it('spots an outage', () => {
    for (const text of [
      'Everything is down for every user at our facility.',
      'The site is down for all of our staff since 8am',
      'Nobody can log in to CareBase this morning.',
      'Is there an outage? None of us can open the app.',
      'The website is completely down.',
    ]) expect(category(text), text).toBe('outage');
  });

  it('spots a security concern', () => {
    for (const text of ['Someone logged in as me last night.', 'I think our account was hacked', 'We saw a suspicious login from another state.', 'Is this a data breach?', 'Unauthorized access to our admin account']) expect(category(text), text).toBe('security');
  });

  it('spots a legal matter', () => {
    for (const text of ['My attorney will contact you.', 'We will sue if this is not fixed.', 'This is a HIPAA complaint.', 'I will be reporting you to the attorney general', 'We received a subpoena for your records']) expect(category(text), text).toBe('legal');
  });

  it('spots a cancellation and a billing question', () => {
    for (const text of ['We will cancel our subscription unless this is fixed today.', 'Please close our account.', 'We are switching to a competitor.', 'I want to cancel the service', 'We will cancel unless this is fixed today.', 'We\'ll have to cancel']) expect(category(text), text).toBe('cancellation');
    for (const text of ['We were charged twice this month.', 'I need a refund.', 'Our payment failed again.', 'Where do I find the invoice?', 'There is a billing error on our statement']) expect(category(text), text).toBe('billing');
  });

  it('spots a sales or consulting inquiry', () => {
    for (const text of ['We run 12 ALFs and are interested in consulting.', 'How much does the Intel plan cost?', 'Can we see a demo?', 'Could you send a proposal?']) expect(category(text), text).toBe('sales');
  });

  it('treats everything else as a general question, with no reasons', () => {
    for (const text of ['How do I export the staff roster by month?', 'Our resident census report shows the wrong total.', 'Thanks, that fixed it!']) expect(categorize({ text }), text).toEqual({ category: 'general', reasons: [] });
  });

  it('puts the most urgent kind first when a message has several', () => {
    expect(category('Our payment failed and now everything is down for everyone. We will cancel the account.')).toBe('outage');
    expect(category('I was charged twice and someone logged in as me.')).toBe('security');
    expect(category('Please cancel our account, my lawyer says we are owed a refund.')).toBe('legal');
  });

  it('reads an email subject with the body', () => {
    expect(category('Please call me.', 'URGENT: outage at our facility')).toBe('outage');
    expect(category('Please call me.', 'Quick question')).toBe('general');
  });

  it('recognizes an empty message, an automatic reply and a bounce, near the start only', () => {
    for (const text of ['[Empty text message]', '[Empty email]', 'Automatic reply: I am out of the office until Monday.', 'Out of office: back Nov 9', 'Mail Delivery Subsystem: Undeliverable', 'Please do not reply to this message.']) expect(category(text), text).toBe('auto_reply');
    expect(category(`${'x '.repeat(300)} automatic reply`)).toBe('general');
    expect(category('[Empty email]', 'Re: Your question')).toBe('auto_reply');
  });

  it('names the rules that matched and never the words', () => {
    const result = categorize({ text: 'Someone logged in as me. Our account was hacked, an unauthorized login.' });
    expect(result.category).toBe('security');
    expect(result.reasons).toEqual(['security.hacked', 'security.unauthorized', 'security.someone_in_account']);
    expect(JSON.stringify(result)).not.toMatch(/logged in as me|hacked,/);
  });

  it('ignores nothing it was given and survives odd input', () => {
    for (const input of [undefined, {}, { text: null }, { text: 42 }]) expect(categorize(input).category).toBe('general');
  });

  it('stays fast on hostile input', () => {
    const started = performance.now();
    for (const text of ['down '.repeat(4000), `everyone ${'can\'t '.repeat(3000)}`, `cancel ${'x'.repeat(19_000)}`, `someone ${'a '.repeat(9000)}`, 'billing '.repeat(2500)]) categorize({ text });
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
