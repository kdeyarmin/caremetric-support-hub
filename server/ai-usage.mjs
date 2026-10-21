// The AI usage ledger: one row per Anthropic call, written through the Hub server
// role (private.record_ai_usage, migration 20261021120000). The ledger carries
// provenance only — feature, model, outcome, token counts and latency — and the
// database attributes the row to the application and customer tenant from the
// case id. Recording never delays or fails the AI action it describes.

export const aiUsageActors = Object.freeze(['staff', 'automation']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Shape one ledger row; anything malformed becomes null or a safe default so a row is never lost to a bad field. */
export function normalizeAiUsage({ caseId = null, actor, feature, model, outcome, inputTokens = null, outputTokens = null, latencyMs = null } = {}) {
  return {
    caseId: typeof caseId === 'string' && uuid.test(caseId) ? caseId.toLowerCase() : null,
    actor: actor === 'automation' ? 'automation' : 'staff',
    feature: String(feature ?? '').toLowerCase().replace(/[^a-z_]/g, '').slice(0, 60) || 'unknown',
    model: String(model ?? '').toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 80) || 'unknown',
    outcome: outcome === 'failed' ? 'failed' : 'completed',
    inputTokens: count(inputTokens),
    outputTokens: count(outputTokens),
    latencyMs: count(latencyMs),
  };
}

export function sqlAiUsageRecorder(pool, { log = (line) => console.warn(line) } = {}) {
  return {
    async record(entry) {
      const row = normalizeAiUsage(entry);
      try {
        await pool.query('select private.record_ai_usage($1,$2,$3,$4,$5,$6,$7,$8)',
          [row.caseId, row.actor, row.feature, row.model, row.outcome, row.inputTokens, row.outputTokens, row.latencyMs]);
      } catch {
        // A missed row is logged by feature only; no content, no error body (it could name the database).
        log(JSON.stringify({ event: 'hub_ai_usage_not_recorded', feature: row.feature, actor: row.actor }));
      }
    },
  };
}
