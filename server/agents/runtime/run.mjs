/**
 * One model run for one agent task: check the budget, make one call, price what it used, close
 * the run row, write the usage ledger, and hand back the validated answer. Every rule that
 * matters is enforced here in code; the model only ever returns one structured object, and the
 * calling handler decides what that is allowed to cause.
 *
 * `run` makes one call per run and offers no tools. A model that stops to ask for a tool, or for any
 * reason other than finishing, has produced no usable result.
 *
 * `research` is the one run with tools: Anthropic's server-side web search and web fetch (tools.mjs),
 * only those the agent's own tool allowlist names. It reserves the caller's ceiling for the whole run,
 * continues a turn the server paused (`pause_turn`) by sending it back unchanged, up to a number of
 * rounds, and starts no round whose worst case would pass the ceiling. Its answer is free text and the
 * addresses the tools returned; a caller that needs a structured answer makes an ordinary `run` from
 * them. One run row is booked with the real rounds, tool calls, tokens and search fees. (The loop is
 * written by hand rather than handed to the SDK's tool runner because the Hub keeps its own budget,
 * deadline and accounting between calls.)
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
import { costCents, inputOnlyCents, prices, searchCents, worstCaseCents } from './pricing.mjs';
import { researchToolNames, serverTools, sourcesOf } from './tools.mjs';
import { schemaDefects, schemaProblems } from './schema.mjs';

const versionPattern = /^[a-z0-9.-]{1,20}$/;
const efforts = new Set(['low', 'medium', 'high']);
// A request may name a tier for one call (the Creative Director writes concepts on quality and variants on draft); otherwise the agent's own.
const tiers = new Set(['fast', 'draft', 'quality']);
const reasonPattern = /^[a-z_]{1,40}$/;
const maxTokensCeiling = 8000;
const configurationAlerts = {
  ai_auth_failed: { subject: 'The AI team\'s model key was refused', body: 'Anthropic refused the API key (HTTP 401). Check ANTHROPIC_API_KEY on the Hub service. Work that needs the model is waiting and will be retried.' },
  ai_not_permitted: { subject: 'The AI team\'s model account is not permitted', body: 'Anthropic refused the request for permission reasons (HTTP 403). Check the account\'s access and billing. Work that needs the model is waiting and will be retried.' },
  model_not_found: { subject: 'The AI team asked for a model Anthropic does not know', body: 'Anthropic does not recognise the model for this agent\'s tier. A model name in the Hub is out of date.' },
};
const easternDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const ours = new Set([...transientCodes, ...permanentCodes]);
// How many times a closing write that keeps failing is tried again, one try per later call, before the debt is given up.
const writeAttempts = 5;

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
  const { promptVersion, system, user, schema, maxTokens = 3000, effort = 'medium', tier = null, timeoutMs = null } = request ?? {};
  if (typeof promptVersion !== 'string' || !versionPattern.test(promptVersion)) reject();
  if (!Array.isArray(system) || system.length === 0 || system.length > 4) reject();
  if (system.some(block => typeof block?.text !== 'string' || block.text.length === 0)) reject();
  if (typeof user !== 'string' || user.length === 0) reject();
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > maxTokensCeiling) reject();
  if (!efforts.has(effort)) reject();
  if (schemaDefects(schema).length > 0) reject();
  if (tier !== null && !tiers.has(tier)) reject();
  // A longer wait for one call (an account brief or a first email on the quality tier), never past the run's own deadline.
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 180_000)) reject();
  return { ...request, maxTokens, effort, tier, timeoutMs };
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

/** A research request, checked: only the tools the agent's allowlist names, and caps on every tool, round and cent. */
function checkResearch(request, agent) {
  const reject = () => { throw aiError('request_rejected'); };
  const { promptVersion, system, user, tools, maxSearches = 5, maxFetches = 3, maxRounds = 3, maxTokens = 4000, effort = 'medium', tier = null, ceilingCents } = request ?? {};
  if (typeof promptVersion !== 'string' || !versionPattern.test(promptVersion)) reject();
  if (!Array.isArray(system) || system.length === 0 || system.length > 4 || system.some(block => typeof block?.text !== 'string' || !block.text)) reject();
  if (typeof user !== 'string' || !user) reject();
  if (!Array.isArray(tools) || !tools.length || tools.some(name => !researchToolNames.includes(name))) reject();
  const allowed = Array.isArray(agent?.toolAllowlist) ? agent.toolAllowlist : [];
  if (tools.some(name => !allowed.includes(name))) throw aiError('tool_not_allowed');
  if (![maxSearches, maxFetches, maxRounds, maxTokens].every(Number.isInteger) || maxSearches < 1 || maxSearches > 10 || maxFetches < 0 || maxFetches > 10
    || maxRounds < 1 || maxRounds > 5 || maxTokens < 1 || maxTokens > maxTokensCeiling) reject();
  if (!Number.isFinite(ceilingCents) || ceilingCents <= 0 || ceilingCents > 500) reject();
  if (!efforts.has(effort) || (tier !== null && !tiers.has(tier))) reject();
  return { ...request, tools: [...new Set(tools)], maxSearches, maxFetches, maxRounds, maxTokens, effort, tier, ceilingCents };
}

// The fewest output tokens a research round is worth making with: below this the model cannot both search and write down what it found.
export const minResearchRoundTokens = 1024;

/**
 * What one research round may use so that the most it could cost (its prompt bound, every output token, every search it may make) fits
 * in `leftCents`: the full caps when they fit, otherwise fewer output tokens (down to `minResearchRoundTokens`), and fewer searches
 * (down to one) only when that floor leaves too little for them. Null when even that does not fit, so no round, the first included, can
 * take the run past its ceiling.
 */
export function fitResearchRound(model, spec, inputTokens, leftCents, lockedSearches = null) {
  const cached = spec.system.some(block => block.cache);
  const searching = spec.tools.includes('web_search');
  const worst = (maxTokens, searches) => worstCaseCents(model, { inputTokens, maxTokens, cached }) + searches * searchCents;
  // After the first round the tool definitions are fixed (lockedSearches): a later round may only ask for fewer output tokens. Changing
  // a tool's max_uses mid-conversation would change the request's prefix, so the cached system prompt and the conversation's earlier
  // turns would be read again at full price, and models that bind thinking to the tool list could refuse the turn.
  const wanted = searching ? (Number.isInteger(lockedSearches) ? lockedSearches : spec.maxSearches) : 0;
  if (worst(spec.maxTokens, wanted) <= leftCents) return { maxTokens: spec.maxTokens, searches: wanted, worst: worst(spec.maxTokens, wanted) };
  const floor = Math.min(spec.maxTokens, minResearchRoundTokens);
  const searches = searching ? (Number.isInteger(lockedSearches) ? lockedSearches : Math.min(wanted, Math.floor((leftCents - worst(floor, 0)) / searchCents))) : 0;
  if ((searching && searches < 1) || worst(floor, searches) > leftCents) return null;
  let low = floor, high = spec.maxTokens;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (worst(middle, searches) <= leftCents) low = middle; else high = middle - 1;
  }
  return { maxTokens: low, searches, worst: worst(low, searches) };
}

const serverCounts = message => {
  const used = message?.usage?.server_tool_use;
  return { searches: count(used?.web_search_requests), fetches: count(used?.web_fetch_requests) };
};

export function modelRunner({
  client, store, record = null, notifier = null, models = aiModels, log = line => console.warn(line), now = () => new Date(), callDeadlineMs = 200_000,
}) {
  // Cents reserved by calls in flight in this process, per agent. The database only learns a call's cost when its run is closed.
  const held = new Map();
  const heldFor = agentKey => held.get(agentKey) ?? 0;
  // Costs whose run could not be closed (the write failed): still owed to the budget, retried at the next admission. Each belongs to the
  // Eastern day its run started, which is the day the database counts it in, so only today's count against today's money; a write that keeps
  // failing is given up after a few tries, because nothing else would ever clear it.
  const owed = new Map();
  const today = () => easternDate.format(now());
  const owedFor = agentKey => (owed.get(agentKey) ?? []).filter(debt => !debt.booked && debt.day === today()).reduce((total, debt) => total + (Number(debt.usage?.costCents) || 0), 0);
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
    const list = [...(owed.get(agentKey) ?? [])];
    if (!list.length) return;
    const done = new Set();
    for (const debt of list) {
      if (!debt.booked) {
        try {
          await store.finishRun(debt.runId, debt.outcome, debt.usage, debt.summary, debt.errorCode);
          debt.booked = true;
        } catch (error) {
          debt.tries += 1;
          if (error?.code === 'P0002') debt.booked = true;
          else if (debt.tries >= writeAttempts) {
            done.add(debt);
            log(JSON.stringify({ event: 'hub_agent_run_unbooked_dropped', agent: agentKey, run_id: debt.runId }));
          }
        }
      }
      if (debt.booked) {
        // The persisted reservation is retained until the cost is known to be booked. A failed release is retried
        // without writing the cost twice; other replicas continue counting the reservation in the meantime.
        try {
          if (debt.reservation) await store.releaseBudget(debt.reservation);
          done.add(debt);
        } catch { /* keep the confirmed booking's release pending */ }
      }
    }
    // A call that is still in flight can add a debt while a write above is waiting, so the list is read again: only what was settled goes.
    const current = (owed.get(agentKey) ?? []).filter(debt => !done.has(debt));
    if (current.length) owed.set(agentKey, current); else owed.delete(agentKey);
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
   * request: { promptVersion, system: [{ text, cache? }], user, schema, maxTokens?, effort?, tier?, validate?, describe? }
   * `tier` (fast, draft or quality) picks the model for this call instead of the agent's own tier; the budget is the agent's either way.
   * `validate(output)` returns nothing when the answer is acceptable, or a short lowercase reason
   * when it is not. `describe(output)` returns the run's summary: counts and enums, never text.
   */
  async function run(task, request, { signal } = {}) {
    const agentKey = task.agentKey;
    const spec = checkRequest(request);
    const model = models[spec.tier ?? task.agent?.modelTier];
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
    let reservation = null;
    if (store.reserveBudget) {
      try { reservation = await store.reserveBudget(task.id, reserve); }
      catch (error) { await release(); throw error; }
      if (!reservation) { await release(); return {outcome:'budget_exhausted',neededCents:reserve,remainingCents:0}; }
    }
    let booked = false;
    const budgetDay = today();
    let runId = null;
    let finished = false;
    const finish = async (outcome, usage, summary, errorCode = null) => {
      if (finished || runId === null) return;
      finished = true;
      try { await store.finishRun(runId, outcome, usage, summary, errorCode); booked = true; } catch {
        // Not booked. The cost stays against the budget (and the write is retried) until the database has it.
        owed.set(agentKey, [...(owed.get(agentKey) ?? []), { runId, outcome, usage, summary, errorCode, day: budgetDay, tries: 0, reservation, booked: false }]);
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
        reply = await client.create(body, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}) });
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
      if (reservation && (booked || runId === null)) {
        try { await store.releaseBudget(reservation); }
        catch { owed.set(agentKey, [...(owed.get(agentKey) ?? []), { runId, reservation, day: budgetDay, booked: true }]); }
      }
      await release();
    }
  }

  /**
   * One research run with server tools. Resolves with `{ outcome: 'completed', text, sources, searches, fetches, rounds, costCents }`,
   * `{ outcome: 'stopped', ... }` when the rounds or the ceiling ran out before the model finished (the sources it found and the text it
   * wrote so far are kept; a ceiling too small for even a trimmed first round makes no call), `text` being every response's text in order,
   * `{ outcome: 'refused' }`, or `{ outcome: 'budget_exhausted' }`. Rejects with a coded error otherwise, `tool_not_allowed` when the
   * agent's allowlist does not name a tool.
   *
   * request: { promptVersion, system: [{ text, cache? }], user, tools: ['web_search', 'web_fetch'], maxSearches?, maxFetches?, maxRounds?,
   *   maxTokens?, effort?, tier?, ceilingCents, describe? } — `describe({ searches, fetches, sources })` returns the summary (counts only).
   */
  async function research(task, request, { signal } = {}) {
    const agentKey = task.agentKey;
    const spec = checkResearch(request, task.agent);
    const model = models[spec.tier ?? task.agent?.modelTier];
    if (!model || !prices[model]) throw aiError('unknown_model');
    if (!client.configured) throw aiError('ai_not_configured');
    if (signal?.aborted) throw aiError('run_aborted', true);
    const tools = serverTools(model, spec);
    const system = spec.system.map(block => ({ type: 'text', text: block.text, ...(block.cache ? { cache_control: { type: 'ephemeral' } } : {}) }));
    const messages = [{ role: 'user', content: spec.user }];
    // A round trimmed to fit the ceiling asks for fewer output tokens and searches; the full caps keep the cached tool definitions as they are.
    const bodyNow = (fit = { maxTokens: spec.maxTokens, searches: spec.maxSearches }) => ({
      model, max_tokens: fit.maxTokens, system, messages,
      tools: fit.searches === spec.maxSearches ? tools : serverTools(model, { ...spec, maxSearches: Math.max(fit.searches, 1) }),
      output_config: { effort: spec.effort },
    });
    const reserve = Math.ceil(spec.ceilingCents);
    const admission = await exclusive(agentKey, async () => {
      await settleOwed(agentKey);
      const budget = await store.budget(agentKey);
      const left = Number(budget?.remainingCents ?? 0) - heldFor(agentKey) - owedFor(agentKey);
      return left >= reserve ? { admitted: true, release: hold(agentKey, reserve) } : { admitted: false, remaining: left };
    });
    if (!admission.admitted) {
      try {
        const runId = await store.startRun(task.id, model, spec.promptVersion);
        await store.finishRun(runId, 'budget_exhausted', {}, 'Today\'s budget does not cover this research, so it was not started.', null);
      } catch { log(JSON.stringify({ event: 'hub_agent_run_unrecorded', agent: agentKey, kind: task.kind })); }
      return { outcome: 'budget_exhausted', neededCents: reserve, remainingCents: Math.max(admission.remaining, 0) };
    }
    let reservation = null;
    if (store.reserveBudget) {
      try { reservation = await store.reserveBudget(task.id, reserve); }
      catch (error) { await admission.release(); throw error; }
      if (!reservation) { await admission.release(); return { outcome: 'budget_exhausted', neededCents: reserve, remainingCents: 0 }; }
    }
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0, fetches: 0, rounds: 0, cents: 0 };
    const sources = new Map();
    let runId = null, booked = false, finished = false;
    const budgetDay = today();
    const finish = async (outcome, summary, errorCode = null) => {
      if (finished || runId === null) return;
      finished = true;
      const usage = { rounds: Math.max(totals.rounds, 1), toolCalls: totals.searches + totals.fetches, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens, cacheWriteTokens: totals.cacheWriteTokens, costCents: Math.ceil(totals.cents * 10_000) / 10_000 };
      try { await store.finishRun(runId, outcome, usage, summary, errorCode); booked = true; } catch {
        owed.set(agentKey, [...(owed.get(agentKey) ?? []), { runId, outcome, usage, summary, errorCode, day: budgetDay, tries: 0, reservation, booked: false }]);
        log(JSON.stringify({ event: 'hub_agent_run_unrecorded', agent: agentKey, kind: task.kind }));
      }
    };
    const describe = () => {
      try { const text = spec.describe?.({ searches: totals.searches, fetches: totals.fetches, sources: sources.size }); if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 500); } catch { /* default */ }
      return `Researched with ${totals.searches} searches and ${totals.fetches} page reads over ${totals.rounds} rounds.`;
    };
    try {
      runId = await store.startRun(task.id, model, spec.promptVersion);
      const deadline = AbortSignal.timeout(callDeadlineMs);
      const startedAt = Date.now();
      let outcome = 'stopped', stopped = 'rounds';
      // The text of every response, paused ones included: a turn that pauses or stops at a limit keeps what it wrote so far.
      const written = [];
      // The search allowance the first round was sent with; every later round sends the same tool definitions.
      let lockedSearches = null;
      for (let round = 0; round < spec.maxRounds; round++) {
        // Every round, the first included, fits what the ceiling leaves (the bound of the untrimmed body is the larger one).
        const fit = fitResearchRound(model, spec, inputTokenBound(bodyNow()), spec.ceilingCents - totals.cents, lockedSearches);
        if (!fit) { stopped = 'ceiling'; break; }
        if (lockedSearches === null) lockedSearches = fit.searches;
        const body = bodyNow(fit);
        const worst = fit.worst;
        let reply = null, failure = null;
        try { reply = await client.create(body, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, timeoutMs: 150_000 }); }
        catch (error) {
          failure = classify(error);
          log(JSON.stringify({ event: 'hub_agent_model_error', agent: agentKey, kind: task.kind, code: failure.code, status: failure.status, request_id: failure.requestId }));
        }
        if (failure) {
          if (failure.status === null) totals.cents += inputOnlyCents(model, inputTokenBound(body));
          totals.rounds += 1;
          await finish(failure.code === 'run_aborted' ? 'cancelled' : 'failed', `The research call failed (${failure.code.replaceAll('_', ' ')}).`, failure.code);
          await afterwards({ task, model, outcome: 'failed', usage: null, latencyMs: Date.now() - startedAt, failure });
          throw aiError(failure.code, failure.transient, { status: failure.status });
        }
        totals.rounds += 1;
        const usage = usageOf(reply.message);
        const tools = serverCounts(reply.message);
        totals.inputTokens += usage.inputTokens; totals.outputTokens += usage.outputTokens;
        totals.cacheReadTokens += usage.cacheReadTokens; totals.cacheWriteTokens += usage.cacheWriteTokens;
        totals.searches += tools.searches; totals.fetches += tools.fetches;
        totals.cents += (usage.reported ? costCents(model, usage) : worst) + tools.searches * searchCents;
        for (const source of sourcesOf(reply.message?.content)) if (!sources.has(source.url)) sources.set(source.url, source);
        const stop = reply.message?.stop_reason;
        if (stop === 'pause_turn' || stop === 'end_turn') { const part = textOf(reply.message).trim(); if (part) written.push(part); }
        if (stop === 'pause_turn') { messages.push({ role: 'assistant', content: reply.message.content }); continue; }
        if (stop === 'end_turn') { outcome = 'completed'; stopped = null; break; }
        if (stop === 'refusal') { outcome = 'refused'; stopped = null; break; }
        outcome = 'no_result'; stopped = null;
        await finish('no_result', 'The research stopped before it finished.', stop === 'max_tokens' ? 'output_truncated' : 'output_invalid');
        await afterwards({ task, model, outcome: 'no_result', usage: totals, latencyMs: Date.now() - startedAt, failure: null });
        throw aiError(stop === 'max_tokens' ? 'output_truncated' : 'output_invalid', false);
      }
      const summary = outcome === 'refused' ? 'The model declined to research.' : `${describe()}${stopped ? ` Stopped: ${stopped === 'ceiling' ? 'the cost ceiling' : 'the round limit'}.` : ''}`;
      await finish(outcome === 'stopped' ? 'completed' : outcome, summary, null);
      await afterwards({ task, model, outcome, usage: totals, latencyMs: Date.now() - startedAt, failure: null });
      const text = outcome === 'refused' ? '' : written.join('\n\n');
      return { outcome, model, runId, text, sources: [...sources.values()], searches: totals.searches, fetches: totals.fetches, rounds: totals.rounds,
        costCents: Math.ceil(totals.cents * 10_000) / 10_000, ...(stopped ? { stopped } : {}) };
    } catch (error) {
      if (ours.has(error?.code)) throw error;
      log(JSON.stringify({ event: 'hub_agent_model_unexpected', agent: agentKey, kind: task.kind, name: String(error?.name ?? 'Error').slice(0, 40) }));
      throw aiError('ai_error', false);
    } finally {
      await finish('failed', 'The research ended unexpectedly.', 'ai_error');
      if (reservation && (booked || runId === null)) {
        try { await store.releaseBudget(reservation); }
        catch { owed.set(agentKey, [...(owed.get(agentKey) ?? []), { runId, reservation, day: budgetDay, booked: true }]); }
      }
      await admission.release();
    }
  }

  return { run, research, reserved: heldFor, owing: owedFor, configured: client.configured };
}
