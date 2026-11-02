/**
 * The hard-flag screen: does a message contain something that looks like a personal identifier
 * (a Social Security number, a date of birth, a record or member number, a Medicare number, a
 * payment card)? Customers are told not to send patient or resident information, but text and
 * email cannot enforce it, so every inbound message is checked before anything else happens.
 *
 * It answers with kinds only, never with the matching text. A flagged message gets a fixed
 * acknowledgment instead of anything written about it, and nothing it says is repeated.
 * Soft words such as "resident" or "medication" never flag on their own: nearly every question
 * from an assisted living facility uses them.
 *
 * Every pattern is bounded (no unbounded repetition inside another), so a hostile message cannot
 * make a scan slow; the text is also cut to 20,000 characters first.
 */
const limit = 20_000;

const ssn = /\b\d{3}[- ]\d{2}[- ]\d{4}\b|\b\d{9}\b/;
const date = String.raw`(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2},? (?:\d{4}|\d{2}))`;
const dob = new RegExp(String.raw`\b(?:dob|d\.o\.b\.?|date of birth|birth ?date|born(?: on)?)\b[^\n]{0,30}?\b${date}\b`, 'i');
const recordNumber = /\b(?:mrn|medical record(?: number| no\.?| #)?|member (?:id|number|no\.?|#)|policy (?:id|number|no\.?|#)|patient (?:id|number|#)|resident (?:id|number|#)|chart (?:number|no\.?|#))[^\n]{0,20}?\b[a-z]{0,3}\d{5,}\b/i;
// A Medicare Beneficiary Identifier: 11 characters in a fixed pattern of digits and letters (never S, L, O, I, B or Z), often written 1EG4-TE5-MK73.
const medicare = /\b[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[- ]?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[- ]?[AC-HJKMNP-RT-Y]{2}\d{2}\b/i;
const cardCandidate = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) { value *= 2; if (value > 9) value -= 9; }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text) {
  for (const [candidate] of text.matchAll(cardCandidate)) {
    const digits = candidate.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

/** Returns { flagged, kinds } where kinds are drawn from ssn, dob, record_number, medicare_id and card_number. */
export function screenIdentifiers(value) {
  const text = String(value ?? '').slice(0, limit);
  const kinds = [];
  if (ssn.test(text)) kinds.push('ssn');
  if (dob.test(text)) kinds.push('dob');
  if (recordNumber.test(text)) kinds.push('record_number');
  if (medicare.test(text)) kinds.push('medicare_id');
  if (hasCardNumber(text)) kinds.push('card_number');
  return { flagged: kinds.length > 0, kinds };
}
