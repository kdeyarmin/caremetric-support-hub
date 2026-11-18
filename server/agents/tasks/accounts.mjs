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
import { delivered } from '../notify.mjs';
import { composeAccountsReport } from '../accounts/report.mjs';
import { weekStart } from '../accounts/week.mjs';
import { heldForScorecard, heldResult, recordRun } from './shared.mjs';

export const accountsFeature = 'platform.agents.accounts.v1';
const snapshotLimit = 200;

/**
 * Every page of the billing snapshot (up to `snapshotLimit` accounts a page) as one snapshot. The scorecard reads it the same way.
 * A database without the paged read (customer growth not applied) gives its single first page.
 */
export async function readAccountsSnapshot(store) {
  let snapshot = store.accountsPage ? await store.accountsPage({ limit: snapshotLimit, offset: 0 }) : await store.accountsSnapshot({ limit: snapshotLimit });
  if (store.accountsPage) {
    while (snapshot.accounts.length < snapshot.total && snapshot.truncated) {
      const page = await store.accountsPage({ limit: snapshotLimit, offset: snapshot.accounts.length });
      if (!page.accounts.length) break;
      snapshot = { ...snapshot, accounts: [...snapshot.accounts, ...page.accounts], total: page.total, truncated: page.truncated };
    }
  }
  return snapshot;
}

const declared = features => (features instanceof Set ? features.has(accountsFeature) : Array.isArray(features) && features.includes(accountsFeature));

/** Registered only when the database declares the feature, so a Hub whose database lacks the migration still starts and the schedule stays due. */
export function accountsHandlers({ store, notifier, publicOrigin, features = null, log = line => console.warn(line) }) {
  if (!declared(features)) return {};

  async function weekly(task, { now = () => new Date() } = {}) {
    const moment = now();
    const week = weekStart(moment);
    const asked = task.sourceKind === 'owner';
    // The Monday scorecard carries this report while the owner's "Send the individual weekly reports" is off.
    if (await heldForScorecard({ store, log }, task)) return heldResult({ week });
    const snapshot = await readAccountsSnapshot(store);
    const report = composeAccountsReport({ snapshot, now: moment, publicOrigin });
    if (report.result.accounts === 0) return { result: { skipped: 'no_accounts', week } };

    const results = await notifier.send({
      severity: 'info', subject: report.subject, body: report.body, blocks: report.blocks,
      dedupeKey: asked ? `accounts:run:${task.id}` : `accounts:weekly:${week}`, agentKey: task.agentKey, taskId: task.id, attention: asked ? 'now' : 'update',
    });
    // A scheduled run that finds the week's alert already recorded sends nothing. It says whether that earlier attempt reached the owner.
    if (!asked && results.every(item => item.delivery === 'duplicate')) return { result: { skipped: results.some(delivered) ? 'already_sent' : 'earlier_attempt_unconfirmed', week } };

    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    const reached = results.some(delivered);
    await recordRun({ store, log }, task, {
      promptVersion: 'accounts.1',
      summary: reached ? `Sent the weekly accounts report: ${report.body}` : `The weekly accounts report was written but not delivered (${delivery.join(', ')}).`,
      outcome: reached ? 'completed' : 'failed', errorCode: reached ? null : 'not_delivered',
    });
    return { result: { week, delivery, ...report.result } };
  }

  return { 'accounts.weekly': weekly };
}
