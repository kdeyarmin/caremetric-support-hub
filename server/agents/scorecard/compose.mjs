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
import { shownPage } from '../seo/insights.mjs';
import { constraintLabels, watchLabels } from '../strategist/rules.mjs';

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
 * maths over the subscriptions that were paying then, at today's prices and discounts). Subscription state cannot prove a purchase:
 * verified new paying customers come separately from the billing event facts. Null or `{ unavailable: true }` gives null.
 */
export function billingFigures(snapshot, { now }) {
  if (!snapshot || snapshot.unavailable === true) return null;
  const coupons = snapshot.coupons ?? [];
  const accounts = snapshot.accounts ?? [];
  const weekEarlier = now.getTime() - 7 * day;
  return {
    mode: snapshot.mode ?? null,
    products: Object.fromEntries(products.map(({ key }) => {
      const subscriptions = accounts.flatMap(account => account.subscriptions ?? []).filter(item => item.app === key);
      const earlier = subscriptions.filter(item => payingAt(item, weekEarlier)).map(item => ({ ...item, status: 'active', pause_behavior: null }));
      return [key, {
        mrrCents: monthlyTotals(subscriptions, coupons).mrrCents,
        previousMrrCents: monthlyTotals(earlier, coupons).mrrCents,
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

/** Up to three actionable SEO opportunities, one of each kind, for the consolidated email only. */
export function searchOpportunityBlocks(insights) {
  if (!insights) return [];
  if (insights.unavailable || !insights.sites?.length) return [{ type: 'paragraph', text: 'Search opportunities could not be read this week. Organic click totals are reported separately when available.' }];
  const rows = [];
  const low = insights.lowCtr?.[0];
  if (low) rows.push(['Improve a search snippet', `${shownPage(low.page)}: ${Math.round(low.impressions)} impressions, ${(low.ctr * 100).toFixed(1)}% clicked at position ${low.position.toFixed(1)}. Review its title and description.`]);
  const near = insights.striking?.[0];
  if (near) rows.push(['Strengthen a page near the first page', `“${near.query}”: position ${near.position.toFixed(1)}, ${Math.round(near.impressions)} impressions.${near.page ? ` Improve ${shownPage(near.page)} and link to it from relevant pages.` : ' Identify the relevant page and improve its answer to this search.'}`]);
  const competing = insights.competing?.[0];
  if (competing) rows.push(['Choose one page for this search', `“${competing.query}”: your sites compete. Choose the canonical page and link or redirect the others: ${competing.hosts.slice(0, 2).map(row => shownPage(row.page)).join(' and ')}.`]);
  const window = insights.window?.current;
  return [
    { type: 'paragraph', text: `Search opportunities${window ? ` (${window.startDate} to ${window.endDate}, final Google data)` : ''}.` },
    ...(rows.length ? [{ type: 'details', rows }, { type: 'paragraph', text: 'For checked title and description drafts, open AI team → SEO Analyst → Run now on Weekly SEO check. No page changes automatically.' }]
      : [{ type: 'paragraph', text: 'No search opportunities met the evidence thresholds in the properties read.' }]),
    ...(insights.failures?.length ? [{ type: 'paragraph', text: `${plural(insights.failures.length, 'Search Console property')} could not be read for opportunities; these suggestions use the properties that responded.` }] : []),
  ];
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

const visitorStates = new Set(['read', 'partial', 'unavailable', 'not_configured']);
const visitorCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** A missing period is unknown, never zero. Explicit reader failures remain different from an unconfigured source. */
function visitorFigures(source) {
  const explicit = source !== null && source !== undefined && Object.hasOwn(source, 'state');
  const sourceValid = !explicit || visitorStates.has(source.state);
  const byProduct = Object.fromEntries(products.map(({ key }) => {
    const item = source?.products?.[key];
    // A reader with explicit states must account for each product. An omitted product in the old injection shape means unconfigured.
    const absent = !source || (explicit && source.state === 'not_configured') || (!explicit && source?.products && !item);
    if (absent || item?.state === 'not_configured') return [key, { state: 'not_configured', values: null }];
    if (!sourceValid || source?.state === 'unavailable' || !item || item.state === 'unavailable' || (item.state !== undefined && !visitorStates.has(item.state))) {
      return [key, { state: 'unavailable', values: null }];
    }
    const values = [visitorCount(item.visitors), visitorCount(item.previous)];
    if (values.every(value => value === null)) return [key, { state: 'unavailable', values: null }];
    const state = item.state === 'partial' || values.some(value => value === null) ? 'partial' : 'read';
    return [key, { state, values }];
  }));
  const entries = Object.values(byProduct);
  const anyRead = entries.some(entry => entry.values !== null);
  const allRead = entries.every(entry => entry.state === 'read');
  const allMissing = entries.every(entry => entry.state === 'not_configured');
  const incomplete = entries.some(entry => ['partial', 'unavailable'].includes(entry.state));
  const state = !source ? 'not_connected'
    : !explicit ? anyRead ? incomplete ? 'partial' : 'connected' : source?.products && allMissing ? 'not_connected' : 'unavailable'
    : allMissing ? 'not_configured' : allRead && source.state !== 'partial' ? 'read' : anyRead ? 'partial' : 'unavailable';
  return { state, byProduct };
}

function visitorWords(entry) {
  if (!entry.values) return entry.state === 'not_configured' ? 'Not connected' : 'Could not be read';
  const [current, previous] = entry.values;
  return `${current === null ? 'Unavailable' : current} (last week ${previous === null ? 'unavailable' : previous})`
    + (entry.state === 'partial' && current !== null && previous !== null ? '; partial data' : '');
}

function costPerTrial(spendCents, trials) {
  if (spendCents === null) return 'Not available';
  if (trials === null) return 'Not available (trial count unavailable)';
  return trials > 0 ? `${dollars(spendCents / trials)} (${dollars(spendCents)} over ${plural(trials, 'trial')})` : `No trials (${dollars(spendCents)} spent)`;
}

/** What needs the owner, most urgent first, from what the five reports and the brief already flag. Each has a link; at most three are kept. */
export function rankNeeds({ incidents = 0, approvals = null, accounts = null, stuckDeals = null, failingAds = null, siteProblems = null }) {
  const items = [
    count(incidents) && { key: 'site_down', rank: 1, text: `${plural(count(incidents), 'product')} down right now`, path: '/admin/team', button: 'Open the AI team' },
    count(approvals?.count) && { key: 'approvals', rank: 2, text: `${plural(count(approvals.count), 'proposal')} waiting for your approval`, path: '/admin/team', button: 'Open the AI team' },
    count(accounts) && { key: 'accounts', rank: 3, text: `${plural(count(accounts), 'customer account')} ${count(accounts) === 1 ? 'needs' : 'need'} attention`, path: '/admin/billing?tab=customers', button: 'Open Billing' },
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
 * @param {object|null} input.visitors `{ state, products: { [key]: { state, visitors, previous } } }`, with read/partial/unavailable/not_configured
 * states and nullable nonnegative integer counts. The legacy shape without states remains supported; null means no configured reader.
 * @param {object} input.needs the inputs of rankNeeds
 */
/** Sessions from tagged outreach links this week: the total and the five largest tags, or a plain none. */
function campaignWords(list) {
  const kept = list.filter(item => /^[a-z0-9-]{1,60}$/.test(item?.campaign ?? '') && Number.isSafeInteger(item?.sessions) && item.sessions > 0);
  if (!kept.length) return 'None this week';
  const total = kept.reduce((sum, item) => sum + item.sessions, 0);
  return `${total} (${kept.slice(0, 5).map(item => `${item.campaign} ${item.sessions}`).join(', ')}${kept.length > 5 ? ', and others' : ''})`;
}

export function composeScorecard({ week, facts, billing = null, search = null, ads = null, visitors = null, verifiedLifecycle = false, needs = {}, publicOrigin = null, notes = [], strategy = null }) {
  const byProduct = list => Object.fromEntries((list ?? []).map(entry => [entry.product, entry]));
  const current = byProduct(facts?.current?.products);
  const previous = byProduct(facts?.previous?.products);
  const link = origin(publicOrigin);
  const searchOn = search?.state === 'connected';
  const seen = visitorFigures(visitors);
  // Coverage starts with the billing lifecycle release. A zero from an earlier week is not historical evidence.
  const lifecycleCount = (period, item, name) => {
    const start = instant(period?.lifecycleStartedAt);
    const since = instant(period?.since);
    return verifiedLifecycle && start !== null && since !== null && start <= since ? visitorCount(item[name]) : null;
  };
  const trialLabel = verifiedLifecycle ? 'Trial starts (verified)' : 'Trial sign-ups';

  const figures = Object.fromEntries(products.map(({ key }) => {
    const now = current[key] ?? {};
    const then = previous[key] ?? {};
    const pair = name => [count(now[name]), count(then[name])];
    return [key, {
      countyReports: pair('countyReports'),
      trialStarts: verifiedLifecycle ? [lifecycleCount(facts?.current, now, 'verifiedTrialStarts'), lifecycleCount(facts?.previous, then, 'verifiedTrialStarts')] : pair('trialStarts'),
      activated: pair('activated'),
      ...(verifiedLifecycle ? { newPaying: [lifecycleCount(facts?.current, now, 'verifiedPaid'), lifecycleCount(facts?.previous, then, 'verifiedPaid')] } : {}),
      delivered: pair('delivered'), replies: pair('replies'), bounces: pair('bounces'), complaints: pair('complaints'),
      // Clicks only from a property that was read: a product with none configured has no row, and one whose properties all failed says so.
      ...(searchOn && search.products[key]?.properties > 0 ? { clicks: [count(search.products[key].clicks), count(search.products[key].previous)] } : {}),
      ...(seen.byProduct[key].values ? { visitors: seen.byProduct[key].values } : {}),
    }];
  }));
  const total = (name, index) => products.reduce((sum, { key }) => sum + (figures[key][name]?.[index] ?? 0), 0);
  const knownTotal = (name, index) => products.every(({ key }) => Number.isSafeInteger(figures[key][name]?.[index])) ? total(name, index) : null;
  const trials = [knownTotal('trialStarts', 0), knownTotal('trialStarts', 1)];
  const paid = knownTotal('newPaying', 0);
  const nullablePair = values => `${values[0] ?? 'Unavailable'} (last week ${values[1] ?? 'unavailable'})`;
  const adsRead = ads && ads.unavailable !== true;
  const spend = index => count(index === 0 ? facts?.current?.aiSpendCents : facts?.previous?.aiSpendCents)
    + (adsRead ? count(index === 0 ? ads.spendCents : ads.previousSpendCents) : 0);

  const ranked = rankNeeds(needs);
  const headline = ranked.kept.length === 0 ? 'Nothing needs you this week.'
    : ranked.kept.length === 1 ? 'One decision needs you this week.' : `${ranked.kept.length} decisions need you this week.`;
  const changed = Object.keys(metricNames)
    .filter(name => knownTotal(name, 0) !== null && knownTotal(name, 1) !== null)
    .map(name => changeWords(name === 'trialStarts' ? trialLabel : metricNames[name], total(name, 0), total(name, 1))).filter(Boolean);

  const productBlocks = products.flatMap(({ key, label }) => {
    const f = figures[key];
    const money = billing?.products?.[key];
    const rows = [
      [visitors?.metric === 'anonymous_sessions' && key === 'caremetric-intel' ? 'Website sessions (anonymous tabs)' : 'Website visitors', visitorWords(seen.byProduct[key])],
      ['County reports', beside(...f.countyReports)],
      [trialLabel, nullablePair(f.trialStarts)],
      ['Activated trials (first value)', beside(...f.activated)],
      ['New paying customers (verified)', f.newPaying ? nullablePair(f.newPaying) : 'Unavailable: verified billing events not enabled'],
      ['MRR', money ? `${dollars(money.mrrCents)} (a week earlier ${dollars(money.previousMrrCents)})` : 'Billing could not be read'],
      ['Outbound email', `${f.delivered[0]} delivered, ${replies(f.replies[0])}, ${plural(f.bounces[0], 'bounce')}, ${plural(f.complaints[0], 'complaint')} `
        + `(last week ${f.delivered[1]} delivered, ${f.replies[1]} replies, ${f.bounces[1]} bounces, ${f.complaints[1]} complaints)`],
      // Anonymous sessions that came from a link in the team's own outreach email, by the arms it was written under (links.mjs).
      ...(key === 'caremetric-intel' && seen.byProduct[key].values && Array.isArray(visitors?.products?.[key]?.campaigns) ? [['Sessions from outreach email links',
        campaignWords(visitors.products[key].campaigns)]] : []),
      ...(f.clicks ? [['Organic search clicks', `${f.clicks[0]} (the 7 days before ${f.clicks[1]})${search.products[key].failed ? `; ${search.products[key].failed} ${search.products[key].failed === 1 ? 'property' : 'properties'} could not be read` : ''}`]]
        : searchOn && search.products[key]?.failed > 0 ? [['Organic search clicks', 'Search Console could not be read this week']] : []),
    ];
    return [{ type: 'paragraph', text: label }, { type: 'details', rows }];
  });

  const spendWords = index => `AI ${dollars(count(index === 0 ? facts?.current?.aiSpendCents : facts?.previous?.aiSpendCents))}`
    + (adsRead ? ` and ads ${dollars(count(index === 0 ? ads.spendCents : ads.previousSpendCents))}` : '');
  const sourceNotes = [
    verifiedLifecycle ? 'Verified trial starts and new paying customers use processed billing events, one first event per organization and product. A paid event requires a confirmed positive invoice payment; subscription status alone is not a purchase. Measurement is prospective; periods before lifecycle coverage begins are unavailable, and renewals are not counted as new customers.'
      : 'Trial sign-ups count website forms, not verified product trials. Verified new paying customers are unavailable until billing lifecycle measurement is enabled; subscription status is not used as evidence of a purchase.',
    visitors?.metric === 'anonymous_sessions' ? 'Intel website sessions count anonymous browser-tab sessions on public marketing pages, not unique people or customer accounts. A tab keeps its session across reloads; this is not a standard 30-minute analytics session. Weeks before collection or outside retained coverage are unavailable. These counts do not establish matched visitor-to-trial conversion.' : null,
    visitors?.sources && Object.values(visitors.sources).includes('google_analytics') ? `${products.filter(({ key }) => visitors.sources[key] === 'google_analytics').map(({ label }) => label).join(' and ')} website visitors are Google Analytics active users on the public site for the same Eastern weeks. A week Google has no data for is unavailable, not zero.` : null,
    ['not_connected', 'not_configured'].includes(seen.state) ? 'Website visitors are shown only from a connected analytics source, never estimated. No visitor analytics source is configured for these products.' : null,
    seen.state === 'unavailable' ? 'Website visitor analytics could not be read this week. Unavailable figures are not counted as zero.' : null,
    seen.state === 'partial' ? 'Website visitor analytics are incomplete. Each product shows the periods that could be read; unavailable figures are not counted as zero.' : null,
    ads === null ? 'No ad account is connected, so cost per trial is the AI spend alone.' : null,
    ads?.unavailable === true ? 'The ad accounts could not be read this week, so cost per trial is the AI spend alone.' : null,
    search && !searchOn ? 'Search Console is not connected, so there are no organic search clicks. The SEO Analyst\'s report says how to connect it.' : null,
    billing?.mode && billing.mode !== 'live' ? `Billing figures are from Stripe ${billing.mode} mode.` : null,
    billing ? 'MRR is the Billing screen\'s figure. A week earlier is the same calculation over the subscriptions that were paying then, at today\'s prices and discounts.' : null,
    ...notes,
  ].filter(Boolean);

  // The weekly strategist's note for this week (strategist/index.mjs), first: its words travel only in the blocks.
  const named = strategy && typeof strategy.headline === 'string' && (Object.hasOwn(constraintLabels, strategy.constraint) || strategy.constraint === 'none') ? strategy : null;
  const strategyBlocks = named ? [
    { type: 'callout', tone: 'info', title: named.constraint === 'none' ? 'This week\'s constraint: none stood out.' : `This week's constraint: ${constraintLabels[named.constraint]}.`,
      text: named.headline },
    ...(named.why ? [{ type: 'paragraph', text: named.why }] : []),
    ...(named.move ? [{ type: 'paragraph', text: `This week: ${named.move}` }] : []),
    ...(named.watch && watchLabels[named.watch] ? [{ type: 'paragraph', text: `Next Monday, watch ${watchLabels[named.watch]}.` }] : []),
  ] : [];
  const blocks = [
    ...strategyBlocks,
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
      [verifiedLifecycle ? 'Cost per verified trial' : 'Cost per trial sign-up', `${costPerTrial(spend(0), trials[0])}; last week ${costPerTrial(spend(1), trials[1])}`],
      ['Spend counted', `${spendWords(0)}; last week ${spendWords(1)}`],
    ] },
    ...(changed.length ? [{ type: 'paragraph', text: 'What changed' }, ...changed.map(text => ({ type: 'paragraph', text }))] : [{ type: 'paragraph', text: 'Nothing changed from the week before.' }]),
    ...sourceNotes.map(text => ({ type: 'paragraph', text })),
  ];

  // Counts only: this is what the notification log keeps.
  const body = [
    named ? `Constraint: ${named.constraint}.` : null,
    headline,
    ranked.kept.length ? `Needs you:\n${ranked.kept.map(item => `- ${item.text}`).join('\n')}` : null,
    `Last week: ${plural(total('countyReports', 0), 'county report')}, ${trials[0] === null ? 'trial starts unavailable' : plural(trials[0], verifiedLifecycle ? 'verified trial start' : 'trial sign-up')}, ${total('activated', 0)} activated`
      + `${paid !== null ? `, ${paid} verified new paying` : ', verified new paying unavailable'}; ${total('delivered', 0)} emails delivered, ${replies(total('replies', 0))}, `
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
      needsYou: ranked.kept.length, needs: ranked.kept.map(item => item.key), moreNeeds: ranked.more, ...(named ? { constraint: named.constraint } : {}),
      products: figures,
      sources: {
        visitors: seen.state, visitorProducts: Object.fromEntries(products.map(({ key }) => [key, seen.byProduct[key].state])), billing: billing ? 'read' : 'unavailable',
        lifecycle: !verifiedLifecycle ? 'not_configured' : ['trialStarts', 'newPaying'].every(name => [0, 1].every(index => knownTotal(name, index) !== null)) ? 'read' : 'partial',
        search: searchOn ? 'connected' : search?.state ?? 'not_configured', ads: ads === null ? 'not_connected' : adsRead ? 'read' : 'unavailable',
      },
    },
  };
}
