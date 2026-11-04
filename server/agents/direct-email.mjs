/**
 * The owner explicitly prepares and then approves one external email. This executor is
 * available only when the private ledger and guarded send operations are declared.
 * Nothing is sent by a scheduled agent or the model. Even Act cannot bypass owner approval.
 *
 * Once the database reserves a send, an uncertain provider outcome is NEVER retried:
 * a crash after the provider receives the request cannot become a second email.
 */
const failure = code => Object.assign(new Error(code), { code });

export function directEmailExecutors({ store, email, features }) {
  if (features?.has?.('platform.agents.direct-email.v1') !== true) return {};
  return {
    'email.direct': async action => {
      if (!email?.configured) throw failure('not_configured');
      const begun = await store.directEmailBeginSend(action.id, action.execution);
      if (begun?.state === 'recorded') {
        if (begun.status === 'sent') return { delivery: 'sent', replay: true };
        throw failure(begun.status === 'failed' ? 'delivery_failed' : 'email_unconfirmed');
      }
      if (begun?.state !== 'ready') throw failure(begun?.state === 'approval_required' ? 'approval_required' : 'wording_changed');
      let delivery;
      try {
        delivery = await email.send(begun.to, begun.subject, begun.body);
      } catch {
        delivery = { delivery: 'unknown', id: null };
      }
      const outcome = ['sent', 'failed', 'unknown'].includes(delivery?.delivery) ? delivery.delivery : 'unknown';
      // Provider may have accepted the message even if recording fails. Do not attempt another send.
      const recorded = await store.directEmailFinishSend({
        actionId: action.id, execution: action.execution, delivery: outcome, providerMessageId: delivery?.id ?? null,
      }).catch(() => false);
      if (recorded !== true) throw failure('email_unconfirmed');
      if (outcome === 'failed') throw failure('delivery_failed');
      if (outcome === 'unknown') throw failure('email_unconfirmed');
      return { delivery: 'sent', replay: false };
    },
  };
}
