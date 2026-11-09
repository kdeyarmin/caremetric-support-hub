/**
 * The Growth Manager's weekly email: where leads came from, what became of them, and three things to do next. Pure: the same facts
 * (private.agent_growth_facts, counts and labels only, test leads never among them) always give the same email.
 *
 * The suggestions are rules, not a model: each has a condition on the facts and fixed words, and the first three whose condition
 * holds are sent. The last few always hold, so there are always three. None suggests a demo, a call or a meeting: CareMetric does
 * no personal demos with anyone (owner decision 2026-11-09).
 */
import { plural } from '../tasks/shared.mjs';
import { clip, digestKinds, kindList, kindWord, leadKinds, leadProduct, span } from './words.mjs';

const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
const count = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);
const list = value => (Array.isArray(value) ? value : []);
const shown = 5;

// A search engine, by the source label a lead carries (utm_source, else the referring host).
const searchEngine = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|brave|startpage)(\.|$)/;
export const fromSearch = label => searchEngine.test(String(label ?? '').toLowerCase());

/** The facts, read defensively: a missing or malformed part is zero or empty, never an error that stops the email. */
export function readFacts(facts) {
  const leads = facts?.leads ?? {};
  const byKind = Object.fromEntries(leadKinds.map(kind => [kind, count(leads.byKind?.[kind])]));
  const median = facts?.replies?.medianMinutes;
  return {
    total: count(leads.total),
    byKind,
    byProduct: list(leads.byProduct).map(item => ({ product: item?.product ?? null, count: count(item?.count) })).filter(item => item.count),
    bySource: list(leads.bySource).map(item => ({ source: clip(item?.source ?? 'direct', 60) || 'direct', count: count(item?.count) })).filter(item => item.count),
    otherSources: count(leads.otherSources),
    landingPaths: list(leads.landingPaths).map(item => ({ path: clip(item?.path, 80), count: count(item?.count) })).filter(item => item.path && item.count),
    campaigns: list(leads.campaigns).map(item => ({ campaign: clip(item?.campaign, 60), count: count(item?.count) })).filter(item => item.campaign && item.count),
    trials: { started: count(facts?.trials?.started), subscriptions: count(facts?.trials?.subscriptions), converted: count(facts?.trials?.converted) },
    replies: { replied: count(facts?.replies?.replied), medianMinutes: Number.isFinite(Number(median)) && median !== null ? Math.max(0, Math.round(Number(median))) : null },
    unanswered: {
      count: count(facts?.unanswered?.count),
      oldestMinutes: Number.isFinite(Number(facts?.unanswered?.oldestMinutes)) && facts.unanswered.oldestMinutes !== null ? Math.max(0, Math.floor(Number(facts.unanswered.oldestMinutes))) : null,
      byKind: Object.fromEntries(leadKinds.map(kind => [kind, count(facts?.unanswered?.byKind?.[kind])])),
    },
  };
}

// A CareBase or Intel trial usually shows up twice, as a sign-up lead and as a Stripe trial subscription: the larger count is the trials.
const trialsStarted = f => Math.max(f.trials.started, f.trials.subscriptions);

const rules = [
  ['unanswered', f => f.unanswered.count > 0, f => {
    const kinds = kindList(f.unanswered.byKind) || plural(f.unanswered.count, 'lead');
    return `${kinds} ${f.unanswered.count === 1 ? 'is' : 'are'} still unanswered. Answer ${f.unanswered.count === 1 ? 'it' : 'them'} before anything else this week.`;
  }],
  ['slow_reply', f => f.replies.replied > 0 && f.replies.medianMinutes !== null && f.replies.medianMinutes > 60,
    f => `Your median first reply took ${span(f.replies.medianMinutes)}. Aim to answer every new lead within the hour.`],
  ['no_leads', f => f.total === 0, () => 'No leads came in. Send a link to your free trial or a free guide to five people who might need it, or post one short, useful tip.'],
  ['no_search', f => f.total > 0 && f.otherSources === 0 && !f.bySource.some(item => fromSearch(item.source)),
    () => 'No lead came from a search engine. Connect Google Search Console to see which searches find your sites and which pages to improve.'],
  ['one_source', f => f.total >= 2 && f.bySource.length === 1 && f.otherSources === 0,
    f => `Every lead came from ${f.bySource[0].source === 'direct' ? 'direct visits' : f.bySource[0].source}. Try one more channel this week, so a single source drying up cannot stop your leads.`],
  ['no_campaigns', f => f.total > 0 && f.campaigns.length === 0,
    () => 'No lead carried a campaign tag. Add utm_source and utm_campaign to the links you share, so this report can show which ones work.'],
  ['trials_started', f => trialsStarted(f) > 0, f => (trialsStarted(f) === 1
    ? '1 trial started. Check in with them well before the trial ends, while the first impression is fresh.'
    : `${trialsStarted(f)} trials started. Check in with each one well before the trial ends, while the first impression is fresh.`)],
  ['reports_only', f => digestKinds.some(kind => f.byKind[kind] > 0) && f.byKind.demo_request + f.byKind.consultation + f.byKind.contact === 0, f => {
    const people = digestKinds.reduce((sum, kind) => sum + f.byKind[kind], 0);
    return `${people === 1 ? '1 person' : `${people} people`} downloaded a report or joined a list, but nobody wrote in with a question. Send them the free trial and the walkthrough page, and invite their questions by email.`;
  }],
  ['testimonial', () => true, () => 'Ask one happy customer for a two-sentence quote you can put on your pricing page.'],
  ['article', () => true, () => 'Write one short article that answers a question prospects often ask, and link it from your home page.'],
  ['referral', () => true, () => 'Ask your newest customer who else they know who should see CareMetric.'],
];

const suggest = read => rules.filter(([, holds]) => holds(read)).slice(0, 3).map(([code, , words]) => ({ code, text: words(read) }));
/** The first three suggestions whose rule holds, for the facts as the database returns them: [{ code, text }]. */
export const suggestionsFor = facts => suggest(readFacts(facts));

const rangeOf = (since, until) => {
  const start = new Date(since), end = new Date(new Date(until).getTime() - 1);
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ? 'the last seven days' : `${dayLabel.format(start)} to ${dayLabel.format(end)}`;
};
const rows = (items, labelOf) => {
  const head = items.slice(0, shown).map(item => [labelOf(item), String(item.count)]);
  return items.length > shown ? [...head, ['And more', plural(items.length - shown, 'other')]] : head;
};
const productName = product => leadProduct({ product });

/** Turns the facts into { subject, body, blocks, headline, result }. `result` holds counts and suggestion codes only. */
export function composeGrowthReport(facts, { since, until, publicOrigin } = {}) {
  const f = readFacts(facts);
  const range = rangeOf(since, until);
  const started = trialsStarted(f);
  const headline = f.total === 0 ? `No new leads from ${range}.` : `${plural(f.total, 'lead')} from ${range}: ${kindList(f.byKind)}.`;
  const suggestions = suggest(f);
  const reply = f.replies.medianMinutes === null ? 'no lead was answered yet' : `${span(f.replies.medianMinutes)} (median of ${plural(f.replies.replied, 'answered lead')})`;
  const waiting = f.unanswered.count ? `${f.unanswered.count}, the oldest waiting ${span(f.unanswered.oldestMinutes)}` : 'none';
  const trials = `${plural(f.trials.started, 'sign-up')} and ${plural(f.trials.subscriptions, 'new trial subscription')}; ${f.trials.converted} converted to paid`;
  const join = (items, labelOf) => items.slice(0, shown).map(item => `${labelOf(item)} (${item.count})`).join(', ');
  const link = /^https:\/\//i.test(publicOrigin ?? '') ? `${publicOrigin.replace(/\/+$/, '')}/admin/leads` : null;

  const body = [
    headline,
    f.byProduct.length ? `By product: ${join(f.byProduct, item => productName(item.product))}.` : null,
    f.bySource.length ? `Where they came from: ${join(f.bySource, item => item.source)}${f.otherSources ? `, and ${f.otherSources} from other sources` : ''}.` : null,
    `Trials: ${trials}.`,
    `First reply: ${reply}.`,
    `Unanswered now: ${waiting}.`,
    f.landingPaths.length ? `Top landing pages: ${join(f.landingPaths, item => item.path)}.` : null,
    f.campaigns.length ? `Top campaigns: ${join(f.campaigns, item => item.campaign)}.` : null,
    `Suggestions:\n${suggestions.map((item, index) => `${index + 1}. ${item.text}`).join('\n')}`,
  ].filter(Boolean).join('\n\n');

  return {
    headline,
    subject: `Weekly growth: ${plural(f.total, 'lead')}, ${plural(started, 'trial')} started (${range})`,
    body,
    blocks: [
      { type: 'callout', tone: f.unanswered.count ? 'warning' : 'info', title: 'This week.', text: headline },
      ...(f.total ? [
        { type: 'paragraph', text: 'Leads by kind' },
        { type: 'details', rows: leadKinds.filter(kind => f.byKind[kind]).map(kind => [kindWord(kind, 2).replace(/^./, letter => letter.toUpperCase()), String(f.byKind[kind])]) },
        { type: 'paragraph', text: 'By product' },
        { type: 'details', rows: rows(f.byProduct, item => productName(item.product)) },
        { type: 'paragraph', text: 'Where they came from' },
        { type: 'details', rows: [...rows(f.bySource, item => item.source), ...(f.otherSources ? [['Other sources', String(f.otherSources)]] : [])] },
      ] : []),
      { type: 'paragraph', text: 'Trials and replies' },
      { type: 'details', rows: [
        ['Trial sign-ups', String(f.trials.started)], ['New trial subscriptions', String(f.trials.subscriptions)], ['Trials converted to paid', String(f.trials.converted)],
        ['Median time to first reply', f.replies.medianMinutes === null ? 'No lead answered yet' : span(f.replies.medianMinutes)], ['Unanswered now', waiting],
      ] },
      ...(f.landingPaths.length ? [{ type: 'paragraph', text: 'Top landing pages' }, { type: 'details', rows: rows(f.landingPaths, item => item.path) }] : []),
      ...(f.campaigns.length ? [{ type: 'paragraph', text: 'Top campaigns' }, { type: 'details', rows: rows(f.campaigns, item => item.campaign) }] : []),
      { type: 'paragraph', text: 'Three things to do next' },
      ...suggestions.map((item, index) => ({ type: 'paragraph', text: `${index + 1}. ${item.text}` })),
      { type: 'paragraph', text: 'Test leads from the form checks are never counted.' },
      ...(link ? [{ type: 'button', label: 'Open Leads', url: link }] : []),
    ],
    result: {
      leads: f.total, byKind: Object.fromEntries(leadKinds.filter(kind => f.byKind[kind]).map(kind => [kind, f.byKind[kind]])),
      trials: f.trials, medianFirstReplyMinutes: f.replies.medianMinutes, unanswered: f.unanswered.count, suggestions: suggestions.map(item => item.code),
    },
  };
}
