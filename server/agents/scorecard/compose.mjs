/**
 * The Monday scorecard, composed. Pure: the figures and the time go in; an email comes out.
 *
 * Six numbers per product (CareBase and CareMetric Intel), each beside last week's: website visitors (only from a connected source,
 * never estimated), county reports and trial starts, activated trials, new paying customers and MRR, outbound email, and cost per
 * trial; organic search clicks when Search Console is connected. Then what changed, and at most three things that need the owner,
 * each with a link to the screen that handles it.
 *
 * What is stored and what is not. Money (MRR, AI and ad spend, cost per trial) travels only in the email's `blocks`, which the notifier
 * never stores. The subject, the stored body and the task result carry counts only: no name, amount or address.
 */
import { monthlyTotals } from '../accounts/money.mjs';
import { plural } from '../tasks/shared.mjs';

export const composeVersion = 'scorecard.1';
export const products = Object.freeze([
  Object.freeze({ key: 'carebase', label: 'CareBase', hosts: Object.freeze(['cmcarebase.com', 'caremetrictrain.com']) }),
  Object.freeze({ key: 'caremetric-intel', label: 'CareMetric Intel', hosts: Object.freeze(['caremetricintel.com']) }),
]);
export const needsLimit = 3;

const day = 86_400_000;
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const shortDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const dollars = cents => usd.format((Number.isFinite(cents) ? cents : 0) / 100);
const count = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);
const instant = value => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : null; };
const origin = publicOrigin => (/^https:\/\//i.test(publicOrigin ?? '') ? publicOrigin.replace(/\/+$/, '') : null);

// ---- Billing: the same maths as the Billing screen --------------------------------------------------------------------------------

/**
 * Whether a subscription was paying at `time`, from its own dates: created by then, past any trial, and not yet ended. A subscription
 * that is trialing, unpaid, paused or incomplete now is not counted as paying a week ago either; one canceled since is, if it was past
 * its trial then.
 */
export function payingAt(subscription, time) {
  if (!['active', 'past_due', 'canceled'].includes(subscription?.status) || subscription.pause_behavior) return false;
  const created = instant(subscription.created);
  const trialEnd = instant(subscription.trial_end);
  const ended = subscription.status === 'canceled' ? instant(subscription.ended_at) ?? instant(subscription.canceled_at) : null;
  if (created === null || created > time) return false;
  if (trialEnd !== null && trialEnd > time) return false;
  return subscription.status !== 'canceled' || (ended !== null && ended > time);
}

/**
 * Per product: MRR now (exactly the Billing screen's figure: monthlyTotals over the product's subscriptions) and a week earlier (the same
 * maths over the subscriptions that were paying then, at today's prices and discounts), and the customers who became paying in the week
 * to `until` and in the week before. `snapshot` is the Account Manager's billing snapshot; null or `{ unavailable: true }` gives null.
 */
export function billingFigures(snapshot, { now, until }) {
  if (!snapshot || snapshot.unavailable === true) return null;
  const coupons = snapshot.coupons ?? [];
  const accounts = snapshot.accounts ?? [];
  const weekEarlier = now.getTime() - 7 * day;
  const end = until.getTime();
  const becamePaying = (subscriptions, from, to) => accounts.filter(account => {
    const own = (account.subscriptions ?? []).filter(item => subscriptions.includes(item));
    return own.some(item => payingAt(item, to)) && !own.some(item => payingAt(item, from));
  }).length;
  return {
    mode: snapshot.mode ?? null,
    products: Object.fromEntries(products.map(({ key }) => {
      const subscriptions = accounts.flatMap(account => account.subscriptions ?? []).filter(item => item.app === key);
      const earlier = subscriptions.filter(item => payingAt(item, weekEarlier)).map(item => ({ ...item, status: 'active', pause_behavior: null }));
      return [key, {
        mrrCents: monthlyTotals(subscriptions, coupons).mrrCents,
        previousMrrCents: monthlyTotals(earlier, coupons).mrrCents,
        newPaying: becamePaying(subscriptions, end - 7 * day, end),
        previousNewPaying: becamePaying(subscriptions, end - 14 * day, end - 7 * day),
      }];
    })),
  };
}

/** Search Console's clicks per product, from `reader.totals()`: the property's host decides the product; other sites are left out. */
export function searchFigures(read) {
  if (!read) return null;
  const hostOf = property => {
    const text = String(property ?? '');
    try { return (text.startsWith('sc-domain:') ? text.slice(10) : new URL(text).hostname).toLowerCase().replace(/^www\./, ''); } catch { return ''; }
  };
  const productOf = property => products.find(entry => entry.hosts.some(host => hostOf(property) === host || hostOf(property).endsWith(`.${host}`)))?.key ?? null;
  const figures = Object.fromEntries(products.map(({ key }) => [key, { clicks: 0, previous: 0, properties: 0, failed: 0 }]));
  for (const entry of read.properties ?? []) {
    const key = productOf(entry.property);
    if (!key) continue;
    if (entry.ok) {
      figures[key].clicks += Math.round(Number(entry.current?.clicks) || 0);
      figures[key].previous += Math.round(Number(entry.previous?.clicks) || 0);
      figures[key].properties += 1;
    } else figures[key].failed += 1;
  }
  return { state: 'connected', products: figures };
}

// ---- The email ------------------------------------------------------------------------------------------------------------------

const metricNames = {
  countyReports: 'County reports', trialStarts: 'Trial starts', activated: 'Activated trials', newPaying: 'New paying customers',
  delivered: 'Outbound emails delivered', replies: 'Replies', bounces: 'Bounces', complaints: 'Complaints', clicks: 'Organic search clicks',
};
const replies = n => `${n} ${n === 1 ? 'reply' : 'replies'}`;
const beside = (current, previous) => `${current} (last week ${previous})`;
const changeWords = (name, current, previous) => (current === previous ? null
  : `${name}: ${current}, ${current > previous ? 'up' : 'down'} from ${previous}.`);

function costPerTrial(spendCents, trials) {
  if (spendCents === null) return 'Not available';
  return trials > 0 ? `${dollars(spendCents / trials)} (${dollars(spendCents)} over ${plural(trials, 'trial')})` : `No trials (${dollars(spendCents)} spent)`;
}

/** What needs the owner, most urgent first, from what the five reports and the brief already flag. Each has a link; at most three are kept. */
export function rankNeeds({ incidents = 0, approvals = null, atRisk = null, stuckDeals = null, failingAds = null, siteProblems = null }) {
  const items = [
    count(incidents) && { key: 'site_down', rank: 1, text: `${plural(count(incidents), 'product')} down right now`, path: '/admin/team', button: 'Open the AI team' },
    count(approvals?.count) && { key: 'approvals', rank: 2, text: `${plural(count(approvals.count), 'proposal')} waiting for your approval`, path: '/admin/team', button: 'Open the AI team' },
    count(atRisk) && { key: 'at_risk_accounts', rank: 3, text: `${plural(count(atRisk), 'customer account')} at risk`, path: '/admin/billing?tab=customers', button: 'Open Billing' },
    count(stuckDeals) && { key: 'stuck_deals', rank: 4, text: `${plural(count(stuckDeals), 'deal')} waiting on you in the pipeline`, path: '/admin/growth', button: 'Open Customer growth' },
    count(failingAds) && { key: 'failing_ads', rank: 5, text: `${plural(count(failingAds), 'ad')} losing money`, path: '/admin/team', button: 'Open the AI team' },
    count(siteProblems) && { key: 'site_problems', rank: 6, text: `${plural(count(siteProblems), 'urgent website problem')} that could keep pages out of search`, path: '/admin/team', button: 'Open the AI team' },
  ].filter(Boolean).sort((a, b) => a.rank - b.rank);
  return { kept: items.slice(0, needsLimit), more: Math.max(items.length - needsLimit, 0) };
}

/**
 * @param {object} input
 * @param {string} input.week the Monday (YYYY-MM-DD) that starts the week reported on
 * @param {{ current: object, previous: object }} input.facts private.agent_scorecard_facts for that week and the week before
 * @param {object|null} input.billing billingFigures(...), or null when the billing snapshot could not be read
 * @param {object|null} input.search searchFigures(...), `{ state }` when Search Console is not connected, or null when it is not set up at all
 * @param {object|null} input.ads `{ spendCents, previousSpendCents, failing }`, `{ unavailable: true }`, or null when no ad account is connected
 * @param {object|null} input.visitors `{ products: { [key]: { visitors, previous } } }` from a connected source, or null: "Not connected"
 * @param {object} input.needs the inputs of rankNeeds
 */
export function composeScorecard({ week, facts, billing = null, search = null, ads = null, visitors = null, needs = {}, publicOrigin = null, notes = [] }) {
  const byProduct = list => Object.fromEntries((list ?? []).map(entry => [entry.product, entry]));
  const current = byProduct(facts?.current?.products);
  const previous = byProduct(facts?.previous?.products);
  const link = origin(publicOrigin);
  const searchOn = search?.state === 'connected';

  const figures = Object.fromEntries(products.map(({ key }) => {
    const now = current[key] ?? {};
    const then = previous[key] ?? {};
    const pair = name => [count(now[name]), count(then[name])];
    return [key, {
      countyReports: pair('countyReports'), trialStarts: pair('trialStarts'), activated: pair('activated'),
      ...(billing ? { newPaying: [count(billing.products[key]?.newPaying), count(billing.products[key]?.previousNewPaying)] } : {}),
      delivered: pair('delivered'), replies: pair('replies'), bounces: pair('bounces'), complaints: pair('complaints'),
      ...(searchOn ? { clicks: [count(search.products[key]?.clicks), count(search.products[key]?.previous)] } : {}),
      ...(visitors?.products?.[key] ? { visitors: [count(visitors.products[key].visitors), count(visitors.products[key].previous)] } : {}),
    }];
  }));
  const total = (name, index) => products.reduce((sum, { key }) => sum + (figures[key][name]?.[index] ?? 0), 0);
  const trials = [total('trialStarts', 0), total('trialStarts', 1)];
  const adsRead = ads && ads.unavailable !== true;
  const spend = index => count(index === 0 ? facts?.current?.aiSpendCents : facts?.previous?.aiSpendCents)
    + (adsRead ? count(index === 0 ? ads.spendCents : ads.previousSpendCents) : 0);

  const ranked = rankNeeds(needs);
  const headline = ranked.kept.length === 0 ? 'Nothing needs you this week.'
    : ranked.kept.length === 1 ? 'One decision needs you this week.' : `${ranked.kept.length} decisions need you this week.`;
  const changed = Object.keys(metricNames)
    .filter(name => products.some(({ key }) => figures[key][name]))
    .map(name => changeWords(metricNames[name], total(name, 0), total(name, 1))).filter(Boolean);

  const productBlocks = products.flatMap(({ key, label }) => {
    const f = figures[key];
    const money = billing?.products?.[key];
    const rows = [
      ['Website visitors', f.visitors ? beside(...f.visitors) : 'Not connected'],
      ['County reports', beside(...f.countyReports)],
      ['Trial starts', beside(...f.trialStarts)],
      ['Activated trials (first value)', beside(...f.activated)],
      ['New paying customers', f.newPaying ? beside(...f.newPaying) : 'Billing could not be read'],
      ['MRR', money ? `${dollars(money.mrrCents)} (a week earlier ${dollars(money.previousMrrCents)})` : 'Billing could not be read'],
      ['Outbound email', `${f.delivered[0]} delivered, ${replies(f.replies[0])}, ${plural(f.bounces[0], 'bounce')}, ${plural(f.complaints[0], 'complaint')} `
        + `(last week ${f.delivered[1]} delivered, ${f.replies[1]} replies, ${f.bounces[1]} bounces, ${f.complaints[1]} complaints)`],
      ...(f.clicks ? [['Organic search clicks', `${f.clicks[0]} (the 7 days before ${f.clicks[1]})`]] : []),
    ];
    return [{ type: 'paragraph', text: label }, { type: 'details', rows }];
  });

  const spendWords = index => `AI ${dollars(count(index === 0 ? facts?.current?.aiSpendCents : facts?.previous?.aiSpendCents))}`
    + (adsRead ? ` and ads ${dollars(count(index === 0 ? ads.spendCents : ads.previousSpendCents))}` : '');
  const sourceNotes = [
    visitors ? null : 'Website visitors are shown only from a connected analytics source, never estimated. None is connected to the Hub yet.',
    ads === null ? 'No ad account is connected, so cost per trial is the AI spend alone.' : null,
    ads?.unavailable === true ? 'The ad accounts could not be read this week, so cost per trial is the AI spend alone.' : null,
    search && !searchOn ? 'Search Console is not connected, so there are no organic search clicks. The SEO Analyst\'s report says how to connect it.' : null,
    billing?.mode && billing.mode !== 'live' ? `Billing figures are from Stripe ${billing.mode} mode.` : null,
    billing ? 'MRR is the Billing screen\'s figure. A week earlier is the same calculation over the subscriptions that were paying then, at today\'s prices and discounts.' : null,
    ...notes,
  ].filter(Boolean);

  const blocks = [
    { type: 'callout', tone: ranked.kept.length ? 'warning' : 'success', title: ranked.kept.length ? 'Needs you.' : 'All clear.', text: headline },
    ...(ranked.kept.length ? [
      { type: 'details', rows: ranked.kept.map((item, index) => [`${index + 1}.`, item.text]) },
      ...(ranked.more ? [{ type: 'paragraph', text: `And ${plural(ranked.more, 'smaller item')} in the screens below.` }] : []),
      ...(link ? [...new Map(ranked.kept.map(item => [item.path, item])).values()].map(item => ({ type: 'button', label: item.button, url: `${link}${item.path}` })) : []),
    ] : []),
    { type: 'paragraph', text: `The week of ${shortDay.format(new Date(`${week}T12:00:00Z`))}, Monday to Sunday Eastern, against the week before.` },
    ...productBlocks,
    { type: 'paragraph', text: 'Both products' },
    { type: 'details', rows: [
      ['Cost per trial', `${costPerTrial(spend(0), trials[0])}; last week ${costPerTrial(spend(1), trials[1])}`],
      ['Spend counted', `${spendWords(0)}; last week ${spendWords(1)}`],
    ] },
    ...(changed.length ? [{ type: 'paragraph', text: 'What changed' }, ...changed.map(text => ({ type: 'paragraph', text }))] : [{ type: 'paragraph', text: 'Nothing changed from the week before.' }]),
    ...sourceNotes.map(text => ({ type: 'paragraph', text })),
  ];

  // Counts only: this is what the notification log keeps.
  const body = [
    headline,
    ranked.kept.length ? `Needs you:\n${ranked.kept.map(item => `- ${item.text}`).join('\n')}` : null,
    `Last week: ${plural(total('countyReports', 0), 'county report')}, ${plural(trials[0], 'trial start')}, ${total('activated', 0)} activated`
      + `${billing ? `, ${total('newPaying', 0)} new paying` : ''}; ${total('delivered', 0)} emails delivered, ${replies(total('replies', 0))}, `
      + `${plural(total('bounces', 0), 'bounce')}, ${plural(total('complaints', 0), 'complaint')}.`,
    changed.length ? `What changed:\n${changed.map(line => `- ${line}`).join('\n')}` : 'Nothing changed from the week before.',
  ].filter(Boolean).join('\n\n');

  return {
    headline,
    needsYou: ranked.kept.length,
    subject: `Monday scorecard: ${ranked.kept.length === 0 ? 'nothing needs you' : ranked.kept.length === 1 ? '1 decision needs you' : `${ranked.kept.length} decisions need you`}`,
    body,
    blocks,
    result: {
      needsYou: ranked.kept.length, needs: ranked.kept.map(item => item.key), moreNeeds: ranked.more,
      products: figures,
      sources: {
        visitors: visitors ? 'connected' : 'not_connected', billing: billing ? 'read' : 'unavailable',
        search: searchOn ? 'connected' : search?.state ?? 'not_configured', ads: ads === null ? 'not_connected' : adsRead ? 'read' : 'unavailable',
      },
    },
  };
}
