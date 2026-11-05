/** Owner-authored operational email. No model, customer template or automatic approval can create this action. */
export const externalEmailFeature = 'platform.agents.external-email.v1';
const mailbox = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const headerControls = /[\u0000-\u001f\u007f]/;
const bodyControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const providerId = value => (typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value) ? value : null);
const failure = code => Object.assign(new Error(code === 'external_email_unconfirmed'
  ? 'The email outcome is uncertain. Do not resend. Check the activity history and email provider.'
  : 'The external email could not be confirmed.'), { code });
const declared = features => (features instanceof Set ? features.has(externalEmailFeature) : Array.isArray(features) && features.includes(externalEmailFeature));

/** Validate without rewriting the owner-approved recipient, subject or message. */
export function validExternalEmail(input) {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    && typeof input.to === 'string' && input.to.length <= 320 && mailbox.test(input.to)
    && typeof input.subject === 'string' && input.subject.trim().length > 0 && Array.from(input.subject).length <= 200 && !headerControls.test(input.subject)
    && typeof input.body === 'string' && input.body.trim().length > 0 && Array.from(input.body).length <= 5000 && !bodyControls.test(input.body);
}

export function externalEmailAvailable({ features, email }) {
  return declared(features) && email?.configured === true && typeof email.send === 'function';
}

function recordedOutcome(record) {
  if (record.status === 'sent') return { outcome: 'accepted', providerMessageId: providerId(record.providerMessageId), replay: true };
  throw failure(record.status === 'failed' ? 'external_email_refused' : 'external_email_unconfirmed');
}

/**
 * The private ledger binds the reviewed payload to the owner's request and admits a single send attempt.
 * A crash or uncertain provider response leaves a durable record: replay settles that record and never sends again.
 * Only provider acceptance is reported as success; it does not establish delivery to the recipient's inbox.
 */
export function externalEmailExecutor({ store, email, log = line => console.warn(line) }) {
  return async execution => {
    if (execution?.kind !== 'email.external' || execution.autoApproved !== false
      || !Number.isSafeInteger(execution.execution) || execution.execution < 1
      || !uuid.test(execution?.input?.requestKey ?? '') || Object.keys(execution.input).length !== 1) throw failure('invalid_external_email');
    const claim = { actionId: execution.id, execution: execution.execution };
    // A failed lookup may be a recovery of an earlier send; a lost claim response may have
    // committed. Neither failure establishes that no message was sent or that retrying is safe.
    const lookup = async shouldClaim => {
      try { return await store.externalEmailBeginSend({ ...claim, claim: shouldClaim }); }
      catch { throw failure('external_email_unconfirmed'); }
    };
    const earlier = await lookup(false);
    if (earlier?.state === 'recorded') return recordedOutcome(earlier);
    if (earlier?.state !== 'unrecorded') throw failure('external_email_unconfirmed');
    if (email?.configured !== true || typeof email.send !== 'function') throw failure('external_email_not_configured');

    const begun = await lookup(true);
    if (begun?.state === 'recorded') return recordedOutcome(begun);
    if (begun?.state !== 'ready' || !validExternalEmail(begun)) throw failure('external_email_unconfirmed');

    let response;
    try {
      // Reuse the transactional support sender. Plain text preserves the approved message, with no campaign footer.
      response = await email.send(begun.to, begun.subject, begun.body);
    } catch {
      // An exception may occur after the provider accepted the message. Never infer that it is safe to resend.
      response = null;
    }
    const delivery = ['sent', 'failed', 'unknown'].includes(response?.delivery) ? response.delivery : 'unknown';
    const messageId = delivery === 'sent' ? providerId(response?.id) : null;
    try {
      const settled = await store.externalEmailFinishSend({ ...claim, delivery, providerMessageId: messageId });
      if (settled !== true) log(JSON.stringify({ event: 'hub_agent_external_email_unsettled', action_id: execution.id }));
    } catch {
      // The sending record remains. A recovered worker will report uncertainty without contacting the provider again.
      log(JSON.stringify({ event: 'hub_agent_external_email_unsettled', action_id: execution.id }));
    }
    if (delivery === 'sent') return { outcome: 'accepted', providerMessageId: messageId };
    throw failure(delivery === 'failed' ? 'external_email_refused' : 'external_email_unconfirmed');
  };
}

export function externalEmailExecutors({ store, features, email, log }) {
  return declared(features) ? { 'email.external': externalEmailExecutor({ store, email, log }) } : {};
}

/** Only this email kind is offered for owner-requested recovery; it remains eligible for background completion too. */
export function externalEmailRecovery({ store, features }) {
  return declared(features) ? (recover = false) => store.externalEmailReady({ recover }) : null;
}
