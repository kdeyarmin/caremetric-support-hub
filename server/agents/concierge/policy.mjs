/**
 * What the Concierge tells the owner about a new message, and how loudly. Pure: a category from
 * the rules and whether the identifier screen flagged the message go in; a severity and the words
 * for the alert come out. Alerts carry the kind of message, the channel, the product, the
 * reference and how long ago it arrived, and nothing the customer wrote.
 *
 * Severity: an outage, a security concern or a legal matter is urgent (the owner is texted and
 * emailed); billing, a cancellation or a message with identifiers is a warning (email); anything
 * else is information (email). A message that carries identifiers is never quieter than a warning.
 */
import { plural } from '../tasks/shared.mjs';

const severities = {
  security: 'urgent', legal: 'urgent', outage: 'urgent', urgent: 'urgent', cancellation: 'warning', billing: 'warning', sales: 'info', general: 'info',
};
/** How much attention each severity asks for, so a second reading can be compared with the first. */
export const severityRank = { info: 1, warning: 2, urgent: 3 };

// `urgent` is not a topic: it is how the model's reading of an ordinary question is recorded when it calls it urgent.
const categoryWords = {
  security: 'possible security concern', legal: 'possible legal matter', outage: 'possible outage report', urgent: 'possible urgent matter',
  cancellation: 'possible cancellation', billing: 'billing question', sales: 'sales or consulting inquiry', general: 'general question',
};
const channelWords = { phone: 'phone-line message', sms: 'text message', email: 'email', chat: 'chat', web_form: 'web form message' };
const productWords = {
  carebase: 'CareBase', breathe: 'Breathe', 'caremetric-intel': 'CareMetric Intel', advisors: 'Healthcare Advisors', pennsync: 'PennSync',
  'caremetric-emr': 'CareMetric EMR', 'caremetric-go': 'CareMetric Go',
};

export const categoryWord = category => categoryWords[category] ?? categoryWords.general;
export const channelWord = channel => channelWords[channel] ?? 'message';
export const productWord = slug => (slug ? productWords[slug] ?? slug : null);

/** { severity } for a message, or { severity: null } when it should not be triaged (an automatic reply). `urgent` is the model's reading, which can only raise the severity. */
export function decide({ category, phi = false, urgent = false }) {
  if (category === 'auto_reply') return { severity: null };
  // `urgent` is a reading of how pressing the message is, separate from its topic: a billing question that cannot wait is still urgent.
  if (urgent) return { severity: 'urgent' };
  const base = severities[category] ?? 'info';
  return { severity: phi && base === 'info' ? 'warning' : base };
}

/** The subject and body of the owner's alert. */
export function alertWords({ category, phi, severity, channel, productSlug, reference, minutes, source = 'rules', unread = false }) {
  const kind = categoryWords[category] ?? categoryWords.general;
  const product = productWord(productSlug);
  const via = channelWord(channel);
  const subject = severity === 'urgent'
    ? `Urgent: ${kind} (CM-${reference}, ${via})`
    : `New ${via}: CM-${reference}${product ? ` for ${product}` : ''}${category === 'general' ? (phi ? ', personal identifiers' : '') : `, ${kind}`}`;
  const ago = minutes === null || minutes === undefined ? 'just now' : minutes <= 1 ? 'a minute ago' : `${plural(minutes, 'minute')} ago`;
  const body = [
    `${/^[aeiou]/i.test(via) ? 'An' : 'A'} ${via}${product ? ` for ${product}` : ''} reached the Hub ${ago}. It looks like a ${kind}${phi ? ' and appears to contain personal identifiers' : ''}.`,
    phi
      ? `Open CM-${reference} in Communications. Please do not forward or copy it: it may contain patient or resident information.`
      : `Open CM-${reference} in Communications. Nothing has been sent to the customer.`,
    unread ? 'It is longer than the part the AI team reads (the first 4,000 characters), so the rest was not screened. Please read all of it.' : null,
    source === 'model'
      ? (severity === 'urgent' ? 'This was flagged by the AI team\'s reading of the message, so it may be a false alarm.' : 'This comes from the AI team\'s reading of the message.')
      : (severity === 'urgent' ? 'This was flagged by simple word matching, so it may be a false alarm.' : null),
  ].filter(Boolean).join('\n\n');
  return { subject, body };
}

/**
 * Which fixed reply, if any, to offer the owner for a message. Only a plain question gets one: the owner answers
 * an outage, a security or legal matter, billing, a cancellation and a sales or consulting inquiry personally.
 * A plain question that carries identifiers gets the notice that asks the sender to resend without them.
 */
export function replyFor({ category, phi = false, productSlug = null, inquiryType = null }) {
  if (category !== 'general') return null;
  if (productSlug === 'advisors' || inquiryType === 'sales' || inquiryType === 'advisors') return null;
  return phi ? 'phi' : 'standard';
}

/** How a reply to the conversation would travel, from what its snapshot says it can reach; null when it cannot be answered. */
export function replyRoute({ channel, canEmail = false, canText = false }) {
  if (channel === 'chat') return 'chat';
  if (channel === 'sms') return canText ? 'sms' : null;
  if (channel === 'email') return canEmail ? 'email' : null;
  // A phone-line message or a web form: by email if there is an address, else by text.
  return canEmail ? 'email' : canText ? 'sms' : null;
}
