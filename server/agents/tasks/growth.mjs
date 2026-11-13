/**
 * The Growth Manager: no website lead waits, and the owner sees where customers come from. It uses no model, reads leads only
 * through server-only operations that return no contact name, address, phone number or message, and sends nothing to a customer.
 *
 * - `growth.leads` (every five minutes) looks at each new lead once. A trial sign-up is an owner alert at once; a demo, consultation
 *   or contact request is left to the Support Concierge, which alerts on its conversation; a newsletter sign-up, savings model or
 *   county report waits for the morning brief and the weekly report.
 * - `growth.followup` (every fifteen minutes) reminds the owner about a lead conversation nobody has answered, once per step of the
 *   agent's `followup_minutes` (an hour, then a day), never during its quiet hours.
 * - `growth.weekly` (every morning; the work is Monday's) emails the week's leads, trials, replies and three suggestions.
 * - `probe.forms` (the Platform Engineer's, every six hours) sends each lead form a signed probe and confirms the test lead reached
 *   the Hub, recording the result like a health check so two failures in a row open an incident.
 *
 * Everything registers only when the database declares platform.agents.growth.v1, so a Hub whose database lacks the migration still
 * starts and the schedules stay due instead of failing.
 */
import { createHmac } from 'node:crypto';
import { live } from '../../live.mjs';
import { delivered } from '../notify.mjs';
import { easternDate, easternMidnight, weekStart } from '../accounts/week.mjs';
import { composeGrowthReport } from '../growth/report.mjs';
import { growthSettings, quietUntil } from '../growth/settings.mjs';
import { conversationKinds, followupAlert, kindWord, trialAlert } from '../growth/words.mjs';
import { formTargets as defaultFormTargets } from '../targets.mjs';
import { shortFailure } from './probe.mjs';
import { dueMoment, heldForScorecard, heldResult, mustHaveReached, plural, recordRun } from './shared.mjs';

export const growthFeature = 'platform.agents.growth.v1';
/** Website leads followed up through the growth pipeline (20261113160000_growth_inbound.sql). */
export const growthInboundFeature = 'platform.agents.growth-inbound.v1';
/** The lead kinds the growth pipeline follows up, and the trial sign-up that stops cold email to its business. */
export const capturedLeadKinds = Object.freeze(['county_report', 'savings_model', 'contact', 'newsletter', 'trial_signup']);
const declared = features => (features instanceof Set ? features.has(growthFeature) : Array.isArray(features) && features.includes(growthFeature));

const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
// How far back a new lead is still news: older ones are never alerted, so resuming a paused agent cannot flood the owner.
const pendingWindowHours = 24;
const pendingLimit = 50;
// A lead conversation is chased for a week, or a day past the largest step when that is longer; after that it is past chasing one by
// one and stays in the brief and the weekly report. The database caps the window at 31 days.
const chaseWindow = steps => Math.min(Math.max(7 * 1440, steps.at(-1) + 1440), 44_640);
const unansweredLimit = 50;
const failureThreshold = 2;
const arrivalWindowMs = 10 * 60_000;
const answerLimitBytes = 4096;
const minimumSecretLength = 32;

const stopped = () => Object.assign(new Error('The task was stopped.'), { code: 'task_timeout', transient: true });
const usable = secret => typeof secret === 'string' && secret.length >= minimumSecretLength;

// ---- probe.forms: one signed probe per lead form ----------------------------------------------------------------------------------

/** `v1=` and the hex HMAC-SHA256, under the product's lead secret, of `<timestamp>.probe` (docs/LEAD_INTAKE.md, "Probe mode"). */
export const probeSignature = (secret, timestamp) => `v1=${createHmac('sha256', secret).update(`${timestamp}.probe`).digest('hex')}`;

async function readAnswer(reader) {
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > answerLimitBytes) return null;
    chunks.push(value);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))); } catch { return null; }
}

const abortion = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

/**
 * One probe of one form. Never throws: returns { ok, statusCode, latencyMs, failure, hubStatus }. `ok` means the form answered 200 with
 * `probe: true` and `forwarded: true`; whether the test lead really arrived is the caller's check. The answer is read for at most 4 KB
 * and only its two flags and the Hub status it reports are kept; the secret and the answer are never logged or returned.
 */
export async function checkForm(target, { secret, fetchImpl = fetch, signal, now = () => new Date(), clock = () => performance.now() } = {}) {
  const started = clock();
  const limit = AbortSignal.timeout((target.timeoutSeconds ?? 20) * 1000);
  const combined = signal ? AbortSignal.any([signal, limit]) : limit;
  const timestamp = String(Math.floor(now().getTime() / 1000));
  const result = (ok, statusCode, failure, hubStatus = null) => ({ ok, statusCode, failure, hubStatus, latencyMs: Math.min(Math.max(Math.round(clock() - started), 0), 600_000) });
  let statusCode = 0;
  let reader;
  let text = null;
  try {
    const response = await fetchImpl(target.url, {
      method: 'POST', redirect: 'manual', signal: combined, body: JSON.stringify(target.body ?? {}),
      headers: {
        'content-type': 'application/json', accept: 'application/json', 'user-agent': 'CareMetric-Hub-Probe/1',
        'x-caremetric-probe': probeSignature(secret, timestamp), 'x-caremetric-timestamp': timestamp,
      },
    });
    statusCode = response.status;
    reader = response.body?.getReader();
    if (reader) text = await Promise.race([readAnswer(reader), abortion(combined)]);
  } catch (error) {
    return result(false, statusCode, limit.aborted || error?.name === 'TimeoutError' ? 'timeout' : 'network');
  } finally {
    await reader?.cancel().catch(() => {});
  }
  if (statusCode >= 300 && statusCode < 400) return result(false, statusCode, 'redirect');
  if (statusCode !== 200) return result(false, statusCode, 'status');
  let answer = null;
  try { answer = text ? JSON.parse(text) : null; } catch { answer = null; }
  if (!answer || typeof answer !== 'object' || answer.probe !== true) return result(false, statusCode, 'not_probe');
  const hubStatus = Number.isInteger(answer.status) && answer.status >= 0 && answer.status <= 999 ? answer.status : null;
  if (answer.forwarded !== true) return result(false, statusCode, 'not_forwarded', hubStatus);
  return result(true, statusCode, null, hubStatus);
}

const hubWords = status => (status === null ? '' : status === 0 ? ' (it could not reach the Hub)' : ` (the Hub answered ${status})`);
const formWords = ({ target, check }) => (check.ok ? `${target.label} passed`
  : `${target.label} ${shortFailure(check)}${check.failure === 'not_forwarded' ? hubWords(check.hubStatus) : ''}`);

// ---- The handlers ----------------------------------------------------------------------------------------------------------------

export function growthHandlers({
  store, notifier, publicOrigin, features = null, leadSecrets = {}, formTargets = defaultFormTargets, fetchImpl = fetch,
  threshold = failureThreshold, log = line => console.warn(line), inboundFollowup = false,
}) {
  if (!declared(features)) return {};
  const inbound = () => (features instanceof Set ? features.has(growthInboundFeature) : Array.isArray(features) && features.includes(growthInboundFeature)) && live(inboundFollowup) === true;

  /**
   * `growth.leads`: each lead is looked at once. Only a trial sign-up alerts here, by email, under its own key. A lead whose alert the
   * provider refused stays unseen and the task fails transiently once the rest are handled, so the scheduler's retry sends it again
   * under the same key (the notifier reopens only the channel that failed, at most three times). A lead whose alert used up its tries
   * is set aside as seen: the morning brief still counts it.
   */
  async function leads(task, { now = () => new Date(), signal } = {}) {
    const answer = await store.growthPending({ limit: pendingLimit, windowHours: pendingWindowHours });
    const pending = Array.isArray(answer) ? answer : [];
    const counts = { trials: 0, conversations: 0, digest: 0 };
    const capturing = inbound() && typeof store.growthLeadCapture === 'function';
    let captured = 0;
    const seen = [];
    const delivery = [];
    const refusals = [];
    let refused = 0;
    let unsent = 0;
    for (const item of pending) {
      if (signal?.aborted) throw stopped();
      if (item.kind === 'trial_signup') {
        const lead = await store.growthLead(item.id);
        // The scheduler may have stopped waiting while the lead was read: nothing is sent after that.
        if (signal?.aborted) throw stopped();
        if (lead && lead.test !== true) {
          const words = trialAlert(lead, { publicOrigin });
          const results = await notifier.send({
            severity: 'warning', subject: words.subject, body: words.body, blocks: words.blocks, dedupeKey: `growth:trial:${item.id}`, agentKey: task.agentKey, taskId: task.id,
          });
          delivery.push(...results.map(entry => `${entry.channel}:${entry.delivery}`));
          if (results.some(entry => entry.delivery === 'failed')) { refusals.push(...results); refused += 1; continue; }
          if (!results.some(delivered)) unsent += 1;
          counts.trials += 1;
        }
      } else if (conversationKinds.includes(item.kind)) {
        counts.conversations += 1;
      } else {
        counts.digest += 1;
      }
      // Settings → Customer growth → Follow up website leads by email: the lead becomes a qualified opportunity (or, for a trial
      // sign-up, stops cold email to its business). Drafting, approval and every send check stay the growth pipeline's.
      if (capturing && capturedLeadKinds.includes(item.kind)) {
        const outcome = await store.growthLeadCapture(item.id);
        if (outcome?.captured) captured += 1;
      }
      seen.push(item.id);
    }
    if (seen.length) await store.growthMarkSeen(seen);
    // A run row when something arrived, and one an hour otherwise, so the Team screen shows a pulse without 288 rows a day.
    if (pending.length || now().getUTCMinutes() < 5) {
      await recordRun({ store, log }, task, {
        promptVersion: 'growth.1',
        summary: pending.length
          ? `Looked at ${plural(pending.length, 'new lead')}: ${plural(counts.trials, 'trial')} alerted${delivery.length ? ` (${delivery.join(', ')})` : ''}, `
            + `${counts.conversations} left to the Support Concierge, ${counts.digest} for the brief${captured ? `; ${plural(captured, 'lead')} handed to the Marketing Manager to follow up` : ''}${refused ? `; ${plural(refused, 'alert')} refused, tried again shortly` : ''}.`
          : 'No new leads.',
        outcome: refused || unsent ? 'failed' : 'completed', errorCode: refused || unsent ? 'not_delivered' : null,
      });
    }
    // A refused alert is tried again by the scheduler; the run above stays as the record of this attempt.
    mustHaveReached(refusals);
    return { result: { seen: seen.length, ...counts, ...(captured ? { captured } : {}), delivery } };
  }

  /**
   * `growth.followup`: one reminder per lead conversation per step, under `growth:followup:<lead>:<step>`, for the largest step it has
   * reached (a lead found three days late gets the one-day reminder, not both). The database leaves out the steps already reminded before
   * it limits the list, so a backlog longer than one run's 50 is worked through run by run. Nothing during quiet hours: the first run after
   * them sends what waited, and the key keeps each reminder once. A refused reminder fails the task transiently once the others are sent,
   * so the scheduler tries it again under the same key (the notifier reopens only the channel that failed, at most three times).
   */
  async function followup(task, { now = () => new Date(), signal } = {}) {
    const settings = growthSettings(task.agent?.config);
    const moment = now();
    const until = quietUntil(moment, settings.quietHours);
    if (until) return { result: { skipped: 'quiet_hours', resumesAt: until.toISOString() } };
    const steps = settings.followupMinutes;
    const answer = await store.growthUnanswered({ steps, maxMinutes: chaseWindow(steps), limit: unansweredLimit });
    const waiting = Array.isArray(answer) ? answer : [];
    const reminded = [];
    const delivery = [];
    const outcomes = [];
    let repeats = 0;
    for (const item of waiting) {
      if (signal?.aborted) throw stopped();
      // The database names the step; one it could not have chosen from these steps is worked out here instead.
      const step = steps.includes(item.step) ? item.step : steps.filter(minutes => item.minutesWaiting >= minutes).at(-1);
      if (step === undefined) continue;
      const words = followupAlert(item, step);
      const results = await notifier.send({
        severity: 'warning', subject: words.subject, body: words.body, dedupeKey: `growth:followup:${item.leadId}:${step}`, agentKey: task.agentKey, taskId: task.id,
      });
      outcomes.push(...results);
      if (results.every(entry => entry.delivery === 'duplicate')) { repeats += 1; continue; }
      delivery.push(...results.map(entry => `${entry.channel}:${entry.delivery}`));
      reminded.push({ reference: item.reference, kind: item.kind, step, minutes: item.minutesWaiting });
    }
    if (reminded.length) {
      await recordRun({ store, log }, task, {
        promptVersion: 'growth.1',
        summary: `Reminded you about ${plural(reminded.length, 'unanswered lead')}: ${reminded.slice(0, 10).map(entry => `${entry.reference} (${kindWord(entry.kind)})`).join(', ')}${reminded.length > 10 ? ', and more' : ''} (${delivery.join(', ')}).`,
      });
    }
    mustHaveReached(outcomes);
    return { result: { waiting: waiting.length, reminded: reminded.length, alreadyReminded: repeats, delivery } };
  }

  /**
   * `growth.weekly`: the schedule fires every morning and only Monday's run reports (the day is the one the task was due for, so a retry
   * after midnight keeps it); every scheduled run in an Eastern week uses `growth:weekly:<Monday>`, so the week is reported once. Run now
   * reports on any day, under a key of its own. The window is the seven Eastern days before the day it runs.
   */
  async function weekly(task, { now = () => new Date(), signal } = {}) {
    const moment = now();
    const asked = task.sourceKind === 'owner';
    const due = asked ? moment : dueMoment(task) ?? moment;
    if (!asked && weekday.format(due) !== 'Mon') return { result: { skipped: 'not_monday' } };
    // The Monday scorecard carries this report while the owner's "Send the individual weekly reports" is off.
    if (await heldForScorecard({ store, log }, task)) return heldResult({ week: weekStart(due) });
    const today = easternDate(due);
    const [year, month, day] = today.split('-').map(Number);
    const since = easternMidnight(new Date(Date.UTC(year, month - 1, day - 7)).toISOString().slice(0, 10));
    const until = easternMidnight(today);
    const week = weekStart(due);
    if (signal?.aborted) throw stopped();
    const facts = await store.growthFacts({ since, until });
    const report = composeGrowthReport(facts, { since, until, publicOrigin });
    // The scheduler may have stopped waiting while the figures were read: the report is not sent after that.
    if (signal?.aborted) throw stopped();
    const results = await notifier.send({
      severity: 'info', subject: report.subject, body: report.body, blocks: report.blocks,
      dedupeKey: asked ? `growth:run:${task.id}` : `growth:weekly:${week}`, agentKey: task.agentKey, taskId: task.id,
    });
    if (!asked && results.every(item => item.delivery === 'duplicate')) return { result: { skipped: results.some(delivered) ? 'already_sent' : 'earlier_attempt_unconfirmed', week } };
    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    const reached = results.some(delivered);
    await recordRun({ store, log }, task, {
      promptVersion: 'growth.1',
      summary: reached ? `Sent the weekly growth report: ${report.headline}` : `The weekly growth report was written but not delivered (${delivery.join(', ')}).`,
      outcome: reached ? 'completed' : 'failed', errorCode: reached ? null : 'not_delivered',
    });
    // A report the provider refused is tried again under the same key, the same day it was due: finishing now would leave the week
    // unreported, because the other mornings of the week do no work. The run above stays as the record of this attempt.
    mustHaveReached(results);
    return { result: { week, since: since.toISOString(), until: until.toISOString(), delivery, ...report.result } };
  }

  /**
   * `probe.forms`: each form whose product has a lead secret on the Hub gets one signed probe, side by side. A form passes when it answered
   * 200 with `probe: true` and `forwarded: true` AND a test lead from that product reached the Hub in the last ten minutes. Each result is
   * recorded under the form's target key through the same operation as a health check, so two failures in a row open an incident and the
   * first pass closes it. A product without a secret is skipped, never failed.
   */
  async function forms(task, { signal, now = () => new Date() } = {}) {
    const configured = formTargets.filter(target => usable(leadSecrets?.[target.source]));
    const skipped = formTargets.filter(target => !configured.includes(target)).map(target => target.key);
    const checked = await Promise.all(configured.map(async target => {
      const check = await checkForm(target, { secret: leadSecrets[target.source], fetchImpl, signal, now });
      if (!check.ok) return { target, check };
      const arrived = await store.leadProbeSeen({ source: target.source, since: new Date(now().getTime() - arrivalWindowMs) });
      return { target, check: arrived === true ? check : { ...check, ok: false, failure: 'not_received' } };
    }));
    const rows = [];
    for (const { target, check } of checked) {
      if (signal?.aborted) throw stopped();
      const outcome = await store.probeRecord({
        targetKey: target.key, ok: check.ok, statusCode: check.statusCode, latencyMs: check.latencyMs, failure: check.failure, threshold, agentKey: task.agentKey,
      });
      rows.push({ target, check, outcome });
    }
    const labels = Object.fromEntries(formTargets.map(target => [target.key, target.label]));
    const summary = [
      rows.length ? `${rows.map(formWords).join('; ')}.` : 'No lead form has its product\'s secret on the Hub, so none was checked.',
      skipped.length && rows.length ? `Skipped (no secret on the Hub): ${skipped.map(key => labels[key]).join(', ')}.` : null,
    ].filter(Boolean).join(' ');
    await recordRun({ store, log }, task, { promptVersion: 'forms.1', summary });
    return {
      result: {
        checked: rows.length, passed: rows.filter(row => row.check.ok).length, skipped, summary,
        failing: rows.filter(row => !row.check.ok).map(row => ({ target: row.target.key, failure: row.check.failure, statusCode: row.check.statusCode, hubStatus: row.check.hubStatus })),
        transitions: rows.filter(row => row.outcome?.transition && row.outcome.transition !== 'none')
          .map(row => ({ target: row.target.key, transition: row.outcome.transition, incident: row.outcome.incident })),
      },
    };
  }

  return { 'growth.leads': leads, 'growth.followup': followup, 'growth.weekly': weekly, 'probe.forms': forms };
}
