/**
 * Copies the messages Advisors and Breathe received into the Communications inbox. Reading
 * another application needs the owner's live SMS session, so these tasks are marked
 * requires_session: the schedule creates them waiting, and "Run what's waiting" on the Team
 * screen runs them with the owner's session. Nothing here runs unattended, and nothing is kept:
 * the session token is used for the calls and is never stored, logged or returned.
 *
 * One run makes at most three sync calls (200 messages each) from the newest end of the list.
 * A source that lists newest first stops after a call that finds nothing new, because everything
 * older was already copied. History beyond that window is brought in with the Import buttons on
 * the Communications page, which resume where they stopped; the sync itself is idempotent, so
 * reading a message twice never creates it twice.
 */
const sources = {
  // Advisors lists inquiries newest first (advisors/hub-bridge.mjs orders by created_at DESC).
  'import.advisors': { source: 'advisors.web', newestFirst: true },
  // Breathe's order has not been checked, so every run reads its whole window instead of stopping early.
  'import.breathe': { source: 'breathe.phone', newestFirst: false },
};
const maxCalls = 3;
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/**
 * What a failed read means for the task. An error with no HTTP status is not ours to classify:
 * returning null lets the scheduler's own retry policy handle it.
 */
function failure(error, summary) {
  const status = Number.isInteger(error?.status) ? error.status : 0;
  if (status === 401) return { status: 'awaiting_session', errorCode: 'session_required', result: summary };
  if (status === 503 && error.code === 'unconfigured') return { status: 'done', result: { ...summary, skipped: 'not_connected' } };
  if (status === 429) return { status: 'queued', errorCode: 'rate_limited', result: summary };
  if (status >= 500) return { status: 'queued', errorCode: 'bridge_unavailable', result: summary };
  if (status === 403) return { status: 'failed', errorCode: 'not_permitted', result: summary };
  if (status >= 400) return { status: 'failed', errorCode: 'request_rejected', result: summary };
  return null;
}

/** The import handlers, only when the Communications service is available to call. */
export function importHandlers({ communications }) {
  if (!communications || typeof communications.sync !== 'function') return {};
  return Object.fromEntries(Object.entries(sources).map(([kind, { source, newestFirst }]) => [kind, async (_task, { sessionToken, signal } = {}) => {
    // Without the owner's session there is nothing to do but wait for it.
    if (!sessionToken) return { status: 'awaiting_session', errorCode: 'session_required' };
    const summary = { source, read: 0, created: 0, skipped: 0, calls: 0, complete: false, nextOffset: null };
    let offset = 0;
    while (summary.calls < maxCalls && !signal?.aborted) {
      let page;
      try { page = await communications.sync(sessionToken, { source, offset }); }
      catch (error) {
        const outcome = failure(error, { ...summary });
        if (outcome) return outcome;
        throw error;
      }
      summary.calls += 1;
      summary.read += count(page?.read);
      summary.created += count(page?.created);
      summary.skipped += count(page?.skipped);
      summary.nextOffset = Number.isSafeInteger(page?.nextOffset) ? page.nextOffset : null;
      // The end of the list, or (newest first) a window with nothing new: caught up.
      if (summary.nextOffset === null || (newestFirst && count(page?.created) === 0)) { summary.complete = true; summary.nextOffset = null; break; }
      offset = summary.nextOffset;
    }
    return { result: summary };
  }]));
}
