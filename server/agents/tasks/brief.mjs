/**
 * The Chief of Staff's morning brief: one email at 07:00 Eastern that says what needs the owner,
 * what the team did yesterday and what is worth knowing. It uses no model: it is composed from
 * the counts and times in private.agent_brief_facts, so it always arrives and never says anything
 * that is not in the database. (A model may later write the narrative on top of the same facts.)
 *
 * The brief carries counts, product names and times. It never quotes a customer, an address or an
 * amount of money.
 */
import { plural, recordRun, when } from './shared.mjs';

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

/** Turns the facts into { subject, body, blocks, needsYou }. Pure: the same facts always give the same email. */
export function composeBrief(facts, { now = new Date(), publicOrigin, services = {}, labels = {} } = {}) {
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
      ...(watch.length ? [{ type: 'paragraph', text: 'Worth knowing' }, ...watch.map(text => ({ type: 'paragraph', text }))] : []),
      ...(needs.length && link ? [{ type: 'button', label: 'Open the AI team', url: link }] : []),
    ],
  };
}

export function briefHandlers({ store, notifier, publicOrigin, services = {}, labels = {}, log = line => console.warn(line) }) {
  async function brief(task, { now = () => new Date() } = {}) {
    const facts = await store.briefFacts();
    const moment = now();
    const content = composeBrief(facts, { now: moment, publicOrigin, services, labels });
    const date = dayKey.format(moment);
    // The scheduled brief is sent once a day, however often the task is retried. A brief the owner asks for is sent every time.
    const dedupeKey = task.sourceKind === 'owner' ? `brief:${date}:${task.id}` : `brief:${date}`;
    const results = await notifier.send({
      severity: content.needsYou > 0 ? 'warning' : 'info', subject: content.subject, body: content.body, blocks: content.blocks,
      dedupeKey, agentKey: task.agentKey, taskId: task.id,
    });
    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    const reached = results.some(item => item.delivery === 'sent' || item.delivery === 'duplicate');
    await recordRun({ store, log }, task, {
      promptVersion: 'brief.1',
      summary: reached ? `Sent the morning brief: ${content.headline}` : `The morning brief was written but not delivered (${delivery.join(', ')}).`,
      outcome: reached ? 'completed' : 'failed',
      errorCode: reached ? null : 'not_delivered',
    });
    return { result: { date, needsYou: content.needsYou, delivery } };
  }
  return { 'brief.daily': brief };
}
