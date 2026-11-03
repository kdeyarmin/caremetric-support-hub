/**
 * The Chief of Staff's morning brief: one email at 07:00 Eastern that says what needs the owner,
 * what the team did yesterday and what is worth knowing. It uses no model: it is composed from
 * the counts and times in private.agent_brief_facts, so it always arrives and never says anything
 * that is not in the database. (A model may later write the narrative on top of the same facts.)
 *
 * The brief carries counts, product names and times. It never quotes a customer, an address or an
 * amount of money.
 *
 * When the database declares the Growth Manager's feature, a Growth section adds yesterday's website leads by kind, the
 * trials that started and the lead conversations still waiting for a first answer (private.agent_growth_facts: counts only),
 * and a lead that waits is something that needs the owner.
 */
import { easternMidnight } from '../accounts/week.mjs';
import { kindList, span } from '../growth/words.mjs';
import { delivered } from '../notify.mjs';
import { dueMoment, mustHaveReached, plural, recordRun, when } from './shared.mjs';

const growthFeature = 'platform.agents.growth.v1';

const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
// en-CA writes a date as YYYY-MM-DD, which is what the alert key and the schedule both use.
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

const count = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);
const dollars = cents => `$${(Math.max(Number(cents) || 0, 0) / 100).toFixed(2)}`;

function age(from, to) {
  const minutes = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 90) return plural(Math.max(minutes, 1), 'minute');
  const hours = Math.round(minutes / 60);
  return hours < 48 ? plural(hours, 'hour') : plural(Math.round(hours / 24), 'day');
}

const headlineFor = needs => (needs === 0 ? 'Nothing needs you this morning.' : needs === 1 ? 'One thing needs you this morning.' : `${needs} things need you this morning.`);

/**
 * Yesterday's growth, from private.agent_growth_facts: { needs, rows, line }, or null when there is no Growth section (the feature is not
 * declared). `growth.unavailable` says the figures could not be read, which the section says instead of showing zeros.
 */
function growthSection(growth) {
  if (!growth) return null;
  if (growth.unavailable === true) return { needs: [], rows: [['Growth figures', 'Could not be read this morning']], line: 'Growth: the figures could not be read this morning.' };
  const total = count(growth.leads?.total);
  const kinds = kindList(Object.fromEntries(Object.entries(growth.leads?.byKind ?? {}).map(([kind, value]) => [kind, count(value)])));
  const signups = count(growth.trials?.started);
  const subscriptions = count(growth.trials?.subscriptions);
  const waiting = count(growth.unanswered?.count);
  const oldest = Number.isFinite(Number(growth.unanswered?.oldestMinutes)) && growth.unanswered?.oldestMinutes !== null ? span(growth.unanswered.oldestMinutes) : null;
  const waitingWords = waiting ? `${waiting}${oldest ? `, the oldest waiting ${oldest}` : ''}` : 'None';
  return {
    needs: waiting ? [['Leads waiting for a first reply', `${waiting}${oldest ? ` (oldest ${oldest})` : ''}`]] : [],
    rows: [
      ['New leads', total ? `${total} (${kinds})` : 'None'],
      ['Trials started', `${plural(signups, 'sign-up')}, ${plural(subscriptions, 'new trial subscription')}`],
      ['Lead conversations unanswered', waitingWords],
    ],
    line: `Growth yesterday: ${total ? `${plural(total, 'new lead')} (${kinds})` : 'no new leads'}, ${plural(signups, 'trial sign-up')} and ${plural(subscriptions, 'new trial subscription')}. `
      + `Lead conversations unanswered now: ${waiting ? waitingWords : 'none'}.`,
  };
}

/** Turns the facts into { subject, body, blocks, needsYou }. Pure: the same facts always give the same email. */
export function composeBrief(facts, { now = new Date(), publicOrigin, services = {}, labels = {}, growth = null } = {}) {
  const generated = facts?.generatedAt ?? now;
  const approvals = count(facts?.approvals?.count);
  const incidents = Array.isArray(facts?.incidents) ? facts.incidents : [];
  const billing = facts?.billing ?? {};
  const yesterday = facts?.yesterday ?? {};
  const agents = Array.isArray(facts?.agents) ? facts.agents : [];

  const needs = [];
  if (approvals) needs.push(['Waiting for your approval', `${approvals}${facts.approvals.oldestAt ? ` (oldest ${age(facts.approvals.oldestAt, generated)})` : ''}`]);
  if (count(facts?.awaitingSession)) needs.push(['Waiting for you to sign in', plural(count(facts.awaitingSession), 'task')]);
  for (const incident of incidents) needs.push([`${labels[incident.target] ?? incident.target} is down`, `since ${when(incident.since)}`]);
  if (count(facts?.failedTasks)) needs.push(['Failed tasks in the last 24 hours', String(count(facts.failedTasks))]);
  if (count(facts?.undeliveredAlerts)) needs.push(['Urgent alerts that did not reach you', String(count(facts.undeliveredAlerts))]);
  if (count(billing.pastDue)) needs.push(['Subscriptions past due', String(count(billing.pastDue))]);
  const growthPart = growthSection(growth);
  if (growthPart) needs.push(...growthPart.needs);

  const yesterdayRows = [
    ['Runs recorded', String(count(yesterday.runs))],
    ['Tasks finished', `${count(yesterday.tasksDone)} done, ${count(yesterday.tasksFailed)} failed`],
    ['Actions carried out', String(count(yesterday.actionsExecuted))],
    ['Incidents', `${count(yesterday.incidentsOpened)} opened, ${count(yesterday.incidentsClosed)} closed`],
    ['AI spend', dollars(yesterday.spendCents)],
  ];

  const watch = [];
  if (count(billing.trialsEnding)) watch.push(`${plural(count(billing.trialsEnding), 'trial')} end${count(billing.trialsEnding) === 1 ? 's' : ''} within a week.`);
  const paused = agents.filter(agent => agent.status === 'paused').map(agent => agent.name);
  if (paused.length) watch.push(`Paused, so ${paused.length === 1 ? 'it does' : 'they do'} nothing until you resume ${paused.length === 1 ? 'it' : 'them'}: ${paused.join(', ')}.`);
  const overBudget = agents.filter(agent => agent.hitBudget === true).map(agent => agent.name);
  if (overBudget.length) watch.push(`Reached the daily budget yesterday: ${overBudget.join(', ')}.`);
  if (services.sms === false) watch.push('Text alerts are not set up, so urgent items reach you by email only.');

  const headline = headlineFor(needs.length);
  const link = /^https:\/\//i.test(publicOrigin ?? '') ? `${publicOrigin.replace(/\/+$/, '')}/admin/team` : null;
  const body = [
    headline,
    needs.length ? `Needs you:\n${needs.map(([label, value]) => `- ${label}: ${value}`).join('\n')}` : null,
    `Yesterday: ${plural(count(yesterday.runs), 'run')}, ${count(yesterday.tasksDone)} tasks done and ${count(yesterday.tasksFailed)} failed, `
      + `${plural(count(yesterday.actionsExecuted), 'action')} carried out, ${plural(count(yesterday.incidentsOpened), 'incident')} opened and ${count(yesterday.incidentsClosed)} closed, `
      + `AI spend ${dollars(yesterday.spendCents)}.`,
    growthPart ? growthPart.line : null,
    watch.length ? `Worth knowing:\n${watch.map(line => `- ${line}`).join('\n')}` : null,
  ].filter(Boolean).join('\n\n');

  return {
    needsYou: needs.length,
    headline,
    subject: `CareMetric brief for ${day.format(now)}: ${needs.length === 0 ? 'nothing needs you' : needs.length === 1 ? '1 thing needs you' : `${needs.length} things need you`}`,
    body,
    blocks: [
      { type: 'callout', tone: needs.length ? 'warning' : 'success', title: needs.length ? 'Heads up.' : 'All clear.', text: headline },
      ...(needs.length ? [{ type: 'details', rows: needs }] : []),
      { type: 'paragraph', text: 'Yesterday, midnight to midnight Eastern:' },
      { type: 'details', rows: yesterdayRows },
      ...(growthPart ? [{ type: 'paragraph', text: 'Growth: website leads yesterday, and what is waiting now' }, { type: 'details', rows: growthPart.rows }] : []),
      ...(watch.length ? [{ type: 'paragraph', text: 'Worth knowing' }, ...watch.map(text => ({ type: 'paragraph', text }))] : []),
      ...(needs.length && link ? [{ type: 'button', label: 'Open the AI team', url: link }] : []),
    ],
  };
}

// The Eastern day before `date` (YYYY-MM-DD), found from the calendar so a night the clocks change cannot move it.
const dayBefore = date => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
};

export function briefHandlers({ store, notifier, publicOrigin, services = {}, labels = {}, features = null, log = line => console.warn(line) }) {
  const withGrowth = features instanceof Set ? features.has(growthFeature) : Array.isArray(features) && features.includes(growthFeature);

  // Yesterday's growth figures. A failure to read them never holds back the brief: the section says they could not be read.
  async function growthFacts(date) {
    if (!withGrowth) return null;
    try {
      return await store.growthFacts({ since: easternMidnight(dayBefore(date)), until: easternMidnight(date) }) ?? { unavailable: true };
    } catch {
      log(JSON.stringify({ event: 'hub_agent_brief_growth_unread' }));
      return { unavailable: true };
    }
  }

  async function brief(task, { now = () => new Date() } = {}) {
    const facts = await store.briefFacts();
    const moment = now();
    // The scheduled brief is sent once a day, however often the task is retried, and the day is the one it was due for, so a retry after
    // midnight keeps its key. A brief the owner asks for is sent once per request (its own task), whatever day a retry falls on.
    const owner = task.sourceKind === 'owner';
    const date = dayKey.format(owner ? moment : dueMoment(task) ?? moment);
    const content = composeBrief(facts, { now: moment, publicOrigin, services, labels, growth: await growthFacts(date) });
    const dedupeKey = owner ? `brief:owner:${task.id}` : `brief:${date}`;
    const results = await notifier.send({
      severity: content.needsYou > 0 ? 'warning' : 'info', subject: content.subject, body: content.body, blocks: content.blocks,
      dedupeKey, agentKey: task.agentKey, taskId: task.id,
    });
    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    const reached = results.some(delivered);
    await recordRun({ store, log }, task, {
      promptVersion: 'brief.1',
      summary: reached ? `Sent the morning brief: ${content.headline}` : `The morning brief was written but not delivered (${delivery.join(', ')}).`,
      outcome: reached ? 'completed' : 'failed',
      errorCode: reached ? null : 'not_delivered',
    });
    // A brief the provider refused is tried again; the run above stays as the record of this attempt.
    mustHaveReached(results);
    return { result: { date, needsYou: content.needsYou, delivery } };
  }
  return { 'brief.daily': brief };
}
