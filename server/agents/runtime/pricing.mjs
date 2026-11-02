/**
 * What a model call costs. The AI team's daily budgets are in cents, and the cost of a run is
 * written to the database only when the run ends, so this module has two jobs: price what a call
 * actually used, and price the worst case before it is made (the reservation the budget check
 * holds while the call is in flight).
 *
 * Prices are US dollars per million tokens, from the published Claude 5.5 price list. A model
 * that is not in the table is refused, so changing a tier in `aiModels` without pricing it stops
 * the agents instead of letting them spend unmetered (a test holds the two together).
 *
 * Anthropic reports a call's prompt in three parts: `input_tokens` (not cached), the tokens read
 * from the cache and the tokens written to it. The first is billed at the input price, a cache
 * read at its own lower price and a five-minute cache write at 1.25 times the input price (the
 * one-hour kind, which this server never asks for, at twice). Haiku 5.5 is priced higher for the
 * whole call when the prompt, all three parts together, is over 100,000 tokens.
 */
import { aiModels } from '../../ai-assistance.mjs';
import { aiError } from './errors.mjs';

const rate = (input, output, cacheRead) => Object.freeze({ input, output, cacheRead });

export const prices = Object.freeze({
  [aiModels.fast]: Object.freeze({ short: rate(0.10, 0.50, 0.01), long: rate(0.50, 2.50, 0.05), longAbove: 100_000 }),
  [aiModels.draft]: Object.freeze({ short: rate(2, 10, 0.20) }),
  [aiModels.quality]: Object.freeze({ short: rate(4, 20, 0.20) }),
});

/**
 * A rough upper bound on tokens from characters. The newer tokenizer counts about three characters
 * to a token for English, and text with many numbers or symbols runs denser, so 2.5 over-counts on
 * purpose: a reservation that is too large only delays a call, one that is too small overspends.
 */
export const charsPerToken = 2.5;
export const estimateTokens = chars => Math.ceil(Math.max(Number(chars) || 0, 0) / charsPerToken);

const count = value => (Number.isFinite(value) && value > 0 ? value : 0);
const centsPerDollarPerMillion = 1 / 10_000;

function entryFor(model) {
  const entry = prices[model];
  if (!entry) throw aiError('unknown_model');
  return entry;
}

/**
 * Cents for a call that used `usage`. The result is rounded up at the fourth decimal (the database
 * keeps four), so a run is never recorded as cheaper than it was.
 */
export function costCents(model, usage = {}) {
  const entry = entryFor(model);
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  const cacheRead = count(usage.cacheReadTokens);
  const cacheWrite = count(usage.cacheWriteTokens);
  const oneHour = Math.min(count(usage.cacheWriteOneHourTokens), cacheWrite);
  const prompt = input + cacheRead + cacheWrite;
  const price = entry.long && prompt > entry.longAbove ? entry.long : entry.short;
  const cents = (input * price.input + output * price.output + cacheRead * price.cacheRead
    + (cacheWrite - oneHour) * price.input * 1.25 + oneHour * price.input * 2) * centsPerDollarPerMillion;
  // toFixed first, so floating point noise (0.30000000000000004) cannot round a whole amount up.
  return Math.ceil(Number((cents * 10_000).toFixed(6))) / 10_000;
}

/**
 * The most a call could cost: every input character taken as a token at the cache-write price
 * when the request asks for a cache breakpoint (the first call after a deploy writes the cache),
 * and every output token up to `maxTokens`.
 */
export function worstCaseCents(model, { inputChars, maxTokens, cached = false }) {
  const tokens = estimateTokens(inputChars);
  return costCents(model, { inputTokens: cached ? 0 : tokens, cacheWriteTokens: cached ? tokens : 0, outputTokens: maxTokens });
}

/** What a call whose outcome is unknown (a timeout, an abort, a dropped connection) is booked at: its input, as if it had been read. */
export const inputOnlyCents = (model, inputChars) => costCents(model, { inputTokens: estimateTokens(inputChars) });
