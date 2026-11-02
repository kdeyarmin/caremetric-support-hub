import { describe, expect, it } from 'vitest';
import { checkDraft, normalizeTerms, wordsOf } from './draft.mjs';

// Fake data only: "Pat Example", "Resident A. Sample", 555-01xx numbers, example.test addresses.
const guides = [
  { title: 'Export the staff roster', summary: 'Download a roster for any month.', body: 'Open Reports, choose Staff roster, pick a month and select Export. The file is a CSV. A single export is free of limits on the Plus plan.' },
  { title: 'Plans and pricing', summary: 'What each plan costs.', body: 'The Plus plan costs $49 a month. Annual billing saves 10% on the Plus plan.' },
];
const question = 'How do I export the staff roster for last month? Pat Example at Sample Court asked me.';
const good = 'Open Reports, choose Staff roster, pick the month you need and select Export. You will get a CSV file.';
const check = (over = {}) => checkDraft({ reply: good, citations: ['g1'], guides, text: question, route: 'email', ...over });

describe('the checks on a drafted reply', () => {
  it('accepts a plain answer drawn from the guides and lays it out for the route', () => {
    expect(check()).toEqual({ ok: true, reply: good, body: `Hello,\n\n${good}`, citations: ['g1'] });
    const short = 'Open Reports, choose Staff roster, pick a month and select Export.';
    expect(check({ reply: short, route: 'sms' })).toMatchObject({ ok: true, body: `Hello, ${short}` });
    expect(check({ route: 'chat' })).toMatchObject({ ok: true, body: `Hello,\n\n${good}` });
  });

  it('tidies whitespace and keeps paragraphs', () => {
    const result = check({ reply: `  Open  Reports.\r\n\r\n\r\n\r\nChoose   Staff roster.  ` });
    expect(result).toMatchObject({ ok: true, reply: 'Open Reports.\n\nChoose Staff roster.' });
  });

  it('rewrites the retired terms instead of rejecting a draft that uses them', () => {
    expect(normalizeTerms('Our ALR guide: Assisted Living Residence rules, assisted living residences, ALRs and ALR\'s auditors; an Auditor, auditor.'))
      .toBe('Our ALF guide: Assisted Living Facility rules, Assisted Living Facilities, ALFs and ALF\'s surveyors; an Surveyor, surveyor.');
    expect(normalizeTerms('Align and tailor stay as they are; so do the words audit and auditing.')).toBe('Align and tailor stay as they are; so do the words audit and auditing.');
    expect(normalizeTerms(undefined)).toBe('');
    const result = check({ reply: 'Your ALR can export a roster. Open Reports and select Export; auditors see the same file.' });
    expect(result).toMatchObject({ ok: true });
    expect(result.reply).toBe('Your ALF can export a roster. Open Reports and select Export; surveyors see the same file.');
    expect(result.body).not.toMatch(/ALR|auditor/i);
  });

  it('rejects nothing to send and a reply that cites nothing, or a guide it was not given', () => {
    for (const reply of ['', '   ', undefined, null]) expect(check({ reply }), String(reply)).toEqual({ ok: false, reason: 'empty' });
    for (const citations of [[], undefined, 'g1', ['g3'], ['g9'], ['guide 1'], ['g1', 'g0']]) expect(check({ citations }), JSON.stringify(citations)).toEqual({ ok: false, reason: 'citation' });
    expect(check({ citations: ['g1', 'g1', 'g2'] })).toMatchObject({ ok: true, citations: ['g1', 'g2'] });
  });

  it('holds a text message to one message and an email or chat reply to 1,500 characters', () => {
    const words = 'Open Reports and select Export for the month. ';
    expect(check({ reply: words.repeat(8), route: 'sms' })).toMatchObject({ ok: false, reason: 'too_long' });
    expect(check({ reply: words.repeat(6), route: 'sms' })).toMatchObject({ ok: true });
    expect(check({ reply: words.repeat(40) })).toMatchObject({ ok: false, reason: 'too_long' });
    expect(check({ reply: 'Open Reports and select Export. '.repeat(40).trim() })).toMatchObject({ ok: true });
    const atSmsLimit = 'a'.repeat(320 - 'Hello, '.length);
    expect(check({ reply: atSmsLimit, route: 'sms' }).ok).toBe(true);
    expect(check({ reply: `${atSmsLimit}a`, route: 'sms' })).toEqual({ ok: false, reason: 'too_long' });
  });

  it('rejects markup, links, email addresses and phone numbers', () => {
    const cases = {
      markup: ['Open <b>Reports</b> and export.', 'Use `Export` in Reports.', 'See [the guide](page) for the export.', 'Choose **Export** in Reports.', '# Steps\nOpen Reports.'],
      contact_detail: ['Open Reports. More at https://help.example.test/export.', 'See www.example.test for the export steps.', 'Write to help@example.test to export.', 'Open Reports, or text 717-555-0142.'],
    };
    for (const [reason, replies] of Object.entries(cases)) for (const reply of replies) expect(check({ reply }), reply).toEqual({ ok: false, reason });
  });

  it('rejects identifiers the way the inbound screen would', () => {
    for (const reply of ['Your resident DOB 01/01/1900 is on the roster.', 'Use member number 12345678 in Reports.', 'MRN 00123456 can be exported.', 'The SSN 000-12-3456 is hidden.']) {
      expect(check({ reply }), reply).toMatchObject({ ok: false });
    }
  });

  it('allows an amount only when the guides state it', () => {
    expect(check({ reply: 'The Plus plan costs $49 a month.', citations: ['g2'], text: 'How much is the plan?' })).toMatchObject({ ok: true });
    expect(check({ reply: 'Annual billing saves 10% on the Plus plan.', citations: ['g2'], text: 'Is there a discount?' })).toMatchObject({ ok: true });
    for (const reply of ['The Plus plan costs $39 a month.', 'The Plus plan costs $ 49.50 a month.', 'Annual billing saves 15% on the Plus plan.', 'We can offer $500 off.']) {
      expect(check({ reply, citations: ['g2'], text: 'How much is the plan?' }), reply).toEqual({ ok: false, reason: 'unlisted_amount' });
    }
  });

  it('never offers a call, a phone, a voicemail, a meeting or a demo', () => {
    for (const reply of ['Call us and we will help you export.', 'You can give us a call about the roster.', 'Leave a voicemail and open Reports.', 'Our phone support is available.', 'Dial the support line to export.', 'Book a meeting to export the roster.', 'We can run a demo of the export.', 'A telephone is not needed.']) {
      expect(check({ reply }), reply).toEqual({ ok: false, reason: 'voice_offer' });
    }
  });

  it('never promises a refund, a credit, a guarantee, a time frame or a day', () => {
    for (const reply of [
      'We will refund the charge. Open Reports to export.', 'A credit to your account is possible.', 'We guarantee the export works.', 'I promise this will be fixed.', 'We will waive the fee.',
      'Open Reports; it is free of charge.', 'This is available at no extra cost.', 'The export will finish within 2 hours.', 'We will fix it within a day.', 'You will have it by tomorrow.',
      'Expect it by Friday.', 'We will resolve this soon.',
    ]) expect(check({ reply }), reply).toEqual({ ok: false, reason: 'promise' });
  });

  it('never gives legal, compliance or medical advice', () => {
    for (const reply of ['This export is HIPAA compliant.', 'The roster will pass a survey.', 'That is legally required of you.', 'This is not medical advice, but open Reports.', 'Check the dosage in Reports.', 'The diagnosis column is in the export.']) {
      expect(check({ reply }), reply).toEqual({ ok: false, reason: 'advice' });
    }
  });

  it('never claims to be an AI or points at its own prompt', () => {
    for (const reply of ['As an AI, I suggest opening Reports.', 'I am an assistant and Reports has Export.', 'This automated reply says open Reports.', 'The chatbot suggests Export.']) {
      expect(check({ reply }), reply).toEqual({ ok: false, reason: 'ai_mention' });
    }
    for (const reply of ['Guide g1 says to open Reports.', 'My instructions say to select Export.', 'The system prompt covers exports.']) {
      expect(check({ reply }), reply).toEqual({ ok: false, reason: 'prompt_echo' });
    }
  });

  it('rejects a draft that repeats a name or an identifier-like word from the message, unless the guides use it', () => {
    expect(check({ reply: 'Pat, open Reports and select Export.' })).toEqual({ ok: false, reason: 'name_echo' });
    expect(check({ reply: 'For Sample Court, open Reports and select Export.' })).toEqual({ ok: false, reason: 'name_echo' });
    expect(check({ reply: 'Open Reports for that facility and select Export.', text: question })).toMatchObject({ ok: true });
    const message = 'Ticket ZX9-4417 and the CANARY-7f3a91 batch will not export. Is the Reports page down for Pat?';
    expect(check({ reply: 'Open Reports and select Export for batch CANARY-7f3a91.', text: message })).toEqual({ ok: false, reason: 'name_echo' });
    expect(check({ reply: 'Ticket zx9-4417 is not needed; open Reports.', text: message })).toEqual({ ok: false, reason: 'name_echo' });
    // A capital that only starts a sentence is grammar, and a word the guides use is not a name.
    expect(check({ reply: 'Open Reports and select Export.', text: 'Roster export is not working. Please help. Reports are slow.' })).toMatchObject({ ok: true });
    expect(check({ reply: 'Use the Plus plan.', citations: ['g2'], text: 'Is the Plus plan the one with exports?' })).toMatchObject({ ok: true });
  });

  it('rejects a long verbatim quotation of the customer, and allows an answer that shares a short phrase', () => {
    const message = 'Our director of nursing keeps telling every new hire that the roster export fails on the first of each month for her account';
    expect(check({ reply: 'You said the roster export fails on the first of each month for her account, so open Reports.', text: message })).toEqual({ ok: false, reason: 'quotes_customer' });
    expect(check({ reply: 'To export the roster, open Reports and select Export.', text: message })).toMatchObject({ ok: true });
    expect(check({ reply: good, text: 'too short to quote' })).toMatchObject({ ok: true });
  });

  it('lists the words of a text in lower case, as the checks compare them', () => {
    expect(wordsOf("Don't Export it, Pat! v2")).toEqual(["don't", 'export', 'it', 'pat', 'v2']);
    expect(wordsOf(undefined)).toEqual([]);
  });

  it('never puts the draft, the message or a name in a rejection: only the name of the check', () => {
    const result = check({ reply: 'Pat Example, we guarantee a refund of $999 — call 717-555-0142.' });
    expect(Object.keys(result).sort()).toEqual(['ok', 'reason']);
    expect(JSON.stringify(result)).not.toMatch(/Pat|refund|999|717/);
  });
});
