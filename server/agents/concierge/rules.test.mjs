import { describe, expect, it } from 'vitest';
import { categorize, ownWords, withoutTrialPhrase } from './rules.mjs';
import { intelReviewedFacts, trialCardTerms } from '../content/facts.mjs';
import { salesPlaybook, reportTouchAngle, reviewTouchAngle } from '../../growth/playbook.mjs';

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

  it('reads every form of the word sue, and nothing that only contains it', () => {
    for (const text of ['We are suing your company.', 'They sued us last year and we want out.', 'Suing is the next step.', 'If it is not fixed we will sue.']) expect(category(text), text).toBe('legal');
    for (const text of ['We are pursuing the issue with a suite of tools.', 'Is this suitable for a small facility?', 'The tissue box report is wrong.']) expect(category(text), text).toBe('general');
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

  it('never lets a guess that a message is automatic hide an urgent report', () => {
    expect(category('Our account was hacked while I was out of the office. Please help.')).toBe('security');
    expect(category('My attorney will contact you. I am out of the office until Monday.')).toBe('legal');
    expect(category('Everyone can\'t log in.', 'Automatic reply: Re: hello')).toBe('outage');
  });

  it('does not mistake a person for a machine', () => {
    expect(category('We will be out of the office next week. Please cancel our subscription.')).toBe('cancellation');
    expect(category('We are out of the office on Friday. We were charged twice this month.')).toBe('billing');
    expect(category('Our emails to customers are undeliverable, can you help?')).toBe('general');
    expect(category('How do I export the roster? Please do not reply by phone, only by email.')).toBe('general');
    expect(category('We are away from the office, so please answer by email: how do I reset a password?', 'Re: Hello')).toBe('auto_reply');
  });

  it('still trusts the labels a mail system adds', () => {
    expect(category('Thanks. Invoice attached.', 'Automatic reply: Invoice from CareMetric')).toBe('auto_reply');
    expect(category('We were charged twice.', 'Out of office: back Nov 9')).toBe('auto_reply');
    expect(category('x', 'RE: Undeliverable: Your question')).toBe('auto_reply');
    expect(category('From: MAILER-DAEMON@mail.example.test\nDelivery has failed to these recipients.')).toBe('auto_reply');
    expect(category('From: Mail Delivery Subsystem <mailer-daemon@mail.example.test>\nWe could not deliver your message.')).toBe('auto_reply');
    expect(category('Please see the attached.', 'Fwd: Auto-reply')).toBe('auto_reply');
  });

  it('is not fooled by a machine address that a person mentions or forwards', () => {
    expect(category('Please cancel our subscription. Send the confirmation to postmaster@example.test.')).toBe('cancellation');
    expect(category('How do I export the roster? Send the file to noreply@example.test please.')).toBe('general');
    expect(category('Hi, my password reset does not work. The message is below.\n\nFrom: noreply@example.test\nSubject: Reset your password')).toBe('general');
    expect(category('Our emails from no-reply@example.test never arrive, and the account was hacked.')).toBe('security');
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

describe('a reply with the original email quoted under it', () => {
  const outreach = 'I run a home health and hospice agency. You can try CareMetric Intel free for 30 days, no credit card needed.\n\nOpt out of these emails: https://hub.example.org/api/growth/preferences/abc';
  const quoted = outreach.split('\n').map(line => `> ${line}`).join('\n');
  const replies = [
    `Yes, tell me more about the free trial.\n\nOn Tue, Nov 10, 2026 at 3:14 PM Kevin Deyarmin <growth@example.org> wrote:\n${quoted}`,
    `Yes, tell me more about the free trial.\n\nOn Tue, Nov 10, 2026 at 3:14 PM Kevin Deyarmin\n<growth@example.org> wrote:\n${quoted}`,
    `Yes, tell me more about the free trial.\n\n-----Original Message-----\nFrom: Kevin Deyarmin\nSent: Tuesday\n\n${outreach}`,
    `Yes, tell me more about the free trial.\n\nFrom: Kevin Deyarmin <growth@example.org>\nSent: Tuesday, November 10, 2026 3:14 PM\nTo: Info\nSubject: A question\n\n${outreach}`,
    `Yes, tell me more about the free trial.\n\n${quoted}`,
  ];
  it('is not a billing matter because the company\'s own email is under it, so a prospect\'s answer reaches sales', () => {
    for (const reply of replies) expect(categorize({ text: reply, subject: 'Re: A question' }), reply.slice(40, 90)).toMatchObject({ category: 'sales' });
    // Nor is the company's own trial sentence, quoted with a mark, with none, or on its own.
    for (const words of ['A 30-day free trial with no credit card.', 'The free trial needs no credit card.', 'A 30-day free trial (credit card required; canceling before it ends avoids any charge).', 'A credit card is required to start the trial, and the plan chosen at sign-up bills automatically when the trial ends unless it is canceled before then.', outreach, quoted])
      expect(categorize({ text: words }).category, words).not.toBe('billing');
  });
  it('still reads billing and cancellation wherever the sender wrote them, and every urgent kind in the quote', () => {
    expect(categorize({ text: `Please refund my last invoice.\n\nOn Tue, Nov 10, 2026 Kevin wrote:\n${quoted}` }).category).toBe('billing');
    expect(categorize({ text: `We need to cancel our subscription.\n\n${quoted}` }).category).toBe('cancellation');
    // An answer typed under the quote, after a line of introduction above it.
    expect(categorize({ text: 'See my answer below.\n\nOn Tue, Nov 10, 2026 Kevin wrote:\n> Would you like to continue?\n\nPlease cancel our subscription.' }).category).toBe('cancellation');
    expect(categorize({ text: `See below.\n\n${quoted}\n\nPlease refund my last invoice.` }).category).toBe('billing');
    // An answer typed under an original quoted with no mark cannot be told from it, so nothing there is dropped.
    expect(categorize({ text: 'See below.\n\n-----Original Message-----\nFrom: Kevin\nSent: Tuesday\n\nWould you like to continue?\n\nPlease cancel our subscription.' }).category).toBe('cancellation');
    expect(categorize({ text: 'See below.\n\nFrom: Kevin <growth@example.org>\nSent: Tuesday\nSubject: A question\n\nWould you like to continue?\n\nWe were charged twice.' }).category).toBe('billing');
    expect(categorize({ text: 'See below.\n\nOn Tue, Nov 10, 2026 Kevin wrote:\n> Our account was hacked last night.' }).category).toBe('security');
    // A credit card that is the sender's own matter is billing, with or without the word "no".
    for (const words of ['Please update the credit card on our account.', 'I have no credit card on file. How do I pay?', 'There is no credit card charge on my statement, but you sent a receipt.'])
      expect(categorize({ text: words }).category, words).toBe('billing');
  });
  it('keeps card-management requests during a trial as billing in the subject or body', () => {
    for (const request of [
      'How do I update my credit card during the free trial?',
      'Please change the credit card for my trial.',
      'Please try another credit card.',
      'I have no credit card on file during my free trial.',
      'Please update the credit card required for my trial.',
    ]) {
      expect(withoutTrialPhrase(request)).toBe(request);
      for (const message of [{ text: request }, { subject: request, text: 'Please help.' }])
        expect(categorize(message)).toEqual({ category: 'billing', reasons: ['billing.invoice'] });
      expect(category(`I am out of the office. ${request}`)).toBe('billing');
    }
  });
  it('neutralizes old and new disclosures without hiding adjacent card requests', () => {
    const request = 'Please change the credit card for my trial.';
    for (const disclosure of [
      'You can try CareMetric Intel free for 30 days, no credit card needed.',
      'A 30-day free trial with no credit card.',
      'The free trial needs no credit card.',
      'A 30-day free trial (credit card required; canceling before it ends avoids any charge).',
      'A credit card is required to start the trial, and the plan chosen at sign-up bills automatically when the trial ends unless it is canceled before then.',
    ]) {
      for (const original of [disclosure, `> ${disclosure}`, `-----Original Message-----\n${disclosure}`]) {
        expect(category(`Tell me more about the free trial.\n\n${original}`)).toBe('sales');
        expect(category(`${request}\n\n${original}`)).toBe('billing');
        expect(category(`See below.\n\n${original}\n\n${request}`)).toBe('billing');
        expect(category(original, request)).toBe('billing');
      }
      // Both card occurrences share a sentence; only the disclosure may be neutralized.
      const adjacent = `${disclosure.replace(/\.$/, '')}; ${request}`;
      expect(withoutTrialPhrase(adjacent)).toContain(request);
      expect(category(adjacent)).toBe('billing');
      expect(category(`I am out of the office. ${adjacent}`)).toBe('billing');
    }
  });
  it('recognizes every current playbook and fact-sheet disclosure in an unmarked reply', () => {
    const book = salesPlaybook['caremetric-intel'];
    const disclosures = [
      ...book.valuePoints,
      ...book.objections.map(objection => objection.answer),
      ...intelReviewedFacts.offers,
      trialCardTerms,
      reportTouchAngle,
      reviewTouchAngle,
      // docs/INTEL_MARKETING_PLAYBOOK.md trial terms and the site wording cited in docs/GTM_FACTS.md.
      '30-day free trial, one county, 3 marketer seats and 1 manager seat. A credit card is required to start it, and the plan chosen at sign-up bills automatically when it ends unless canceled first.',
      'Credit card required · Cancel before trial end to avoid charges',
    ].filter(disclosure => /credit card/i.test(disclosure));
    expect(disclosures.length).toBeGreaterThanOrEqual(9);
    const request = 'Please change the credit card for my trial.';
    for (const disclosure of disclosures) {
      expect(withoutTrialPhrase(disclosure), disclosure).not.toMatch(/credit card/i);
      expect(category(`Tell me more about the free trial.\n\n-----Original Message-----\n${disclosure}`), disclosure).toBe('sales');
      for (const text of [`${request}\n${disclosure}`, `${disclosure}\n${request}`, `${disclosure}; ${request}`, `I am out of the office. ${request}\n${disclosure}`])
        expect(category(text), text).toBe('billing');
      expect(category(disclosure, request)).toBe('billing');
    }
  });
  it('does not treat card-management wording inside a trial clause as a disclosure', () => {
    for (const text of [
      'A free trial (please update my credit card).',
      'A free trial on one county (change the credit card required for it).',
      'A free trial on one county, my credit card is required to be updated.',
      'My free trial has ended. A credit card is required to start it again; please change mine.',
      'Please change the credit card required to start the trial.',
    ]) {
      expect(withoutTrialPhrase(text)).toBe(text);
      expect(category(text)).toBe('billing');
    }
  });
  it('preserves urgent priority and machine labels for trial card requests', () => {
    const request = 'Please change the credit card for my trial.';
    for (const [urgent, expected] of [['Our account was hacked.', 'security'], ['My attorney will contact you.', 'legal'], ['The site is down.', 'outage']])
      expect(category(`${request}\n> ${urgent}`, 'Automatic reply: trial')).toBe(expected);
    for (const subject of ['Automatic reply: trial', 'Out of office: trial', 'Undeliverable: trial'])
      expect(category(request, subject)).toBe('auto_reply');
    expect(category(`From: MAILER-DAEMON@example.test\n${request}`)).toBe('auto_reply');
  });
  it('drops only marked quotes and the line that introduces them', () => {
    expect(ownWords(`${quoted}\n\nPlease refund my invoice.`)).toBe('Please refund my invoice.');
    expect(ownWords(`Above.\n\nOn Tue, Nov 10, 2026 Kevin wrote:\n${quoted}\n\nBelow.`)).toBe('Above.\n\n\nBelow.');
    expect(ownWords(`Above.\n\nOn Tue, Nov 10, 2026 Kevin\n<growth@example.org> wrote:\n\n${quoted}`)).toBe('Above.');
    // All quote, or a quote under an attribution with no words of the sender's: returned whole.
    expect(ownWords(quoted)).toBe(quoted);
    expect(ownWords(`On Tue, Nov 10, 2026 Kevin wrote:\n${quoted}`)).toContain('credit card');
    // "On ..." that introduces no marked quote is the sender's own sentence, and an unmarked original is kept.
    expect(ownWords('On Monday we will start. Our invoice is attached.')).toBe('On Monday we will start. Our invoice is attached.');
    expect(ownWords('On Tuesday my manager wrote:\nPlease cancel our subscription.')).toBe('On Tuesday my manager wrote:\nPlease cancel our subscription.');
    expect(ownWords(`Yes.\n\n-----Original Message-----\n${outreach}`)).toContain('no credit card needed');
  });
  it('sets aside only the company\'s own trial phrase, in its own sentence', () => {
    expect(withoutTrialPhrase('A 30-day free trial with no credit card.')).toBe('A 30-day free trial with no card.');
    expect(withoutTrialPhrase('Try it free for 30 days. A credit card is required to start the trial.')).toBe('Try it free for 30 days. A card is required to start the trial.');
    expect(withoutTrialPhrase('Try it free. Our credit card was charged twice.')).toBe('Try it free. Our credit card was charged twice.');
    expect(withoutTrialPhrase('A free trial, credit card required.')).toBe('A free trial, card required.');
    expect(withoutTrialPhrase('Try it free for 30 days, No Credit Card needed. Our credit card was charged twice.')).toBe('Try it free for 30 days, no card needed. Our credit card was charged twice.');
    expect(withoutTrialPhrase('I have no credit card on file. Is the trial free?')).toBe('I have no credit card on file. Is the trial free?');
    expect(withoutTrialPhrase('Nothing here.')).toBe('Nothing here.');
    // A very long line with no sentence breaks is scanned once.
    const long = `${'word '.repeat(4000)}no credit card`;
    expect(withoutTrialPhrase(long)).toBe(long);
  });
});
