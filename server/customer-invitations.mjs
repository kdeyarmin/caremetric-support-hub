import { createHash, randomBytes } from 'node:crypto';
import { HttpError, transaction, withSession } from './sms-auth.mjs';
import { CAREBASE_SITE, INTEL_SITE, INTEL_TAGLINE, SUPPORT_EMAIL, SUPPORT_PHONE_DISPLAY, emailImagePaths, emailThemes, escapeHtml, renderEmail } from './email-layout.mjs';
import { CHECKOUT_API_VERSION, StripeError } from './stripe.mjs';
import { live } from './live.mjs';
import {
  discountLabel, durationWords, invitationCommandSchema, isComplimentary, normalizedRecord, quantityLabel, regularPriceLabel, yourPriceLabel,
} from '../src/billing/invitationProtocol.ts';

/**
 * Customer invitations (docs/CUSTOMER_INVITATIONS.md). The owner invites one customer to one application (CareBase, Breathe or CareMetric
 * Intel) at a published plan price they authorize, with a discount from 0 to 100%:
 *
 * - The invitation email is in the application's own look (server/email-layout.mjs themes): it welcomes them, describes the application,
 *   states their plan, regular price, discount and price, and links to the Hub's welcome page.
 * - The welcome page (/welcome/<token>, in the same look) shows the offer. At 100% accepting creates the subscription in Stripe from the
 *   server: no Checkout page, no card. Below 100% the customer pays in Stripe Checkout with the discount already applied.
 * - Once the plan is active the customer gets a "your plan is active" email and a button to the application's sign-up with the
 *   invitation's code (`hub_invite`), which the application passes to POST /api/apps/trials so the new account is joined to this plan
 *   instead of starting a trial (billing.mjs `trial`, private.customer_invitation_claim).
 *
 * The link's token (32 random bytes) is in the email and the page's address only; the database keeps its SHA-256. Every Stripe request
 * carries an idempotency key derived from the invitation, so a retried click never creates a second customer, coupon, subscription or
 * Checkout session.
 */
export const invitationsFeature = 'billing.customer-invitations.v1';
export const invitationTokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const newInvitationToken = () => randomBytes(32).toString('base64url');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const checkoutOptions = { apiVersion: CHECKOUT_API_VERSION };

/**
 * What each application's invitation says about it, and where its customers sign up. The descriptions follow each product's own reviewed
 * copy: CareBase and Intel from the fact sheet (server/agents/content/facts.mjs), Breathe from its own site (kdeyarmin/PennFit
 * artifacts/cpap-fitter/src/pages/breathe.tsx).
 */
export const invitationProfiles = Object.freeze({
  carebase: Object.freeze({
    name: 'CareMetric CareBase', short: 'CareBase', theme: 'carebase', site: CAREBASE_SITE, siteLabel: 'cmcarebase.com',
    signupSetting: 'billing.invite_carebase_signup', defaultSignup: 'https://cmcarebase.com/signup',
    summary: 'CareBase connects the records and daily work a personal care home or assisted living facility needs to manage staff, residents and facilities. Managers see missing requirements, assign follow-up and prepare survey documentation from the same records staff use every day.',
    highlights: Object.freeze([
      'Staff training with maintained courses, graded quizzes, certificates and a training-compliance matrix',
      'Resident records, assessments, support plans and daily care tasks in one place',
      'Survey readiness: binders, survey packets and a crosswalk to Pennsylvania\'s personal care home and ALF rules',
      'Due dates, reminders and assigned follow-up, so responsibilities never live in a separate calendar',
    ]),
  }),
  breathe: Object.freeze({
    name: 'CareMetric Breathe', short: 'Breathe', theme: 'breathe', site: 'https://cmbreathe.com', siteLabel: 'cmbreathe.com',
    signupSetting: 'billing.invite_breathe_signup', defaultSignup: 'https://cmbreathe.com/breathe/signup',
    summary: 'Breathe runs the whole CPAP business on one patient record: mask fitting, resupply, billing and live therapy data from ResMed, Philips and 3B.',
    highlights: Object.freeze([
      'Virtual mask fitting: patients scan on their own phone in about two minutes, at your counter or at home',
      'Each fitting is matched to the formulary you actually stock and lands in your team\'s worklist',
      'Resupply and billing on the same patient record',
      'Therapy data from ResMed, Philips and 3B in one view',
    ]),
  }),
  'caremetric-intel': Object.freeze({
    name: 'CareMetric Intel', short: 'Intel', theme: 'intel', site: INTEL_SITE, siteLabel: 'caremetricintel.com',
    signupSetting: 'billing.invite_intel_signup', defaultSignup: 'https://www.caremetricintel.com/login?signup=true',
    summary: 'Intel brings targeted marketing, marketing analysis and territory analysis from Medicare, Census and other healthcare data together with a marketing CRM that keeps outreach, follow-up and the referrals your organization records in one place.',
    highlights: Object.freeze([
      'Find the physicians, hospitals and facilities that matter in your territory, from Medicare data',
      'Know who serves each county, with an alert when a competitor\'s rating, owner or service area changes',
      'One shared workspace for research, accounts, visits, follow-ups and results',
      'Walk into every visit prepared, and show what the work led to',
    ]),
  }),
});

const dateWords = value => new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }).format(new Date(value));
/** "Jane" from "Jane Doe"; the whole name when it starts with a title ("Dr. Jane Doe") or is one word. */
export function greetingName(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return words.length > 1 && !/\.$/.test(words[0]) ? words[0] : words.join(' ');
}
const offerOf = invitation => ({
  unit_amount: Number(invitation.unit_amount), currency: invitation.currency, interval: invitation.interval, interval_count: Number(invitation.interval_count ?? 1),
  pricing_model: invitation.pricing_model, unit_label: invitation.unit_label ?? '', plan_name: invitation.plan_name, quantity: Number(invitation.quantity),
  discount_percent: Number(invitation.discount_percent), discount_duration: invitation.discount_duration, discount_months: invitation.discount_months ?? null,
});
/** The rows of the offer, as the email and the page show them. */
export function offerRows(invitation) {
  const offer = offerOf(invitation);
  return [
    ['Plan', offer.plan_name],
    ...(offer.pricing_model === 'per_unit' ? [['Quantity', quantityLabel(offer)]] : []),
    ['Regular price', regularPriceLabel(offer)],
    ...(offer.discount_percent > 0 ? [['Your discount', discountLabel(offer)]] : []),
    ['Your price', yourPriceLabel(offer)],
  ];
}
/** What the customer is told about paying, in one sentence. */
function payingWords(invitation, profile) {
  const offer = offerOf(invitation);
  if (isComplimentary(offer)) {
    return offer.discount_duration === 'forever'
      ? 'Your plan is complimentary: there is nothing to pay and no card to enter. Accept the invitation and it starts right away.'
      : `There is nothing to pay today and no card to enter. When the complimentary period ends, ${profile.short} invoices at the regular price are emailed to you.`;
  }
  return offer.discount_percent > 0
    ? 'Your discount is applied automatically. You will pay securely through Stripe, CareMetric\'s payment provider.'
    : 'You will pay securely through Stripe, CareMetric\'s payment provider.';
}

/**
 * The emails say what the customer has in plain words, as an account notice does, and leave the offer's breakdown (regular price,
 * discount, "complimentary") to the welcome page: Microsoft 365 filed the first production invitation as junk with SPF, DKIM and DMARC
 * all passing, and promotional wording is one of the things such filters weigh.
 */
/** The plan's price in those words: "No charge", "No charge for your first 3 months, then $597.00 per month", "$298.50 per month". */
function emailPriceWords(offer) {
  if (!isComplimentary(offer)) return yourPriceLabel(offer);
  return offer.discount_duration === 'forever' ? 'No charge' : `No charge ${durationWords(offer)}, then ${regularPriceLabel(offer)}`;
}
/** The plan as the emails show it: its name, the quantity of a per-unit price, and what it costs. */
export function emailRows(invitation) {
  const offer = offerOf(invitation);
  return [['Plan', offer.plan_name], ...(offer.pricing_model === 'per_unit' ? [['Quantity', quantityLabel(offer)]] : []), ['Price', emailPriceWords(offer)]];
}
/** What the invitation email says about paying, in one sentence. */
function emailPayingWords(offer, profile) {
  if (isComplimentary(offer)) {
    return offer.discount_duration === 'forever' ? 'No card is needed.'
      : `No card is needed now. When the no-charge period ends, ${profile.short} invoices at the regular price are emailed to you.`;
  }
  return 'You will pay through Stripe, the payment service CareMetric uses.';
}

/** The invitation email: what CareMetric set up, what the application does, the plan, and the button to the welcome page. */
export function invitationEmail(invitation, link) {
  const profile = invitationProfiles[invitation.app];
  const offer = offerOf(invitation);
  const free = isComplimentary(offer);
  const organization = invitation.organization_name;
  const subject = `Your ${profile.name} account for ${organization}`;
  const expires = dateWords(invitation.expires_at);
  const preheader = free ? `${profile.name} is set up for ${organization}. Accept the invitation to create your sign-in.`
    : `${offer.plan_name} for ${organization}. Review and accept by ${expires}.`;
  const blocks = [
    { type: 'paragraph', text: free ? `CareMetric has set up ${profile.name} for ${organization}.` : `CareMetric has invited ${organization} to ${profile.name}.` },
    { type: 'paragraph', text: profile.summary },
    { type: 'details', rows: emailRows(invitation) },
    { type: 'paragraph', text: emailPayingWords(offer, profile) },
    ...(invitation.note ? [{ type: 'paragraph', text: 'A note from CareMetric:' }, { type: 'message', text: invitation.note }] : []),
    { type: 'button', label: free ? 'Accept the invitation' : 'Review the invitation', url: link },
    { type: 'paragraph', text: 'What happens next:' },
    { type: 'steps', items: free
      ? ['Accept the invitation on the page the button opens.', `Create your ${profile.short} sign-in.`]
      : ['Review the plan and price, then accept.', 'Pay through Stripe.', `Create your ${profile.short} sign-in.`] },
    { type: 'paragraph', text: `This invitation is for ${invitation.contact_email} at ${organization} and expires on ${expires}. Questions? Reply to this email or call ${SUPPORT_PHONE_DISPLAY}.` },
  ];
  return { subject, ...renderEmail({ theme: profile.theme, brand: profile.name, title: subject, preheader, eyebrow: 'Account setup',
    heading: `Welcome to ${profile.name}`, recipientName: greetingName(invitation.contact_name), blocks,
    signature: [`The ${profile.name} team`], footer: [`You received this email because CareMetric invited ${organization} to ${profile.short}. If you were not expecting it, you can ignore it.`] }) };
}

/**
 * Where the customer creates their sign-in: the application's sign-up address (Settings → Billing) with the invitation's code. A CareBase
 * invitation to a Train plan (entitlement key train…) opens CareBase's training sign-up (`product=train`), which sets the organization up
 * for training only; a Breathe invitation names its plan (`plan=<entitlement key>`), which Breathe's form chooses for them.
 */
export function signupLink(base, token, { app = null, entitlement = null } = {}) {
  const url = new URL(base);
  if (app === 'carebase' && /^train/.test(entitlement ?? '')) url.searchParams.set('product', 'train');
  if (app === 'breathe' && /^[a-z0-9_]{1,64}$/.test(entitlement ?? '')) url.searchParams.set('plan', entitlement);
  url.searchParams.set('hub_invite', token);
  return url.href;
}

/** The "your plan is active" email: what they have, and the button to create their sign-in with the invitation's code. */
export function readyEmail(invitation, signup) {
  const profile = invitationProfiles[invitation.app];
  const offer = offerOf(invitation);
  const subject = `Create your ${profile.name} sign-in`;
  const blocks = [
    { type: 'paragraph', text: `${isComplimentary(offer) ? '' : 'Thank you for your payment. '}${invitation.organization_name}'s ${offer.plan_name} plan is active.` },
    { type: 'details', rows: emailRows(invitation) },
    { type: 'paragraph', text: `One step is left: create your ${profile.short} sign-in. Use the button below so your new account is connected to this plan.` },
    { type: 'button', label: `Create your ${profile.short} sign-in`, url: signup },
    { type: 'paragraph', text: `This link is for ${invitation.contact_email} only. Please do not forward it.` },
  ];
  return { subject, ...renderEmail({ theme: profile.theme, brand: profile.name, title: subject, preheader: `Your ${profile.short} plan is active. Create your sign-in to start.`,
    eyebrow: 'Account setup', heading: `Welcome to ${profile.name}`, recipientName: greetingName(invitation.contact_name), blocks,
    signature: [`The ${profile.name} team`], footer: [`You received this email because ${invitation.organization_name} accepted CareMetric's invitation to ${profile.short}.`] }) };
}

// ---- The welcome page ---------------------------------------------------------------------------------------------------------------

/**
 * The welcome page's own security policy: the shared one, plus Stripe Checkout as a form's destination. Its logos are the Hub's own copies
 * (server/email-layout.mjs, emailImagePaths), so images come from the page's own origin only.
 */
export const welcomePagePolicy = `default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://checkout.stripe.com`;

/**
 * The welcome page's referrer policy. The Hub's own is no-referrer, and under it a browser sends `Origin: null` with a form's POST, so
 * the same-origin check refused every acceptance. same-origin gives the Hub's own POST its Origin (and Referer, to the Hub only) while a
 * page the customer goes on to (Stripe Checkout, the application's sign-up, a logo) still gets no referrer, so the link stays private.
 */
export const welcomePageReferrerPolicy = 'same-origin';

function pageHeader(profile, p) {
  if (profile.theme === 'carebase') {
    return `<header style="background:${p.card};border-bottom:3px solid ${p.brand};padding:20px 32px;"><img src="${emailImagePaths.carebaseLockup}" width="200" height="50" alt="CareMetric CareBase" style="display:block;"></header>`;
  }
  if (profile.theme === 'intel') {
    return `<header style="background:${p.canvas};padding:28px 32px;display:flex;align-items:center;gap:20px;"><img src="${emailImagePaths.intelLogo}" width="76" height="63" alt="CareMetric Intel">
<div><p style="margin:0 0 6px;font-size:11px;letter-spacing:1.5px;color:${p.body};">CAREMETRIC INTEL</p><p style="margin:0;font-size:24px;line-height:30px;font-weight:600;color:${p.heading};">${escapeHtml(INTEL_TAGLINE)}</p></div></header>
<img src="${emailImagePaths.intelFire}" alt="" width="600" height="100" style="display:block;width:100%;height:auto;border-bottom:1px solid ${p.brandDark};">`;
  }
  return `<header style="background:${p.ink};background:linear-gradient(135deg,${p.ink} 0%,${p.brandDark} 100%);padding:24px 32px;display:flex;align-items:center;justify-content:space-between;">
<span style="color:${p.onBrand};font-size:20px;font-weight:700;letter-spacing:-0.01em;">CareMetric Breathe</span><span style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,${p.cyan} 0%,${p.brand} 100%);"></span></header>
<div style="height:4px;background:linear-gradient(90deg,${p.cyan} 0%,${p.brand} 50%,${p.gold} 100%);"></div>`;
}

/**
 * One welcome page in the application's look. `content` is { heading, lines, highlights, offer, action, notice, fine }; every value is
 * escaped here, and `action` is either a form posting back to this page or a link the server built.
 */
export function welcomePage(app, { title, heading, lines = [], highlights = [], offer = null, notice = null, action = null, fine = [] }) {
  const profile = invitationProfiles[app] ?? invitationProfiles.carebase;
  const theme = emailThemes[profile.theme];
  const p = theme.palette, b = theme.button, info = theme.callouts[notice?.tone ?? 'info'] ?? theme.callouts.info;
  const buttonStyle = `display:inline-block;border:0;cursor:pointer;padding:14px 28px;font:inherit;font-size:16px;line-height:20px;font-weight:${b.weight};color:${b.text};background:${b.fill};border-radius:${b.radius}px;text-decoration:none;`;
  const actionHtml = !action ? '' : action.post
    ? `<form method="post" action="${escapeHtml(action.post)}" style="margin:24px 0 8px;"><button type="submit" style="${buttonStyle}">${escapeHtml(action.label)}</button></form>`
    : `<p style="margin:24px 0 8px;"><a href="${escapeHtml(action.href)}" rel="noopener" style="${buttonStyle}">${escapeHtml(action.label)}</a></p>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="${theme.colorScheme}">
<title>${escapeHtml(title)}</title>
<style>
body { margin: 0; background: ${p.canvas}; color: ${p.body}; font-family: ${theme.fontStack}; font-size: 16px; line-height: 24px; }
main { max-width: 600px; margin: 32px auto; background: ${p.card}; border: 1px solid ${p.hairline}; border-radius: ${theme.cardRadius}px; overflow: hidden; }
.body { padding: 32px; }
h1 { margin: 0 0 16px; color: ${p.heading}; font-size: 24px; line-height: 32px; }
dl { margin: 16px 0; padding: 12px 16px; background: ${p.panel}; border: 1px solid ${p.hairline}; border-radius: 8px; display: grid; grid-template-columns: 40% 60%; gap: 8px 12px; font-size: 14px; line-height: 20px; }
dt { color: ${p.muted}; } dd { margin: 0; color: ${p.heading}; font-weight: 600; }
ul { padding-left: 20px; } li { margin: 0 0 6px; }
li::marker { color: ${p.brand}; }
a { color: ${p.brand}; }
footer { padding: 18px 32px 24px; border-top: 1px solid ${p.hairline}; font-size: 13px; line-height: 20px; color: ${p.muted}; text-align: center; }
@media (max-width: 620px) { main { margin: 0; border-radius: 0; } .body { padding: 24px; } dl { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
${pageHeader(profile, p)}
<div class="body">
<h1>${escapeHtml(heading)}</h1>
${notice ? `<p role="status" style="margin:0 0 16px;padding:12px 16px;background:${info.fill};border:1px solid ${info.border};border-left:4px solid ${info.accent};border-radius:8px;color:${info.text};">${escapeHtml(notice.text)}</p>` : ''}
${lines.map(text => `<p style="margin:0 0 16px;">${escapeHtml(text)}</p>`).join('\n')}
${highlights.length ? `<ul>${highlights.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
${offer ? `<dl>${offer.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>` : ''}
${actionHtml}
${fine.map(text => `<p style="margin:12px 0 0;font-size:14px;line-height:21px;color:${p.muted};">${escapeHtml(text)}</p>`).join('\n')}
</div>
<footer>Questions? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> or call ${SUPPORT_PHONE_DISPLAY}.<br>${escapeHtml(profile.name)} · ${escapeHtml(profile.siteLabel)}</footer>
</main>
</body>
</html>
`;
}

/** The page for an address that is not a current invitation. */
export const unknownInvitationPage = () => welcomePage('carebase', {
  title: 'Invitation not found', heading: 'This invitation link is not valid',
  lines: ['The link may be incomplete, or it was replaced by a newer invitation. Check the most recent email from CareMetric, or contact us and we will send a new one.'],
});

/** The welcome page for one invitation in its current state. `signup` is the sign-up link once the plan is active. */
export function invitationPage(invitation, { token, signup = null, notice = null } = {}) {
  const profile = invitationProfiles[invitation.app];
  const offer = offerOf(invitation);
  const free = isComplimentary(offer);
  const title = `Your invitation to ${profile.name}`;
  if (invitation.status === 'revoked') {
    return welcomePage(invitation.app, { title, heading: 'This invitation was withdrawn', lines: [`The invitation for ${invitation.organization_name} is no longer available. Contact us if you think this is a mistake.`] });
  }
  if (invitation.status === 'expired') {
    return welcomePage(invitation.app, { title, heading: 'This invitation has expired', lines: [`The invitation for ${invitation.organization_name} expired on ${dateWords(invitation.expires_at)}. Contact us and we will gladly send a new one.`] });
  }
  if (invitation.status === 'claimed') {
    return welcomePage(invitation.app, { title, heading: `Your ${profile.short} account is set up`,
      lines: [`${invitation.organization_name}'s ${offer.plan_name} plan is connected to your ${profile.short} account.`],
      action: { href: profile.site, label: `Go to ${profile.short}` } });
  }
  if (invitation.status === 'active') {
    return welcomePage(invitation.app, { title, heading: 'Your plan is active', notice,
      lines: [free ? `${invitation.organization_name}'s ${offer.plan_name} plan is active, with nothing to pay${offer.discount_duration === 'forever' ? '' : ' during your complimentary period'}.`
        : `Thank you for your payment. ${invitation.organization_name}'s ${offer.plan_name} plan is active.`,
      `One step is left: create your ${profile.short} sign-in. Use this button so your new account is connected to this plan.`],
      offer: offerRows(invitation), action: signup ? { href: signup, label: `Create your ${profile.short} sign-in` } : null,
      fine: [`We also emailed this link to ${invitation.contact_email}.`] });
  }
  // Pending, or a payment that was started: the offer and the button that accepts it.
  return welcomePage(invitation.app, { title, heading: `Welcome to ${profile.name}`, notice,
    lines: [`CareMetric has invited ${invitation.organization_name} to ${profile.name}.`, profile.summary],
    highlights: profile.highlights, offer: offerRows(invitation),
    action: { post: `/welcome/${token}`, label: free ? 'Accept and activate your plan' : 'Accept and continue to secure payment' },
    fine: [payingWords(invitation, profile), `This invitation is for ${invitation.contact_email} and expires on ${dateWords(invitation.expires_at)}.`] });
}

// ---- The service ---------------------------------------------------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {import('pg').Pool} options.pool
 * @param {{ client: () => Promise<any>, mirror: Function, refresh: Function }} options.stripe platform billing's Stripe access (billing.mjs)
 * @param {{ send: Function, configured: boolean }} options.mail the sender for customer email (from the support address)
 * @param {(key: string) => any} options.setting a Hub setting's current value (Settings → Billing)
 * @param {string} options.publicOrigin the Hub's own https origin, where the welcome page is
 * @param {boolean} options.enabled whether the database declares billing.customer-invitations.v1
 */
export function customerInvitations({ pool, stripe, mail, setting = () => null, publicOrigin, enabled = false, now = () => Date.now(), log = console }) {
  const one = async (db, sql, values) => (await db.query(sql, values)).rows[0];
  const find = async (db, by, value, lock = false) => (await one(db, 'select private.customer_invitation_find($1,$2,$3) as v', [by, value, lock])).v;
  const progress = async (db, id, change, values = {}) => (await one(db, 'select private.customer_invitation_progress($1,$2,$3::jsonb) as v', [id, change, JSON.stringify(values)])).v;
  const origin = () => new URL(live(publicOrigin)).origin;
  const welcomeUrl = token => `${origin()}/welcome/${token}`;
  const days = () => { const value = Number(setting('billing.invite_days')); return Number.isInteger(value) && value >= 1 && value <= 90 ? value : 30; };
  const expiry = () => new Date(now() + days() * 86_400_000);
  const signupBase = app => {
    const profile = invitationProfiles[app];
    const value = setting(profile.signupSetting);
    return typeof value === 'string' && /^https:\/\//.test(value) ? value : profile.defaultSignup;
  };
  const signupFor = (invitation, token) => signupLink(signupBase(invitation.app), token, { app: invitation.app, entitlement: invitation.entitlement_key });
  const requireEnabled = () => { if (!enabled) throw new HttpError(503, 'Customer invitations are waiting for their database migration (billing.customer-invitations.v1).'); };
  const asHttp = error => {
    if (error instanceof HttpError) return error;
    if (error instanceof StripeError) {
      return error.status >= 500 || error.type === 'api_connection_error'
        ? new HttpError(503, 'Stripe is temporarily unavailable. Try again.') : new HttpError(400, `Stripe: ${error.message}`);
    }
    if (error?.code === '22023' && typeof error.message === 'string' && error.message.length < 200) return new HttpError(400, error.message);
    if (error?.code === '55000' && typeof error.message === 'string' && error.message.length < 200) return new HttpError(409, error.message);
    if (error?.code === '40001') return new HttpError(409, 'The invitation changed. Refresh and review before saving.');
    if (error?.code === 'P0002') return new HttpError(404, 'That invitation was not found.');
    if (error?.code === '23505') return new HttpError(409, 'That account is already linked to another customer.');
    return error;
  };

  async function send(invitation, token, kind) {
    const content = kind === 'ready' ? readyEmail(invitation, signupFor(invitation, token)) : invitationEmail(invitation, welcomeUrl(token));
    let delivery = 'unknown';
    try {
      const result = await mail.send({ to: invitation.contact_email, subject: content.subject, text: content.text, html: content.html,
        fromName: invitationProfiles[invitation.app].name });
      delivery = ['sent', 'failed', 'unknown'].includes(result?.delivery) ? result.delivery : 'unknown';
    } catch { delivery = 'unknown'; }
    if (kind === 'invitation') {
      await transaction(pool, db => db.query('select private.customer_invitation_sent($1,$2)', [invitation.id, delivery]))
        .catch(() => log.warn('An invitation email went out, but its delivery could not be recorded.'));
    }
    if (delivery !== 'sent') log.warn(`A customer invitation ${kind === 'ready' ? 'sign-up' : ''} email was not accepted by the email service (${delivery}).`);
    return delivery;
  }

  // ---- The owner's commands (Billing → Invite a customer) ----------------------------------------------------------------------------
  async function admin(sessionToken, input) {
    requireEnabled();
    let command;
    try { command = invitationCommandSchema.parse(input); } catch (error) {
      const issue = error?.issues?.[0]?.message;
      throw new HttpError(400, typeof issue === 'string' ? issue : 'Check the invitation and try again.');
    }
    try {
      const actor = await withSession(pool, sessionToken, async db => {
        const value = (await one(db, 'select hub.authorize_app_command() as actor')).actor;
        return value.user_id;
      });
      const server = operation => transaction(pool, operation);
      if (command.action === 'list') {
        return { invitations: await server(async db => (await one(db, 'select private.customer_invitations_list() as v')).v) };
      }
      if (command.action === 'preview') {
        const record = normalizedRecord(command.invitation);
        const price = await server(async db => (await one(db, 'select private.customer_invitation_price($1,$2) as v', [record.app, record.price])).v);
        if (price.pricing_model === 'flat' && record.quantity !== 1) throw new HttpError(400, 'A flat price is sold once.');
        const draft = { ...record, ...price, id: '00000000-0000-4000-8000-000000000000', expires_at: expiry().toISOString() };
        const { subject, html, text } = invitationEmail(draft, `${origin()}/welcome/preview`);
        return { subject, html, text };
      }
      if (command.action === 'create') {
        const record = normalizedRecord(command.invitation);
        const token = newInvitationToken();
        let invitation = await server(async db => (await one(db, 'select private.customer_invitation_create($1,$2::jsonb,$3,$4,$5) as v',
          [actor, JSON.stringify(record), command.request_key, sha256(token), expiry()])).v);
        if (invitation.replay) {
          // The same request again: the invitation exists. Its email is sent only if it never was, under a fresh link (the first one's
          // token was not kept).
          if (invitation.email_status) return { invitation: stripReplay(invitation), delivery: null };
          invitation = await server(async db => (await one(db, 'select private.customer_invitation_owner($1,$2,$3,$4,$5,$6) as v',
            [actor, invitation.id, 'rotate', invitation.version, sha256(token), expiry()])).v);
        }
        const delivery = await send(invitation, token, 'invitation');
        return { invitation: await view(invitation.id), delivery };
      }
      if (command.action === 'resend') {
        const token = newInvitationToken();
        let current = await server(db => find(db, 'id', command.id));
        if (!current) throw new HttpError(404, 'That invitation was not found.');
        if (current.version !== command.expected_version) throw new HttpError(409, 'The invitation changed. Refresh and review before saving.');
        // An open Checkout returns to the link being replaced, so it is closed first (a new one is made with the new link); one that
        // has just been paid makes the plan active, and the sign-up email goes out instead.
        current = await stopCheckout(current);
        const invitation = await server(async db => (await one(db, 'select private.customer_invitation_owner($1,$2,$3,$4,$5,$6) as v',
          [actor, command.id, 'rotate', current.version, sha256(token), expiry()])).v);
        // An active plan needs the sign-up link; anything earlier, the invitation itself.
        const delivery = await send(invitation, token, invitation.raw_status === 'active' ? 'ready' : 'invitation');
        return { invitation: await view(invitation.id), delivery };
      }
      if (command.action === 'revoke') {
        const current = await server(db => find(db, 'id', command.id));
        if (!current) throw new HttpError(404, 'That invitation was not found.');
        if (current.version !== command.expected_version) throw new HttpError(409, 'The invitation changed. Refresh and review before saving.');
        // A payment in progress is stopped first, unless it has just finished: then the plan is recorded and it cannot be revoked.
        if ((await stopCheckout(current)).raw_status === 'active') {
          throw new HttpError(409, 'They have just paid, so the plan is active. Cancel its subscription in Billing instead.');
        }
        const invitation = await server(async db => (await one(db, 'select private.customer_invitation_owner($1,$2,$3,$4,null,null) as v',
          [actor, command.id, 'revoke', command.expected_version])).v);
        return { invitation: await view(invitation.id), delivery: null };
      }
      const invitation = await server(async db => (await one(db, 'select private.customer_invitation_owner($1,$2,$3,$4,null,null) as v',
        [actor, command.id, 'link', command.expected_version])).v);
      return { invitation: await view(invitation.id), delivery: null };
    } catch (error) { throw asHttp(error); }
  }
  const ownerFields = ['product_id', 'product', 'raw_status', 'customer', 'coupon', 'checkout', 'checkout_attempt', 'ready_email_at', 'app_name', 'entitlement_key', 'replay'];
  const stripReplay = invitation => Object.fromEntries(Object.entries(invitation).filter(([key]) => !ownerFields.includes(key)));
  const view = async id => stripReplay(await transaction(pool, db => find(db, 'id', id)));

  // ---- The customer's welcome page -----------------------------------------------------------------------------------------------
  /** The subscription a completed Checkout made, recorded on the invitation and mirrored. Returns the invitation. */
  async function settleCheckout(client, sessionId) {
    const session = await client.get(`/v1/checkout/sessions/${sessionId}`, {}, checkoutOptions);
    const subscription = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (session.status !== 'complete' || !subscription) return transaction(pool, db => find(db, 'checkout', sessionId));
    return transaction(pool, async db => {
      const invitation = await find(db, 'checkout', sessionId, true);
      if (!invitation || session.metadata?.hub_invitation !== invitation.id) return invitation;
      await stripe.refresh(db, client, 'subscription', subscription);
      return progress(db, invitation.id, 'active', { subscription });
    });
  }

  /** Closes an invitation's open Checkout, or records the plan of one that was just paid. Returns the invitation as it now is. */
  async function stopCheckout(invitation) {
    if (invitation.raw_status !== 'checkout' || !invitation.checkout) return invitation;
    const client = await stripe.client();
    const session = await client.get(`/v1/checkout/sessions/${invitation.checkout}`, {}, checkoutOptions);
    if (session.status === 'complete') return (await settleCheckout(client, invitation.checkout)) ?? invitation;
    if (session.status === 'open') {
      await client.post(`/v1/checkout/sessions/${invitation.checkout}/expire`, {}, { ...checkoutOptions, idempotencyKey: `hub-invitation-expire-${invitation.checkout}` });
    }
    return invitation;
  }

  /** The "plan is active" email, once, when the customer is on the page with the invitation's own link. */
  async function readyOnce(invitation, token) {
    const claim = await transaction(pool, db => progress(db, invitation.id, 'ready_email', {})).catch(() => null);
    if (claim?.send) await send(invitation, token, 'ready');
  }

  /** GET /welcome/<token>: the page, after confirming a payment the customer has just returned from. */
  async function page(token, { checkout = null } = {}) {
    if (!enabled || !invitationTokenPattern.test(token ?? '')) return { status: 404, html: unknownInvitationPage() };
    let invitation = await transaction(pool, db => find(db, 'token', sha256(token)));
    if (!invitation) return { status: 404, html: unknownInvitationPage() };
    let notice = null;
    if (invitation.raw_status === 'checkout' && checkout === 'done') {
      try {
        invitation = await settleCheckout(await stripe.client(), invitation.checkout);
        if (invitation.raw_status === 'active') await readyOnce(invitation, token);
        else notice = { tone: 'warning', text: 'We are still confirming your payment with Stripe. Refresh this page in a minute.' };
      } catch { notice = { tone: 'warning', text: 'We could not confirm your payment with Stripe just now. Refresh this page in a minute.' }; }
    } else if (checkout === 'cancelled' && ['pending', 'checkout'].includes(invitation.raw_status)) {
      notice = { tone: 'info', text: 'Your payment was not completed, and nothing was charged. You can continue whenever you are ready.' };
    } else if (invitation.raw_status === 'active' && !invitation.ready_email_at) {
      // Stripe's webhook recorded the payment before the customer came back: the sign-up email still goes out, once.
      await readyOnce(invitation, token);
    }
    const signup = invitation.status === 'active' ? signupFor(invitation, token) : null;
    return { status: 200, html: invitationPage(invitation, { token, signup, notice }) };
  }

  /**
   * POST /welcome/<token>: the customer accepts. Complimentary: the plan is created now, with no Stripe page. Otherwise: a Checkout session
   * (an open one is reused) with the discount applied. Returns where to send the browser next, or a page to show.
   */
  async function accept(token) {
    if (!enabled || !invitationTokenPattern.test(token ?? '')) return { status: 404, html: unknownInvitationPage() };
    const hash = sha256(token);
    let client;
    try { client = await stripe.client(); } catch {
      const invitation = await transaction(pool, db => find(db, 'token', hash));
      if (!invitation) return { status: 404, html: unknownInvitationPage() };
      return { status: 503, html: invitationPage(invitation, { token, notice: { tone: 'warning', text: 'We could not reach our payment provider just now. Please try again in a few minutes.' } }) };
    }
    // Each step locks the invitation, re-reads it and commits on its own, so whatever Stripe made is recorded at once and survives a later
    // failure. The tenant is committed before the first Stripe request, and every request's parameters follow from what is already
    // recorded: a retry after any failure sends Stripe the same parameters under the same idempotency key, which Stripe requires.
    const step = operation => transaction(pool, async db => {
      const invitation = await find(db, 'token', hash, true);
      if (!invitation) return { page: { status: 404, html: unknownInvitationPage() } };
      if (!['pending', 'checkout'].includes(invitation.status)) return { redirect: `/welcome/${token}` };
      return operation(db, invitation);
    });
    const steps = [
      async (db, invitation) => {
        const price = (await one(db, 'select private.billing_lookup($1,$2) as v', ['price', invitation.price])).v;
        if (!price?.active || !price.product_active) {
          return { page: { status: 409, html: invitationPage(invitation, { token, notice: { tone: 'warning',
            text: 'This plan\'s price has changed since you were invited, so the invitation needs to be updated. Contact us and we will send you a new one.' } }) } };
        }
        await one(db, 'select private.customer_invitation_tenant($1) as t', [invitation.id]);
        return null;
      },
      async (db, invitation) => {
        if (invitation.customer) return null;
        const customer = await client.post('/v1/customers', { name: invitation.organization_name, email: invitation.contact_email,
          metadata: { hub_tenant_id: invitation.tenant_id, app: invitation.app, hub_invitation: invitation.id } }, { idempotencyKey: `hub-invitation-customer-${invitation.id}` });
        await stripe.mirror(db, client, 'customer', customer);
        await progress(db, invitation.id, 'customer', { customer: customer.id });
        return null;
      },
      async (db, invitation) => {
        const percent = Number(invitation.discount_percent);
        if (percent <= 0 || invitation.coupon) return null;
        const coupon = await client.post('/v1/coupons', { percent_off: percent, duration: invitation.discount_duration,
          ...(invitation.discount_duration === 'repeating' ? { duration_in_months: invitation.discount_months } : {}),
          max_redemptions: 1, name: `Invitation ${percent}% off`.slice(0, 40), applies_to: { products: [invitation.product] },
          metadata: { app: invitation.app, hub_invitation: invitation.id } }, { idempotencyKey: `hub-invitation-coupon-${invitation.id}` });
        await stripe.refresh(db, client, 'coupon', coupon.id);
        await progress(db, invitation.id, 'coupon', { coupon: coupon.id });
        return null;
      },
      async (db, invitation) => {
        const metadata = { app: invitation.app, hub_tenant_id: invitation.tenant_id, hub_invitation: invitation.id };
        const items = [{ price: invitation.price, quantity: Number(invitation.quantity) }];
        if (Number(invitation.discount_percent) >= 100) {
          // Complimentary: the subscription is made here, with no Checkout and no card. Its invoices are emailed (send_invoice), so a
          // complimentary period that ends bills by email instead of failing a card that was never asked for.
          const subscription = await client.post('/v1/subscriptions', { customer: invitation.customer, items, discounts: [{ coupon: invitation.coupon }],
            collection_method: 'send_invoice', days_until_due: 30, metadata, expand: ['discounts'] }, { idempotencyKey: `hub-invitation-subscription-${invitation.id}` });
          await stripe.mirror(db, client, 'subscription', subscription);
          return { invitation: await progress(db, invitation.id, 'active', { subscription: subscription.id }), ready: true, redirect: `/welcome/${token}` };
        }
        if (invitation.checkout) {
          const session = await client.get(`/v1/checkout/sessions/${invitation.checkout}`, {}, checkoutOptions);
          if (session.status === 'open' && typeof session.url === 'string') return { redirect: session.url };
          if (session.status === 'complete') return { settle: invitation.checkout };
        }
        // The key names the link too (a resend changes the return addresses), and the session keeps Stripe's own 24-hour expiry, so a
        // retried request is identical to the first and Stripe returns the session it already made.
        const attempt = Number(invitation.checkout_attempt ?? 0) + 1;
        const back = welcomeUrl(token);
        const session = await client.post('/v1/checkout/sessions', { mode: 'subscription', customer: invitation.customer, line_items: items,
          ...(invitation.coupon ? { discounts: [{ coupon: invitation.coupon }] } : {}), client_reference_id: invitation.id, metadata,
          subscription_data: { metadata }, success_url: `${back}?checkout=done`, cancel_url: `${back}?checkout=cancelled` },
        { ...checkoutOptions, idempotencyKey: `hub-invitation-checkout-${invitation.id}-${attempt}-${hash.slice(0, 16)}` });
        if (!/^https:\/\/checkout\.stripe\.com\//.test(session.url ?? '')) throw new HttpError(503, 'Stripe did not return a payment page.');
        await progress(db, invitation.id, 'checkout', { checkout: session.id, attempt });
        return { redirect: session.url };
      },
    ];
    let outcome = null;
    try {
      for (const operation of steps) {
        outcome = await step(operation);
        if (outcome) break;
      }
    } catch (error) {
      log.warn(`A customer invitation could not be accepted (${error?.status ?? error?.code ?? 'error'}).`);
      const invitation = await transaction(pool, db => find(db, 'token', hash)).catch(() => null);
      if (!invitation) return { status: 503, html: unknownInvitationPage() };
      return { status: 503, html: invitationPage(invitation, { token, notice: { tone: 'warning', text: 'Something went wrong while accepting your invitation, and nothing was charged. Please try again in a few minutes.' } }) };
    }
    if (outcome.settle) {
      const invitation = await settleCheckout(client, outcome.settle);
      if (invitation?.raw_status === 'active') await readyOnce(invitation, token);
      return { redirect: `/welcome/${token}` };
    }
    if (outcome.ready) await readyOnce(outcome.invitation, token);
    return outcome.page ?? { redirect: outcome.redirect };
  }

  /** A Checkout event for an invitation (billing.mjs webhook): the paid plan is recorded even if the customer never came back. */
  async function reconcileCheckout(sessionId) {
    if (!enabled) return;
    const known = await transaction(pool, db => find(db, 'checkout', sessionId));
    if (!known || !['checkout', 'revoked'].includes(known.raw_status)) return;
    await settleCheckout(await stripe.client(), sessionId);
  }

  return { admin, page, accept, reconcileCheckout, enabled: () => enabled };
}
