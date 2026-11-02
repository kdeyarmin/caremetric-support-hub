import { describe, expect, it } from 'vitest';
import { screenIdentifiers } from './screen.mjs';

// Fake data only: a 000-prefix SSN, a 1900 birth date, example numbers.
const kinds = text => screenIdentifiers(text).kinds;

describe('the identifier screen', () => {
  it('flags a Social Security number however it is written', () => {
    for (const text of ['My SSN is 000-12-3456.', 'ssn 000 12 3456', 'Her number: 000123456 thanks', '000-12-3456']) expect(kinds(text), text).toContain('ssn');
  });

  it('flags a date of birth only next to a birth word', () => {
    for (const text of ['DOB 01/01/1900', 'Date of birth: January 1, 1900', 'she was born on 1900-01-01', 'd.o.b. 1-1-00', 'birthdate: Jan 1 1900']) expect(kinds(text), text).toContain('dob');
    for (const text of ['Our meeting is on 01/01/2026.', 'The invoice is dated 2026-11-02', 'Born in the USA']) expect(kinds(text), text).not.toContain('dob');
  });

  it('flags a record, member, policy, patient or resident number', () => {
    for (const text of ['MRN 1234567', 'medical record number: 7654321', 'Member ID: AB12345678', 'policy # 555555', 'patient id 98765', 'resident number 123456', 'chart no. 55555']) expect(kinds(text), text).toContain('record_number');
    for (const text of ['I lost my member id', 'The policy number is on the form', 'resident id 12']) expect(kinds(text), text).not.toContain('record_number');
  });

  it('flags a Medicare number, with or without hyphens', () => {
    for (const text of ['1EG4-TE5-MK73', '1EG4TE5MK73', '1eg4 te5 mk73', 'her MBI is 1EG4-TE5-MK73 please']) expect(kinds(text), text).toContain('medicare_id');
    for (const text of ['SELECT * FROM table', '1SG4-TE5-MK73', 'CM-1042']) expect(kinds(text), text).not.toContain('medicare_id');
  });

  it('flags a payment card number that passes the check digit, and only that', () => {
    for (const text of ['card 4111 1111 1111 1111', '4111-1111-1111-1111', '5500000000000004 exp 12/30']) expect(kinds(text), text).toContain('card_number');
    for (const text of ['card 4111 1111 1111 1112', 'order 1234567890123', 'Call 555-0100 or (555) 010-0123']) expect(kinds(text), text).not.toContain('card_number');
  });

  it('leaves an ordinary question alone, even one full of soft words', () => {
    for (const text of [
      'How do I export the staff roster by month?',
      'Our resident census is 45 and the medication report will not load.',
      'Can you add a second administrator for our Assisted Living Facility? Reference CM-1042.',
      'The surveyor visit is on 11/17. Our zip is 12345-6789 and our phone is 555-010-0123.',
      '',
    ]) expect(screenIdentifiers(text), text).toEqual({ flagged: false, kinds: [] });
    expect(screenIdentifiers(undefined)).toEqual({ flagged: false, kinds: [] });
    expect(screenIdentifiers(null)).toEqual({ flagged: false, kinds: [] });
  });

  it('reports every kind found, and never the text that matched', () => {
    const text = 'Resident A. Sample, DOB 01/01/1900, SSN 000-12-3456, MRN 1234567, card 4111 1111 1111 1111, MBI 1EG4-TE5-MK73';
    const result = screenIdentifiers(text);
    expect(result).toEqual({ flagged: true, kinds: ['ssn', 'dob', 'record_number', 'medicare_id', 'card_number'] });
    expect(JSON.stringify(result)).not.toMatch(/Sample|1900|000-12|1234567|4111|1EG4/);
  });

  it('stays fast on hostile input', () => {
    const started = performance.now();
    for (const text of ['1 '.repeat(10_000), '1-'.repeat(10_000), `dob ${'1'.repeat(19_000)}`, `mrn ${'a'.repeat(19_000)}`, 'DOB '.repeat(5_000), `${'9'.repeat(19_990)} x`]) screenIdentifiers(text);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('reads only the first 20,000 characters', () => {
    expect(screenIdentifiers(`${'x'.repeat(20_000)} SSN 000-12-3456`).flagged).toBe(false);
  });
});
