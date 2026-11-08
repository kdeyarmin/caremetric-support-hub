/**
 * The Account Manager's customer emails: four short, fixed emails to the billing contact of a trial or a new paying account, written
 * once, here, and reviewed like any other copy. Pure: facts go in, words come out, and the same facts always give the same words.
 *
 * - welcome          days 0 to 2 of a trial: what to do first, with a link to the product's getting-started help.
 * - setup_nudge      days 3 to 6 of a trial, only while the product has reported no positive usage for the account: an offer of
 *                    help (a report of zero, which the usage API accepts, is not usage).
 * - trial_checkin    when 5 days or fewer (and more than 2) are left in a trial: a personal check-in, and it says it is not a billing
 *                    notice. Stripe's own trial and payment emails stay on; nothing here repeats them. It names the Founders Sale (ask
 *                    for FOUNDERS50 at activation, in the offer's exact terms; owner decision 2026-11-08).
 * - testimonial_ask  45 to 60 days after the account's first paid invoice for the product (across every subscription it has had for
 *                    it, so a replaced subscription changes nothing), with no open high or urgent case: would they share a
 *                    sentence, with consent wording, and a reply is how they say yes.
 *
 * Each is proposed at most once per account and product (its period key, account:<template>:<tenant>:<product>). The emails say
 * nothing about AI, quote no price (the trial check-in states the Founders Sale's code and percentage only), promise no time or outcome, never mention a phone call or voicemail, and use the company's
 * vocabulary for CareBase (an Assisted Living Facility, ALF, and a surveyor; never the regulation's own name for the facility type or
 * an auditor). The owner's booking link appears only when HUB_BOOKING_URL is an https address.
 *
 * What the owner approves is the subject and the message ("the wording"). The action keeps the facts that rebuild it and a hash of
 * it, never the address; the email that is sent is rebuilt from those facts and is refused if its wording no longer matches the hash.
 * Every email ends with the same footer: why it was sent, a personal one-click unsubscribe link (made when it is sent) and the
 * company's postal address.
 */
import { createHash } from 'node:crypto';
import { renderEmail } from '../../email-layout.mjs';

export const lifecycleFeature = 'platform.agents.lifecycle.v1';
export const lifecycleTemplates = Object.freeze(['welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask']);
/** At most this many emails are proposed in one run. The database sends at most `dailySendLimit` a day across every account. */
export const proposalLimit = 20;
export const dailySendLimit = 20;
export const templateWords = Object.freeze({ welcome: 'welcome', setup_nudge: 'setup help', trial_checkin: 'trial check-in', testimonial_ask: 'testimonial request' });
export const unsubscribeLabel = 'Unsubscribe from CareMetric check-in emails';
export const signature = Object.freeze(['The CareMetric team']);

/** The products with customer emails: the help each email links to, and the first steps the welcome lists. */
export const lifecycleProducts = Object.freeze({
  carebase: Object.freeze({
    helpUrl: 'https://cmcarebase.com/app/help',
    helpLabel: 'Open the help center',
    firstSteps: Object.freeze([
      'Add your facility, whether it is a personal care home or an Assisted Living Facility (ALF).',
      'Import your staff roster from a spreadsheet, or add a few people by hand.',
      'Choose the training each role needs and assign it.',
    ]),
    setup: 'Most teams start by importing their staff roster and assigning the training each role needs, so their training records are kept in one place for when a surveyor asks to see them. The help center walks through each step for a personal care home or an Assisted Living Facility.',
  }),
  'caremetric-intel': Object.freeze({
    helpUrl: 'https://www.caremetricintel.com/Help',
    helpLabel: 'Open the Help page',
    firstSteps: Object.freeze([
      'Open Setup from the Dashboard and name your agency.',
      'Pick the counties you cover.',
      'Build a first list of physicians to reach.',
    ]),
    setup: 'Most teams start in Setup: they name the agency, pick the counties it covers and build a first list of physicians to reach. The Help page walks through each step.',
  }),
});

const day = 86_400_000;
const slug = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const httpsLink = /^https:\/\/[^\s"<>]{1,300}$/;
const at = value => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : null; };
const tidy = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
};

export const periodKey = ({ template, tenant, product }) => `account:${template}:${tenant}:${product}`;
/** The owner's booking page, when it is an https address; anything else is left out of every email. */
export const bookingLink = value => (typeof value === 'string' && httpsLink.test(value.trim()) ? value.trim() : null);

/**
 * The templates an account and product are due, most pressing first, from one row of the database's facts
 * (private.agent_lifecycle_snapshot). Templates already proposed are not removed here; see `planEmails`.
 */
export function dueTemplates(fact, now = new Date()) {
  if (!fact || !Object.hasOwn(lifecycleProducts, fact.product) || fact.cancelling === true) return [];
  const moment = now.getTime();
  if (fact.status === 'trialing') {
    const start = at(fact.trialStart) ?? at(fact.created);
    const end = at(fact.trialEnd);
    const trialDay = start === null ? null : Math.floor((moment - start) / day);
    const left = end === null ? null : (end - moment) / day;
    const due = [];
    if (trialDay !== null && trialDay >= 0 && trialDay <= 2) due.push('welcome');
    if (left !== null && left > 2 && left <= 5) due.push('trial_checkin');
    if (trialDay !== null && trialDay >= 3 && trialDay <= 6 && fact.hasUsage !== true) due.push('setup_nudge');
    return due;
  }
  if (fact.status === 'active') {
    const paid = at(fact.firstPaidAt);
    if (paid === null || Number(fact.openUrgentCases ?? 0) > 0) return [];
    const paying = Math.floor((moment - paid) / day);
    return paying >= 45 && paying <= 60 ? ['testimonial_ask'] : [];
  }
  return [];
}

/**
 * Whether an approved email still fits the account when it is about to be sent: the trial is still a trial (and, for the setup
 * offer, the product has still reported no positive usage), or the account is still paying with no open high or urgent case. A trial or a
 * plan that is being cancelled fits nothing.
 */
export function stillApplies(template, fact) {
  if (!fact || fact.cancelling === true) return false;
  if (template === 'testimonial_ask') return fact.status === 'active' && Number(fact.openUrgentCases ?? 0) === 0;
  if (!['welcome', 'setup_nudge', 'trial_checkin'].includes(template)) return false;
  return fact.status === 'trialing' && (template !== 'setup_nudge' || fact.hasUsage !== true);
}

/**
 * What one run proposes: for each account and product, the most pressing template that is due and was never proposed for it, one
 * email per account a run (a second one waits for the next run), never to an account without a usable address or one that
 * unsubscribed. Returns the candidates in order (most pressing template first, then the database's order: newest first) and counts.
 */
export function planEmails(accounts, now = new Date()) {
  const entries = [];
  const skipped = { noAddress: 0, suppressed: 0, sameAccount: 0 };
  for (const fact of accounts ?? []) {
    const due = dueTemplates(fact, now).filter(template => (fact.emails ?? {})[template] == null);
    if (due.length === 0) continue;
    if (fact.hasEmail !== true) { skipped.noAddress += 1; continue; }
    if (fact.suppressed === true) { skipped.suppressed += 1; continue; }
    entries.push({ fact, template: due[0] });
  }
  entries.sort((a, b) => lifecycleTemplates.indexOf(a.template) - lifecycleTemplates.indexOf(b.template));
  const candidates = [];
  const accountsSeen = new Set();
  for (const entry of entries) {
    if (accountsSeen.has(entry.fact.tenant)) { skipped.sameAccount += 1; continue; }
    accountsSeen.add(entry.fact.tenant);
    candidates.push(entry);
  }
  return { candidates, skipped };
}

/** The Founders Sale as the trial check-in states it: the code to ask for and the offer's exact terms, no price. */
export const foundersWords = productName => `If you decide to keep ${productName}, ask us for FOUNDERS50 when you activate your paid plan. Under the Founders Sale, eligible subscription charges are 50% off for the first 12 months of paid service, starting when your trial ends; standard pricing resumes after that year.`;

/** The subject, the message blocks and the sign-off of one email, from the facts kept on its action. */
export function lifecycleEmail({ template, tenantName, productName, product, helpUrl, bookingUrl = null }) {
  const words = lifecycleProducts[product];
  if (!words || !lifecycleTemplates.includes(template)) throw new TypeError('Unknown customer email.');
  const help = { type: 'button', label: words.helpLabel, url: helpUrl };
  const booking = bookingLink(bookingUrl);
  const together = label => (booking ? [{ type: 'button', label, url: booking }] : []);
  const hello = { type: 'paragraph', text: 'Hello,' };
  if (template === 'welcome') {
    return {
      subject: `Welcome to ${productName}`,
      blocks: [
        hello,
        { type: 'paragraph', text: `Thank you for starting a ${productName} trial for ${tenantName}. A good way to begin:` },
        { type: 'message', text: words.firstSteps.map((step, index) => `${index + 1}. ${step}`).join('\n') },
        help,
        ...together('Pick a time to go through setup together'),
        { type: 'paragraph', text: 'If anything is unclear, reply to this email. We are glad to help.' },
      ],
      signature: [...signature],
    };
  }
  if (template === 'setup_nudge') {
    return {
      subject: `Need a hand getting set up in ${productName}?`,
      blocks: [
        hello,
        { type: 'paragraph', text: `You are a few days into your ${productName} trial for ${tenantName}, and we wanted to offer a hand with setup.` },
        { type: 'paragraph', text: words.setup },
        help,
        { type: 'paragraph', text: 'If something is slowing you down, or you are not sure where to start, reply to this email and tell us what you would like to get done first.' },
        ...together('Pick a time to go through it together'),
      ],
      signature: [...signature],
    };
  }
  if (template === 'trial_checkin') {
    return {
      subject: `How is your ${productName} trial going?`,
      blocks: [
        hello,
        { type: 'paragraph', text: 'This is a personal check-in, not a billing notice.' },
        { type: 'paragraph', text: `Your ${productName} trial for ${tenantName} is nearing its end, and we wanted to ask how it is going. Is anything getting in the way: a step that is unclear, something you expected to find and did not, or a question from your team?` },
        { type: 'paragraph', text: 'Reply to this email and let us know.' },
        // Owner decision 2026-11-08: the trial check-in names the Founders Sale, in its exact terms (docs/GTM_FACTS.md).
        { type: 'paragraph', text: foundersWords(productName) },
        ...together('Pick a time to go through it together'),
      ],
      signature: [...signature],
    };
  }
  return {
    subject: `Would you share a sentence about ${productName}?`,
    blocks: [
      hello,
      { type: 'paragraph', text: `Thank you for choosing ${productName} for ${tenantName}. We are glad to have you with us.` },
      { type: 'paragraph', text: 'Would you be willing to share a sentence or two about your experience? Teams deciding whether it fits them find it helpful to hear from people who use it.' },
      { type: 'paragraph', text: 'If you are willing, reply to this email to say yes, and include your sentence if you have it ready. We would use your words only with your permission, only in the form you approve, and with or without your name and organization, as you prefer. If you would rather not, there is no need to reply.' },
    ],
    signature: [...signature],
  };
}

const footerLines = (input, unsubscribe, postalAddress) => [
  `You are receiving this email because ${input.tenantName} has a ${input.productName} account.`,
  unsubscribe,
  ...(String(postalAddress ?? '').trim() ? [String(postalAddress).trim()] : []),
];
const text = (input, footer) => {
  const { subject, blocks, signature: signOff } = lifecycleEmail(input);
  return { subject, ...renderEmail({ layout: 'personal', title: subject, blocks, signature: signOff, footer }) };
};

/** The words the owner approves: the subject line and the message, without the footer every email carries. */
export function lifecycleWording(input) {
  const email = text(input, []);
  return `Subject: ${email.subject}\n\n${email.text}`;
}
export const wordingHash = input => createHash('sha256').update(lifecycleWording(input)).digest('hex');

/** The approval card's text: the email exactly as it will be sent, except that the personal unsubscribe link is made when it is sent. */
export function lifecyclePreview(input, { postalAddress = '' } = {}) {
  const email = text(input, footerLines(input, `${unsubscribeLabel}: a personal link is added when the email is sent`, postalAddress));
  return `Subject: ${email.subject}\n\n${email.text}`;
}

/** The email that is sent: plain text and HTML in the shared layout, with the personal unsubscribe link and the postal address. */
export function renderLifecycleEmail(input, { unsubscribeUrl, postalAddress }) {
  const email = text(input, footerLines(input, { label: unsubscribeLabel, url: unsubscribeUrl }, postalAddress));
  return { subject: email.subject, text: email.text, html: email.html };
}

/**
 * The facts an action keeps to rebuild its email, from one row of the database's facts: never an address. Names are clipped and
 * their spacing collapsed, so a name with a line break cannot change the shape of the email.
 */
export function lifecycleInput(fact, template, { bookingUrl = null } = {}) {
  const product = lifecycleProducts[fact.product];
  if (!product || !slug.test(fact.tenant ?? '') || !lifecycleTemplates.includes(template)) throw new TypeError('Unknown customer email.');
  const input = {
    template, tenant: fact.tenant, tenantName: tidy(fact.tenantName, 80) || fact.tenant, product: fact.product,
    productName: tidy(fact.productName, 60) || fact.product, helpUrl: product.helpUrl, bookingUrl: bookingLink(bookingUrl),
    periodKey: periodKey({ template, tenant: fact.tenant, product: fact.product }),
  };
  return { ...input, textHash: wordingHash(input) };
}

/** An action's input checked field by field (the database checks the same shape), or null. Nothing outside the whitelist is kept. */
export function parseLifecycleInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { template, tenant, tenantName, product, productName, helpUrl, bookingUrl = null, periodKey: key, textHash } = input;
  if (!lifecycleTemplates.includes(template) || typeof tenant !== 'string' || !slug.test(tenant) || !Object.hasOwn(lifecycleProducts, product)) return null;
  if (typeof tenantName !== 'string' || !tenantName || tenantName.length > 200 || typeof productName !== 'string' || !productName || productName.length > 120) return null;
  if (typeof helpUrl !== 'string' || !httpsLink.test(helpUrl) || (bookingUrl !== null && (typeof bookingUrl !== 'string' || !httpsLink.test(bookingUrl)))) return null;
  if (key !== periodKey({ template, tenant, product }) || typeof textHash !== 'string' || !/^[0-9a-f]{64}$/.test(textHash)) return null;
  return { template, tenant, tenantName, product, productName, helpUrl, bookingUrl, periodKey: key, textHash };
}

/**
 * The origin the unsubscribe link is built on, or null. Only a bare https origin passes: a host (and port), at most one trailing
 * slash, no credentials, no path, and no query or fragment, not even an empty `?` or `#` (which a parsed URL would report as
 * empty). Anything else would put the link's path after a fragment or a query, where it never reaches the unsubscribe page.
 */
export function httpsOrigin(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^https:\/\/[^\s/?#\\@]+\/?$/i.test(text)) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname) return null;
  return url.origin;
}

/**
 * Whether the Hub can send customer email at all: a SendGrid sender, the company's postal address (every email's footer carries
 * it, and CAN-SPAM asks for it) and an https public origin for the unsubscribe link (see `httpsOrigin`). `missing` names what is
 * not there.
 */
export function lifecycleReadiness({ mail = null, postalAddress = '', publicOrigin = '' } = {}) {
  const missing = [
    ...(mail?.configured === true && typeof mail.send === 'function' ? [] : ['mail']),
    ...(String(postalAddress ?? '').trim() ? [] : ['postal_address']),
    ...(httpsOrigin(publicOrigin) ? [] : ['public_origin']),
  ];
  return { ready: missing.length === 0, missing };
}
