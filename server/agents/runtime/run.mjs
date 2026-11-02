/**
 * One model run for one agent task: check the budget, make one call, price what it used, close
 * the run row, write the usage ledger, and hand back the validated answer. Every rule that
 * matters is enforced here in code; the model only ever returns one structured object, and the
 * calling handler decides what that is allowed to cause.
 *
 * There is one call per run and no tools. A model that stops to ask for a tool, or for any reason
 * other than finishing, has produced no usable result. (The loop is written by hand rather than
 * handed to the SDK's tool runner because the Hub keeps its own budget, deadline and accounting
 * between calls; the first agent that needs tools adds rounds here.)
 *
 * Budget: a call is allowed only if the agent's remaining cents for the Eastern day, less what
 * other calls in this process have reserved and not yet booked, cover the worst case of this one
 * (an upper bound on the prompt, see `inputTokenBound`, and every output token up to max_tokens).
 * The cost reaches the database only when the run row is closed, so the row is closed immediately
 * after the response, before anything else can go wrong, and a call whose outcome is unknown (a
 * timeout, an abort, a dropped connection) is booked at its input bound rather than at nothing.
 * Reading the budget and reserving against it happen alone among one agent's calls (a lane), and a
 * reservation is released through the same lane after its cost is booked, so a call that finishes
 * while another is reading the budget is always counted once: as a reservation or as booked cost.
 * A cost whose write failed is kept as a debit and retried until the database has it, so the money
 * is never spent twice while the write is failing.
 *
 * Privacy: the request text is the caller's and may be customer text. It is never logged, never
 * put in a run summary or an error, and never stored here; the provider's error messages (which
 * can quote a request) are dropped by errors.mjs. Summaries come from the caller's `describe`,
 * which must return counts and enums only.
 */
import { aiModels } from '../../ai-assistance.mjs';
import { aiError, classify, permanentCodes, transientCodes } from './errors.mjs';
import { costCents, inputOnlyCents, prices, worstCaseCents } from './pricing.mjs';
import { schemaDefects, schemaProblems } from './schema.mjs';

const versionPattern = /^[a-z0-9.-]{1,20}$/;
const efforts = new Set(['low', 'medium', 'high']);
const reasonPattern = /^[a-z_]{1,40}$/;
const maxTokensCeiling = 8000;
const configurationAlerts = {
  ai_auth_failed: { subject: 'The AI team\'s model key was refused', body: 'Anthropic refused the API key (HTTP 401). Check ANTHROPIC_API_KEY on the Hub service. Work that needs the model is waiting and will be retried.' },
  ai_not_permitted: { subject: 'The AI team\'s model account is not permitted', body: 'Anthropic refused the request for permission reasons (HTTP 403). Check the account\'s access and billing. Work that needs the model is waiting and will be retried.' },
  model_not_found: { subject: 'The AI team asked for a model Anthropic does not know', body: 'Anthropic does not recognise the model for this agent\'s tier. A model name in the Hub is out of date.' },
};
const easternDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const ours = new Set([...transientCodes, ...permanentCodes]);

// What the provider wraps around a request (role markers, the structured-output instructions): a fixed margin on top of the bytes.
const requestOverheadTokens = 512;

/**
 * An upper bound on the tokens in a request. No tokenizer produces more tokens than the text has bytes
 * (every token stands for at least one byte), so the serialized request's UTF-8 length plus a margin
 * cannot be too small, whatever the script, symbols or emoji. It is far above the real count for English;
 * the money it reserves is released as soon as the call is booked at its real usage.
 */
export const inputTokenBound = body => Buffer.byteLength(JSON.stringify(body), 'utf8') + requestOverheadTokens;

/** The request sent to the Messages API for a checked spec: one user message, a closed JSON schema for the answer, no tools. */
export const requestBody = (model, spec) => ({
  model, max_tokens: spec.maxTokens,
  system: spec.system.map(block => ({ type: 'text', text: block.text, ...(block.cache ? { cache_control: { type: 'ephemeral' } } : {}) })),
  messages: [{ role: 'user', content: spec.user }],
  output_config: { effort: spec.effort, format: { type: 'json_schema', schema: spec.schema } },
});

const count = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

/** What the request asks for, or a permanent error when the caller got it wrong. Nothing is sent before this passes. */
function checkRequest(request) {
  const reject = () => { throw aiError('request_rejected'); };
  const { promptVersion, system, user, schema, maxTokens = 3000, effort = 'medium' } = request ?? {};
  if (typeof promptVersion !== 'string' || !versionPattern.test(promptVersion)) reject();
  if (!Array.isArray(system) || system.length === 0 || system.length > 4) reject();
  if (system.some(block => typeof block?.text !== 'string' || block.text.length === 0)) reject();
  if (typeof user !== 'string' || user.length === 0) reject();
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > maxTokensCeiling) reject();
  if (!efforts.has(effort)) reject();
  if (schemaDefects(schema).length > 0) reject();
  return { ...request, maxTokens, effort };
}

const usageOf = message => {
  const raw = message?.usage;
  const reported = raw !== null && typeof raw === 'object' && Number.isFinite(raw.input_tokens) && Number.isFinite(raw.output_tokens);
  return {
    reported,
    inputTokens: count(raw?.input_tokens), outputTokens: count(raw?.output_tokens),
    cacheReadTokens: count(raw?.cache_read_input_tokens), cacheWriteTokens: count(raw?.cache_creation_input_tokens),
    cacheWriteOneHourTokens: count(raw?.cache_creation?.ephemeral_1h_input_tokens),
  };
};

const textOf = message => (Array.isArray(message?.content) ? message.content : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');

/** What a finished response means: the run's outcome, why it produced nothing, and the answer when it did. */
function interpret(message, spec) {
  const stop = message?.stop_reason;
  if (stop === 'refusal') return { outcome: 'refused', summary: 'The model declined to answer.' };
  if (stop === 'max_tokens') return { outcome: 'no_result', errorCode: 'output_truncated', summary: 'The answer was cut off before it finished.' };
  const invalid = reason => ({ outcome: 'no_result', errorCode: 'output_invalid', summary: `The answer could not be used (${reason}).` });
  if (stop !== 'end_turn' && stop !== 'stop_sequence') return invalid('stopped early');
  let output;
  try { output = JSON.parse(textOf(message)); } catch { return invalid('not valid JSON'); }
  if (schemaProblems(spec.schema, output).length > 0) return invalid('does not fit the format');
  if (spec.validate) {
    let verdict;
    try { verdict = spec.validate(output); } catch { return invalid('checker failed'); }
    if (verdict !== undefined && verdict !== null && verdict !== true) return invalid(typeof verdict === 'string' && reasonPattern.test(verdict) ? verdict.replaceAll('_', ' ') : 'rejected by the checks');
  }
  let summary = 'The model returned a usable answer.';
  try {
    const described = spec.describe?.(output);
    if (typeof described === 'string' && described.trim()) summary = described.trim().slice(0, 500);
  } catch { /* the default summary stands */ }
  return { outcome: 'completed', output, summary };
}

export function modelRunner({
  client, store, record = null, notifier = null, models = aiModels, log = line => console.warn(line), now = () => new Date(), callDeadlineMs = 200_000,
}) {
  // Cents reserved by calls in flight in this process, per agent. The database only learns a call's cost when its run is closed.
  const held = new Map();
  const heldFor = agentKey => held.get(agentKey) ?? 0;
  // Costs whose run could not be closed (the write failed): still owed to the budget, retried at the next admission.
  const owed = new Map();
  const owedFor = agentKey => (owed.get(agentKey) ?? []).reduce((total, debt) => total + (Number(debt.usage?.costCents) || 0), 0);
  // One queue per agent: the budget read and the reservation (and every release) happen alone, in order.
  const lanes = new Map();
  async function exclusive(agentKey, work) {
    const before = lanes.get(agentKey) ?? Promise.resolve();
    let open;
    const gate = new Promise(resolve => { open = resolve; });
    const tail = before.then(() => gate);
    lanes.set(agentKey, tail);
    await before;
    try { return await work(); } finally { open(); if (lanes.get(agentKey) === tail) lanes.delete(agentKey); }
  }
  const hold = (agentKey, cents) => {
    held.set(agentKey, heldFor(agentKey) + cents);
    let released = false;
    // Releasing waits its turn in the lane, so it cannot slip between another call's budget read and its reservation.
    return () => exclusive(agentKey, async () => {
      if (released) return;
      released = true;
      held.set(agentKey, Math.max(heldFor(agentKey) - cents, 0));
    });
  };
  /** Tries again to close the runs whose cost write failed. A run the database says is already closed was written after all. */
  async function settleOwed(agentKey) {
    const list = owed.get(agentKey);
    if (!list?.length) return;
    const remaining = [];
    for (const debt of list) {
      try { await store.finishRun(debt.runId, debt.outcome, debt.usage, debt.summary, debt.errorCode); } catch (error) { if (error?.code !== 'P0002') remaining.push(debt); }
    }
    if (remaining.length) owed.set(agentKey, remaining); else owed.delete(agentKey);
  }

  /** Bookkeeping that must never fail or delay the task: the ledger row and the once-a-day owner alert. */
  async function afterwards({ task, model, outcome, usage, latencyMs, failure }) {
    if (record) {
      try {
        await record({
          caseId: null, actor: 'automation', feature: `agent_${task.agentKey}`, model, outcome: outcome === 'failed' ? 'failed' : 'completed',
          inputTokens: usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : null, outputTokens: usage ? usage.outputTokens : null, latencyMs,
        });
      } catch { log(JSON.stringify({ event: 'hub_agent_model_usage_not_recorded', agent: task.agentKey })); }
    }
    const alert = failure && configurationAlerts[failure.code];
    if (alert && notifier) {
      try {
        await notifier.send({ severity: 'warning', subject: alert.subject, body: alert.body, dedupeKey: `ai:${failure.code}:${easternDate.format(now())}`, agentKey: task.agentKey, taskId: task.id });
      } catch { log(JSON.stringify({ event: 'hub_agent_model_alert_failed', agent: task.agentKey, code: failure.code })); }
    }
  }

  /**
   * Runs one task's model call. Resolves with `{ outcome: 'completed', output, ... }`, or
   * `{ outcome: 'refused' }` when the model declined, or `{ outcome: 'budget_exhausted' }` when the
   * agent cannot afford the call today (the caller should defer the task to the next day).
   * Rejects with a coded error (see errors.mjs) for everything else; a transient code is retried
   * by the scheduler with a backoff, any other after three attempts.
   *
   * request: { promptVersion, system: [{ text, cache? }], user, schema, maxTokens?, effort?, validate?, describe? }
   * `validate(output)` returns nothing when the answer is acceptable, or a short lowercase reason
   * when it is not. `describe(output)` returns the run's summary: counts and enums, never text.
   */
  async function run(task, request, { signal } = {}) {
    const agentKey = task.agentKey;
    const spec = checkRequest(request);
    const model = models[task.agent?.modelTier];
    if (!model || !prices[model]) throw aiError('unknown_model');
    if (!client.configured) throw aiError('ai_not_configured');
    // The scheduler has already given up on this task: start nothing, book nothing.
    if (signal?.aborted) throw aiError('run_aborted', true);

    const body = requestBody(model, spec);
    const inputBound = inputTokenBound(body);
    const reserve = worstCaseCents(model, { inputTokens: inputBound, maxTokens: spec.maxTokens, cached: spec.system.some(block => block.cache) });
    // Alone among this agent's calls: settle what is still owed, read the budget, and reserve. Nothing can finish and release between the
    // read and the reservation, so no call is judged against money another call has already spent or is holding.
    const admission = await exclusive(agentKey, async () => {
      await settleOwed(agentKey);
      const budget = await store.budget(agentKey);
      const left = Number(budget?.remainingCents ?? 0) - heldFor(agentKey) - owedFor(agentKey);
      return left >= reserve ? { admitted: true, remaining: left, release: hold(agentKey, reserve) } : { admitted: false, remaining: left };
    });
    const remaining = admission.remaining;
    if (!admission.admitted) {
      try {
        const runId = await store.startRun(task.id, model, spec.promptVersion);
        await store.finishRun(runId, 'budget_exhausted', {}, 'Today\'s budget does not cover this call, so it was not made.', null);
      } catch { log(JSON.stringify({ event: 'hub_agent_run_unrecorded', agent: agentKey, kind: task.kind })); }
      return { outcome: 'budget_exhausted', neededCents: reserve, remainingCents: Math.max(remaining, 0) };
    }
    const { release } = admission;
    let runId = null;
    let finished = false;
    const finish = async (outcome, usage, summary, errorCode = null) => {
      if (finished || runId === null) return;
      finished = true;
      try { await store.finishRun(runId, outcome, usage, summary, errorCode); } catch {
        // Not booked. The cost stays against the budget (and the write is retried) until the database has it.
        owed.set(agentKey, [...(owed.get(agentKey) ?? []), { runId, outcome, usage, summary, errorCode }]);
        log(JSON.stringify({ event: 'hub_agent_run_unrecorded', agent: agentKey, kind: task.kind }));
      }
    };

    try {
      runId = await store.startRun(task.id, model, spec.promptVersion);
      const deadline = AbortSignal.timeout(callDeadlineMs);
      const startedAt = Date.now();
      let reply = null;
      let failure = null;
      try {
        reply = await client.create(body, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      } catch (error) {
        failure = classify(error);
        // Fixed fields and the provider's request id only: never the message, which can quote the request.
        log(JSON.stringify({ event: 'hub_agent_model_error', agent: agentKey, kind: task.kind, code: failure.code, status: failure.status, request_id: failure.requestId }));
      }
      const latencyMs = Date.now() - startedAt;

      if (failure) {
        // An HTTP status means the provider answered and did not process the call. Anything else (a timeout, an abort, a dropped
        // connection) leaves its outcome unknown, so it is booked at its input estimate.
        const cost = failure.status === null ? inputOnlyCents(model, inputBound) : 0;
        await finish(failure.code === 'run_aborted' ? 'cancelled' : 'failed', { rounds: 1, costCents: cost }, `The model call failed (${failure.code.replaceAll('_', ' ')}).`, failure.code);
        await afterwards({ task, model, outcome: 'failed', usage: null, latencyMs, failure });
        throw aiError(failure.code, failure.transient, { status: failure.status });
      }

      try {
        const usage = usageOf(reply.message);
        // A response with no usable usage figures is booked at the reserve, the most the call could have cost.
        const cost = usage.reported ? costCents(model, usage) : reserve;
        const verdict = interpret(reply.message, spec);
        await finish(verdict.outcome, {
          rounds: 1, toolCalls: 0, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, costCents: cost,
        }, verdict.summary, verdict.errorCode ?? null);
        await afterwards({ task, model, outcome: verdict.outcome, usage, latencyMs, failure: null });
        if (verdict.outcome === 'no_result') throw aiError(verdict.errorCode, false);
        return {
          outcome: verdict.outcome, model, runId, requestId: reply.requestId, costCents: cost, output: verdict.output ?? null,
          usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens },
        };
      } catch (error) {
        if (ours.has(error?.code)) throw error;
        // A bug, not a provider answer. Its message can quote what it was handling, so only its class is logged and a fixed error goes up.
        log(JSON.stringify({ event: 'hub_agent_model_unexpected', agent: agentKey, kind: task.kind, name: String(error?.name ?? 'Error').slice(0, 40) }));
        throw aiError('ai_error', false);
      }
    } finally {
      // Normally closed above. Reaching here unclosed means something unexpected threw after the call started.
      await finish('failed', { rounds: 1, costCents: inputOnlyCents(model, inputBound) }, 'The run ended unexpectedly.', 'ai_error');
      await release();
    }
  }

  return { run, reserved: heldFor, owing: owedFor, configured: client.configured };
}
