/**
 * The model runtime's errors. Every failure becomes one of a few lowercase codes (the scheduler and
 * the database accept only `^[a-z][a-z_]{0,59}$`) and a flag saying whether trying again can help.
 *
 * Nothing here ever carries the provider's message. The SDK puts the response body into
 * `error.message`, and a body can quote what was sent, so a message is never logged, stored or
 * passed on: only the code, the HTTP status and the provider's request id (which Anthropic support
 * can look up) survive. The same goes for a JSON parse error, whose message can quote the text.
 */
import Anthropic from '@anthropic-ai/sdk';

/** Transient codes are retried with a backoff by the scheduler; the rest stop after three attempts. */
export const transientCodes = Object.freeze(['rate_limited', 'provider_outage', 'provider_unreachable', 'run_aborted']);
export const permanentCodes = Object.freeze([
  'request_rejected', 'ai_auth_failed', 'ai_not_permitted', 'model_not_found', 'unknown_model', 'ai_not_configured',
  'output_truncated', 'output_invalid', 'ai_error', 'tool_not_allowed',
]);

/** An error the scheduler understands: a code, a fixed message and whether it is worth retrying. */
export const aiError = (code, transient = false, details = {}) =>
  Object.assign(new Error('The model call could not be completed.'), { code, transient, ...details });

const requestIdOf = error => (typeof error?.requestID === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.requestID) ? error.requestID : null);

/** The code, retry flag, HTTP status and request id for anything a call can throw. */
export function classify(error) {
  const fields = (code, transient, status = null) => ({ code, transient, status, requestId: requestIdOf(error) });
  // One of this module's own errors (output_invalid and the like) passes through unchanged.
  if (typeof error?.code === 'string' && [...transientCodes, ...permanentCodes].includes(error.code)) {
    return fields(error.code, error.transient === true, Number.isInteger(error.status) ? error.status : null);
  }
  // The caller's signal (the scheduler's deadline or a shutdown). Checked before the connection
  // errors because the SDK's own timeout is a connection error and this is not.
  if (error instanceof Anthropic.APIUserAbortError) return fields('run_aborted', true);
  if (error instanceof Anthropic.APIConnectionError) return fields('provider_unreachable', true);
  if (error instanceof Anthropic.APIError) {
    const { status } = error;
    if (status === 429) return fields('rate_limited', true, status);
    if (status === 401) return fields('ai_auth_failed', false, status);
    if (status === 403) return fields('ai_not_permitted', false, status);
    if (status === 404) return fields('model_not_found', false, status);
    if (status === 408 || status === 409 || (Number.isInteger(status) && status >= 500)) return fields('provider_outage', true, status);
    return fields('request_rejected', false, Number.isInteger(status) ? status : null);
  }
  return fields('ai_error', false);
}
