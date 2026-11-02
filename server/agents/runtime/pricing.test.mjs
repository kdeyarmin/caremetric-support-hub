import { describe, expect, it } from 'vitest';
import { aiModels } from '../../ai-assistance.mjs';
import { charsPerToken, costCents, estimateTokens, inputOnlyCents, prices, worstCaseCents } from './pricing.mjs';

const { fast, draft, quality } = aiModels;

describe('model prices', () => {
  it('has a price for every model the AI tiers can name, so an unpriced model cannot run', () => {
    for (const model of Object.values(aiModels)) expect(prices[model], model).toBeDefined();
    expect(Object.keys(prices).sort()).toEqual(Object.values(aiModels).sort());
  });

  it('is keyed by the model ids themselves, so pointing a tier at a new model cannot inherit the old model\'s rates', () => {
    // If the keys followed `aiModels`, a new model name would arrive already priced (at the old rates) and the test above would still pass.
    expect(Object.keys(prices).sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(prices['claude-sonnet-5-5'].short).toMatchObject({ input: 2, output: 10 });
    expect(() => costCents('claude-sonnet-5-6', { inputTokens: 1 })).toThrow(expect.objectContaining({ code: 'unknown_model' }));
  });

  it('prices input and output per million tokens, in cents', () => {
    // $2 and $10 per million: 1,000 in is 0.2 cents, 500 out is 0.5 cents.
    expect(costCents(draft, { inputTokens: 1000, outputTokens: 500 })).toBe(0.7);
    expect(costCents(quality, { inputTokens: 1000, outputTokens: 500 })).toBe(1.4);
    expect(costCents(fast, { inputTokens: 1000, outputTokens: 500 })).toBe(0.035);
    expect(costCents(draft, {})).toBe(0);
    expect(costCents(draft)).toBe(0);
  });

  it('prices cache reads below input and five-minute cache writes at 1.25 times input', () => {
    expect(costCents(draft, { cacheReadTokens: 10_000 })).toBe(0.2);
    expect(costCents(quality, { cacheReadTokens: 10_000 })).toBe(0.2);
    expect(costCents(fast, { cacheReadTokens: 10_000 })).toBe(0.01);
    expect(costCents(draft, { cacheWriteTokens: 4000 })).toBe(1);
    // One-hour writes cost twice the input price: 3,000 at 1.25x and 1,000 at 2x.
    expect(costCents(draft, { cacheWriteTokens: 4000, cacheWriteOneHourTokens: 1000 })).toBe(1.15);
    expect(costCents(draft, { cacheWriteTokens: 4000, cacheWriteOneHourTokens: 9000 })).toBe(1.6);
  });

  it('charges Haiku the higher rates for the whole call when the prompt is over 100,000 tokens', () => {
    expect(costCents(fast, { inputTokens: 100_000 })).toBe(1);
    // 100,001 tokens: $0.50 per million applies to all of them, not only the excess.
    expect(costCents(fast, { inputTokens: 100_001 })).toBe(5.0001);
    expect(costCents(fast, { inputTokens: 100_001, outputTokens: 1000 })).toBe(5.2501);
    // The prompt is input, cache reads and cache writes together.
    expect(costCents(fast, { inputTokens: 50_000, cacheReadTokens: 50_001 })).toBe(2.7501);
    // The other models have one rate at any size.
    expect(costCents(draft, { inputTokens: 500_000 })).toBe(100);
  });

  it('rounds up at the fourth decimal and never lets floating point noise add a step', () => {
    expect(costCents(fast, { inputTokens: 1 })).toBe(0.0001);
    expect(costCents(draft, { inputTokens: 5000 })).toBe(1);
    expect(costCents(draft, { inputTokens: 3, outputTokens: 3 })).toBe(0.0036);
    expect(costCents(fast, { inputTokens: 3, outputTokens: 7 })).toBe(0.0004);
  });

  it('ignores negative, fractional and non-numeric token counts instead of lowering a cost', () => {
    expect(costCents(draft, { inputTokens: -5000, outputTokens: Number.NaN, cacheReadTokens: 'many' })).toBe(0);
    expect(costCents(draft, { inputTokens: 1000, cacheWriteOneHourTokens: 5 })).toBe(0.2);
  });

  it('refuses a model it has no price for', () => {
    expect(() => costCents('claude-unpriced-9', { inputTokens: 1 })).toThrow(expect.objectContaining({ code: 'unknown_model', transient: false }));
    expect(() => worstCaseCents('nope', { inputTokens: 10, maxTokens: 10 })).toThrow(expect.objectContaining({ code: 'unknown_model' }));
  });
});

describe('the worst case a call is reserved at', () => {
  it('estimates tokens from characters at two and a half to a token, rounding up (a size guide, never what a call is admitted against)', () => {
    expect(charsPerToken).toBe(2.5);
    expect(estimateTokens(10)).toBe(4);
    expect(estimateTokens(11)).toBe(5);
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-3)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('adds the input at the cache-write rate when a breakpoint is requested, and every output token', () => {
    // 4,800 input tokens are 1.2 cents written to the cache, plus 3,000 output tokens at $10 per million.
    expect(worstCaseCents(draft, { inputTokens: 4_800, maxTokens: 3000, cached: true })).toBe(4.2);
    expect(worstCaseCents(draft, { inputTokens: 4_800, maxTokens: 3000 })).toBe(3.96);
    expect(worstCaseCents(fast, { inputTokens: 4_800, maxTokens: 3000, cached: true })).toBe(0.21);
  });

  it('prices a prompt bound that crosses Haiku\'s long-prompt threshold at the long rate, so the reserve cannot be too low', () => {
    // 100,000 tokens at $0.10 per million are 1 cent and 1,000 output tokens at $0.50 are 0.05 cents; one token more and the whole call is
    // at $0.50 and $2.50: 5.00005 + 0.25 cents, rounded up at the fourth decimal.
    expect(worstCaseCents(fast, { inputTokens: 100_000, maxTokens: 1000 })).toBe(1.05);
    expect(worstCaseCents(fast, { inputTokens: 100_001, maxTokens: 1000 })).toBe(5.2501);
  });

  it('books a call with an unknown outcome at its input estimate only', () => {
    expect(inputOnlyCents(draft, 4_800)).toBe(0.96);
    expect(inputOnlyCents(draft, 0)).toBe(0);
  });
});
