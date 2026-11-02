/**
 * What is taken out of a customer's words before they leave the Hub for the model. Customers are told
 * not to send patient or resident information, and the identifier screen (screen.mjs) already keeps a
 * message that carries an obvious identifier away from the model altogether. This is the second line:
 * whatever the screen let through is scrubbed of the things that identify a person or a place, and the
 * characters that could be mistaken for the prompt's own markup are escaped.
 *
 * Replaced with a bracketed word: links (a path can carry a token, so the whole link goes), email
 * addresses, phone numbers, dates, runs of six or more digits (record, member, card and account
 * numbers, with or without separators), street addresses, post office boxes and state-and-ZIP endings.
 * Names cannot be found by pattern, so they stay; the draft is checked for echoing one (draft.mjs).
 *
 * The result says how many of each kind were removed, never what they were. Every pattern is simple, and
 * the text is cut to a fixed length first, so a hostile message cannot make a scan slow.
 */
const inputLimit = 20_000;

const streetWords = 'street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl|terrace|ter|circle|cir|highway|hwy|parkway|pkwy|square|sq';
const monthWords = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';

// Order matters: a link is removed before the email or digits inside it are looked at, and an address (which has digits in it)
// before the general run of digits.
const steps = [
  // Punctuation that ends a sentence is not part of the link, so it stays.
  // The whole link goes, however long: a token can sit anywhere in it. One plain character class repeated is linear in the
  // text, which is already cut to inputLimit.
  ['link', /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, match => `[link]${match.match(/[.,;:!?]+$/)?.[0] ?? ''}`],
  ['email', /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g, '[email]'],
  ['phone', /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]'],
  ['date', new RegExp(String.raw`\b(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2}|(?:${monthWords})[a-z]*\.? \d{1,2},? (?:\d{4}|\d{2}))\b`, 'gi'), '[date]'],
  ['address', new RegExp(String.raw`\b\d{1,6} (?:[A-Za-z0-9.'-]{1,30} ){0,4}(?:${streetWords})\b\.?`, 'gi'), '[address]'],
  ['address', /\bp\.? ?o\.? box \d{1,10}\b/gi, '[address]'],
  ['address', /\b[A-Z]{2} \d{5}(?:-\d{4})?\b/g, '[address]'],
  ['number', /\b(?:\d[ -]?){5,}\d\b/g, '[number]'],
];

/** `<`, `>` and `&` become entities, so customer text cannot close a tag the prompt opened or open one of its own. */
export const escapeMarkup = text => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * @returns {{ text: string, removed: Record<string, number> }} the scrubbed, escaped text (cut to `limit`
 * characters) and how many of each kind of thing was removed.
 */
export function redact(value, { limit = 4000 } = {}) {
  let text = String(value ?? '').slice(0, inputLimit).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  const removed = {};
  for (const [kind, pattern, replacement] of steps) {
    text = text.replace(pattern, (...found) => { removed[kind] = (removed[kind] ?? 0) + 1; return typeof replacement === 'function' ? replacement(found[0]) : replacement; });
  }
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
  return { text: escapeMarkup(text), removed };
}
