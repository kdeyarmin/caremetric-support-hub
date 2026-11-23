/**
 * The Account Manager's customer emails: short, fixed emails to the billing contact of a trial or a new paying account, written
 * once, here, and reviewed like any other copy. Pure: facts go in, words come out, and the same facts always give the same words.
 *
 * Each email opens with what the customer gets (email review 2026-11-17): the per-product words below say what the first steps lead
 * to (`firstWin`) and what stays when the plan starts (`kept`).
 *
 * - welcome          days 0 to 2 of a trial: the first three steps and the result they lead to, with a link to the product's help.
 * - setup_nudge      days 3 to 6 of a trial, only while the product has reported no positive usage for the account: an offer of
 *                    help (a report of zero, which the usage API accepts, is not usage).
 * - trial_checkin    when 5 days or fewer (and more than 2) are left in a trial: a personal check-in, and it says it is not a billing
 *                    notice. Stripe's own trial and payment emails stay on; nothing here repeats them. It names the Founders Sale (ask
 *                    in the offer's exact terms: it applies automatically when paid service starts; owner decision 2026-11-08).
 * - testimonial_ask  45 to 60 days after the account's first paid invoice for the product (across every subscription it has had for
 *                    it, so a replaced subscription changes nothing), with no open high or urgent case: would they share a
 *                    sentence, with consent wording, and a reply is how they say yes.
 * - cancel_save      a trial or a paid plan the customer has set to cancel: what did not work, told by reply.
 * - trial_ended      a trial that ended in the last 14 days with no payment ever made for the product: thanks for trying, and what got
 *                    in the way, told by reply.
 *
 * The trial path (`trialPathFeature`, team review 2026-11-17, stage 4) changes three things once the database declares it:
 * - A product whose trial ends without a card (Intel, `cardToKeep`) reminds a trial with no card confirmed (`cardConfirmedAt`) once, in
 *   its last week (7 to 1 days left): `card_reminder`, to add a card in Billing to keep the plan, in Intel's own terms. A trial with a
 *   card confirmed gets none. Every trial counts from its start: since 2026-11-23 (owner decision) Intel needs no card to start one, so
 *   the welcome and the rest no longer wait for a card, and a trial that ended without one is an ended trial like any other. (From
 *   2026-11-14 until then Intel's trial counted from its card, and the reminder asked a sign-up to finish adding it.)
 * - Whether a trial has used the product is read from the product's own activity events (`activeAt`, `firstValueAt`) where it sends
 *   them (Intel), not from billing usage reports, which Intel never sends; CareBase keeps the usage reports.
 * - Days 10 to 16 of a trial with more than 5 days left: `midtrial_nudge` when the trial has not reached first value (the one step
 *   that shows what the product does), else `value_followup` (what teams do next, and that what they built stays when they keep the plan) for a product
 *   that has those words (Intel).
 * A refused email (the day's cap, or the growth contact gap) then waits and is tried again rather than ending (executor.mjs).
 *
 * The last two (`saveTemplates`) are proposed only while the database declares `lifecycleSaveFeature` and the owner has turned on
 * Settings → Customer growth → "Win-back and cancellation emails"; neither is ever approved on its own. Payment failures stay with
 * Stripe's own emails.
 *
 * Each is proposed at most once per account and product (its period key, account:<template>:<tenant>:<product>). The emails say
 * nothing about AI, quote no price (the trial check-in states the Founders Sale's percentage and term only), promise no time or outcome, never mention a phone call or voicemail, and use the company's
 * vocabulary for CareBase (an Assisted Living Facility, ALF, and a surveyor; never the regulation's own name for the facility type or
 * an auditor). None offers a time to meet, a call or a demo: CareMetric does no personal demos with anyone (owner decision
 * 2026-11-09), so help comes by reply and through the product's help pages. An email proposed with the owner's old booking button
 * is refused when it would be sent (its wording no longer matches what was approved), so no such button goes out.
 *
 * What the owner approves is the subject and the message ("the wording"). The action keeps the facts that rebuild it and a hash of
 * it, never the address; the email that is sent is rebuilt from those facts and is refused if its wording no longer matches the hash.
 * Every email ends with the same footer: why it was sent, a personal one-click unsubscribe link (made when it is sent) and the
 * company's postal address.
 */
import { createHash } from 'node:crypto';
import { renderEmail, themeFor } from '../../email-layout.mjs';

export const lifecycleFeature = 'platform.agents.lifecycle.v1';
export const lifecycleTemplates = Object.freeze(['card_reminder', 'welcome', 'setup_nudge', 'midtrial_nudge', 'value_followup', 'trial_checkin',
  'testimonial_ask', 'cancel_save', 'trial_ended']);
/** The trial path's emails (20261117230000_trial_path.sql), proposed only while the database declares `trialPathFeature`. */
export const trialPathTemplates = Object.freeze(['card_reminder', 'midtrial_nudge', 'value_followup']);
export const trialPathFeature = 'platform.agents.trial-path.v1';
/** The cancellation and win-back emails (20261113300000_lifecycle_save.sql), proposed only with their feature and the owner's switch. */
export const saveTemplates = Object.freeze(['cancel_save', 'trial_ended']);
export const lifecycleSaveFeature = 'platform.agents.lifecycle-save.v1';
// A subscription that ended: Stripe cancels, expires or pauses a trial that ends unpaid, depending on the account's settings.
const endedStatuses = Object.freeze(['canceled', 'incomplete_expired', 'paused']);
/** At most this many emails are proposed in one run. The database sends at most `dailySendLimit` a day across every account. */
export const proposalLimit = 20;
export const dailySendLimit = 20;
export const templateWords = Object.freeze({ welcome: 'welcome', setup_nudge: 'setup help', trial_checkin: 'trial check-in', testimonial_ask: 'testimonial request',
  cancel_save: 'cancellation check-in', trial_ended: 'ended-trial check-in', card_reminder: 'card reminder', midtrial_nudge: 'mid-trial next step',
  value_followup: 'what to do next' });
export const unsubscribeLabel = 'Unsubscribe from CareMetric check-in emails';
/** Customer emails sign off as the product's own team, with its website. */
export const signatureFor = (productName, site) => Object.freeze([`The ${productName} team`, ...(site ? [site] : [])]);

/** The products with customer emails: the help each email links to, and the first steps the welcome lists. */
export const lifecycleProducts = Object.freeze({
  carebase: Object.freeze({
    site: Object.freeze({ label: 'cmcarebase.com', url: 'https://cmcarebase.com' }),
    helpUrl: 'https://cmcarebase.com/app/help',
    helpLabel: 'Open the help center',
    firstSteps: Object.freeze([
      'Add your facility, whether it is a personal care home or an Assisted Living Facility (ALF).',
      'Import your staff roster from a spreadsheet, or add a few people by hand.',
      'Choose the training each role needs and assign it.',
    ]),
    setup: 'Most teams start by importing their staff roster and assigning the training each role needs, so their training records are kept in one place for when a surveyor asks to see them. The help center walks through each step for a personal care home or an Assisted Living Facility.',
    // What the first steps lead to, and what stays when the plan starts (email review 2026-11-17: each email says what the customer gets).
    firstWin: 'each role\'s training assigned, with its records kept in one place for when a surveyor asks to see them',
    kept: 'your facility, your staff roster and their training records',
    // Whether a trial has used it is read from billing usage reports (CareBase sends no activity events).
    value: 'usage',
  }),
  'caremetric-intel': Object.freeze({
    site: Object.freeze({ label: 'caremetricintel.com', url: 'https://www.caremetricintel.com' }),
    helpUrl: 'https://www.caremetricintel.com/Help',
    helpLabel: 'Open the Help page',
    firstSteps: Object.freeze([
      'Open Setup from the Dashboard and name your agency.',
      'Pick the counties you cover.',
      'Build a first list of physicians to reach.',
    ]),
    setup: 'Most teams start in Setup: they name the agency, pick the counties it covers and build a first list of physicians to reach. The Help page walks through each step.',
    firstWin: 'a list of the highest-ranked physicians for outreach in the county your trial covers',
    kept: 'your lists, your accounts and every visit you\'ve logged',
    // Trial path: the trial starts without a card and ends without one, unless a card is added in Billing to keep the plan (owner
    // decision 2026-11-23), so a trial with no card confirmed is reminded in its last week; use is read from Intel's activity events.
    cardToKeep: true,
    billingUrl: 'https://www.caremetricintel.com/Billing',
    value: 'events',
    midtrial: 'Most teams see what Intel can do once they open Setup, pick the county their trial covers and build a first list: the highest-ranked physicians for outreach in that county.',
    next: Object.freeze([
      'Add the accounts you visit, so visits, referrals and follow-ups stay in one place.',
      'Log each visit as you make it, so your last visit and notes are ready before the next one.',
      'Open County Intelligence to see where the county\'s residents are hospitalized and the referral sources near you.',
    ]),
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

/**
 * The templates an account and product are due, most pressing first, from one row of the database's facts
 * (private.agent_lifecycle_snapshot). Templates already proposed are not removed here; see `planEmails`.
 */
export function dueTemplates(fact, now = new Date(), { trialPath = false } = {}) {
  if (!fact || !Object.hasOwn(lifecycleProducts, fact.product)) return [];
  if (trialPath) return trialPathDue(fact, now);
  // A live trial or plan set to cancel gets the cancellation check-in only, never a welcome or a testimonial request. A subscription
  // that has ended keeps Stripe's cancellation fields, so the flag is read only while it is still trialing or active.
  if (fact.cancelling === true && ['trialing', 'active'].includes(fact.status)) return ['cancel_save'];
  const moment = now.getTime();
  if (endedStatuses.includes(fact.status)) {
    const end = at(fact.trialEnd);
    return end !== null && at(fact.firstPaidAt) === null && end <= moment && moment - end < 14 * day ? ['trial_ended'] : [];
  }
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

// Trial path: whether a trial that ends without a card has none confirmed yet, and whether it has used the product (activity events
// where the product sends them, else billing usage reports) or reached first value.
const cardMissing = fact => lifecycleProducts[fact.product]?.cardToKeep === true && at(fact.cardConfirmedAt) === null;
/** How many days before a trial's end the card reminder is due (a trial with no card confirmed, from 7 days left to 1). */
export const cardReminderDays = Object.freeze({ from: 7, until: 1 });
const usedIt = fact => lifecycleProducts[fact.product]?.value === 'events' ? at(fact.activeAt) !== null : fact.hasUsage === true;
const reachedValue = fact => lifecycleProducts[fact.product]?.value === 'events' ? at(fact.firstValueAt) !== null : fact.hasUsage === true;

/** The templates due under the trial path (see the module's comment), most pressing first. */
function trialPathDue(fact, now) {
  if (fact.cancelling === true && ['trialing', 'active'].includes(fact.status)) return ['cancel_save'];
  const moment = now.getTime();
  if (endedStatuses.includes(fact.status)) {
    const end = at(fact.trialEnd);
    return end !== null && at(fact.firstPaidAt) === null && end <= moment && moment - end < 14 * day ? ['trial_ended'] : [];
  }
  if (fact.status === 'trialing') {
    const start = at(fact.trialStart) ?? at(fact.created);
    const end = at(fact.trialEnd);
    const trialDay = start === null ? null : Math.floor((moment - start) / day);
    const left = end === null ? null : (end - moment) / day;
    const due = [];
    if (cardMissing(fact) && left !== null && left > cardReminderDays.until && left <= cardReminderDays.from) due.push('card_reminder');
    if (trialDay !== null && trialDay >= 0 && trialDay <= 2) due.push('welcome');
    if (left !== null && left > 2 && left <= 5) due.push('trial_checkin');
    if (trialDay !== null && trialDay >= 3 && trialDay <= 6 && !usedIt(fact)) due.push('setup_nudge');
    if (trialDay !== null && trialDay >= 10 && trialDay <= 16 && (left === null || left > 5)) {
      if (!reachedValue(fact)) due.push('midtrial_nudge');
      else if (lifecycleProducts[fact.product]?.next) due.push('value_followup');
    }
    return due;
  }
  return dueTemplates(fact, now);
}

/**
 * Whether an approved email still fits the account when it is about to be sent: the trial is still a trial (and, for the setup
 * offer, the product has still reported no positive usage), or the account is still paying with no open high or urgent case. A trial or a
 * plan that is being cancelled fits nothing.
 */
export function stillApplies(template, fact, { trialPath = false } = {}) {
  if (!fact) return false;
  if (trialPath) {
    // Until the trial ends, and only while no card is confirmed: a card added since the reminder was proposed ends its moment.
    if (template === 'card_reminder') return fact.status === 'trialing' && fact.cancelling !== true && cardMissing(fact);
    if (template === 'setup_nudge') return fact.status === 'trialing' && fact.cancelling !== true && !usedIt(fact);
    if (template === 'midtrial_nudge') return fact.status === 'trialing' && fact.cancelling !== true && !reachedValue(fact);
    if (template === 'value_followup') return fact.status === 'trialing' && fact.cancelling !== true && reachedValue(fact);
  } else if (trialPathTemplates.includes(template)) return false;
  if (template === 'cancel_save') return fact.cancelling === true && ['trialing', 'active'].includes(fact.status);
  // A new subscription (a second trial, or a paid plan) is the newest one the facts show, and ends this email's moment.
  if (template === 'trial_ended') return endedStatuses.includes(fact.status) && at(fact.firstPaidAt) === null;
  if (fact.cancelling === true) return false;
  if (template === 'testimonial_ask') return fact.status === 'active' && Number(fact.openUrgentCases ?? 0) === 0;
  if (!['welcome', 'setup_nudge', 'trial_checkin'].includes(template)) return false;
  return fact.status === 'trialing' && (template !== 'setup_nudge' || fact.hasUsage !== true);
}

/**
 * What one run proposes: for each account and product, the most pressing template that is due and was never proposed for it, one
 * email per account a run (a second one waits for the next run), never to an account without a usable address or one that
 * unsubscribed. Returns the candidates in order (most pressing template first, then the database's order: newest first) and counts.
 */
export function planEmails(accounts, now = new Date(), { save = false, trialPath = false } = {}) {
  const entries = [];
  const skipped = { noAddress: 0, suppressed: 0, sameAccount: 0 };
  for (const fact of accounts ?? []) {
    const due = dueTemplates(fact, now, { trialPath }).filter(template => (save || !saveTemplates.includes(template))
      && (trialPath || !trialPathTemplates.includes(template)) && (fact.emails ?? {})[template] == null);
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

/**
 * The card reminder's terms, as Intel states them (docs/GTM_FACTS.md, `trialCardTerms`, which opens with "No credit card is needed to start
 * your trial." and goes on in these words): the one place a customer email names a card.
 */
export const cardTermsWords = 'Add a card in Billing before the trial ends to keep your plan; it then bills automatically after the trial unless you cancel. Without a card, the trial simply ends.';

/** The Founders Sale as the trial check-in states it: the offer's exact terms (billing applies it automatically at conversion), no price. */
export const foundersWords = productName => `If you decide to keep ${productName}, the Founders Sale applies on its own: eligible subscription charges are 50% off for the first 12 months of paid service, starting when your trial ends, with no code needed. Standard pricing resumes after that year.`;

/**
 * One customer email, from the facts kept on its action: the subject, the inbox preview, the headline, the message blocks and the
 * sign-off. It is sent in the branded layout under the product's own name, and greets "Hello," before the blocks.
 */
export function lifecycleEmail({ template, tenantName, productName, product, helpUrl }) {
  const words = lifecycleProducts[product];
  if (!words || !lifecycleTemplates.includes(template)) throw new TypeError('Unknown customer email.');
  const help = { type: 'button', label: words.helpLabel, url: helpUrl };
  const signature = signatureFor(productName, words.site);
  if (template === 'card_reminder') {
    // A trial with no card confirmed, in its last week (owner decision 2026-11-23): Intel's own terms, word for word (`cardTermsWords`).
    return {
      subject: `Keep your ${productName} plan after your trial`,
      preheader: 'Your trial ends within a week. Here\'s how to keep your plan.',
      heading: 'Keep your plan after the trial',
      blocks: [
        { type: 'paragraph', text: `Your ${productName} trial for ${tenantName} ends within a week.` },
        { type: 'paragraph', text: cardTermsWords },
        { type: 'paragraph', text: `Everything you've built stays in place when your plan continues: ${words.kept}.` },
        { type: 'button', label: 'Open Billing', url: helpUrl },
        { type: 'paragraph', text: 'If you have a question, just reply. We\'ll answer here.' },
      ],
      signature,
    };
  }
  if (template === 'midtrial_nudge') {
    return {
      subject: `The one step that shows what ${productName} can do`,
      preheader: 'One step shows most teams what it can do, and it\'s still ahead of you.',
      heading: 'The step worth taking next',
      blocks: [
        { type: 'paragraph', text: `You're partway through your ${productName} trial for ${tenantName}. One step shows most teams what it can do, and it's still ahead of you.` },
        { type: 'callout', tone: 'info', title: 'The next step:', text: words.midtrial ?? words.setup },
        help,
        { type: 'paragraph', text: 'If something\'s in the way, just reply and tell us what you\'d like to get done. We\'ll send you the steps.' },
      ],
      signature,
    };
  }
  if (template === 'value_followup') {
    if (!words.next) throw new TypeError('Unknown customer email.');
    return {
      subject: `Your first list is built. What to do next in ${productName}`,
      preheader: 'What teams do next, and what stays in place when you keep your plan.',
      heading: 'What to do next',
      blocks: [
        { type: 'paragraph', text: `You've built your first list in ${productName} for ${tenantName}. Teams that keep using it after the trial usually do these next:` },
        { type: 'steps', items: words.next },
        // Since 2026-11-23 the plan continues after an Intel trial only with a card added in Billing, so this says nothing about it starting.
        { type: 'paragraph', text: 'When you keep your plan after the trial, everything you\'ve built stays in place.' },
        help,
        { type: 'paragraph', text: 'If you have a question, just reply. We\'ll answer here.' },
      ],
      signature,
    };
  }
  if (template === 'welcome') {
    return {
      subject: `Welcome to ${productName}: your first three steps`,
      preheader: `Three steps for ${tenantName}, and what they lead to.`,
      heading: `Welcome to ${productName}`,
      blocks: [
        { type: 'paragraph', text: `Thanks for starting a ${productName} trial for ${tenantName}. These three steps get you to the first result worth seeing: ${words.firstWin}.` },
        { type: 'steps', items: words.firstSteps },
        help,
        { type: 'paragraph', text: 'Each step has a short guide. If anything\'s unclear, just reply and we\'ll help you through it.' },
      ],
      signature,
    };
  }
  if (template === 'setup_nudge') {
    return {
      subject: `Need a hand getting set up in ${productName}?`,
      preheader: 'Where most teams start, and how to get help with any step.',
      heading: 'Need a hand with setup?',
      blocks: [
        { type: 'paragraph', text: `You're a few days into your ${productName} trial for ${tenantName}, and we wanted to offer a hand with setup.` },
        { type: 'callout', tone: 'info', title: 'Where most teams start:', text: words.setup },
        { type: 'paragraph', text: `Setup ends with the first result worth seeing: ${words.firstWin}.` },
        help,
        { type: 'paragraph', text: 'If something\'s slowing you down, or you\'re not sure where to start, just reply and tell us what you\'d like to get done first. We\'ll send you the steps.' },
      ],
      signature,
    };
  }
  if (template === 'trial_checkin') {
    return {
      subject: `Before your ${productName} trial ends`,
      preheader: 'A personal check-in, not a billing notice.',
      heading: 'How is your trial going?',
      blocks: [
        { type: 'paragraph', text: 'This is a personal check-in, not a billing notice.' },
        { type: 'paragraph', text: `Your ${productName} trial for ${tenantName} is almost over, and we wanted to ask how it's going. Is anything getting in the way? A step that's unclear, something you expected to find and didn't, or a question from your team?` },
        { type: 'paragraph', text: 'Just reply and let us know. We\'ll answer here.' },
        { type: 'paragraph', text: `Everything you've built stays in place when your plan starts: ${words.kept}.` },
        // Owner decision 2026-11-08: the trial check-in names the Founders Sale, in its exact terms (docs/GTM_FACTS.md).
        { type: 'callout', tone: 'success', title: 'The Founders Sale.', text: foundersWords(productName) },
      ],
      signature,
    };
  }
  if (template === 'cancel_save') {
    return {
      subject: `Before your ${productName} plan ends`,
      preheader: 'What didn\'t work, in a line or two, helps us fix it.',
      heading: 'Before your plan ends',
      blocks: [
        { type: 'paragraph', text: `We saw that ${tenantName} is ending its ${productName} plan. Thanks for using ${productName}.` },
        { type: 'paragraph', text: 'Before it ends, would you tell us what didn\'t work? A step that was unclear, something you needed and didn\'t find, or a problem we could fix. Just reply. A line or two is enough, and we read every reply.' },
        help,
        { type: 'paragraph', text: 'If you\'d rather not, there\'s no need to reply.' },
      ],
      signature,
    };
  }
  if (template === 'trial_ended') {
    return {
      subject: `Thank you for trying ${productName}`,
      preheader: 'What got in the way, in a line or two, helps us make it better.',
      heading: `Thank you for trying ${productName}`,
      blocks: [
        { type: 'paragraph', text: `Your ${productName} trial for ${tenantName} has ended. Thanks for taking the time to try it.` },
        { type: 'paragraph', text: 'Would you tell us what got in the way? A step that was unclear, something you expected to find and didn\'t, or simply the timing. Just reply. A line or two is enough, and we read every reply.' },
        { type: 'paragraph', text: 'If you\'d like to pick up where you left off, reply and we\'ll help you get going again.' },
        help,
      ],
      signature,
    };
  }
  return {
    subject: `Would you share a sentence about ${productName}?`,
    preheader: 'A sentence from you helps other teams decide whether it fits them.',
    heading: 'Would you share a sentence?',
    blocks: [
      { type: 'paragraph', text: `Thanks for choosing ${productName} for ${tenantName}. We're glad to have you with us.` },
      { type: 'paragraph', text: 'Would you share a sentence or two about how it\'s going? Teams deciding whether it fits them like to hear from people who use it.' },
      { type: 'paragraph', text: 'If you\'re willing, just reply to say yes, and include your sentence if you have it ready.' },
      { type: 'callout', tone: 'info', text: 'We\'d use your words only with your permission, only in the form you approve, and with or without your name and organization, as you prefer.' },
      { type: 'paragraph', text: 'If you\'d rather not, there\'s no need to reply.' },
    ],
    signature,
  };
}

const footerLines = (input, unsubscribe, postalAddress) => [
  `You're getting this email because ${input.tenantName} has a ${input.productName} account.`,
  unsubscribe,
  ...(String(postalAddress ?? '').trim() ? [String(postalAddress).trim()] : []),
];
const text = (input, footer) => {
  const { subject, preheader, heading, blocks, signature: signOff } = lifecycleEmail(input);
  // In the theme of the product's app, so a customer's emails from the Hub look like the ones the app sends (Intel's Emberline).
  return { subject, ...renderEmail({ layout: 'branded', theme: themeFor(input.product), brand: input.productName, title: subject, preheader, heading, recipientName: null, blocks, signature: signOff, footer }) };
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
export function lifecycleInput(fact, template) {
  const product = lifecycleProducts[fact.product];
  if (!product || !slug.test(fact.tenant ?? '') || !lifecycleTemplates.includes(template)) throw new TypeError('Unknown customer email.');
  const input = {
    template, tenant: fact.tenant, tenantName: tidy(fact.tenantName, 80) || fact.tenant, product: fact.product,
    productName: tidy(fact.productName, 60) || fact.product,
    // The card reminder links to the product's billing page, where the card is added; every other email to its help.
    helpUrl: template === 'card_reminder' && product.billingUrl ? product.billingUrl : product.helpUrl,
    // Kept as null: the database's shape for this action still has the key, and no email offers a booking page any more.
    bookingUrl: null,
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
