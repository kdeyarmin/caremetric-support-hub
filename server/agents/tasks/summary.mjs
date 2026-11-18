import { live } from '../../live.mjs';
import { delivered } from '../notify.mjs';
import { kindList } from '../growth/words.mjs';
import { briefNeeds, briefWatch, growthSection } from './brief.mjs';
import { watchdogFindings } from './watchdog.mjs';
import { dueMoment, mustHaveReached, plural, recordRun } from './shared.mjs';

/**
 * The Chief of Staff's end-of-day summary (owner decision 2026-11-18): "I only want emails when something needs my decision or for me
 * to do something. What would be nice would be 1 email at the end of the day of just a summary of what was done that day, what came in,
 * what went out (just a summary) and if anything needs my decision."
 *
 * While Settings → AI team → "One end-of-day summary" is on, the AI team's news and reports are not emailed one at a time: the notifier
 * holds them (notify.mjs) and this task lists them once a day, at the hour the owner chose (Settings → AI team → "Summary time"), with
 * what needs the owner, what came in, what went out and what the team did since the last summary. The scheduled morning brief is not
 * sent while it is on: this email carries the same "needs you" list. New customer and prospect messages wait for it too (their replies
 * are counted under Needs you). Something that cannot wait (an urgent message, a lead still unanswered after hours, something broken
 * that only the owner can fix) is still emailed at once, and listed here again.
 *
 * The schedule fires at noon Eastern (20261118120000_owner_summary.sql); the task then waits, queued, until the chosen hour. Each
 * summary covers the 24 hours since the previous one, so nothing falls between two summaries. Like the brief it uses no model and
 * carries counts, agent names, alert subjects and times: never a customer's words, address or amount of money.
 */
export const summaryFeature = 'platform.agents.owner-summary.v1';
export const defaultSummaryHour = 17;

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const easternHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

const count = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);
const dollars = cents => `$${(Math.max(Number(cents) || 0, 0) / 100).toFixed(2)}`;
const clip = (value, limit) => { const text = String(value ?? '').trim(); return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`; };
const time = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : clock.format(date); };

/** The summary hour the owner chose (12 to 23, Eastern), or the default for anything else. */
export const summaryHour = value => (Number.isInteger(value) && value >= 12 && value <= 23 ? value : defaultSummaryHour);

/** The instant `date` (YYYY-MM-DD) reaches `hour`:00 Eastern. The clocks change at 2 a.m., so an afternoon hour is never ambiguous. */
export function easternAt(date, hour) {
  for (const offset of [4, 5]) {
    const candidate = new Date(Date.parse(`${date}T00:00:00Z`) + (hour + offset) * 3_600_000);
    if (dayKey.format(candidate) === date && Number(easternHour.format(candidate)) === hour) return candidate;
  }
  throw new RangeError('That is not an Eastern calendar date and hour.');
}

const dayBefore = date => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
};

/**
 * What an action is in the owner's words: [one, many]. Kinds that are bookkeeping (an incident recorded, a pipeline stage moved) are
 * left out of "what went out"; any kind not named here is counted as another change.
 */
const actionWords = {
  'communication.reply': ['reply to a customer', 'replies to customers'],
  'communication.answer': ['answer to a customer', 'answers to customers'],
  'communication.acknowledge': ['acknowledgment to a customer', 'acknowledgments to customers'],
  'email.send': ['customer email', 'customer emails'],
  'email.external': ['email you wrote', 'emails you wrote'],
  'growth.message': ['prospect email', 'prospect emails'],
  'social.post': ['social post', 'social posts'],
  'social.founder_post': ['post for your LinkedIn profile', 'posts for your LinkedIn profile'],
  'social.reply': ['social reply', 'social replies'],
  'social.moderate': ['social comment to hide or remove', 'social comments to hide or remove'],
  'social.ad_create': ['new ad', 'new ads'],
  'social.ad_pause': ['ad to pause', 'ads to pause'],
  'social.ad_budget': ['ad budget change', 'ad budget changes'],
  'social.campaign_create': ['ad campaign', 'ad campaigns'],
  'social.google_campaign': ['Google search campaign', 'Google search campaigns'],
  'content.publish': ['article', 'articles'],
  'creative.asset': ['creative asset', 'creative assets'],
  'creative.retire': ['creative asset to retire', 'creative assets to retire'],
  'offer.apply': ['offer from your menu', 'offers from your menu'],
};
const bookkeeping = new Set(['incident.open', 'incident.resolve', 'import.run', 'communication.note', 'communication.update', 'growth.pipeline', 'growth.success']);

/** "3 social posts, 2 prospect emails and 1 other change", most first; null when there is nothing. */
export function actionList(byKind, { other = ['other change', 'other changes'] } = {}) {
  const named = new Map();
  let rest = 0;
  for (const [kind, value] of Object.entries(byKind ?? {})) {
    const n = count(value);
    if (!n || bookkeeping.has(kind)) continue;
    if (actionWords[kind]) named.set(kind, (named.get(kind) ?? 0) + n);
    else rest += n;
  }
  const parts = [...named.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${n} ${actionWords[kind][n === 1 ? 0 : 1]}`);
  if (rest) parts.push(`${rest} ${other[rest === 1 ? 0 : 1]}`);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

const channelWords = { email: ['email', 'emails'], chat: ['chat', 'chats'], sms: ['text', 'texts'], phone: ['call', 'calls'], web_form: ['web form', 'web forms'] };
const channelList = byChannel => Object.entries(byChannel ?? {}).filter(([, n]) => count(n))
  .sort((a, b) => count(b[1]) - count(a[1]) || a[0].localeCompare(b[0]))
  .map(([channel, n]) => `${count(n)} ${(channelWords[channel] ?? [channel, channel])[count(n) === 1 ? 0 : 1]}`).join(', ');

/**
 * The summary as { subject, body, blocks, needsYou, headline }. Pure: the same facts give the same email.
 * `facts` are the brief's (what needs the owner now), `day` the summary's own (private.agent_summary_facts: the window's work, what came
 * in and went out, the approvals waiting by kind and the alerts held or sent), `growth` the window's growth figures or null.
 */
export function composeSummary(facts, day, { now = new Date(), since, publicOrigin, services = {}, labels = {}, growth = null, watchdog = [], truth = false } = {}) {
  const generated = facts?.generatedAt ?? now;
  const findings = Array.isArray(watchdog) ? watchdog : [];
  const growthPart = growthSection(growth);
  const needs = briefNeeds(facts, { generated, labels, growthPart, findings, truth });
  // The approvals waiting, by kind: the first row says how many, this says what they are.
  const waiting = actionList(day?.waiting, { other: ['other approval', 'other approvals'] });
  const approvalsRow = needs.find(([label]) => label === 'Waiting for your approval');
  if (approvalsRow && waiting) approvalsRow[1] = `${approvalsRow[1]}: ${waiting}`;

  const notes = day?.notifications ?? {};
  const sent = Array.isArray(notes.sent) ? notes.sent : [];
  // Held messages, approval requests first: what would have been separate emails. The approvals themselves are counted in Needs you.
  const held = (Array.isArray(notes.held) ? notes.held : []).map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.attention === 'decision' ? 0 : 1) - (b.item.attention === 'decision' ? 0 : 1) || a.index - b.index).map(({ item }) => item);
  const more = (shown, total) => (count(total) > shown ? [`…and ${count(total) - shown} more on the AI team page.`] : []);
  const sentLines = [...sent.map(item => `${time(item.at)}: ${clip(item.subject, 160)}`), ...more(sent.length, notes.sentCount)];
  const heldLines = [...held.map(item => `${item.name ? `${item.name}: ` : ''}${clip(item.subject, 160)}`), ...more(held.length, notes.heldCount)];

  // What the team did: the window's totals and, by agent, the work that took a run (a check that found nothing new records none).
  const work = day?.day ?? {};
  const byAgent = (Array.isArray(day?.work) ? day.work : []).filter(item => count(item.runs)).slice(0, 8)
    .map(item => [String(item.name ?? item.agent ?? 'Agent'), `${plural(count(item.runs), 'job')} done${count(item.spendCents) ? `, ${dollars(item.spendCents)} of AI` : ''}`]);
  // Runs, not tasks: the checks that run every few minutes finish hundreds of tasks a day without doing anything worth counting.
  const doneLine = `${plural(count(work.runs), 'job')} done, ${plural(count(work.actionsExecuted), 'approved action')} carried out`
    + `${count(work.tasksFailed) ? `, ${plural(count(work.tasksFailed), 'task')} failed` : ''}, AI spend ${dollars(work.spendCents)}`
    + `${count(work.incidentsOpened) ? `, ${plural(count(work.incidentsOpened), 'outage')} opened and ${count(work.incidentsClosed)} closed` : ''}.`;

  // What came in: conversations in Communications, website leads and trials.
  const inbound = day?.inbound ?? {};
  const inRows = [];
  inRows.push(['Customer messages', count(inbound.messages)
    ? `${plural(count(inbound.messages), 'message')} in ${plural(count(inbound.conversations), 'conversation')}${count(inbound.newConversations) ? ` (${count(inbound.newConversations)} new)` : ''}${channelList(inbound.byChannel) ? `: ${channelList(inbound.byChannel)}` : ''}`
    : 'None']);
  if (growth && growth.unavailable !== true) {
    const total = count(growth.leads?.total);
    const kinds = kindList(Object.fromEntries(Object.entries(growth.leads?.byKind ?? {}).map(([kind, value]) => [kind, count(value)])));
    inRows.push(['Website leads', total ? `${total} (${kinds})` : 'None']);
    inRows.push(['Trials', `${plural(count(growth.trials?.started), 'sign-up')}, ${plural(count(growth.trials?.subscriptions), 'new trial subscription')}`]);
  } else if (growth?.unavailable === true) inRows.push(['Website leads', 'Could not be read just now']);

  // What went out: answers sent from Communications, and the approved actions carried out (emails, posts, ad changes).
  const outbound = day?.outbound ?? {};
  const outRows = [
    ['Replies sent from Communications', count(outbound.messages) ? `${plural(count(outbound.messages), 'message')} in ${plural(count(outbound.conversations), 'conversation')}` : 'None'],
    ['Carried out by the team', actionList(day?.executed) ?? 'Nothing'],
  ];

  const watch = briefWatch(facts, { services, findings, truth, moment: 'just now' });
  const decisions = needs.length;
  const headline = decisions === 0 ? 'Nothing needs your decision right now.' : decisions === 1 ? 'One thing needs you.' : `${decisions} things need you.`;
  const sinceWords = since ? `since ${weekday.format(new Date(since))}, ${time(since)}` : 'in the last 24 hours';
  const origin = /^https:\/\//i.test(publicOrigin ?? '') ? publicOrigin.replace(/\/+$/, '') : null;

  const body = [
    headline,
    decisions ? `Needs you:\n${needs.map(([label, value]) => `- ${label}: ${value}`).join('\n')}` : null,
    sentLines.length ? `Already emailed to you today because it could not wait:\n${sentLines.map(line => `- ${line}`).join('\n')}` : null,
    `What the team did ${sinceWords}: ${doneLine}`,
    `What came in:\n${inRows.map(([label, value]) => `- ${label}: ${value}`).join('\n')}`,
    `What went out:\n${outRows.map(([label, value]) => `- ${label}: ${value}`).join('\n')}`,
    heldLines.length ? `Held for this summary instead of separate emails:\n${heldLines.map(line => `- ${line}`).join('\n')}` : null,
    watch.length ? `Worth knowing:\n${watch.map(line => `- ${line}`).join('\n')}` : null,
  ].filter(Boolean).join('\n\n');

  const list = lines => lines.map(text => ({ type: 'paragraph', text: `• ${text}` }));
  return {
    needsYou: decisions,
    headline,
    subject: `CareMetric end of day, ${weekday.format(now)}: ${decisions === 0 ? 'nothing needs you' : decisions === 1 ? '1 thing needs you' : `${decisions} things need you`}`,
    body,
    blocks: [
      { type: 'callout', tone: decisions ? 'warning' : 'success', title: decisions ? 'Needs your decision.' : 'All clear.', text: headline },
      ...(decisions ? [{ type: 'details', rows: needs }] : []),
      ...(sentLines.length ? [{ type: 'paragraph', text: 'Already emailed to you today because it could not wait:' }, ...list(sentLines)] : []),
      { type: 'paragraph', text: `What the team did ${sinceWords}: ${doneLine}` },
      ...(byAgent.length ? [{ type: 'details', rows: byAgent }] : []),
      { type: 'paragraph', text: 'What came in' },
      { type: 'details', rows: inRows },
      { type: 'paragraph', text: 'What went out' },
      { type: 'details', rows: outRows },
      ...(heldLines.length ? [{ type: 'paragraph', text: 'Held for this summary instead of separate emails (each one is on the AI team page):' }, ...list(heldLines)] : []),
      ...(watch.length ? [{ type: 'paragraph', text: 'Worth knowing' }, ...watch.map(text => ({ type: 'paragraph', text }))] : []),
      ...(origin ? [{ type: 'button', label: 'Open the AI team', url: `${origin}/admin/team` }] : []),
    ],
  };
}

/**
 * Registered once the database declares the summary. `settings` holds two of the owner's settings, each a value or a function read when
 * used: `enabled` (One end-of-day summary) and `hour` (Summary time). The notifier reads "Email new messages and approvals right away" itself.
 */
export function summaryHandlers({ store, notifier, publicOrigin, services = {}, labels = {}, features = null, toolkit = null, watchdogIdleDays = 3,
  settings = {}, log = line => console.warn(line) }) {
  const has = feature => (features instanceof Set ? features.has(feature) : Array.isArray(features) && features.includes(feature));
  if (!has(summaryFeature) || typeof store?.summaryFacts !== 'function') return {};
  const truth = has('platform.agents.support-truth.v1');
  const withGrowth = has('platform.agents.growth.v1');

  async function watchdog(moment) {
    if (typeof store.watchdogFacts !== 'function') return [];
    try {
      const days = Number(live(watchdogIdleDays));
      return watchdogFindings(await store.watchdogFacts(), { idleDays: Number.isInteger(days) && days >= 1 ? days : 3, now: moment, toolkit: typeof toolkit === 'function' ? toolkit() : [] });
    } catch {
      log(JSON.stringify({ event: 'hub_agent_summary_watchdog_unread' }));
      return [];
    }
  }
  async function growthFacts(since, until) {
    if (!withGrowth) return null;
    try { return await store.growthFacts({ since, until }) ?? { unavailable: true }; } catch {
      log(JSON.stringify({ event: 'hub_agent_summary_growth_unread' }));
      return { unavailable: true };
    }
  }

  async function summary(task, { now = () => new Date() } = {}) {
    const moment = now();
    const owner = task.sourceKind === 'owner';
    // The day is the one the schedule fired for, so a retry after midnight keeps its key and its window.
    const date = dayKey.format(owner ? moment : dueMoment(task) ?? moment);
    const hour = summaryHour(live(settings.hour));
    const at = easternAt(date, hour);
    // Fired at noon, it waits until the owner's hour. A changed hour is read again when it wakes.
    if (!owner && moment < at) return { status: 'queued', retryAt: at, result: { date, waitingUntil: at.toISOString() } };
    // The 24 hours since the last summary, so nothing falls between two of them; one the owner asks for covers the last 24 hours.
    const until = owner ? moment : at;
    const since = owner ? new Date(moment.getTime() - 24 * 3_600_000) : easternAt(dayBefore(date), hour);
    const day = await store.summaryFacts({ since, until });
    const on = live(settings.enabled) === true;
    // Switched off, nothing is sent, unless updates were held before it was switched off: those are still delivered, once.
    if (!owner && !on && !count(day?.notifications?.heldCount)) return { result: { date, skipped: 'summary_off' } };
    const [facts, growth, findings] = await Promise.all([store.briefFacts(), growthFacts(since, until), watchdog(moment)]);
    const content = composeSummary(facts, day, { now: moment, since, publicOrigin, services, labels, growth, watchdog: findings, truth });
    const results = await notifier.send({
      severity: content.needsYou > 0 ? 'warning' : 'info', subject: content.subject, body: content.body, blocks: content.blocks,
      dedupeKey: owner ? `summary:owner:${task.id}` : `summary:${date}`, agentKey: task.agentKey, taskId: task.id, attention: 'now',
    });
    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    const reached = results.some(delivered);
    await recordRun({ store, log }, task, {
      promptVersion: 'summary.1',
      summary: reached ? `Sent the end-of-day summary: ${content.headline}` : `The end-of-day summary was written but not delivered (${delivery.join(', ')}).`,
      outcome: reached ? 'completed' : 'failed',
      errorCode: reached ? null : 'not_delivered',
    });
    mustHaveReached(results);
    return { result: { date, needsYou: content.needsYou, held: count(day?.notifications?.heldCount), delivery } };
  }
  return { 'summary.daily': summary };
}
