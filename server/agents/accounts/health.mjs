/**
 * How an account is doing, read from facts the Hub already holds (the Stripe mirror, the apps' own usage reports and the
 * support cases): a score from 0 to 100, a band, and the reasons behind it. Pure, with every number in the tables below
 * so the owner can retune it by changing one constant. It is advice for the owner's weekly report and never changes a plan,
 * a price or anyone's access. Later customer emails will hang off these same reasons, so the version is part of the result.
 *
 * Payment problems count once however many of them there are (the largest applies), so an account with a past-due
 * subscription and an overdue invoice is not punished twice for one failed charge. An account that has been billing for under 14 days is "new"
 * and has no score: a week of data says too little. Cases waiting on the customer are not held against the account, and
 * a gap in usage reports means nothing unless the app reported before: usage is compared with the newest report at or
 * before 28 days earlier, and no baseline means no comparison.
 */
export const healthVersion = 'health.1';

export const liveStatuses = Object.freeze(['trialing', 'active', 'past_due', 'paused', 'unpaid', 'incomplete']);

export const weights = Object.freeze({
  // Only the largest of these applies.
  payment: Object.freeze({ unpaid: 50, past_due: 40, invoice_overdue: 25, delinquent: 20 }),
  cancel_scheduled: 35,
  closed_but_billing: 30,
  suspended: 20,
  trial_ending: 10,
  paused: 10,
  usage_stopped: 25,
  usage_dropped: 15,
  urgent_case_waiting: 15,
  many_open_cases: 10,
  no_billing_email: 5,
  // The same gap matters more while Stripe's own emails are the only way a past-due or trialing customer hears from us.
  no_billing_email_exposed: 15,
});

export const thresholds = Object.freeze({
  healthy: 75, watch: 50, newDays: 14, trialDays: 7, renewalDays: 30, manyCases: 3, usageDropRatio: 0.75, usageUpRatio: 1.25, usageMinChange: 2, longPlanMonths: 3,
});

/** What each reason asks the owner to look at; these also decide who appears under "needs you". */
export const attentionReasons = Object.freeze(['unpaid', 'past_due', 'invoice_overdue', 'delinquent', 'cancel_scheduled', 'closed_but_billing', 'suspended', 'trial_ending', 'urgent_case_waiting']);

export const reasonWords = Object.freeze({
  unpaid: 'subscription unpaid', past_due: 'payment past due', invoice_overdue: 'an invoice is overdue', delinquent: 'marked delinquent in Stripe',
  cancel_scheduled: 'cancellation scheduled', closed_but_billing: 'account closed but still billing', suspended: 'account suspended', trial_ending: 'trial ends soon',
  paused: 'subscription paused', usage_stopped: 'usage stopped', usage_dropped: 'usage dropped', urgent_case_waiting: 'a high-priority case is open',
  many_open_cases: 'several open cases', no_billing_email: 'no billing email on file', renewing_soon: 'renews within 30 days', usage_up: 'usage is growing',
});

const day = 86_400_000;
const instant = value => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : null; };
const number = value => (Number.isFinite(value) ? value : null);

function isLongPlan(item) {
  return item.interval === 'year' || (item.interval === 'month' && (item.interval_count ?? 1) >= thresholds.longPlanMonths);
}

// The date-based tests below are the ones `assess` scores with. The report asks the same functions which subscription raised a
// flag, so the date in the email is the date that earned the flag, not the first one the account happens to have.
const liveOf = account => (account.subscriptions ?? []).filter(subscription => liveStatuses.includes(subscription.status));
const cancelsSoon = (subscription, nowTime) => subscription.cancel_at_period_end === true || (instant(subscription.cancel_at) ?? 0) > nowTime;
const trialEndsSoon = (subscription, nowTime) => {
  if (subscription.status !== 'trialing') return false;
  const end = instant(subscription.trial_end);
  return end !== null && end - nowTime <= thresholds.trialDays * day && end - nowTime >= -day;
};
const renewsSoon = (subscription, nowTime) => {
  if (subscription.status !== 'active' || subscription.cancel_at_period_end || !(subscription.items ?? []).some(isLongPlan)) return false;
  const end = instant(subscription.current_period_end);
  if (end === null || end < nowTime || end - nowTime > thresholds.renewalDays * day) return false;
  // A cancellation date at or before the period end means the subscription stops instead of renewing (one after it renews once more first).
  // As for `cancel_scheduled`, a date that has already passed is stale data and does not count.
  const cancelAt = instant(subscription.cancel_at);
  return !(cancelAt !== null && cancelAt > nowTime && cancelAt <= end);
};
const soonest = (list, key) => list.reduce((best, entry) => (best === null || (instant(entry[key]) ?? Infinity) < (instant(best[key]) ?? Infinity) ? entry : best), null);

/** The live subscription whose scheduled cancellation raised `cancel_scheduled`, the earliest first, or null. */
export const cancelingSubscription = (account, now = new Date()) => soonest(liveOf(account).filter(subscription => cancelsSoon(subscription, now.getTime())), 'cancel_at');
/** The trialing subscription whose end raised `trial_ending`, the earliest first, or null. */
export const endingTrial = (account, now = new Date()) => soonest(liveOf(account).filter(subscription => trialEndsSoon(subscription, now.getTime())), 'trial_end');
/** The subscription that raised `renewing_soon`, the earliest renewal first, or null. */
export const renewingSubscription = (account, now = new Date()) => soonest(liveOf(account).filter(subscription => renewsSoon(subscription, now.getTime())), 'current_period_end');

/**
 * How long the account has been billing, in days: from its earliest subscription or, with none, from when the tenant was created.
 * A tenant that existed for months before its first subscription is still new to billing, which is what the score reads.
 */
export function ageDays(account, now) {
  const subscribed = (account.subscriptions ?? []).map(subscription => instant(subscription.created)).filter(time => time !== null);
  const times = subscribed.length ? subscribed : [instant(account.createdAt)].filter(time => time !== null);
  return times.length ? (now.getTime() - Math.min(...times)) / day : null;
}

/**
 * @param account one entry of the account snapshot (see supabase/migrations/20261102170000_agent_accounts.sql)
 * @param {Date} now
 * @returns {{ version: string, band: 'healthy'|'watch'|'at_risk'|'new'|'inactive', score: number|null, penalty: number, reasons: string[], flags: string[], attention: boolean, ageDays: number|null }}
 */
export function assess(account, now = new Date()) {
  const live = (account.subscriptions ?? []).filter(subscription => liveStatuses.includes(subscription.status));
  const reasons = [];
  const flags = [];
  const has = status => live.some(subscription => subscription.status === status);

  // Payment: the largest signal applies, once.
  const payment = [];
  if (has('unpaid')) payment.push('unpaid');
  if (has('past_due')) payment.push('past_due');
  if ((account.invoices?.overdue ?? 0) > 0) payment.push('invoice_overdue');
  if (account.customer?.delinquent === true) payment.push('delinquent');
  const paymentReasons = payment.sort((a, b) => weights.payment[b] - weights.payment[a]);
  reasons.push(...paymentReasons);
  let penalty = paymentReasons.length ? weights.payment[paymentReasons[0]] : 0;

  const add = (reason, amount = weights[reason]) => { reasons.push(reason); penalty += amount; };
  const nowTime = now.getTime();

  if (live.some(subscription => cancelsSoon(subscription, nowTime))) add('cancel_scheduled');
  if (account.status === 'closed' && live.length > 0) add('closed_but_billing');
  if (account.status === 'suspended') add('suspended');
  if (live.some(subscription => trialEndsSoon(subscription, nowTime))) add('trial_ending');
  if (has('paused')) add('paused');

  // Usage, where the app reports it: the latest report against the newest one at or before 28 days earlier.
  let dropped = false;
  let stopped = false;
  let up = false;
  for (const entry of account.usage ?? []) {
    const latest = number(entry.latest);
    const baseline = number(entry.baseline);
    if (latest === null || baseline === null || baseline < thresholds.usageMinChange) continue;
    if (latest === 0) stopped = true;
    else if (latest <= baseline * thresholds.usageDropRatio && baseline - latest >= thresholds.usageMinChange) dropped = true;
    else if (latest >= baseline * thresholds.usageUpRatio && latest - baseline >= thresholds.usageMinChange) up = true;
  }
  if (stopped) add('usage_stopped');
  else if (dropped) add('usage_dropped');

  const cases = account.cases ?? {};
  if ((cases.highOrUrgent ?? 0) > 0) add('urgent_case_waiting');
  if ((cases.waitingOnYou ?? 0) >= thresholds.manyCases) add('many_open_cases');

  if (account.customer && account.customer.hasEmail === false) {
    add('no_billing_email', paymentReasons.length || has('trialing') ? weights.no_billing_email_exposed : weights.no_billing_email);
  }

  if (live.some(subscription => renewsSoon(subscription, nowTime))) flags.push('renewing_soon');
  if (up && has('active')) flags.push('usage_up');

  const age = ageDays(account, now);
  let band;
  let score = null;
  if (live.length === 0) band = 'inactive';
  else if (age !== null && age < thresholds.newDays) band = 'new';
  else {
    score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
    band = score >= thresholds.healthy ? 'healthy' : score >= thresholds.watch ? 'watch' : 'at_risk';
  }
  const attention = band === 'at_risk' || reasons.some(reason => attentionReasons.includes(reason));
  return { version: healthVersion, band, score, penalty, reasons, flags, attention, ageDays: age };
}
