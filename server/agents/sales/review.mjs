/**
 * `sales.review`: the Sales Executive's weekly pipeline review for the owner. It reads the growth pipeline (every page of the
 * server-only private.growth_snapshot), leaves out internal organizations, and says, per product, where every deal stands, what moved
 * this week, and which deals need the owner now and why: a prospect waiting for a reply, a conversation gone quiet, a trial ending
 * without first value or ended with no decision, a yes that has not become a trial, a qualified prospect with no permitted contact.
 *
 * It uses no model and sends nothing to a customer. The schedule fires every morning and every run in an Eastern week shares one alert
 * key, so the first sends and later ones find it sent; "Run now" always reports, under a key of its own. The stored body carries counts
 * only; organization names travel in the email's blocks, which the notifier never stores.
 */
import { delivered } from '../notify.mjs';
import { weekStart } from '../accounts/week.mjs';
import { plural, recordRun } from '../tasks/shared.mjs';

export const reviewVersion = 'sales-review.1';
const day = 86_400_000;
const nameLimit = 80;
const listLimit = 15;
const productNames = { carebase: 'CareBase', 'caremetric-intel': 'Intel' };
const groups = {
  prospects: ['identified', 'researched', 'qualified'], conversations: ['contacted', 'engaged', 'demo'], trials: ['trial'],
  customers: ['activated', 'paying', 'retained'], nurture: ['nurture'], closed: ['lost', 'disqualified', 'churned'],
};
const at = value => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : null; };
const days = ms => Math.max(0, Math.floor(ms / day));
const clip = (value, limit) => { const text = String(value ?? '').trim() || 'Unnamed organization'; return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`; };

/** Why one deal needs the owner, most urgent first, or null. */
export function attention(o, now) {
  const time = now.getTime();
  const events = o.events ?? [];
  const latest = kinds => events.filter(event => kinds.includes(event.kind)).map(event => at(event.occurred_at)).filter(value => value !== null).sort((a, b) => b - a)[0] ?? null;
  const trialEnd = at(o.trial_end);
  if (o.stage === 'trial' && trialEnd !== null && trialEnd < time) return { rank: 1, key: 'trial_expired', words: `Trial ended ${plural(days(time - trialEnd), 'day')} ago with no decision recorded` };
  if (o.stage === 'trial' && trialEnd !== null && trialEnd - time <= 7 * day && !o.activated_at) return { rank: 2, key: 'trial_ending', words: `Trial ends in ${plural(days(trialEnd - time), 'day')} and has not reached first value` };
  const yes = latest(['positive_reply', 'meeting_booked']);
  if (yes !== null && time - yes <= 14 * day && ['identified', 'researched', 'qualified', 'contacted', 'engaged', 'demo'].includes(o.stage)) {
    return { rank: 3, key: 'warm', words: `Said yes ${plural(days(time - yes), 'day')} ago: offer the free trial` };
  }
  const due = at(o.next_at);
  if (['engaged', 'demo'].includes(o.stage) && due !== null && time - due >= day) return { rank: 4, key: 'reply_waiting', words: `Next step overdue by ${plural(days(time - due), 'day')}` };
  const moved = at(o.updated_at);
  if (['engaged', 'demo'].includes(o.stage) && moved !== null && time - moved >= 14 * day) return { rank: 5, key: 'stalled', words: `No movement for ${plural(days(time - moved), 'day')}` };
  if (o.stage === 'qualified' && (!o.contact_id || o.eligibility !== 'permitted')) return { rank: 6, key: 'blocked', words: 'Qualified, but no permitted contact to write to' };
  return null;
}

export function composeReview({ items, now = new Date(), publicOrigin = null }) {
  const open = (items ?? []).filter(o => !o.internal && productNames[o.product]);
  const since = now.getTime() - 7 * day;
  const perProduct = Object.keys(productNames).map(product => {
    const deals = open.filter(o => o.product === product);
    const counts = Object.fromEntries(Object.entries(groups).map(([group, stages]) => [group, deals.filter(o => stages.includes(o.stage)).length]));
    const week = kind => deals.reduce((sum, o) => sum + (o.events ?? []).filter(event => event.kind === kind && (at(event.occurred_at) ?? 0) >= since).length, 0);
    const moved = { replies: week('positive_reply') + week('reply'), meetings: week('meeting_booked'), trials: week('trial_started'), paid: week('paid') };
    return { product, counts, moved };
  });
  const needs = open.map(o => ({ o, why: attention(o, now) })).filter(entry => entry.why).sort((a, b) => a.why.rank - b.why.rank || String(a.o.name).localeCompare(String(b.o.name)));
  const total = key => perProduct.reduce((sum, entry) => sum + entry.counts[key], 0);
  const counts = {
    prospects: total('prospects'), conversations: total('conversations'), trials: total('trials'), customers: total('customers'), nurture: total('nurture'),
    closed: total('closed'), needsYou: needs.length, trialsAtRisk: needs.filter(entry => ['trial_ending', 'trial_expired'].includes(entry.why.key)).length,
    warm: needs.filter(entry => entry.why.key === 'warm').length,
  };
  const origin = /^https:\/\//i.test(publicOrigin ?? '') ? publicOrigin.replace(/\/+$/, '') : null;
  const headline = open.length === 0 ? 'The pipeline is empty: no prospects, conversations or trials yet.'
    : needs.length === 0 ? 'Nothing in the pipeline needs you this week.'
      : `${plural(needs.length, 'deal')} ${needs.length === 1 ? 'needs' : 'need'} you this week${counts.warm ? `, including ${plural(counts.warm, 'prospect')} who said yes` : ''}.`;
  const blocks = [
    { type: 'callout', tone: needs.length ? 'warning' : 'success', title: needs.length ? 'Heads up.' : 'Pipeline summary.', text: headline },
    ...(needs.length ? [{ type: 'paragraph', text: 'Needs you' }, { type: 'details', rows: needs.slice(0, listLimit).map(({ o, why }) => [`${clip(o.name, nameLimit)} (${productNames[o.product]})`, why.words]) }] : []),
    ...(needs.length > listLimit ? [{ type: 'paragraph', text: `And ${plural(needs.length - listLimit, 'more deal')} in Growth.` }] : []),
    ...perProduct.flatMap(({ product, counts: c, moved }) => [
      { type: 'paragraph', text: productNames[product] },
      { type: 'details', rows: [
        ['Prospects (researched or qualified)', String(c.prospects)], ['In conversation', String(c.conversations)], ['In a free trial', String(c.trials)],
        ['Customers', String(c.customers)], ['Not now (nurture)', String(c.nurture)], ['Closed or lost', String(c.closed)],
        ['This week: replies', String(moved.replies)], ['This week: meetings', String(moved.meetings)], ['This week: trials started', String(moved.trials)], ['This week: became paying', String(moved.paid)],
      ] },
    ]),
    { type: 'paragraph', text: 'Trials that convert in the introductory year qualify for the Founders Sale (FOUNDERS50). Counts come from the growth records and the products\' own events; a missing event is not proof that nothing happened.' },
    ...(needs.length && origin ? [{ type: 'button', label: 'Open Growth', url: `${origin}/admin/growth` }] : []),
  ];
  return {
    subject: `Weekly pipeline: ${needs.length ? `${plural(needs.length, 'deal')} ${needs.length === 1 ? 'needs' : 'need'} you` : 'nothing needs you'}`,
    // Counts only: this is what the notification log keeps.
    body: `${plural(counts.prospects, 'prospect')}, ${counts.conversations} in conversation, ${plural(counts.trials, 'trial')}, ${plural(counts.customers, 'customer')}. ${counts.needsYou} ${counts.needsYou === 1 ? 'deal needs' : 'deals need'} you (${counts.warm} warm, ${counts.trialsAtRisk} trials at risk).`,
    blocks,
    result: counts,
  };
}

export function salesReviewHandler({ store, growth, notifier, publicOrigin, log = line => console.warn(line) }) {
  return async function review(task, { now = () => new Date(), signal } = {}) {
    const moment = now();
    const week = weekStart(moment);
    const asked = task.sourceKind === 'owner';
    const items = [];
    let offset = 0;
    let total = 1;
    while (offset < total) {
      signal?.throwIfAborted();
      const page = await growth.store.snapshot(offset);
      total = page.total;
      if (!page.items.length) break;
      items.push(...page.items);
      offset += page.items.length;
    }
    const report = composeReview({ items, now: moment, publicOrigin });
    const results = await notifier.send({
      severity: 'info', subject: report.subject, body: report.body, blocks: report.blocks,
      dedupeKey: asked ? `sales:review:run:${task.id}` : `sales:review:${week}`, agentKey: task.agentKey, taskId: task.id,
    });
    if (!asked && results.every(item => item.delivery === 'duplicate')) return { result: { skipped: results.some(delivered) ? 'already_sent' : 'earlier_attempt_unconfirmed', week } };
    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    const reached = results.some(delivered);
    await recordRun({ store, log }, task, {
      promptVersion: reviewVersion,
      summary: reached ? `Sent the weekly pipeline review: ${report.body}` : `The weekly pipeline review was written but not delivered (${delivery.join(', ')}).`,
      outcome: reached ? 'completed' : 'failed', errorCode: reached ? null : 'not_delivered',
    });
    return { result: { week, delivery, ...report.result } };
  };
}
