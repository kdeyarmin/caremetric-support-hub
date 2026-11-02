import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicClient, apiOrigin, requestTimeoutMs } from './client.mjs';
import { aiError, classify, permanentCodes, transientCodes } from './errors.mjs';

// The real SDK against a fake network: what the Hub would send, and what a failure looks like when it comes back.
const reply = (over = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...over,
});
// A step is a description; each call builds a fresh Response, because a Response body can be read only once.
const respond = (body, status = 200, headers = {}) => ({ body, status, headers: { 'content-type': 'application/json', 'request-id': 'req_test1', ...headers } });
const build = step => new Response(JSON.stringify(step.body), { status: step.status, headers: step.headers });
const failure = (status, type, message = 'Pat Example asked about 555-0100') => respond({ type: 'error', error: { type, message } }, status);
const request = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] };

function network(steps) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(init.body) : null });
    const step = steps[Math.min(seen.length - 1, steps.length - 1)];
    return typeof step === 'function' ? step(init) : build(step);
  };
  return { fetchImpl, seen };
}
const clientFor = (steps, options = {}) => { const net = network(steps); return { ...net, client: anthropicClient({ apiKey: 'sk-test-key', fetchImpl: net.fetchImpl, maxRetries: 0, ...options }) }; };
const rejection = async promise => { try { await promise; } catch (error) { return error; } throw new Error('Expected the call to fail.'); };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('the Anthropic client', () => {
  it('is not configured without a key, and refuses a call with a coded error', async () => {
    for (const apiKey of [undefined, null, '', '   ']) {
      const client = anthropicClient({ apiKey });
      expect(client.configured).toBe(false);
      await expect(client.create(request)).rejects.toMatchObject({ code: 'ai_not_configured', transient: false });
    }
    expect(anthropicClient({ apiKey: 'sk-test-key' }).configured).toBe(true);
    expect(anthropicClient({ client: { messages: { create: async () => ({}) } } }).configured).toBe(true);
  });

  it('sends the request to the pinned origin with the key in a header and returns the message and request id', async () => {
    const { client, seen } = clientFor([respond(reply())]);
    const result = await client.create(request);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${apiOrigin}/v1/messages`);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].body).toEqual(request);
    expect(seen[0].headers['anthropic-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(seen[0].headers.authorization === 'Bearer sk-test-key' || seen[0].headers['x-api-key'] === 'sk-test-key').toBe(true);
    expect(seen[0].url).not.toContain('sk-test-key');
    expect(result.message.content[0].text).toBe('{"ok":true}');
    expect(result.message.usage.input_tokens).toBe(10);
    expect(result.requestId).toBe('req_test1');
  });

  it('keeps the origin when the host sets a different base URL', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://elsewhere.example.test');
    const { client, seen } = clientFor([respond(reply())]);
    await client.create(request);
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('retries once, not twice: a rate limit that clears on the second try succeeds, one that does not stops there', async () => {
    const quick = { 'retry-after-ms': '1' };
    const recovers = clientFor([respond({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, quick), respond(reply())], { maxRetries: 1 });
    expect((await recovers.client.create(request)).message.stop_reason).toBe('end_turn');
    expect(recovers.seen).toHaveLength(2);
    const stuck = clientFor([respond({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, quick)], { maxRetries: 1 });
    expect(classify(await rejection(stuck.client.create(request))).code).toBe('rate_limited');
    expect(stuck.seen).toHaveLength(2);
    expect(requestTimeoutMs).toBe(90_000);
  });

  it('maps every failure to a lowercase code and says whether trying again can help', async () => {
    const table = [
      [429, 'rate_limit_error', 'rate_limited', true],
      [500, 'api_error', 'provider_outage', true],
      [503, 'api_error', 'provider_outage', true],
      [529, 'overloaded_error', 'provider_outage', true],
      [408, 'request_timeout', 'provider_outage', true],
      [409, 'conflict_error', 'provider_outage', true],
      [400, 'invalid_request_error', 'request_rejected', false],
      [413, 'request_too_large', 'request_rejected', false],
      [422, 'invalid_request_error', 'request_rejected', false],
      [401, 'authentication_error', 'ai_auth_failed', false],
      [403, 'permission_error', 'ai_not_permitted', false],
      [404, 'not_found_error', 'model_not_found', false],
    ];
    for (const [status, type, code, transient] of table) {
      const { client } = clientFor([failure(status, type)]);
      const classified = classify(await rejection(client.create(request)));
      expect(classified, String(status)).toEqual({ code, transient, status, requestId: 'req_test1' });
      expect(code).toMatch(/^[a-z][a-z_]{0,59}$/);
    }
  });

  it('treats a dropped connection and the SDK\'s own timeout as unreachable, and the caller\'s abort as an abort', async () => {
    const dropped = clientFor([() => { throw new TypeError('fetch failed'); }]);
    expect(classify(await rejection(dropped.client.create(request)))).toEqual({ code: 'provider_unreachable', transient: true, status: null, requestId: null });

    const hangs = init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const slow = clientFor([hangs], { timeoutMs: 25 });
    expect(classify(await rejection(slow.client.create(request))).code).toBe('provider_unreachable');

    const controller = new AbortController();
    const waiting = clientFor([hangs]);
    const pending = rejection(waiting.client.create(request, { signal: controller.signal }));
    controller.abort();
    expect(classify(await pending)).toEqual({ code: 'run_aborted', transient: true, status: null, requestId: null });

    const already = AbortSignal.abort();
    expect(classify(await rejection(clientFor([respond(reply())]).client.create(request, { signal: already }))).code).toBe('run_aborted');
  });

  it('never keeps the provider\'s message: a classified failure and its code carry no request or response text', async () => {
    const { client } = clientFor([failure(400, 'invalid_request_error', 'Bad request: Pat Example, DOB 01/01/1900')]);
    const error = await rejection(client.create(request));
    // The SDK's own error quotes the body, which is exactly why nothing but the classification is kept.
    expect(error.message).toContain('Pat Example');
    const classified = classify(error);
    expect(JSON.stringify(classified)).not.toContain('Pat Example');
    const ours = aiError(classified.code, classified.transient, { status: classified.status });
    expect(ours.message).toBe('The model call could not be completed.');
    expect(ours.message + JSON.stringify(ours)).not.toContain('Pat Example');
  });

  it('writes nothing to the console, whatever happens', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map(name => vi.spyOn(console, name).mockImplementation(() => {}));
    for (const step of [failure(500, 'api_error'), failure(429, 'rate_limit_error'), respond(reply())]) {
      await clientFor([step], { maxRetries: 1 }).client.create(request).catch(() => {});
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('error classification', () => {
  it('passes the runtime\'s own coded errors through and names anything else an unknown failure', () => {
    for (const code of [...transientCodes, ...permanentCodes]) {
      expect(code).toMatch(/^[a-z][a-z_]{0,59}$/);
      expect(classify(aiError(code, transientCodes.includes(code)))).toMatchObject({ code, transient: transientCodes.includes(code), requestId: null });
    }
    expect(classify(new Error('Pat Example'))).toEqual({ code: 'ai_error', transient: false, status: null, requestId: null });
    expect(classify(Object.assign(new Error('x'), { code: 'ECONNRESET' })).code).toBe('ai_error');
    expect(classify(undefined).code).toBe('ai_error');
    expect(classify(null).code).toBe('ai_error');
    expect(classify('a string').code).toBe('ai_error');
  });

  it('keeps the status of one of its own errors only when it is a whole number', () => {
    expect(classify(aiError('provider_outage', true, { status: 503 })).status).toBe(503);
    expect(classify(aiError('provider_outage', true, { status: '503' })).status).toBeNull();
  });

  it('builds an error with a fixed message and the flags the scheduler reads', () => {
    const error = aiError('rate_limited', true, { status: 429 });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'rate_limited', transient: true, status: 429, message: 'The model call could not be completed.' });
    expect(aiError('output_invalid')).toMatchObject({ transient: false });
  });
});
