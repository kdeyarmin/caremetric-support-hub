import { describe, expect, it, vi } from 'vitest';
import { normalizeAiUsage, sqlAiUsageRecorder } from './ai-usage.mjs';

const caseId = '44444444-4444-4444-8444-444444444444';

describe('AI usage ledger recorder', () => {
  it('records one row per call through the Hub server operation with provenance only', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ record_ai_usage: '55555555-5555-4555-8555-555555555555' }] })) };
    await sqlAiUsageRecorder(pool).record({ caseId, actor: 'automation', feature: 'automation_attempt', model: 'claude-sonnet-5-5', outcome: 'completed', inputTokens: 1200, outputTokens: 300, latencyMs: 4200 });
    expect(pool.query).toHaveBeenCalledWith('select private.record_ai_usage($1,$2,$3,$4,$5,$6,$7,$8)',
      [caseId, 'automation', 'automation_attempt', 'claude-sonnet-5-5', 'completed', 1200, 300, 4200]);
  });

  it('never fails or blocks the caller when the ledger is unavailable, and logs no content or error detail', async () => {
    const log = vi.fn();
    const pool = { query: vi.fn(async () => { throw new Error('relation private.ai_usage does not exist at db-host.internal'); }) };
    await expect(sqlAiUsageRecorder(pool, { log }).record({ actor: 'staff', feature: 'case_summary', model: 'claude-haiku-5-5', outcome: 'completed' })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(JSON.stringify({ event: 'hub_ai_usage_not_recorded', feature: 'case_summary', actor: 'staff' }));
  });

  it('shapes malformed fields into safe values instead of dropping the row', () => {
    expect(normalizeAiUsage({ caseId: 'not-a-uuid', actor: 'visitor', feature: 'Case Summary!', model: 'Claude/Opus 5.5', outcome: 'maybe', inputTokens: -1, outputTokens: 2.5, latencyMs: 10 }))
      .toEqual({ caseId: null, actor: 'staff', feature: 'casesummary', model: 'claudeopus5.5', outcome: 'completed', inputTokens: null, outputTokens: null, latencyMs: 10 });
    expect(normalizeAiUsage({ caseId: caseId.toUpperCase(), actor: 'automation', feature: 'automation_attempt', model: 'claude-sonnet-5-5', outcome: 'failed' }))
      .toEqual({ caseId, actor: 'automation', feature: 'automation_attempt', model: 'claude-sonnet-5-5', outcome: 'failed', inputTokens: null, outputTokens: null, latencyMs: null });
    expect(normalizeAiUsage({}).feature).toBe('unknown');
    expect(normalizeAiUsage({}).model).toBe('unknown');
  });
});
