/**
 * `accounts.lifecycle`: the Account Manager's customer emails, every morning at 08:20 Eastern. It reads one server-only snapshot of
 * the trials and new paying accounts (names, dates and flags: never an address), works out which of the four fixed emails each
 * account and product is due (accounts/lifecycle.mjs), and proposes each one to the owner with its exact text as the preview. It
 * uses no model and sends nothing itself: an approved email is sent by its executor (accounts/executor.mjs).
 *
 * - Each email is proposed at most once per account and product, ever: the database keys it by its period
 *   (account:<template>:<tenant>:<product>) whichever run proposed it, and the snapshot says which were proposed before.
 * - At most 20 are proposed in a run, and one per account (a second one waits for the next run).
 * - None is proposed to an account with no usable billing address or one that unsubscribed.
 * - An agent in Observe proposes nothing and records what it would have proposed, as counts.
 * - None is proposed while the Hub cannot send customer email (no SendGrid sender, no postal address for the footer, or no https
 *   origin for the unsubscribe link); the run says what is missing.
 * - On Act, the database approves an email on its own only when the owner listed its template in auto_send_templates (never for
 *   being listed in auto_approve_kinds); the result counts what the database recorded, so it says what really happened.
 *
 * The run finishes once it has proposed: the proposals wait on the Team screen, and the next morning's run is not held back by them.
 * The task result and the run summary carry counts and template names only, never an account name.
 */
import { lifecycleFeature, lifecycleInput, lifecyclePreview, lifecycleReadiness, lifecycleTemplates, planEmails, proposalLimit, templateWords } from '../accounts/lifecycle.mjs';
import { plural, recordRun } from './shared.mjs';

export { lifecycleFeature };
const snapshotLimit = 200;
const missingWords = { mail: 'no SendGrid sender', postal_address: 'no postal address (HUB_BULK_EMAIL_POSTAL_ADDRESS)', public_origin: 'no https public origin' };

const declared = features => (features instanceof Set ? features.has(lifecycleFeature) : Array.isArray(features) && features.includes(lifecycleFeature));
const counted = list => Object.fromEntries(lifecycleTemplates.map(template => [template, list.filter(entry => entry.template === template).length]));
const listed = byTemplate => lifecycleTemplates.filter(template => byTemplate[template] > 0).map(template => `${byTemplate[template]} ${templateWords[template]}`).join(', ');

/** Registered only when the database declares the feature, so a Hub whose database lacks the migration still starts and the schedule stays due. */
export function lifecycleHandlers({ store, features = null, lifecycle = {}, log = line => console.warn(line) }) {
  if (!declared(features)) return {};

  async function emails(task, { now = () => new Date(), signal } = {}) {
    const moment = now();
    const snapshot = await store.lifecycleSnapshot({ limit: snapshotLimit });
    const { candidates, skipped } = planEmails(snapshot?.accounts ?? [], moment);
    const chosen = candidates.slice(0, proposalLimit);
    const base = {
      mode: snapshot?.mode ?? null, due: candidates.length, byTemplate: counted(chosen), deferred: candidates.length - chosen.length + skipped.sameAccount,
      noAddress: skipped.noAddress, suppressed: skipped.suppressed, truncated: snapshot?.truncated === true,
    };
    const finish = async (result, summary, { outcome = 'completed', errorCode = null } = {}) => {
      await recordRun({ store, log }, task, { promptVersion: 'lifecycle.1', summary, outcome, errorCode });
      return { result };
    };
    const tail = [
      ...(base.noAddress ? [`Skipped ${plural(base.noAddress, 'account')} with no billing email.`] : []),
      ...(base.suppressed ? [`Skipped ${plural(base.suppressed, 'account')} that unsubscribed.`] : []),
      ...(base.deferred ? [`${base.deferred} more ${base.deferred === 1 ? 'waits' : 'wait'} for the next run.`] : []),
    ].map(note => ` ${note}`).join('');

    if (chosen.length === 0) return finish({ ...base, outcome: 'nothing_due', proposed: 0 }, `No customer email is due.${tail}`);
    // Observe reads and reports only: the same pattern as every other agent, which never asks the database to propose.
    if (task.agent?.autonomy === 'observe') {
      return finish({ ...base, outcome: 'observe_only', proposed: 0 },
        `Observe only: ${plural(chosen.length, 'customer email')} would be proposed (${listed(base.byTemplate)}). Nothing was proposed.${tail}`);
    }
    const readiness = lifecycleReadiness(lifecycle);
    if (!readiness.ready) {
      return finish({ ...base, outcome: 'not_configured', proposed: 0, missing: readiness.missing },
        `${plural(chosen.length, 'customer email')} due, but customer email is not set up (${readiness.missing.map(item => missingWords[item]).join(', ')}), so none was proposed.${tail}`,
        { outcome: 'failed', errorCode: 'not_configured' });
    }

    let proposed = 0;
    let autoApproved = 0;
    let alreadyProposed = 0;
    const made = [];
    for (const { fact, template } of chosen) {
      // The scheduler has stopped waiting for this run: nothing more is proposed.
      if (signal?.aborted) throw Object.assign(new Error('The run was stopped.'), { code: 'task_timeout', transient: true });
      const input = lifecycleInput(fact, template, { bookingUrl: lifecycle.bookingUrl ?? null });
      let proposal;
      try {
        proposal = await store.proposeAction({
          taskId: task.id, kind: 'email.send', targetKind: 'billing_account', targetId: fact.tenant,
          preview: lifecyclePreview(input, { postalAddress: lifecycle.postalAddress }), input,
        });
      } catch (error) {
        // Another run proposed this period first (its key is unique across every task).
        if (error?.code === '23505') { alreadyProposed += 1; continue; }
        // The owner switched the agent to Observe while this run was going: propose nothing more.
        if (error?.code === '42501') break;
        throw error;
      }
      if (proposal?.created === false) { alreadyProposed += 1; continue; }
      proposed += 1;
      made.push({ template });
      if (proposal?.status === 'auto_approved') autoApproved += 1;
    }
    const result = { ...base, outcome: 'proposed', proposed, autoApproved, alreadyProposed, byTemplate: counted(made) };
    return finish(result, proposed === 0
      ? `No new customer email was proposed: ${plural(alreadyProposed, 'email')} had been proposed already.${tail}`
      : `Proposed ${plural(proposed, 'customer email')} (${listed(result.byTemplate)})${autoApproved ? `; ${autoApproved} approved on ${autoApproved === 1 ? 'its' : 'their'} own, by the templates you listed` : ' for your approval'}.${tail}`);
  }

  return { 'accounts.lifecycle': emails };
}
