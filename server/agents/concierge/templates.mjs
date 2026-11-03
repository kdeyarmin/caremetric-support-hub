/**
 * The fixed replies the Concierge offers the owner to send. They are written once, here, and reviewed like
 * any other copy; nothing a customer wrote is ever repeated in them. They say nothing about AI (the owner reads
 * and approves each one, and it goes out under their name), promise no refund, price or outcome, and never offer a
 * phone call. A text message gets a shorter version that fits one message of 320 characters.
 *
 * - standard: the message arrived and a person will review it.
 * - phi: the message appears to carry patient or resident information, which these channels are not set up
 *   for. It does not quote, confirm or deny anything the customer wrote, and makes no claim about what happens to it.
 * - sales: for a prospect (a website lead or a conversation filed as a sale), in the owner's own voice: thanks, and the
 *   owner will follow up personally today. It is the only reply that names a day, because the owner approves it the day
 *   they send it. When the owner's booking page is configured (HUB_BOOKING_URL, https only) it also offers "pick a time
 *   that suits you" with that link: this is the only place the Concierge ever offers a link.
 */
export const smsLimit = 320;

const greeting = 'Hello,';
const bodies = {
  standard: {
    long: 'Thank you for contacting CareMetric Support. We have your message and a member of our team will review it and reply here.',
    short: 'Thanks for contacting CareMetric Support. We have your message and will reply here.',
  },
  phi: {
    long: 'Thank you for contacting CareMetric Support. Our support channels are not set up to receive patient or resident information, so we have not acted on the details in your message. Please send your question again without names, dates of birth, record numbers or health details, and a member of our team will review it.',
    short: 'CareMetric Support: please do not send patient or resident details here. Send your question again without names, birth dates or record numbers and we will review it.',
  },
  sales: {
    long: 'Thank you for reaching out to CareMetric. I have your request, and I will follow up with you personally today.',
    short: 'Thanks for reaching out to CareMetric. I have your request and will follow up with you personally today.',
  },
};
const booking = { long: 'If you would like to set a time now, pick a time that suits you: ', short: 'Or pick a time that suits you: ' };
const bookingLimit = 200;

export const templateNames = Object.keys(bodies);

/**
 * The owner's booking page as the sales reply may offer it, or null. Only an absolute https address with a host, no user name or
 * password, no spaces or control characters and at most 200 characters counts; anything else means no link at all.
 */
export function bookingLink(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > bookingLimit || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return url.href.length <= bookingLimit ? url.href : null;
}

/** The greeting and the text, laid out for the route the message will travel: one line for a text message, a paragraph for the rest. */
export function wrapReply(text, route) {
  return route === 'sms' ? `${greeting} ${text}` : `${greeting}\n\n${text}`;
}

/**
 * The whole message for a template, ready to send by the route it will travel (sms, email or chat). `bookingUrl` is used by the sales
 * reply alone, and only when `bookingLink` accepts it; a text message leaves it out if it would not fit one message.
 */
export function replyBody(template, route, { bookingUrl = null } = {}) {
  const words = bodies[template];
  if (!words) throw new TypeError('Unknown reply template.');
  const link = template === 'sales' ? bookingLink(bookingUrl) : null;
  if (route === 'sms') {
    const offered = link ? wrapReply(`${words.short} ${booking.short}${link}`, route) : null;
    return offered && offered.length <= smsLimit ? offered : wrapReply(words.short, route);
  }
  return wrapReply(link ? `${words.long}\n\n${booking.long}${link}` : words.long, route);
}
