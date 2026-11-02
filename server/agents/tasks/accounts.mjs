/**
 * `accounts.weekly`: the Account Manager's report. It reads one snapshot of the Hub's own billing mirror, the applications' usage
 * reports and the support cases (a server-only database operation that returns no contact address), scores each account, and emails
 * the owner who needs attention. It uses no model, reads no product's data (so it needs no owner session) and sends nothing to a
 * customer.
 *
 * The schedule fires every morning. Every run in an Eastern week uses the same alert key, so the first one sends and a later one
 * finds the report already sent and does nothing: a server that was down on Monday still reports on the next run. A delivery that
 * failed is retried on a later day (the notifier retries a failed alert up to three times); a week whose email was switched off
 * (suppressed) is not sent again by itself, and "Run now" sends it. A run the owner asks for always reports, under a key of its own.
 *
 * What is kept: the task result and the run summary carry counts only, and so do the alert's subject and stored body. Account names
 * and amounts travel in the email's blocks, which the notifier never stores.
 */
import { composeAccountsReport } from '../accounts/report.mjs';
import { weekStart } from '../accounts/week.mjs';
import { recordRun } from './shared.mjs';

export const accountsFeature = 'platform.agents.accounts.v1';
const snapshotLimit = 200;

const declared = features => (features instanceof Set ? features.has(accountsFeature) : Array.isArray(features) && features.includes(accountsFeature));

/** Registered only when the database declares the feature, so a Hub whose database lacks the migration still starts and the schedule stays due. */
export function accountsHandlers({ store, notifier, publicOrigin, features = null, log = line => console.warn(line) }) {
  if (!declared(features)) return {};

  async function weekly(task, { now = () => new Date() } = {}) {
    const moment = now();
    const week = weekStart(moment);
    const asked = task.sourceKind === 'owner';
    const snapshot = await store.accountsSnapshot({ limit: snapshotLimit });
    const report = composeAccountsReport({ snapshot, now: moment, publicOrigin });
    if (report.result.accounts === 0) return { result: { skipped: 'no_accounts', week } };

    const results = await notifier.send({
      severity: 'info', subject: report.subject, body: report.body, blocks: report.blocks,
      dedupeKey: asked ? `accounts:run:${task.id}` : `accounts:weekly:${week}`, agentKey: task.agentKey, taskId: task.id,
    });
    if (!asked && results.every(item => item.delivery === 'duplicate')) return { result: { skipped: 'already_sent', week } };

    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    const reached = results.some(item => item.delivery === 'sent' || item.delivery === 'duplicate');
    await recordRun({ store, log }, task, {
      promptVersion: 'accounts.1',
      summary: reached ? `Sent the weekly accounts report: ${report.body}` : `The weekly accounts report was written but not delivered (${delivery.join(', ')}).`,
      outcome: reached ? 'completed' : 'failed', errorCode: reached ? null : 'not_delivered',
    });
    return { result: { week, delivery, ...report.result } };
  }

  return { 'accounts.weekly': weekly };
}
