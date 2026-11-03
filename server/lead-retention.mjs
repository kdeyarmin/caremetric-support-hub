import { transaction } from './sms-auth.mjs';

/**
 * Website lead retention (docs/LEAD_INTAKE.md, "Retention"). The database deletes a lead twelve months after the Hub
 * received it, and a website conversation (Advisors, CareBase or Intel) twelve months after its last message, in
 * bounded batches: private.lead_retention, which only hub_app_server may run. This module decides when. The server's
 * fifteen-minute cleanup calls `tick()`; a run happens only while the database declares support.leads.v1, at most once
 * every six hours per process, in up to ten batches while the database reports that more are due. Only counts are
 * logged. A run that fails logs one fixed line and is tried again at the next cleanup.
 */
export const leadRetentionIntervalMs = 6 * 60 * 60 * 1000;
export const leadRetentionBatchSize = 500;
export const leadRetentionMaxBatches = 10;

export function sqlLeadRetentionStore(pool) {
  return {
    batch: limit => transaction(pool, async db =>
      (await db.query('select private.lead_retention($1) as result', [limit])).rows[0].result),
  };
}

const isCount = value => Number.isSafeInteger(value) && value >= 0;
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function leadRetention({ pool, store = sqlLeadRetentionStore(pool), enabled = false, now = () => Date.now(),
  intervalMs = leadRetentionIntervalMs, batchSize = leadRetentionBatchSize, maxBatches = leadRetentionMaxBatches,
  log = line => console.info(line), warn = line => console.warn(line) }) {
  let lastStarted = null;
  let running = false;
  return {
    enabled: () => enabled,
    /** Runs when due. Resolves to the run's totals, or null when nothing ran or the run failed; never throws. */
    async tick() {
      if (!enabled || running) return null;
      const started = now();
      if (lastStarted !== null && started - lastStarted < intervalMs) return null;
      running = true;
      try {
        let leads = 0, conversations = 0, more = true, batches = 0;
        while (more && batches < maxBatches) {
          const result = await store.batch(batchSize);
          if (!result || !isCount(result.leads) || !isCount(result.conversations) || typeof result.more !== 'boolean') {
            throw new Error('Unexpected lead retention result.');
          }
          leads += result.leads;
          conversations += result.conversations;
          more = result.more;
          batches += 1;
        }
        // Only a run that completed counts toward the six hours; a failed one is tried again at the next cleanup.
        lastStarted = started;
        if (leads > 0 || conversations > 0) {
          log(`Lead retention: deleted ${plural(leads, 'lead')} and ${plural(conversations, 'website conversation')}${more ? '; more are due at the next run' : ''}.`);
        }
        return { leads, conversations, more, batches };
      } catch {
        // The error itself is never logged: it could quote a value from the database.
        warn('Lead retention could not complete; it will retry.');
        return null;
      } finally {
        running = false;
      }
    },
  };
}
