/**
 * The weekly account report, composed from one snapshot of the Hub's own billing mirror (see the account snapshot function in
 * supabase/migrations/20261102170000_agent_accounts.sql). Pure: a snapshot and the time go in; an email comes out.
 *
 * What is stored and what is not. The owner's email carries account names, reasons and money in its `blocks`, which the notifier
 * never stores. The subject, the stored body (which is also the inbox preview) and the task result carry counts only, so the agent
 * tables, the notification log and the run summary hold no customer name and no amount. No billing contact address is ever in the
 * snapshot, let alone the report.
 *
 * The revenue figures come from the same functions as the Billing screen (money.mjs), so the two always agree: paying and
 * past-due subscriptions after discounts count as MRR, trials are counted separately, and ARR is MRR times twelve.
 */
import { plural } from '../tasks/shared.mjs';
import { assess, cancellationDate, endingTrial, healthVersion, liveStatuses, reasonWords, renewingSubscriptions } from './health.mjs';
import { monthlyTotals } from './money.mjs';

export const rowLimit = 10;
const nameLimit = 60;
const day = 86_400_000;
const shortDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const dollars = cents => usd.format((Number.isFinite(cents) ? cents : 0) / 100);
const clip = (text, limit) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value; };
const instant = value => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : null; };
const dateWords = value => (instant(value) === null ? 'soon' : shortDay.format(new Date(value)));
const capital = text => (text ? text[0].toUpperCase() + text.slice(1) : text);

/** The reasons for one account in words, the first three, with the dates and amounts that make them actionable. */
function reasonLine(account, health, now) {
  // Each date comes from the subscription that raised the reason (health.mjs), never from the first one the account has.
  const words = health.reasons.slice(0, 3).map(reason => {
    if (reason === 'trial_ending') return `trial ends ${dateWords(endingTrial(account, now)?.trial_end)}`;
    if (reason === 'cancel_scheduled') return `cancels ${dateWords(cancellationDate(account, now))}`;
    if (reason === 'invoice_overdue') return `${plural(account.invoices?.overdue ?? 0, 'overdue invoice')}, ${dollars(account.invoices?.remainingCents)} remaining`;
    return reasonWords[reason] ?? reason.replaceAll('_', ' ');
  });
  return capital(words.join('; '));
}

function section(title, rows, extra = '') {
  if (rows.length === 0) return [];
  return [
    { type: 'paragraph', text: title },
    { type: 'details', rows: rows.slice(0, rowLimit) },
    ...(rows.length > rowLimit ? [{ type: 'paragraph', text: `And ${rows.length - rowLimit} more.` }] : []),
    ...(extra ? [{ type: 'paragraph', text: extra }] : []),
  ];
}

/**
 * @param {{ snapshot: object, now?: Date, publicOrigin?: string|null }} input
 * @returns {{ subject: string, body: string, blocks: object[], result: object }}
 */
export function composeAccountsReport({ snapshot, now = new Date(), publicOrigin = null }) {
  const coupons = snapshot.coupons ?? [];
  const everyone = snapshot.accounts ?? [];
  // A closed tenant with nothing live has nothing to report; a closed tenant that still bills is itself a finding.
  const accounts = everyone.filter(account => !(account.status === 'closed' && !(account.subscriptions ?? []).some(subscription => liveStatuses.includes(subscription.status))));
  const assessed = accounts.map(account => ({ account, health: assess(account, now), mrrCents: monthlyTotals(account.subscriptions ?? [], coupons).mrrCents }));
  const byBand = band => assessed.filter(entry => entry.health.band === band).length;

  const needs = assessed.filter(entry => entry.health.attention)
    .sort((a, b) => b.health.penalty - a.health.penalty || a.account.name.localeCompare(b.account.name));
  const renewalDate = entry => instant(renewingSubscriptions(entry.account, now)[0]?.current_period_end) ?? 0;
  const renewals = assessed.filter(entry => entry.health.flags.includes('renewing_soon')).sort((a, b) => renewalDate(a) - renewalDate(b));
  const growing = assessed.filter(entry => entry.health.flags.includes('usage_up'));

  const allSubscriptions = everyone.flatMap(account => account.subscriptions ?? []);
  const totals = monthlyTotals(allSubscriptions, coupons);
  const weekAgo = now.getTime() - 7 * day;
  const newThisWeek = allSubscriptions.filter(subscription => liveStatuses.includes(subscription.status) && (instant(subscription.created) ?? 0) >= weekAgo).length;
  const lostThisWeek = allSubscriptions.filter(subscription => subscription.status === 'canceled'
    && Math.max(instant(subscription.canceled_at) ?? 0, instant(subscription.ended_at) ?? 0) >= weekAgo).length;
  const currencies = new Set(allSubscriptions.flatMap(subscription => (subscription.items ?? []).map(item => item.currency).filter(Boolean)));

  const trialsEnding = assessed.filter(entry => entry.health.reasons.includes('trial_ending')).length;
  const counts = {
    accounts: accounts.length, needsYou: needs.length, healthy: byBand('healthy'), watch: byBand('watch'), atRisk: byBand('at_risk'),
    newAccounts: byBand('new'), inactive: byBand('inactive'), renewals: renewals.length, expansion: growing.length, trialsEnding, truncated: snapshot.truncated === true,
  };

  const headline = counts.accounts === 0 ? 'There are no accounts to report yet.'
    : counts.needsYou === 0 ? `Nothing needs you this week across ${plural(counts.accounts, 'account')}.`
      : `${plural(counts.needsYou, 'account')} ${counts.needsYou === 1 ? 'needs' : 'need'} you this week, out of ${counts.accounts}.`;
  const origin = /^https:\/\//i.test(publicOrigin ?? '') ? publicOrigin.replace(/\/+$/, '') : null;

  const blocks = [
    ...(snapshot.mode === 'test' ? [{ type: 'callout', tone: 'warning', title: 'Test data.', text: 'These figures come from Stripe test mode, not from customers.' }] : []),
    ...(snapshot.mode === 'unverified' ? [{ type: 'callout', tone: 'warning', title: 'Stripe mode not verified.', text: 'The Hub has not verified which Stripe mode it is reading, so test and live data may be mixed.' }] : []),
    ...(snapshot.truncated ? [{ type: 'callout', tone: 'info', title: 'Partial list.', text: `Showing ${everyone.length} of ${snapshot.total ?? everyone.length} accounts. The figures below cover only these.` }] : []),
    { type: 'callout', tone: counts.needsYou ? 'warning' : 'success', title: counts.needsYou ? 'Heads up.' : 'All clear.', text: headline },
    ...section('Needs you', needs.map(entry => [clip(entry.account.name, nameLimit), reasonLine(entry.account, entry.health, now)])),
    ...section('Renewing in the next 30 days', renewals.map(entry => {
      // The date is the first renewal's, and the amount covers every plan that renews in the window, so a second plan is not left out of it.
      const renewing = renewingSubscriptions(entry.account, now);
      return [clip(entry.account.name, nameLimit), `Renews ${dateWords(renewing[0]?.current_period_end)}${renewing.length > 1 ? ` (${plural(renewing.length, 'plan')})` : ''}, ${dollars(monthlyTotals(renewing, coupons).arrCents)} a year`];
    })),
    ...section('Growing', growing.map(entry => [clip(entry.account.name, nameLimit), capital(reasonWords.usage_up)])),
    { type: 'paragraph', text: 'Revenue' },
    { type: 'details', rows: [
      ['MRR', dollars(totals.mrrCents)], ['ARR', dollars(totals.arrCents)], ['Trial MRR, not yet paying', dollars(totals.trialMrrCents)],
      ['New subscriptions this week', String(newThisWeek)], ['Lost this week', String(lostThisWeek)], ['Past due', String(totals.byStatus.past_due ?? 0)],
    ] },
    { type: 'paragraph', text: 'Accounts' },
    { type: 'details', rows: [
      ['Healthy', String(counts.healthy)], ['Watch', String(counts.watch)], ['At risk', String(counts.atRisk)], ['New, not scored', String(counts.newAccounts)],
      ['No live subscription', String(counts.inactive)],
    ] },
    { type: 'paragraph', text: `Revenue uses the same figures as the Billing screen: paying and past-due subscriptions after discounts, with trials counted apart.${currencies.size > 1 ? ' Some amounts are in more than one currency and are added as if equal.' : ''}` },
    { type: 'paragraph', text: `Scores are advice only and never change a plan, a price or anyone's access. Scoring version ${healthVersion}.` },
    ...(needs.length && origin ? [{ type: 'button', label: 'Open the AI team', url: `${origin}/admin/team` }] : []),
  ];

  return {
    subject: `Weekly accounts: ${plural(counts.accounts, 'account')}, ${counts.needsYou === 0 ? 'none need you' : `${counts.needsYou} ${counts.needsYou === 1 ? 'needs' : 'need'} you`}`,
    // Counts only: this is what the notification log keeps and what an inbox shows beside the subject.
    body: `${plural(counts.accounts, 'account')}: ${counts.healthy} healthy, ${counts.watch} watch, ${counts.atRisk} at risk, ${counts.newAccounts} new. ${counts.needsYou} ${counts.needsYou === 1 ? 'needs' : 'need'} you.`,
    blocks,
    result: counts,
  };
}
