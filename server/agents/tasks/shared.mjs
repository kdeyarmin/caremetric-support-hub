/** Small pieces the model-free tasks share: Eastern time words, plurals and the run row the owner's screen shows. */
const stamp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const permanent = code => Object.assign(new Error('The agent task cannot be run.'), { code });
export const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** "Nov 2, 9:05 AM Eastern", or "an unknown time" for anything that is not a date. */
export const when = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'an unknown time' : `${stamp.format(date)} Eastern`;
};

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
