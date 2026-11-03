/**
 * Sends one approved customer email (`email.send`), the only thing that action does. It runs in the background drain or straight
 * after the owner approves; it needs no owner session, because it reads nothing but the Hub's own billing mirror.
 *
 * An action whose send was already recorded by an earlier attempt (the server stopped mid-send and the sweep handed the action back)
 * is settled from that record first, whatever else has changed since, and never sent twice. Otherwise, before anything is sent, it
 * checks, in this order, and refuses with a code the Team screen explains:
 *   - invalid_email      the action's facts are not the shape the database also checks;
 *   - not_configured     the Hub cannot send customer email (no SendGrid sender, no postal address for the footer, or no bare https
 *                        origin for the unsubscribe link);
 *   - wording_changed    the email rebuilt from the action's facts no longer matches the wording the owner approved (a newer Hub
 *                        changed the template), so what was approved is never silently replaced;
 *   - no_longer_applies  the account changed since it was proposed: the trial is no longer a trial (or, for the setup offer, the product
 *                        has reported usage since), the paying account is no longer paying or has an open high or urgent case, or it
 *                        is being cancelled;
 *   - auto_send_off      it was approved on its own, but the agent no longer acts or no longer lists its template;
 *   - no_address         there is no usable billing address on file;
 *   - suppressed         the address unsubscribed (bulk email's suppression list, which the email's own link also writes to);
 *   - daily_limit        20 customer emails already went out today, across every account.
 * Then the database records the send and hands over the one address (private.agent_lifecycle_begin_send), and SendGrid is asked once:
 * sent, delivery_failed (refused: it did not reach the customer) or email_unconfirmed (no answer: it may have, so it is never sent
 * again). Nothing is retried. The address and the email's text are never logged, stored or returned: the result is the outcome and
 * the template.
 */
import { randomBytes } from 'node:crypto';
import { digest } from '../../sms-auth.mjs';
import { httpsOrigin, lifecycleFeature, lifecycleReadiness, parseLifecycleInput, renderLifecycleEmail, stillApplies, wordingHash } from './lifecycle.mjs';

const failure = code => Object.assign(new Error('The customer email was not sent.'), { code });
const refusals = { no_address: 'no_address', suppressed: 'suppressed', daily_limit: 'daily_limit', auto_send_off: 'auto_send_off' };
const providerId = value => (typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value) ? value : null);
// What an earlier attempt recorded: sent stays sent; refused stays refused; anything else may have gone and is never sent again.
const settle = (status, template) => {
  if (status === 'sent') return { outcome: 'sent', template, replay: true };
  throw failure(status === 'failed' ? 'delivery_failed' : 'email_unconfirmed');
};

export function lifecycleExecutor({ store, lifecycle = {}, log = line => console.warn(line) }) {
  return async function sendCustomerEmail(execution) {
    const input = parseLifecycleInput(execution?.input);
    if (!input) throw failure('invalid_email');
    const executionNumber = Number.isInteger(execution.execution) ? execution.execution : null;
    const earlier = await store.lifecycleBeginSend({ actionId: execution.id, execution: executionNumber, unsubscribeHash: null });
    if (earlier?.state === 'recorded') return settle(earlier.status, input.template);
    if (!lifecycleReadiness(lifecycle).ready) throw failure('not_configured');
    if (wordingHash(input) !== input.textHash) throw failure('wording_changed');

    const snapshot = await store.lifecycleSnapshot({ limit: 1, tenant: input.tenant, product: input.product });
    const fact = (snapshot?.accounts ?? []).find(entry => entry.tenant === input.tenant && entry.product === input.product) ?? null;
    if (!stillApplies(input.template, fact)) throw failure('no_longer_applies');

    // The personal unsubscribe link: its token lives only in the email; the database keeps its hash beside the address's hash.
    const token = randomBytes(32).toString('hex');
    const begun = await store.lifecycleBeginSend({ actionId: execution.id, execution: executionNumber, unsubscribeHash: digest(token) });
    if (begun?.state === 'recorded') return settle(begun.status, input.template);
    if (begun?.state !== 'ready' || typeof begun.to !== 'string') throw failure(refusals[begun?.state] ?? 'executor_error');

    // Built on the parsed origin alone (readiness refused anything but a bare https origin), so nothing can come after the path.
    const unsubscribeUrl = `${httpsOrigin(lifecycle.publicOrigin)}/api/email/unsubscribe/${token}`;
    const email = renderLifecycleEmail(input, { unsubscribeUrl, postalAddress: String(lifecycle.postalAddress).trim() });
    let outcome = null;
    try {
      outcome = await lifecycle.mail.send({ to: begun.to, subject: email.subject, text: email.text, html: email.html, unsubscribeUrl });
    } catch {
      // A sender that threw may or may not have handed the message over: unknown, never retried. Its error is not logged (it may quote the address).
      outcome = null;
    }
    const delivery = ['sent', 'failed', 'unknown'].includes(outcome?.delivery) ? outcome.delivery : 'unknown';
    try {
      await store.lifecycleFinishSend({ actionId: execution.id, delivery, providerMessageId: providerId(outcome?.id) });
    } catch {
      // The record stays "sending", which a later attempt reads as unconfirmed: it is never sent again.
      log(JSON.stringify({ event: 'hub_agent_email_unsettled', action_id: execution.id }));
    }
    if (delivery === 'sent') return { outcome: 'sent', template: input.template };
    throw failure(delivery === 'failed' ? 'delivery_failed' : 'email_unconfirmed');
  };
}

const declared = features => (features instanceof Set ? features.has(lifecycleFeature) : Array.isArray(features) && features.includes(lifecycleFeature));

/** The Account Manager's one action, registered only when the database declares the feature (its operations exist only then). */
export function lifecycleExecutors({ store, features = null, lifecycle = {}, log }) {
  if (!declared(features)) return {};
  return { 'email.send': lifecycleExecutor({ store, lifecycle, log }) };
}
