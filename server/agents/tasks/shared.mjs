/** Small pieces the model-free tasks share: Eastern time words, plurals and the run row the owner's screen shows. */
const stamp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const permanent = code => Object.assign(new Error('The agent task cannot be run.'), { code });
export const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** "Nov 2, 9:05 AM Eastern", or "an unknown time" for anything that is not a date. */
export const when = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'an unknown time' : `${stamp.format(date)} Eastern`;
};

/**
 * A message the owner must get. A provider that refuses one (a temporary 429, say) is reported by the notifier as `failed`, not thrown, and
 * finishing the task then would leave the owner without it (for an outage alert, for the whole outage, because nothing enqueues a second
 * task for the same incident). Throwing a transient error has the scheduler try again a few minutes later:
 * the notifier resends only the channels that failed, a bounded number of times, and never one that went or may have gone (unknown,
 * suppressed and duplicate are not retried, which could send twice).
 */
export function mustHaveReached(results) {
  if (results.some(item => item.delivery === 'failed')) throw Object.assign(new Error('The owner could not be told.'), { code: 'notification_failed', transient: true });
}

/**
 * When a scheduled task was due, read from its request key (`schedule:<schedule id>:<UTC time>`), or null for any other task. A handler
 * that keys what it sends by the day must take the day from this and not from the clock: a retried task has to keep the key it first
 * sent under, or a retry after midnight sends again under tomorrow's key, and tomorrow's real message then looks like a repeat.
 */
export function dueMoment(task) {
  const match = /^schedule:[0-9a-f-]{36}:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(task?.requestKey ?? '');
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const moment = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(moment.getTime()) ? null : moment;
}

export const minutesBetween = (from, to) => {
  const span = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(span) && span >= 0 ? Math.max(1, Math.round(span / 60_000)) : null;
};

/**
 * The run row is for the owner's screen only (a visible heartbeat, with no model and no cost). It must never fail the
 * task after the real work is done, so a failure to write it is logged by name and swallowed.
 */
export async function recordRun({ store, log }, task, { promptVersion, summary, outcome = 'completed', errorCode = null }) {
  try {
    const runId = await store.startRun(task.id, 'none', promptVersion);
    await store.finishRun(runId, outcome, {}, summary, errorCode);
  } catch {
    log(JSON.stringify({ event: 'hub_agent_run_unrecorded', agent: task.agentKey, kind: task.kind }));
  }
}
