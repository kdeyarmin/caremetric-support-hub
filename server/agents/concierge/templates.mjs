/**
 * The fixed replies the Concierge offers the owner to send. They are written once, here, and reviewed like
 * any other copy; nothing a customer wrote is ever repeated in them. They say nothing about AI (the owner reads
 * and approves each one, and it goes out under their name), promise no refund, price or outcome, and never offer a
 * phone call. A text message gets a shorter version that fits one message of 320 characters.
 *
 * - standard: the message arrived and a person will review it.
 * - phi: the message appears to carry patient or resident information, which these channels are not set up
 *   for. It does not quote, confirm or deny anything the customer wrote, and makes no claim about what happens to it.
 * - sales: for a prospect (a website lead or a conversation filed as a sale): thanks, the information they need will come
 *   in this conversation. CareMetric sells without demos, calls or meetings (owner decisions 2026-11-08 and 2026-11-09: no
 *   personal demos with anyone), so it promises no personal follow-up, names no day and offers no time to meet.
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
    long: 'Thank you for reaching out to CareMetric. We have your request and will reply here with the information you need.',
    short: 'Thanks for reaching out to CareMetric. We have your request and will reply here with what you need.',
  },
};
export const templateNames = Object.keys(bodies);

/** The greeting and the text, laid out for the route the message will travel: one line for a text message, a paragraph for the rest. */
export function wrapReply(text, route) {
  return route === 'sms' ? `${greeting} ${text}` : `${greeting}\n\n${text}`;
}

/** The whole message for a template, ready to send by the route it will travel (sms, email or chat). It carries no link. */
export function replyBody(template, route) {
  const words = bodies[template];
  if (!words) throw new TypeError('Unknown reply template.');
  return wrapReply(route === 'sms' ? words.short : words.long, route);
}
