/**
 * The Platform Engineer's model-free work: check every product's health endpoint, and tell the
 * owner when one stops answering and when it comes back.
 *
 * `probe.sweep` runs every five minutes. It checks each fixed target (see targets.mjs) and
 * reports the result to the database, which owns the rules: a product that fails two checks in
 * a row opens one incident, and its first healthy check closes it (private.agent_probe_record).
 * Those transitions arrive here as `probe.incident` and `probe.recovery` tasks, which alert the
 * owner and record the incident as an action in the agent's log.
 *
 * Nothing a product returns is kept: a check yields a status code, a latency and one fixed
 * failure word. A response body is read for at most 4 KB so a slow or endless one cannot hold
 * the sweep, then thrown away. Redirects are never followed.
 *
 * A 429 says the product (or something in front of it) turned the probe away for asking too
 * often, not that the product is down: on Nov 10 every product answered the probe 429 at once
 * while the Hub served normal traffic, and the owner got six urgent texts. A rate-limited check
 * is therefore not reported to the database at all. It neither counts toward an incident nor
 * closes one, and the product is simply checked again at the next sweep.
 *
 * The lead forms are checked every six hours by `probe.forms` (in tasks/growth.mjs, because it needs the Growth
 * Manager's database feature) and recorded through the same operation, so their incidents and recoveries come here
 * too: `alertTargets` names them (they are never part of the five-minute sweep), and a form target says how often
 * it is checked and how long it may take.
 */
import { minutesBetween, mustHaveReached, permanent, plural, recordRun, when } from './shared.mjs';

const timeoutMs = 8000;
const bodyLimitBytes = 4096;
const failureThreshold = 2;
// An alert that reaches the owner more than an hour after the failure began (the agent was paused,
// the server was down) is a report, not a page: it goes by email only.
const staleAlertMs = 60 * 60 * 1000;

async function readLimited(reader) {
  let total = 0;
  while (total < bodyLimitBytes) {
    const { done, value } = await reader.read();
    if (done) return;
    total += value.byteLength;
  }
}

// Rejects when the signal fires, so a body that stalls cannot outlive the time limit whatever the fetch implementation does.
const abortion = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

/**
 * One check. Never throws: returns { ok, statusCode, latencyMs, failure } with statusCode 0 when nothing answered. A 429 is the
 * failure `rate_limited`, which the sweep leaves unrecorded (see above).
 */
export async function checkTarget(target, { fetchImpl = fetch, signal, limitMs = timeoutMs, clock = () => performance.now() } = {}) {
  const started = clock();
  const limit = AbortSignal.timeout(limitMs);
  const combined = signal ? AbortSignal.any([signal, limit]) : limit;
  const result = (ok, statusCode, failure) => ({ ok, statusCode, failure, latencyMs: Math.min(Math.max(Math.round(clock() - started), 0), 600_000) });
  let statusCode = 0;
  let reader;
  try {
    const response = await fetchImpl(target.url, {
      method: 'GET', redirect: 'manual', signal: combined,
      headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1', 'user-agent': 'CareMetric-Hub-Probe/1' },
    });
    statusCode = response.status;
    reader = response.body?.getReader();
    if (reader) await Promise.race([readLimited(reader), abortion(combined)]);
  } catch (error) {
    return result(false, statusCode, limit.aborted || error?.name === 'TimeoutError' ? 'timeout' : 'network');
  } finally {
    await reader?.cancel().catch(() => {});
  }
  if (statusCode >= 200 && statusCode < 300) return result(true, statusCode, null);
  if (statusCode === 429) return result(false, statusCode, 'rate_limited');
  return result(false, statusCode, statusCode >= 300 && statusCode < 400 ? 'redirect' : 'status');
}

/** A check that says nothing about whether the product is up: it is not recorded, and the next sweep asks again. */
export const rateLimited = check => check.failure === 'rate_limited';

// The last three are a lead form's own failures: it answered, but not as a probe; it did not pass the test lead on; or it said it did and
// the lead never reached the Hub.
export const shortFailure = ({ failure, statusCode }) => ({
  timeout: 'timed out', network: 'could not be reached', redirect: `redirected (${statusCode})`, status: `returned ${statusCode}`,
  rate_limited: 'was rate-limited (429) and was not counted',
  not_probe: 'did not recognise the probe', not_forwarded: 'did not forward the test lead', not_received: 'forwarded a test lead that never arrived',
}[failure] ?? 'failed');
export const longFailure = ({ failure, statusCode }, seconds = 8) => ({
  timeout: `did not answer within ${seconds} seconds`, network: 'could not be reached', redirect: `answered with a redirect (status ${statusCode})`,
  status: `answered with status ${statusCode}`,
  not_probe: 'answered, but not as a signed probe (check that the product\'s HUB_LEAD_SECRET matches the Hub\'s)',
  not_forwarded: 'answered the probe but could not forward its test lead to the Hub',
  not_received: 'said it forwarded its test lead, but the lead did not reach the Hub',
}[failure] ?? 'failed');

export function summarizeSweep(rows) {
  const failing = rows.filter(row => !row.check.ok);
  if (!failing.length) return `All ${rows.length} products answered, the slowest in ${Math.max(...rows.map(row => row.check.latencyMs))} ms.`;
  return `${failing.map(row => `${row.target.label} ${shortFailure(row.check)}`).join('; ')}. ${rows.length - failing.length} of ${rows.length} answered.`;
}

export function probeHandlers({
  store, notifier, targets, alertTargets = [], fetchImpl = fetch, limitMs = timeoutMs, threshold = failureThreshold, staleMs = staleAlertMs,
  log = line => console.warn(line),
}) {
  const byKey = new Map([...alertTargets, ...targets].map(target => [target.key, target]));

  const targetOf = payload => {
    const target = byKey.get(typeof payload?.target === 'string' ? payload.target : '');
    if (!target) throw permanent('unknown_target');
    if (!Number.isInteger(payload.incident) || payload.incident < 1) throw permanent('invalid_payload');
    return target;
  };

  async function sweep(task, { signal, now = () => new Date() } = {}) {
    const checked = await Promise.all(targets.map(async target => ({ target, check: await checkTarget(target, { fetchImpl, signal, limitMs }) })));
    const rows = [];
    for (const { target, check } of checked) {
      if (signal?.aborted) throw Object.assign(new Error('The sweep was stopped.'), { code: 'task_timeout', transient: true });
      // A rate-limited check leaves the product's state exactly as it was: no failure streak, no incident, no recovery.
      const outcome = rateLimited(check) ? { transition: 'none' } : await store.probeRecord({
        targetKey: target.key, ok: check.ok, statusCode: check.statusCode, latencyMs: check.latencyMs,
        failure: check.failure, threshold, agentKey: task.agentKey,
      });
      rows.push({ target, check, outcome });
    }
    const summary = summarizeSweep(rows);
    const changed = rows.some(row => row.outcome.transition !== 'none');
    const unhealthy = rows.some(row => !row.check.ok);
    // A run row for every sweep that saw something, and one an hour otherwise, so the screen shows a pulse without 288 rows a day.
    if (changed || unhealthy || now().getUTCMinutes() < 5) await recordRun({ store, log }, task, { promptVersion: 'probe.1', summary });
    return {
      result: {
        checked: rows.length, answered: rows.filter(row => row.check.ok).length, summary,
        failing: rows.filter(row => !row.check.ok && !rateLimited(row.check)).map(row => ({ target: row.target.key, failure: row.check.failure, statusCode: row.check.statusCode })),
        rateLimited: rows.filter(row => rateLimited(row.check)).map(row => row.target.key),
        transitions: rows.filter(row => row.outcome.transition !== 'none').map(row => ({ target: row.target.key, transition: row.outcome.transition, incident: row.outcome.incident })),
      },
    };
  }

  // An observe-only agent still tells the owner (that is a report), but proposes no action.
  async function recordAction(task, { kind, target, incident, preview, input }) {
    if (task.agent?.autonomy === 'observe') return 'observe_only';
    try {
      await store.proposeAction({ taskId: task.id, kind, targetKind: 'probe_target', targetId: `${target.key}:${incident}`, preview, input });
      return 'recorded';
    } catch (error) {
      if (error?.code === '42501') return 'observe_only';
      throw error;
    }
  }

  async function incident(task, { now = () => new Date() } = {}) {
    const payload = task.payload ?? {};
    const target = targetOf(payload);
    // A form is checked every six hours, so its second failure always comes hours after the first: it is late only past its own window.
    const stale = payload.since && now().getTime() - new Date(payload.since).getTime() > (target.staleMs ?? staleMs);
    const flapping = payload.flapping === true;
    const urgent = !stale && !flapping;
    const failures = Number.isInteger(payload.failures) ? payload.failures : threshold;
    const last = { failure: typeof payload.failure === 'string' ? payload.failure : 'status', statusCode: Number.isInteger(payload.statusCode) ? payload.statusCode : 0 };
    const down = target.form ? 'is not working' : 'is down';
    const subject = stale ? `${target.label} ${target.form ? 'was not working' : 'was down'}` : flapping ? `${target.label} is unstable again` : `${target.label} ${down}`;
    const body = [
      `${target.label} has not passed ${plural(failures, target.form ? 'form check' : 'health check')} in a row. The last check ${longFailure(last, target.timeoutSeconds ?? 8)}.`,
      `The first failed check was at ${when(payload.since)}. Checks run ${target.every ?? 'every five minutes'}.`,
      stale ? 'This report reached you late, so it did not go by text. Check whether it is still happening.'
        : flapping ? 'It also failed within half an hour of its last recovery, so this came by email only.'
          : target.form
            ? 'Website visitors may not reach you through this form. Nothing has been restarted or changed, and you will get one more message when it works again.'
            : 'Customers of this product may be affected. Nothing has been restarted or changed, and you will get one more message when it answers again.',
    ].join('\n\n');
    const results = await notifier.send({
      severity: urgent ? 'urgent' : 'warning', subject, body, dedupeKey: `probe.incident:${target.key}:${payload.incident}`,
      agentKey: task.agentKey, taskId: task.id, attention: 'now',
    });
    const action = await recordAction(task, {
      kind: 'incident.open', target, incident: payload.incident, preview: subject,
      input: { target: target.key, incident: payload.incident, since: payload.since ?? null, failures, statusCode: last.statusCode, failure: last.failure, flapping },
    });
    mustHaveReached(results);
    return { result: { target: target.key, incident: payload.incident, severity: urgent ? 'urgent' : 'warning', delivery: results.map(item => `${item.channel}:${item.delivery}`), action } };
  }

  async function recovery(task) {
    const payload = task.payload ?? {};
    const target = targetOf(payload);
    const minutes = payload.downSince && payload.recoveredAt ? minutesBetween(payload.downSince, payload.recoveredAt) : null;
    const subject = `${target.label} ${target.form ? 'is working again' : 'is answering again'}`;
    const body = [
      `${target.label} passed its ${target.form ? 'form check' : 'health check'} again at ${when(payload.recoveredAt)}.`,
      payload.downSince
        ? `It first failed at ${when(payload.downSince)}${minutes ? `, about ${plural(minutes, 'minute')} earlier` : ''}.`
        : 'It had been reported down.',
    ].join('\n\n');
    const results = await notifier.send({
      // The owner was told at once that it was down, so the all-clear goes at once too.
      severity: 'info', subject, body, dedupeKey: `probe.recovery:${target.key}:${payload.incident}`, agentKey: task.agentKey, taskId: task.id, attention: 'now',
    });
    const action = await recordAction(task, {
      kind: 'incident.resolve', target, incident: payload.incident, preview: subject,
      input: { target: target.key, incident: payload.incident, downSince: payload.downSince ?? null, recoveredAt: payload.recoveredAt ?? null },
    });
    mustHaveReached(results);
    return { result: { target: target.key, incident: payload.incident, delivery: results.map(item => `${item.channel}:${item.delivery}`), action } };
  }

  return { 'probe.sweep': sweep, 'probe.incident': incident, 'probe.recovery': recovery };
}
