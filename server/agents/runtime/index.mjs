import { anthropicClient } from './client.mjs';
import { modelRunner } from './run.mjs';

export { aiError, classify } from './errors.mjs';
export { costCents, prices, worstCaseCents } from './pricing.mjs';

/**
 * The model runtime the AI team shares: `run(task, request, { signal })` makes one budgeted,
 * metered call (see run.mjs for the request and the outcomes) and `configured` says whether an
 * API key is present. Nothing here calls the model by itself; an agent's handler does, and only
 * the handlers that were written to.
 */
export function modelRuntime({
  apiKey, client = null, fetchImpl = null, store, record = null, notifier = null, log, now, callDeadlineMs, timeoutMs, maxRetries,
} = {}) {
  return modelRunner({ client: anthropicClient({ apiKey, client, fetchImpl, timeoutMs, maxRetries }), store, record, notifier, log, now, callDeadlineMs });
}
