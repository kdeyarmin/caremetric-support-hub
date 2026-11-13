/**
 * The one place the AI team imports the official Anthropic SDK, so the production image's build
 * proves it is installed. The Hub's case assistant keeps its own small fetch client
 * (server/ai-assistance.mjs); this one is for the agents, which need the SDK's request shape,
 * typed errors and request ids.
 *
 * Choices made here, not left to the SDK's defaults:
 * - The origin is pinned, so an ANTHROPIC_BASE_URL variable on the host cannot send customer
 *   text somewhere else.
 * - No automatic retry and a 90 second timeout. The defaults (two retries, ten minutes) would
 *   outlive the scheduler's four-minute limit for a task, and a call the scheduler has given up on
 *   would go on running and spending. A retry after a timeout or a dropped connection is also a
 *   second billable request whose cost the run (one reservation, one booked call) never sees. The
 *   scheduler's own retry makes the next attempt a separate run with its own budget check.
 * - The SDK's logger is off: its messages can name request details.
 */
import Anthropic from '@anthropic-ai/sdk';
import { aiError } from './errors.mjs';

export const apiOrigin = 'https://api.anthropic.com';
export const requestTimeoutMs = 90_000;

/**
 * `client` is for tests (anything with `messages.create`); `fetchImpl` swaps only the transport,
 * so a test can run the real SDK against a fake network.
 */
export function anthropicClient({ apiKey, client = null, fetchImpl = null, timeoutMs = requestTimeoutMs, maxRetries = 0 } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const sdk = client ?? (key
    ? new Anthropic({ apiKey: key, baseURL: apiOrigin, timeout: timeoutMs, maxRetries, logLevel: 'off', ...(fetchImpl ? { fetch: fetchImpl } : {}) })
    : null);
  return {
    configured: sdk !== null,
    /** One Messages API call. Resolves to the response and the provider's request id; rejects with the SDK's own error. */
    async create(request, { signal, timeoutMs: callTimeoutMs = null } = {}) {
      if (!sdk) throw aiError('ai_not_configured');
      // A research round (server tools searching and reading) may need longer than an ordinary call; nothing else changes the timeout.
      const options = { ...(signal ? { signal } : {}), ...(callTimeoutMs ? { timeout: callTimeoutMs } : {}) };
      const message = await sdk.messages.create(request, Object.keys(options).length ? options : undefined);
      return { message, requestId: typeof message?._request_id === 'string' ? message._request_id : null };
    },
  };
}
